import { SidecarApp, Response } from 'sidecar_sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import {
  FINGERPRINT_LEDGER_FILE, isResponseModelMismatched, decodeThinkingSignatureFingerprint,
  loadFingerprintLedger, flushFingerprintLedger, recordModelFingerprint, acknowledgeFingerprintChanges,
} from './fingerprint_ledger.mjs';
import { extractUserPromptPreview, buildWakeTurn, aggregateStepsToTurns, computeConversationTurnMetrics } from './turn_aggregator.mjs';
import { reconcileAndPersistHistory, getPersistedTurnsForConversation, getLocalQuotaEstimatesByConv } from './task_history_store.mjs';
import { buildRootMap, finalizeFleet, preselect, finalSelect, dismissConversation, restoreConversation } from './fleet/index.mjs';
import { cloneQuotaGroups, mergeCatalogQuotaFallback, pickLatestCodexQuota, updateFamilyQuotaTracker, updateQuotaCalibrationTracker, handleQuotaAction } from './quota/index.mjs';
import { startBackgroundUpdateChecker, getPluginUpdateStatus, handleUpdaterAction } from './updater/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const AGY_DIR = join(HOME, '.gemini', 'antigravity');
const BRAIN_DIR = join(AGY_DIR, 'brain');
const ANNOTATIONS_DIR = join(AGY_DIR, 'annotations');
const SCRATCH_DIR = join(AGY_DIR, 'scratch');
const LIVE_STATE_FILE = join(SCRATCH_DIR, 'telemetry_live_state.json');

const CODEX_DIR = join(HOME, '.codex');
const CODEX_STATE_DB = join(CODEX_DIR, 'state_5.sqlite');
const CODEX_CATALOG_DB = join(CODEX_DIR, 'sqlite', 'codex.db');
const CODEX_LOGS_DB = join(CODEX_DIR, 'logs_2.sqlite');
const CODEX_BRIDGE_ACTIVE_FILE = join(CODEX_DIR, '.agy-bridge-active.json');

const LS_ADDR = process.env.ANTIGRAVITY_LS_ADDRESS;
const CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN;

async function callLsRpc(method, payload = {}) {
  const res = await fetch(
    `http://${LS_ADDR}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': CSRF_TOKEN,
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`RPC ${method} failed (${res.status}): ${errText}`);
  }
  return res.json();
}

function parseDurationSec(durStr) {
  if (!durStr || typeof durStr !== 'string') return 0;
  const s = durStr.trim();
  if (s.endsWith('ms')) {
    return parseFloat(s.slice(0, -2)) / 1000;
  }
  if (s.endsWith('s')) {
    return parseFloat(s.slice(0, -1));
  }
  return parseFloat(s) || 0;
}

function extractWorkspaceLabel(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return 'Global';
  const uri = workspaces[0]?.workspaceFolderAbsoluteUri || '';
  if (!uri) return 'Global';
  const decoded = decodeURIComponent(uri).replace(/\/+$/, '');
  const parts = decoded.split(/[\\/]/);
  return parts[parts.length - 1] || 'Workspace';
}

function readConversationTitle(convId) {
  try {
    const p = join(ANNOTATIONS_DIR, `${convId}.pbtxt`);
    if (!existsSync(p)) return convId.slice(0, 8);
    const raw = readFileSync(p, 'utf-8');
    const m = raw.match(/title:\s*"([^"]+)"/);
    return m ? m[1] : convId.slice(0, 8);
  } catch {
    return convId.slice(0, 8);
  }
}

function stripWrappingQuotes(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/^"|"$/g, '').trim();
}

function readTaskLogPreview(convId, stepIndex, maxLines = 2) {
  try {
    const logPath = join(BRAIN_DIR, convId, '.system_generated', 'tasks', `task-${stepIndex}.log`);
    if (!existsSync(logPath)) return { exists: false, sizeBytes: 0, tailLines: [] };
    const st = statSync(logPath);
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    return {
      exists: true,
      sizeBytes: st.size,
      tailLines: lines.slice(-maxLines),
    };
  } catch {
    return { exists: false, sizeBytes: 0, tailLines: [] };
  }
}

const transcriptInspectCache = new Map();
const bgStepResolvedCache = new Map();
const sigStepCache = new Map();

/**
 * Inspects transcript.jsonl and .system_generated/tasks for both the latest turn state AND background tasks.
 */
function inspectTranscriptAndBgCandidates(convId) {
  try {
    const transcriptPath = join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) return null;
    const st = statSync(transcriptPath);
    const tasksDir = join(BRAIN_DIR, convId, '.system_generated', 'tasks');
    const tasksDirMtime = existsSync(tasksDir) ? statSync(tasksDir).mtimeMs : 0;

    const cached = transcriptInspectCache.get(convId);
    if (
      cached &&
      cached.fileMtimeMs === st.mtimeMs &&
      cached.fileSize === st.size &&
      cached.tasksDirMtime === tasksDirMtime &&
      Date.now() - cached.cachedAtMs < 8000
    ) {
      return cached.result;
    }

    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    let lastPlannerStep = null;
    let lastStep = null;
    const bgMap = new Map(); // stepIndex -> candidate info
    const codexThreadIdSet = new Set();
    const userTurns = [];
    const wakeTurns = [];
    let firstCreatedAtMs = 0;
    let prevLineCreatedMs = 0;
    let prevLineWasSys = false;
    let prevPlannerObj = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isTail = i >= lines.length - 12;
      const isUserInput = line.includes('"USER_INPUT"');
      const isSysMsg = line.includes('"SYSTEM_MESSAGE"');
      const createdMatch = line.match(/"created_at"\s*:\s*"([^"]+)"/);
      const lineCreatedMs = createdMatch ? Date.parse(createdMatch[1]) || 0 : 0;
      if (i === 0 && lineCreatedMs) firstCreatedAtMs = lineCreatedMs;
      const curPrevCreatedMs = prevLineCreatedMs;
      const curPrevWasSys = prevLineWasSys;
      if (lineCreatedMs) prevLineCreatedMs = lineCreatedMs;
      prevLineWasSys = isSysMsg;

      const hasBgSpawn = line.includes('Tool is running as a background task with task id:');
      const hasBgFinish =
        (line.includes('Task id "') &&
          (line.includes('" finished') || line.includes('was stopped'))) ||
        (line.includes('/task-') &&
          (line.includes('cancelled') ||
            line.includes('killed') ||
            line.includes('Status: DONE') ||
            line.includes('Status: CANCELED') ||
            line.includes('Status: ERROR')));
      const mightBePlannerBeforeBg =
        (i + 1 < lines.length &&
          lines[i + 1].includes('Tool is running as a background task with task id:')) ||
        (i + 2 < lines.length &&
          lines[i + 2].includes('Tool is running as a background task with task id:'));
      const hasCodexRef =
        line.includes('--thread-id') || line.includes('threadId') || line.includes('codex_chat');

      if (hasCodexRef) {
        const tidRegex =
          /(?:--thread-id\s+["'\\]*|"threadId"\s*:\s*\\?")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
        let tm;
        while ((tm = tidRegex.exec(line)) !== null) {
          const tid = tm[1].toLowerCase();
          codexThreadIdSet.delete(tid);
          codexThreadIdSet.add(tid);
        }
      }

      if (!isTail && !isUserInput && !isSysMsg && !hasBgSpawn && !hasBgFinish && !mightBePlannerBeforeBg) {
        continue;
      }

      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT') {
          userTurns.push({
            stepIndex: obj.step_index ?? i,
            createdAtMs: obj.created_at ? Date.parse(obj.created_at) || 0 : 0,
            promptPreview: extractUserPromptPreview(obj.content || ''),
          });
        } else {
          const wake = buildWakeTurn(obj, i, curPrevCreatedMs, curPrevWasSys, wakeTurns.length);
          if (wake) wakeTurns.push(wake);
        }
        if (obj.type === 'PLANNER_RESPONSE') {
          prevPlannerObj = obj;
          if (isTail) lastPlannerStep = obj;
        }
        if (isTail) {
          lastStep = obj;
        }

        if (hasBgSpawn && (obj.type === 'GENERIC' || obj.type === 'TOOL_RESPONSE')) {
          const contentStr = String(obj.content || '');
          const idMatch = contentStr.match(
            /Tool is running as a background task with task id:\s*(?:([0-9a-fA-F-]+)\/)?task-(\d+)/
          );
          if (!idMatch) continue;
          const matchedConvId = idMatch[1] || convId;
          if (matchedConvId !== convId) continue;
          const resolvedStepIdx = Number(idMatch[2]);

          const descMatch = contentStr.match(/Task Description:\s*([^\r\n]+)/);
          const descFromContent = descMatch ? descMatch[1].trim() : '';

          // Match with tool call from preceding planner step
          let toolName = 'run_command';
          let toolSummary = '';
          let commandLine = descFromContent;
          let isDaemon = false;

          if (prevPlannerObj && Array.isArray(prevPlannerObj.tool_calls)) {
            const cmdCalls = prevPlannerObj.tool_calls.filter(
              (c) => c.name === 'run_command' || c.name === 'schedule'
            );
            const tc =
              cmdCalls.find((c) => {
                const cmdArg = stripWrappingQuotes(c.args?.CommandLine || c.args?.Prompt || '');
                return descFromContent && cmdArg === descFromContent;
              }) ||
              cmdCalls[0] ||
              prevPlannerObj.tool_calls[0];
            if (tc) {
              toolName = tc.name || 'run_command';
              const args = tc.args || {};
              toolSummary = stripWrappingQuotes(
                args.toolSummary || args.Prompt || descFromContent || args.CommandLine || ''
              );
              commandLine =
                descFromContent ||
                stripWrappingQuotes(args.CommandLine || args.CronExpression || '');
              isDaemon = args.IsDaemon === true || args.IsDaemon === 'true';
            }
          }

          bgMap.set(resolvedStepIdx, {
            stepIndex: resolvedStepIdx,
            taskId: `task-${resolvedStepIdx}`,
            toolName,
            toolSummary: toolSummary || descFromContent || `Background Task #${resolvedStepIdx}`,
            commandLine: commandLine || toolSummary,
            isDaemon,
            startedAt: obj.created_at || '',
            completedAt: '',
            transcriptFinished: false,
            transcriptStatus: obj.status || 'RUNNING',
            logMtimeMs: 0,
          });
        }

        if (hasBgFinish) {
          const contentStr = String(obj.content || '');
          const finishRegex = new RegExp(`${convId}\\/task-(\\d+)`, 'g');
          let fm;
          while ((fm = finishRegex.exec(contentStr)) !== null) {
            const idx = Number(fm[1]);
            const existing = bgMap.get(idx);
            if (existing) {
              if (
                obj.type === 'SYSTEM_MESSAGE' &&
                (contentStr.includes('" finished') || contentStr.includes('was stopped'))
              ) {
                existing.transcriptFinished = true;
                existing.completedAt = obj.created_at || '';
                existing.transcriptStatus = contentStr.includes('was stopped')
                  ? 'CANCELED'
                  : 'DONE';
              } else if (obj.type === 'GENERIC' || obj.type === 'TOOL_RESPONSE') {
                if (
                  contentStr.includes('cancelled') ||
                  contentStr.includes('killed') ||
                  contentStr.includes('Status: CANCELED')
                ) {
                  existing.transcriptFinished = true;
                  existing.completedAt = obj.created_at || '';
                  existing.transcriptStatus = 'CANCELED';
                } else if (
                  contentStr.includes('Status: DONE') ||
                  contentStr.includes('Status: ERROR')
                ) {
                  existing.transcriptFinished = true;
                  existing.completedAt = obj.created_at || '';
                  existing.transcriptStatus = contentStr.includes('Status: ERROR')
                    ? 'ERROR'
                    : 'DONE';
                }
              }
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }

    // Also inspect .system_generated/tasks/task-*.log so no background task is missed
    let latestTaskLogMtimeMs = 0;
    try {
      const tasksDir = join(BRAIN_DIR, convId, '.system_generated', 'tasks');
      if (existsSync(tasksDir)) {
        const files = readdirSync(tasksDir);
        for (const f of files) {
          const m = f.match(/^task-(\d+)\.log$/);
          if (!m) continue;
          const idx = Number(m[1]);
          const logPath = join(tasksDir, f);
          const lst = statSync(logPath);
          if (lst.mtimeMs > latestTaskLogMtimeMs) latestTaskLogMtimeMs = lst.mtimeMs;
          if (bgMap.has(idx)) {
            bgMap.get(idx).logMtimeMs = lst.mtimeMs;
          } else {
            bgMap.set(idx, {
              stepIndex: idx,
              taskId: `task-${idx}`,
              toolName: 'run_command',
              toolSummary: `Background Task #${idx}`,
              commandLine: '',
              isDaemon: false,
              startedAt: new Date(lst.birthtimeMs || lst.mtimeMs).toISOString(),
              completedAt: '',
              transcriptFinished: Date.now() - lst.mtimeMs > 25 * 1000,
              transcriptStatus: 'DONE',
              logMtimeMs: lst.mtimeMs,
            });
          }
        }
      }
    } catch {
      // ignore tasks dir scan errors
    }

    const lastToolCalls = (lastPlannerStep?.tool_calls || []).map((tc) => ({
      name: tc.name,
      summary: stripWrappingQuotes(tc.args?.toolSummary || ''),
    }));

    const bgCandidates = Array.from(bgMap.values()).sort((a, b) => a.stepIndex - b.stepIndex);
    const unclosedBgCount = bgCandidates.filter((c) => !c.transcriptFinished).length;
    const unclosedNonDaemonBgCount = bgCandidates.filter(
      (c) => !c.transcriptFinished && !c.isDaemon
    ).length;
    const codexThreadIds = Array.from(codexThreadIdSet).reverse();

    const result = {
      mtimeMs: Math.max(st.mtimeMs, latestTaskLogMtimeMs),
      totalSteps: lines.length,
      lastStepIndex: lastStep?.step_index ?? null,
      lastStepType: lastStep?.type || '',
      lastStepStatus: lastStep?.status || '',
      lastStepCreatedAt: lastStep?.created_at || '',
      lastToolCalls,
      bgCandidates,
      unclosedBgCount,
      unclosedNonDaemonBgCount,
      codexThreadIds,
      userTurns,
      wakeTurns,
      firstCreatedAtMs,
    };

    transcriptInspectCache.set(convId, {
      fileMtimeMs: st.mtimeMs,
      fileSize: st.size,
      tasksDirMtime,
      cachedAtMs: Date.now(),
      result,
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Resolves live status of background tasks via Language Server GetCascadeTrajectorySteps.
 */
async function resolveBackgroundTasks(convId, bgCandidates, nowMs) {
  if (!Array.isArray(bgCandidates) || bgCandidates.length === 0) {
    return [];
  }

  // Keep all unfinished candidates (up to last 6) + up to 1 most recent finished candidate
  const unfinished = bgCandidates.filter((c) => !c.transcriptFinished).slice(-6);
  const finishedRecent = bgCandidates.filter((c) => c.transcriptFinished).slice(-1);
  const toCheck = [...unfinished, ...finishedRecent];

  const resolved = await Promise.all(
    toCheck.map(async (cand) => {
      const cacheKey = `${convId}:${cand.stepIndex}`;
      const cachedDone = bgStepResolvedCache.get(cacheKey);
      if (cachedDone && (cand.transcriptFinished || !cachedDone.isRunning)) {
        return cachedDone;
      }

      let status = cand.transcriptFinished ? cand.transcriptStatus : 'DONE';
      let startedAt = cand.startedAt;
      let completedAt = cand.completedAt;
      let toolSummary = cand.toolSummary;
      let commandLine = cand.commandLine;
      let isDaemon = cand.isDaemon;

      // Only query LS step status if the task is not yet finished in transcript, or we lack its commandLine
      if (!cand.transcriptFinished || !commandLine) {
        try {
          const stepRes = await callLsRpc('GetCascadeTrajectorySteps', {
            cascadeId: convId,
            stepOffset: cand.stepIndex,
          });
          const stepObj = Array.isArray(stepRes.steps) ? stepRes.steps[0] : null;
          if (stepObj) {
            const rawStatus = String(stepObj.status || '').replace('CORTEX_STEP_STATUS_', '');
            if (rawStatus) {
              status = rawStatus;
            }
            if (cand.transcriptFinished && (status === 'RUNNING' || status === 'PENDING')) {
              status = cand.transcriptStatus || 'DONE';
            }

            const td = stepObj.taskDetails || {};
            if (td.title) toolSummary = td.title;
            if (td.description) commandLine = td.description;
            if (td.movedToBackgroundAt && !startedAt) startedAt = td.movedToBackgroundAt;

            const rc = stepObj.runCommand || {};
            if (rc.commandLine) commandLine = rc.commandLine;

            const meta = stepObj.metadata || {};
            if (meta.startedAt || meta.createdAt) {
              startedAt = meta.startedAt || meta.createdAt;
            }
            if (meta.completedAt) {
              completedAt = meta.completedAt;
            }
            if (meta.toolCall?.argumentsJson) {
              try {
                const parsedArgs = JSON.parse(meta.toolCall.argumentsJson);
                if (parsedArgs.toolSummary) toolSummary = parsedArgs.toolSummary;
                if (parsedArgs.CommandLine) commandLine = parsedArgs.CommandLine;
                if (typeof parsedArgs.IsDaemon === 'boolean') isDaemon = parsedArgs.IsDaemon;
              } catch {
                // ignore JSON parse error
              }
            }
          } else if (!cand.transcriptFinished) {
            status = cand.logMtimeMs && nowMs - cand.logMtimeMs < 30000 ? 'RUNNING' : 'DONE';
          }
        } catch {
          if (!cand.transcriptFinished) {
            status = cand.logMtimeMs && nowMs - cand.logMtimeMs < 30000 ? 'RUNNING' : 'DONE';
          }
        }
      }

      const isRunning = status === 'RUNNING' || status === 'PENDING';
      const startMs = startedAt ? new Date(startedAt).getTime() : nowMs;
      const endMs = !isRunning && completedAt ? new Date(completedAt).getTime() : nowMs;
      const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
      const logPreview = readTaskLogPreview(convId, cand.stepIndex, 2);

      const item = {
        stepIndex: cand.stepIndex,
        taskId: cand.taskId,
        toolName: cand.toolName,
        toolSummary: toolSummary || commandLine || `Task #${cand.stepIndex}`,
        commandLine: commandLine || toolSummary || '',
        isDaemon,
        status,
        isRunning,
        startedAt,
        startedAtMs: startMs,
        completedAt,
        elapsedSec,
        logSizeBytes: logPreview.sizeBytes,
        lastLogLine:
          logPreview.tailLines.length > 0
            ? logPreview.tailLines[logPreview.tailLines.length - 1]
            : '',
      };
      if (!isRunning) {
        bgStepResolvedCache.set(cacheKey, item);
      }
      return item;
    })
  );

  // Sort: RUNNING first, then by stepIndex descending
  resolved.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.stepIndex - a.stepIndex;
  });

  // Return all running tasks + at most 1 recently finished task so tail stays compact
  const runningList = resolved.filter((t) => t.isRunning);
  const recentDone = resolved.filter((t) => !t.isRunning).slice(0, 1);
  return [...runningList, ...recentDone];
}

const FALLBACK_MODEL_CATALOG = {
  MODEL_PLACEHOLDER_M525: { modelId: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)', tier: 'High' },
  MODEL_PLACEHOLDER_M526: { modelId: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M527: { modelId: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M528: { modelId: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)', tier: 'XHigh' },
  MODEL_PLACEHOLDER_M427: { modelId: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)', tier: 'High' },
  MODEL_PLACEHOLDER_M437: { modelId: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M438: { modelId: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M417: { modelId: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', tier: 'High' },
  MODEL_PLACEHOLDER_M418: { modelId: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M419: { modelId: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M667: { modelId: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)', tier: 'Pro' },
  MODEL_PLACEHOLDER_M681: { modelId: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)', tier: 'Pro' },
  MODEL_PLACEHOLDER_M669: { modelId: 'gemini-flash-worker-agy', label: 'Gemini Flash', tier: 'Fast' },
  MODEL_PLACEHOLDER_M318: { modelId: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', tier: 'High' },
  MODEL_PLACEHOLDER_M319: { modelId: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M320: { modelId: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M400: { modelId: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M401: { modelId: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M402: { modelId: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', tier: 'High' },
  MODEL_PLACEHOLDER_M403: { modelId: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)', tier: 'Low' },
  MODEL_PLACEHOLDER_M404: { modelId: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', tier: 'Med' },
  MODEL_PLACEHOLDER_M405: { modelId: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)', tier: 'High' },
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: { modelId: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', tier: 'Med' },
  MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE: { modelId: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'Lite' },
};

function classifyRetryEntry(r) {
  if (!r || (!r.retryReason && !r.error && !r.waitTime)) return 'NONE';
  const reason = String(r.retryReason || '');
  const err = String(r.error || '');
  if (reason.includes('NON_RECOVERABLE') || /canceled by user|context canceled/i.test(err)) {
    return 'USER_CANCEL';
  }
  if (/429|resource_exhausted|rate.?limit|quota|too many requests|overloaded|529|capacity/i.test(err)) {
    return 'RATE_LIMIT';
  }
  if (
    /eof|wsasend|wsarecv|127\.0\.0\.1|connection.*closed|reset by peer|stream idle timeout|deadline exceeded|timeout|unreachable|broken pipe/i.test(
      err
    )
  ) {
    return 'NET_EOF';
  }
  return 'RATE_LIMIT';
}

function buildDiagSummaryTag(latestStep, summary, fpInfo) {
  const sigHex = summary?.sigKeyHex || '';
  const totalRateLimitRetries = summary?.totalRateLimitRetries || 0;
  const totalNetRetries = summary?.totalNetRetries || 0;
  const routeMismatch = Boolean(latestStep?.isRouteMismatch || (summary?.routeMismatchCount || 0) > 0);
  const fpChanged = fpInfo?.status === 'CHANGED';

  // Only actual 429 / capacity / quota retries count as rate-limiting.
  const isRateRetryNow = (latestStep?.rateLimitRetries || 0) > 0;
  const isNetRetryNow = (latestStep?.netRetries || 0) > 0;
  const isQueueNow = Boolean(latestStep && latestStep.pureQueueSec >= 15 && latestStep.ttftSec >= 20);
  const isSlowNow = Boolean(
    latestStep && !latestStep.isBufferedFlush && latestStep.streamingTps > 0 && latestStep.streamingTps < 20
  );

  const isCotLowNow = Boolean(latestStep?.isCotCollapsed);
  const isCacheShockNow = Boolean(latestStep?.isCacheShock);
  const isDegradeNow = routeMismatch || isCotLowNow || isCacheShockNow;

  const details = [];
  if (fpChanged) {
    details.push(`签名头变更: 基线 0x${fpInfo.baselineKeyHex} → 当前 0x${sigHex} (仅反映签名格式/密钥版本变化)`);
  } else if (sigHex) {
    details.push(`签名头: 0x${sigHex} (同系模型共用协议头，不区分具体型号)`);
  }
  if (routeMismatch) {
    details.push(`路由异常: 请求 ${latestStep?.requestedModelId} → 实跑 ${latestStep?.responseModel || latestStep?.exactModelId}`);
  }
  if (isRateRetryNow) {
    details.push(`本轮触发 429/限流重试 ${latestStep.rateLimitRetries}x (${latestStep.retryError || latestStep.retryReason})`);
  } else if (totalRateLimitRetries > 0) {
    details.push(`历史触发 429/限流重试 ${totalRateLimitRetries}x`);
  }
  if (isNetRetryNow) {
    details.push(`本轮网络/代理闪断重连 ${latestStep.netRetries}x (${latestStep.retryError})`);
  } else if (totalNetRetries > 0) {
    details.push(`历史网络/代理 EOF 重连 ${totalNetRetries}x (非官方限流)`);
  }
  if (isQueueNow) {
    details.push(`扣除预填充与思考估计后净延迟 ${latestStep.pureQueueSec}s (总 TTFT ${latestStep.ttftSec}s，未必是429限流)`);
  }
  if (isSlowNow) {
    details.push(`真实流式吐字偏慢 ${latestStep.streamingTps} tok/s`);
  }
  if (isCotLowNow) {
    details.push(`长输出思考链占比偏低 ${latestStep.thinkingRatioPct}% (均 ${summary?.avgThinkingRatioPct ?? 0}%)`);
  } else if (latestStep) {
    details.push(`思考链 ${latestStep.thinkingRatioPct}% (均 ${summary?.avgThinkingRatioPct ?? 0}%)`);
  }
  if (isCacheShockNow) {
    details.push(`长上下文缓存骤降至 ${latestStep.cacheHitRate}%`);
  }

  const tooltip = details.join(' · ') || '无异常重试';

  if (routeMismatch) {
    return {
      level: 'ALERT',
      code: 'ROUTE_DEGRADE',
      label: '🚨 路由不一致',
      detail: tooltip,
    };
  }
  if (fpChanged) {
    return {
      level: 'WARN',
      code: 'FP_CHANGED',
      label: '🔑 签名头变更',
      detail: tooltip,
    };
  }
  if (isRateRetryNow && isDegradeNow) {
    return {
      level: 'ALERT',
      code: 'BOTH_WARN',
      label: '🚨 限流重试+异常',
      detail: tooltip,
    };
  }
  if (isRateRetryNow) {
    return {
      level: 'WARN',
      code: 'THROTTLE_NOW',
      label: `⚠️ 限流重试${latestStep.rateLimitRetries}x`,
      detail: tooltip,
    };
  }
  if (isDegradeNow) {
    const sub = isCotLowNow ? `少思${latestStep.thinkingRatioPct}%` : '缓存击穿';
    return {
      level: 'WARN',
      code: 'DEGRADE_NOW',
      label: `⚠️ ${sub}`,
      detail: tooltip,
    };
  }
  if (isNetRetryNow) {
    return {
      level: 'INFO',
      code: 'NET_RETRY_NOW',
      label: `🌐 网络重连(${latestStep.netRetries}x)`,
      detail: tooltip,
    };
  }
  if (isQueueNow) {
    return {
      level: 'INFO',
      code: 'HIGH_TTFT',
      label: `⏳ 首字高延迟 ${Math.round(latestStep.ttftSec)}s`,
      detail: tooltip,
    };
  }
  if (isSlowNow) {
    return {
      level: 'INFO',
      code: 'SLOW_TPS',
      label: `🐢 偏慢 ${Math.round(latestStep.streamingTps)}`,
      detail: tooltip,
    };
  }
  if (totalRateLimitRetries > 0) {
    return {
      level: 'INFO',
      code: 'THROTTLE_HIST',
      label: `⚡ 曾限流(${totalRateLimitRetries}x)`,
      detail: tooltip,
    };
  }
  return {
    level: 'OK',
    code: 'HEALTHY',
    label: '✓ 正常',
    detail: tooltip,
  };
}

let cachedModelMap = null;
let cachedModelMapTime = 0;

async function getModelCatalogMap() {
  const now = Date.now();
  if (cachedModelMap && now - cachedModelMapTime < 3000) {
    return cachedModelMap;
  }
  const map = new Map();
  for (const [k, v] of Object.entries(FALLBACK_MODEL_CATALOG)) {
    map.set(k, { ...v, remainingFraction: null, resetTime: null, tagTitle: '' });
  }
  try {
    const data = await callLsRpc('GetCascadeModelConfigData', {});
    for (const item of data.clientModelConfigs || []) {
      const enumKey = item.modelOrAlias?.model || item.modelOrAlias?.alias || '';
      if (enumKey) {
        const fb = FALLBACK_MODEL_CATALOG[enumKey] || {};
        map.set(enumKey, {
          modelId: item.modelId || fb.modelId || enumKey,
          label: item.label || fb.label || enumKey,
          tier: fb.tier || '',
          remainingFraction: item.quotaInfo?.remainingFraction ?? null,
          resetTime: item.quotaInfo?.resetTime || null,
          tagTitle: item.tagTitle || '',
          tagDescription: item.tagDescription || '',
        });
      }
    }
    cachedModelMap = map;
    cachedModelMapTime = now;
  } catch {
    // fallback if RPC fails
  }
  return map;
}

let cachedQuotaGroups = null;
let cachedQuotaGroupsTime = 0;

async function getUserQuotaGroups() {
  const now = Date.now();
  if (cachedQuotaGroups && now - cachedQuotaGroupsTime < 3000) {
    return cloneQuotaGroups(cachedQuotaGroups);
  }
  const result = {};
  try {
    const res = await callLsRpc('RetrieveUserQuotaSummary', {});
    const groups = res?.response?.groups || res?.groups || [];
    for (const g of groups) {
      const name = String(g.displayName || '').toLowerCase();
      const key = name.includes('gemini') ? 'gemini' : '3p';
      const buckets = g.buckets || [];
      const b5h = buckets.find((b) => b.window === '5h' || String(b.bucketId || '').endsWith('5h'));
      const bWeekly = buckets.find(
        (b) => b.window === 'weekly' || String(b.bucketId || '').endsWith('weekly')
      );
      result[key] = {
        displayName: g.displayName || key,
        fiveHour: b5h
          ? {
              remainingFraction: b5h.remainingFraction ?? 0,
              resetTime: b5h.resetTime || null,
              disabled: Boolean(b5h.disabled),
            }
          : null,
        weekly: bWeekly
          ? {
              remainingFraction: bWeekly.remainingFraction ?? 0,
              resetTime: bWeekly.resetTime || null,
              disabled: Boolean(bWeekly.disabled),
            }
          : null,
      };
    }
    cachedQuotaGroups = result;
    cachedQuotaGroupsTime = now;
  } catch {
    // fallback if RetrieveUserQuotaSummary fails
  }
  return cloneQuotaGroups(cachedQuotaGroups || result);
}

function resolveQuotaForModel(modelLabelOrId, catalogEntry, quotaGroups) {
  const is3p = /claude|sonnet|opus|gpt/i.test(String(modelLabelOrId || ''));
  const group = quotaGroups?.[is3p ? '3p' : 'gemini'] || quotaGroups?.gemini || null;
  const fiveHour = group?.fiveHour || {
    remainingFraction: catalogEntry?.remainingFraction ?? null,
    resetTime: catalogEntry?.resetTime ?? null,
    disabled: false,
  };
  const weekly = group?.weekly || null;
  return {
    groupKey: is3p ? '3p' : 'gemini',
    groupName: group?.displayName || (is3p ? 'Claude & GPT' : 'Gemini Models'),
    fiveHour,
    weekly,
  };
}

function getSelectedModelFromState() {
  try {
    const stateFile = join(AGY_DIR, 'antigravity_state.pbtxt');
    if (!existsSync(stateFile)) return '';
    const content = readFileSync(stateFile, 'utf-8');
    const m = content.match(/last_selected_agent_model:\s*([A-Za-z0-9_]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function readLiveHookState() {
  try {
    if (!existsSync(LIVE_STATE_FILE)) return null;
    return JSON.parse(readFileSync(LIVE_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

const trajectoryMetaCache = new Map();

async function getParsedConversationSteps(
  convId,
  stepHint,
  mtimeMs,
  modelCatalog,
  selectedModelEnum,
  quotaGroups
) {
  const now = Date.now();
  const isRecentlyActive = now - mtimeMs < 15000;
  const cacheTtlMs = isRecentlyActive ? 4000 : 120000;
  const cached = trajectoryMetaCache.get(convId);
  if (
    cached &&
    cached.stepCount === stepHint &&
    Math.abs(cached.mtimeMs - mtimeMs) < 500 &&
    now - cached.fetchedAt < cacheTtlMs
  ) {
    return cached;
  }

  let steps = [];
  let latestSigInfo = null;
  let latestStopReason = '';
  try {
    const genRes = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId: convId,
    });
    const rawList = genRes.generatorMetadata || [];

    // Fetch cryptographic thinkingSignature from the latest planner/tool steps in LS (cached per stepIdx)
    if (rawList.length > 0) {
      const lastEntry = rawList[rawList.length - 1];
      const stepIndices = lastEntry.stepIndices || [];
      const targetStepIdx = stepIndices.length > 0 ? stepIndices[0] : null;
      if (targetStepIdx !== null) {
        const sigCacheKey = `${convId}:${targetStepIdx}`;
        const cachedSig = sigStepCache.get(sigCacheKey);
        if (cachedSig && cachedSig.sigInfo) {
          latestSigInfo = cachedSig.sigInfo;
          latestStopReason = cachedSig.stopReason || '';
        } else {
          try {
            const stepRes = await callLsRpc('GetCascadeTrajectorySteps', {
              cascadeId: convId,
              stepOffset: Math.max(0, targetStepIdx - 12),
            });
            const stepList = Array.isArray(stepRes.steps) ? stepRes.steps : [];
            for (let sIdx = stepList.length - 1; sIdx >= 0; sIdx--) {
              const st = stepList[sIdx];
              if (!latestStopReason && st?.plannerResponse?.stopReason) {
                latestStopReason = String(st.plannerResponse.stopReason).replace('STOP_REASON_', '');
              }
              if (!latestSigInfo) {
                const sigB64 =
                  st?.plannerResponse?.thinkingSignature ||
                  st?.metadata?.toolCall?.thinkingSignature ||
                  '';
                if (sigB64) {
                  latestSigInfo = decodeThinkingSignatureFingerprint(sigB64);
                }
              }
              if (latestSigInfo && latestStopReason) break;
            }
            if (!latestSigInfo && sigStepCache.has(`${convId}:lastKnown`)) {
              latestSigInfo = sigStepCache.get(`${convId}:lastKnown`).sigInfo;
            }
            if (latestSigInfo) {
              const sigRecord = {
                sigInfo: latestSigInfo,
                stopReason: latestStopReason,
              };
              sigStepCache.set(sigCacheKey, sigRecord);
              sigStepCache.set(`${convId}:lastKnown`, sigRecord);
            }
          } catch {
            // ignore if step fetch fails
          }
        }
      }
    }

    steps = rawList.map((entry, idx) => {
      const cm = entry.chatModel || {};
      const usage = cm.usage || {};
      const requestedEnum = cm.model || selectedModelEnum || 'UNKNOWN';
      const billedEnum = usage.model || cm.model || selectedModelEnum || 'UNKNOWN';
      const reqCatalog = modelCatalog.get(requestedEnum);
      const billedCatalog = modelCatalog.get(billedEnum);

      const responseModel = cm.responseModel || '';
      const exactModelId =
        cm.modelName ||
        billedCatalog?.modelId ||
        reqCatalog?.modelId ||
        responseModel ||
        billedEnum;
      const requestedModelId = reqCatalog?.modelId || requestedEnum;
      const modelLabel =
        cm.modelDisplayName || billedCatalog?.label || reqCatalog?.label || responseModel || billedEnum;
      const modelTier = billedCatalog?.tier || reqCatalog?.tier || '';
      const modelDescription = billedCatalog?.tagDescription || reqCatalog?.tagDescription || '';
      const execEnum = entry.plannerConfig?.planExecuteConfig?.executionModel || entry.planExecuteConfig?.executionModel || '';
      const execCatalog = execEnum ? modelCatalog.get(execEnum) : null;
      const execModelId = execCatalog?.modelId || execEnum || '';
      const execModelLabel = execCatalog?.label || execModelId;
      const isRouteMismatch = Boolean(
        (cm.model && usage.model && cm.model !== usage.model) ||
          isResponseModelMismatched(requestedModelId, responseModel)
      );

      const apiProvider = (usage.apiProvider || '').replace('API_PROVIDER_', '') || 'UNKNOWN';
      const sessionID = usage.responseHeader?.sessionID || '';
      const responseId = usage.responseId || '';
      const messageId = usage.messageId || '';

      const retryInfos = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
      let rateLimitRetries = 0;
      let netRetries = 0;
      for (const r of retryInfos) {
        const kind = classifyRetryEntry(r);
        if (kind === 'RATE_LIMIT') rateLimitRetries++;
        else if (kind === 'NET_EOF') netRetries++;
      }
      const retries = rateLimitRetries + netRetries;
      const failedRetry = retryInfos.find((r) => {
        const k = classifyRetryEntry(r);
        return k === 'RATE_LIMIT' || k === 'NET_EOF';
      });
      const retryReason = (failedRetry?.retryReason || '').replace('RETRY_REASON_', '');
      const retryWaitSec = parseDurationSec(failedRetry?.waitTime || '');
      const retryError = failedRetry?.error || '';
      const traceId = retryInfos[retryInfos.length - 1]?.traceId || '';

      const inputTokens = parseInt(usage.inputTokens || '0', 10);
      const outputTokens = parseInt(usage.outputTokens || '0', 10);
      const thinkingTokens = parseInt(usage.thinkingOutputTokens || '0', 10);
      const responseTokens = parseInt(usage.responseOutputTokens || '0', 10);
      const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10);
      const thinkingRatioPct =
        outputTokens > 0 ? +((thinkingTokens / outputTokens) * 100).toFixed(1) : 0;

      const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || {};
      const contextUsed = ctxMeta.estimatedTokensUsed || inputTokens + cacheReadTokens;
      const maxContext = ctxMeta.maxContextTokens || 256000;
      const totalPromptTokens = inputTokens + cacheReadTokens;
      const cacheHitRate =
        totalPromptTokens > 0 ? +((cacheReadTokens / totalPromptTokens) * 100).toFixed(1) : 0;

      const ttftSec = parseDurationSec(cm.timeToFirstToken);
      const streamSec = parseDurationSec(cm.streamingDuration);
      const totalSec = ttftSec + streamSec;

      // Subtract estimated prefill + unstreamed thinking time from TTFT before flagging high wait.
      const expectedPrefillCeilingSec =
        4.0 + inputTokens / 6000 + cacheReadTokens / 25000 + thinkingTokens / 45;
      const pureQueueSec = +Math.max(0, ttftSec - expectedPrefillCeilingSec).toFixed(2);

      const effectiveTps = totalSec > 0.05 ? +(outputTokens / totalSec).toFixed(1) : 0;
      const isBufferedFlush =
        outputTokens > 0 &&
        (streamSec < 1.0 || (streamSec < 2.5 && outputTokens / Math.max(streamSec, 0.05) > 320));
      const activeGenSec = !isBufferedFlush ? streamSec : 0;
      const streamingTps =
        !isBufferedFlush && outputTokens > 0 && streamSec > 0
          ? +(outputTokens / streamSec).toFixed(1)
          : 0;

      const resolvedQuota = resolveQuotaForModel(
        `${modelLabel} ${exactModelId} ${responseModel}`,
        billedCatalog || reqCatalog,
        quotaGroups
      );

      return {
        turnNumber: idx + 1,
        stepIndices: entry.stepIndices || [],
        requestedEnum,
        modelEnum: billedEnum,
        requestedModelId,
        exactModelId,
        modelLabel,
        modelTier,
        modelDescription,
        execModelId,
        execModelLabel,
        responseModel: responseModel || exactModelId || 'N/A',
        isRouteMismatch,
        apiProvider,
        sessionID,
        responseId,
        messageId,
        traceId,
        retries,
        rateLimitRetries,
        netRetries,
        retryReason,
        retryWaitSec,
        retryError,
        quotaRemainingFraction:
          resolvedQuota.fiveHour?.remainingFraction ??
          billedCatalog?.remainingFraction ??
          null,
        quotaResetTime: resolvedQuota.fiveHour?.resetTime ?? billedCatalog?.resetTime ?? null,
        quotaWeeklyRemainingFraction: resolvedQuota.weekly?.remainingFraction ?? null,
        quotaWeeklyResetTime: resolvedQuota.weekly?.resetTime ?? null,
        inputTokens,
        outputTokens,
        thinkingTokens,
        responseTokens,
        thinkingRatioPct,
        cacheReadTokens,
        ttftSec: +ttftSec.toFixed(2),
        pureQueueSec,
        streamSec: +streamSec.toFixed(2),
        activeGenSec: +activeGenSec.toFixed(2),
        totalSec: +totalSec.toFixed(2),
        isBufferedFlush,
        streamingTps,
        effectiveTps,
        contextUsed,
        maxContext,
        cacheHitRate,
      };
    });
  } catch {
    // ignore if trajectory has no generator metadata
  }

  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalSubstantiveTokens = 0;
  let totalSubstantiveGenSec = 0;
  let totalAllGenSec = 0;
  let totalE2ESec = 0;
  let peakStreamingTps = 0;
  let peakEffectiveTps = 0;
  let totalRetries = 0;
  let totalRateLimitRetries = 0;
  let totalNetRetries = 0;
  let routeMismatchCount = 0;
  let lastSubstantiveStep = null;
  let knownExecModelId = '';
  let knownExecModelLabel = '';
  const sessionIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.execModelId) {
      knownExecModelId = s.execModelId;
      knownExecModelLabel = s.execModelLabel || s.execModelId;
    } else if (knownExecModelId) {
      s.execModelId = knownExecModelId;
      s.execModelLabel = knownExecModelLabel;
    }
    totalOutputTokens += s.outputTokens;
    totalThinkingTokens += s.thinkingTokens;
    totalE2ESec += s.totalSec;
    totalAllGenSec += s.activeGenSec;
    totalRetries += s.retries || 0;
    totalRateLimitRetries += s.rateLimitRetries || 0;
    totalNetRetries += s.netRetries || 0;
    if (s.isRouteMismatch) routeMismatchCount++;
    if (s.sessionID) sessionIds.add(s.sessionID);

    // Check cache shock compared to previous step
    const prev = i > 0 ? steps[i - 1] : null;
    const isAnthropicStep =
      String(s.apiProvider || '').includes('ANTHROPIC') ||
      String(s.exactModelId || '').includes('claude');
    s.isCacheShock = Boolean(
      prev && s.contextUsed > 30000 && prev.cacheHitRate >= 70 && s.cacheHitRate < 15
    );
    s.isCotCollapsed = Boolean(
      !isAnthropicStep && s.outputTokens >= 220 && s.thinkingRatioPct < 4
    );
    s.isThrottledStep = Boolean(s.rateLimitRetries > 0);

    if (!s.isBufferedFlush && s.streamingTps > 0) {
      totalSubstantiveTokens += s.outputTokens;
      totalSubstantiveGenSec += s.activeGenSec;
      lastSubstantiveStep = s;
      if (s.streamingTps > peakStreamingTps) peakStreamingTps = s.streamingTps;
    }
    if (s.effectiveTps > peakEffectiveTps) peakEffectiveTps = s.effectiveTps;
  }

  const avgEffectiveTps = totalE2ESec > 0.05 ? +(totalOutputTokens / totalE2ESec).toFixed(1) : 0;
  const avgStreamingTps =
    totalSubstantiveGenSec > 0.5
      ? +(totalSubstantiveTokens / totalSubstantiveGenSec).toFixed(1)
      : 0;
  const avgThinkingRatioPct =
    totalOutputTokens > 0 ? +((totalThinkingTokens / totalOutputTokens) * 100).toFixed(1) : 0;

  const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
  if (latestStep) {
    latestStep.sigKeyHex = latestSigInfo?.keyHex || '';
    latestStep.sigBytes = latestSigInfo?.byteLen || 0;
    latestStep.stopReason = latestStopReason || 'STOP_PATTERN';
    if (latestStep.isCotCollapsed && avgThinkingRatioPct >= 15 && steps.length > 2) {
      // Do not false-alarm on a post-tool final summary turn when session CoT average is healthy
      latestStep.isCotCollapsed = false;
    }
  }

  const headlineStreamingTps = lastSubstantiveStep?.streamingTps || avgStreamingTps || 0;

  // Build health diagnostics for latest step + conversation
  const healthBadges = [];
  let healthLevel = 'OK'; // OK | WARN | ALERT
  if (latestStep) {
    if (latestStep.isRouteMismatch || routeMismatchCount > 0) {
      healthLevel = 'ALERT';
      healthBadges.push({
        type: 'DEGRADE',
        label: '路由不一致',
        detail: `请求 ${latestStep.requestedModelId} 后端返回 ${latestStep.responseModel || latestStep.exactModelId}`,
      });
    }
    if (latestStep.rateLimitRetries > 0) {
      if (healthLevel !== 'ALERT') healthLevel = 'WARN';
      healthBadges.push({
        type: 'THROTTLE',
        label: `本轮限流重试 ${latestStep.rateLimitRetries}x`,
        detail: `触发上游 429/过载重试 (${latestStep.retryError || latestStep.retryReason}, 等待 ${latestStep.retryWaitSec}s)`,
      });
    } else if (totalRateLimitRetries > 0) {
      healthBadges.push({
        type: 'THROTTLE_HIST',
        label: `历史限流 ${totalRateLimitRetries}x`,
        detail: `该会话历史发生过 ${totalRateLimitRetries} 次上游 429/过载重试`,
      });
    }
    if (latestStep.netRetries > 0) {
      healthBadges.push({
        type: 'NET_RETRY',
        label: `本轮网络重连 ${latestStep.netRetries}x`,
        detail: `本地代理/网络闪断重连: ${latestStep.retryError}`,
      });
    } else if (totalNetRetries > 0) {
      healthBadges.push({
        type: 'NET_HIST',
        label: `历史网络重连 ${totalNetRetries}x`,
        detail: `该会话历史发生过 ${totalNetRetries} 次代理/网络 EOF 重连 (非官方限流)`,
      });
    }
    if (latestStep.pureQueueSec >= 15 && latestStep.ttftSec >= 20) {
      healthBadges.push({
        type: 'QUEUE',
        label: `首字高延迟 ${latestStep.ttftSec}s`,
        detail: `扣除预填充与思考估计后净延迟约 ${latestStep.pureQueueSec}s (总 TTFT ${latestStep.ttftSec}s，未必是限流)`,
      });
    }
    if (!latestStep.isBufferedFlush && latestStep.streamingTps > 0 && latestStep.streamingTps < 20) {
      healthBadges.push({
        type: 'SLOW_TPS',
        label: `吐字偏慢 ${latestStep.streamingTps}`,
        detail: `真实流式吐字 ${latestStep.streamingTps} tok/s (均速 ${avgStreamingTps})`,
      });
    }
    if (latestStep.isCotCollapsed) {
      if (healthLevel !== 'ALERT') healthLevel = 'WARN';
      healthBadges.push({
        type: 'COT_LOW',
        label: `思考偏低 ${latestStep.thinkingRatioPct}%`,
        detail: `本轮输出 ${latestStep.outputTokens} tok 中思考链仅占 ${latestStep.thinkingRatioPct}%`,
      });
    }
    if (latestStep.isCacheShock) {
      if (healthLevel !== 'ALERT') healthLevel = 'WARN';
      healthBadges.push({
        type: 'CACHE_SHOCK',
        label: '缓存击穿',
        detail: `长上下文 (${Math.round(latestStep.contextUsed / 1000)}k) 缓存命中骤降至 ${latestStep.cacheHitRate}%`,
      });
    }
  }

  const entry = {
    stepCount: stepHint,
    mtimeMs,
    fetchedAt: Date.now(),
    steps,
    summary: {
      totalInvocations: steps.length,
      totalOutputTokens,
      totalThinkingTokens,
      avgThinkingRatioPct,
      totalRetries,
      totalRateLimitRetries,
      totalNetRetries,
      routeMismatchCount,
      sessionDriftCount: Math.max(0, sessionIds.size - 1),
      headlineStreamingTps,
      avgStreamingTps,
      avgEffectiveTps,
      peakStreamingTps,
      peakEffectiveTps,
      sigKeyHex: latestSigInfo?.keyHex || '',
      sigBytes: latestSigInfo?.byteLen || 0,
      stopReason: latestStopReason || '',
      healthLevel,
      healthBadges,
    },
  };
  trajectoryMetaCache.set(convId, entry);
  return entry;
}

function resolveTaskWorkingState(convId, lsStatus, transcriptInfo, hookState, nowMs) {
  const isEngineRunning = lsStatus === 'CASCADE_RUN_STATUS_RUNNING';

  // 1. Check live hook state first (tighten fallback window if LS already reports IDLE)
  const hookMaxAgeMs = isEngineRunning ? 90000 : 12000;
  if (hookState && hookState.conversationId === convId && nowMs - hookState.timestampMs < hookMaxAgeMs) {
    if (hookState.eventType === 'PreInvocation') {
      const elapsed = ((nowMs - hookState.timestampMs) / 1000).toFixed(1);
      return {
        stateCode: 'THINKING',
        stateLabel: '推理思考中',
        stateDetail: `模型正在推理 (${elapsed}s)`,
        isRunning: true,
      };
    }
  }

  // 2. Check LS status + transcript tail
  if (isEngineRunning) {
    if (transcriptInfo) {
      if (transcriptInfo.lastStepType === 'USER_INPUT') {
        return {
          stateCode: 'THINKING',
          stateLabel: '首字思考中',
          stateDetail: '正在处理输入并生成首字响应 (Prefill / Thinking)...',
          isRunning: true,
        };
      }
      if (transcriptInfo.lastStepType === 'PLANNER_RESPONSE' && transcriptInfo.lastToolCalls.length > 0) {
        const tc = transcriptInfo.lastToolCalls[0];
        const detail = tc.summary ? `${tc.name}: ${tc.summary}` : tc.name;
        return {
          stateCode: 'TOOL_RUNNING',
          stateLabel: `执行工具: ${tc.name}`,
          stateDetail: detail,
          isRunning: true,
        };
      }
      return {
        stateCode: 'RUNNING',
        stateLabel: '运行中',
        stateDetail: `正在执行步骤 (#${transcriptInfo.totalSteps})`,
        isRunning: true,
      };
    }
    return {
      stateCode: 'RUNNING',
      stateLabel: '运行中',
      stateDetail: 'Agent 正在活跃运行',
      isRunning: true,
    };
  }

  // 3. Fallback if transcript was modified very recently (<12s)
  if (transcriptInfo && nowMs - transcriptInfo.mtimeMs < 12000) {
    if (transcriptInfo.lastStepType === 'PLANNER_RESPONSE' && transcriptInfo.lastToolCalls.length > 0) {
      const tc = transcriptInfo.lastToolCalls[0];
      return {
        stateCode: 'TOOL_RUNNING',
        stateLabel: `执行工具: ${tc.name}`,
        stateDetail: tc.summary || tc.name,
        isRunning: true,
      };
    }
  }

  return {
    stateCode: 'IDLE',
    stateLabel: '空闲就绪',
    stateDetail: '等待指令 / 回合完成',
    isRunning: false,
  };
}

// ============================================================================
// OPENAI CODEX DESKTOP / CLI LIVE TELEMETRY & PROGRESS ENGINE
// ============================================================================

const codexRolloutCache = new Map();

function cleanCodexCommandText(cmdArrOrStr) {
  if (Array.isArray(cmdArrOrStr)) {
    const last = cmdArrOrStr[cmdArrOrStr.length - 1] || '';
    return String(last).replace(/\s+/g, ' ').trim().slice(0, 150);
  }
  const s = String(cmdArrOrStr || '');
  const cmdMatch = s.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/);
  if (cmdMatch) {
    return cmdMatch[1]
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
  }
  if (s.includes('apply_patch')) {
    const files = [
      ...s.matchAll(/\*\*\* (?:Add|Update|Delete) File:\s*([^\r\n\\"]+)/g),
    ].map((x) => basename(x[1].trim()));
    return files.length > 0 ? `apply_patch (${files.join(', ')})` : 'apply_patch (修改文件)';
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function fmtClockTime(tsMs) {
  if (!tsMs) return '';
  const d = new Date(tsMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function extractTargetWorkdirFromText(txt) {
  if (!txt) return '';
  const s = String(txt);
  const m = s.match(/本次任务的实际目标工作目录为\s*`([^`]+)`/);
  if (m) return m[1].trim();
  const wsMatch = s.match(/`((?:[a-zA-Z]:[\\/]|\/)[^`\r\n]+)`/);
  return wsMatch ? wsMatch[1].trim() : '';
}

function stripSystemPromptHeader(txt) {
  if (!txt) return '';
  return String(txt)
    .replace(/^\[系统(?:工作区与)?自主执行指令[\s\S]*?\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCodexRolloutCached(rawRolloutPath, threadId, defaultModel, defaultEffort) {
  if (!rawRolloutPath) return null;
  const cleanPath = String(rawRolloutPath).replace(/^\\\\\?\\/, '');
  if (!existsSync(cleanPath)) return null;

  try {
    const fd = openSync(cleanPath, 'r');
    let st;
    let buf;
    try {
      st = fstatSync(fd);
      const cached = codexRolloutCache.get(cleanPath);
      if (
        cached &&
        cached.fileSize === st.size &&
        Date.now() - cached.parsedAtMs < (cached.result?.hasUnclosedTurn ? 1200 : 15000)
      ) {
        return cached.result;
      }
      const maxReadBytes = 1572864; // 1.5 MB tail is plenty for full turn history & speed
      const readLen = Math.min(st.size, maxReadBytes);
      buf = Buffer.allocUnsafe(readLen);
      readSync(fd, buf, 0, readLen, st.size - readLen);
    } finally {
      closeSync(fd);
    }

    const rawText = buf.toString('utf8');
    const lines = rawText.split('\n');
    // If we sliced into the middle of the file, drop the partial first line
    if (st.size > 1572864 && lines.length > 1) {
      lines.shift();
    }

    let curModel = defaultModel || 'gpt-6.1-sol';
    let curEffort = defaultEffort || 'medium';
    let targetWorkdir = '';
    let turnCount = 0;
    let activeTurnId = null;
    let turnStartedAtMs = 0;
    let turnCompletedAtMs = 0;
    let lastTurnDurationSec = 0;
    let lastRecordMs = st.mtimeMs || 0;

    let stepCountInTurn = 0;
    let cmdCountInTurn = 0;
    let fileCountInTurn = 0;
    let latestCommentary = '';
    let currentAction = '';
    let pendingTool = '';
    let lastEventKind = 'IDLE';
    const recentActions = [];

    // Per-invocation speed & token tracking
    let reqStartMs = null;
    let firstGenMs = null;
    let lastGenMs = null;
    let nextReqStartMs = null;
    let prevTotalOutTokens = -1;
    let latestResponseId = '';
    let latestRateLimits = null;
    let latestRateLimitsMs = 0;
    let compactionCount = 0;
    let streamErrorCount = 0;
    let rateLimitErrorCount = 0;
    let lastErrorText = '';
    const steps = [];
    const codexTurns = [];
    let activeTurnObj = null;
    let pendingUserPrompt = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const tsMs = Date.parse(obj.timestamp) || 0;
      if (tsMs > lastRecordMs) lastRecordMs = tsMs;
      const p = obj.payload || {};

      if (obj.type === 'session_meta') {
        if (p.target_workdir) targetWorkdir = p.target_workdir;
      } else if (obj.type === 'turn_context') {
        if (p.model) curModel = p.model;
        if (p.effort) curEffort = p.effort;
        if (!reqStartMs && tsMs) reqStartMs = tsMs;
      } else if (obj.type === 'compacted') {
        compactionCount++;
      } else if (obj.type === 'token_usage_record') {
        if (p.response_id) latestResponseId = p.response_id;
        if (tsMs) lastGenMs = tsMs;
      } else if (obj.type === 'response_item') {
        const pType = p.type || '';
        if (pType === 'reasoning') {
          lastEventKind = 'REASONING';
          if (!firstGenMs && tsMs) firstGenMs = tsMs;
          if (tsMs) lastGenMs = tsMs;
        } else if (pType === 'message' && p.role === 'user') {
          const uTxt = (p.content || []).map((c) => c.text || '').join(' ');
          const wd = extractTargetWorkdirFromText(uTxt);
          if (wd) targetWorkdir = wd;
          const cleanPrompt = extractUserPromptPreview(stripSystemPromptHeader(uTxt));
          if (cleanPrompt) {
            pendingUserPrompt = cleanPrompt;
            if (activeTurnObj && !activeTurnObj.promptPreview) {
              activeTurnObj.promptPreview = cleanPrompt;
            }
          }
        } else if (pType === 'message' && p.role === 'assistant') {
          lastEventKind = 'AGENT_MSG';
          if (!firstGenMs && tsMs) firstGenMs = tsMs;
          if (tsMs) lastGenMs = tsMs;
        } else if (pType === 'custom_tool_call' || pType === 'function_call') {
          lastEventKind = 'TOOL_CALL';
          if (!firstGenMs && tsMs) firstGenMs = tsMs;
          if (tsMs) lastGenMs = tsMs;
          const toolName = p.name || 'tool';
          const summary = cleanCodexCommandText(p.input || p.arguments || toolName);
          pendingTool = toolName === 'exec' ? summary : `${toolName}: ${summary}`;
          currentAction = `⚡ 正在执行: ${pendingTool}`;
        } else if (
          pType === 'custom_tool_call_output' ||
          pType === 'function_call_output' ||
          pType === 'local_shell_call_output'
        ) {
          if (typeof p.output === 'string' && p.output.includes('本次任务的实际目标工作目录为')) {
            const wd = extractTargetWorkdirFromText(p.output);
            if (wd) targetWorkdir = wd;
          }
          pendingTool = '';
          if (tsMs) nextReqStartMs = tsMs;
        }
      } else if (obj.type === 'event_msg') {
        const evType = p.type || '';
        if (evType === 'thread_settings_applied') {
          const s = p.thread_settings || {};
          if (s.model) curModel = s.model;
          if (s.reasoning_effort) curEffort = s.reasoning_effort;
        } else if (evType === 'task_started') {
          turnCount++;
          activeTurnId = p.turn_id || `turn-${turnCount}`;
          turnStartedAtMs = tsMs;
          turnCompletedAtMs = 0;
          stepCountInTurn = 0;
          cmdCountInTurn = 0;
          fileCountInTurn = 0;
          pendingTool = '';
          currentAction = '';
          lastEventKind = 'REASONING';
          reqStartMs = tsMs;
          firstGenMs = null;
          lastGenMs = null;
          nextReqStartMs = null;
          activeTurnObj = {
            turnIndex: turnCount,
            turnId: activeTurnId,
            promptPreview: pendingUserPrompt || '',
            startedAtMs: tsMs,
            completedAtMs: 0,
            isAborted: false,
          };
          pendingUserPrompt = '';
          codexTurns.push(activeTurnObj);
        } else if (evType === 'task_complete' || evType === 'turn_aborted') {
          if (activeTurnObj) {
            activeTurnObj.completedAtMs = tsMs;
            activeTurnObj.isAborted = evType === 'turn_aborted';
            activeTurnObj = null;
          }
          activeTurnId = null;
          turnCompletedAtMs = tsMs;
          pendingTool = '';
          currentAction = '';
          lastEventKind = 'IDLE';
          if (p.duration_ms) {
            lastTurnDurationSec = Math.round(p.duration_ms / 1000);
          } else if (turnStartedAtMs && tsMs > turnStartedAtMs) {
            lastTurnDurationSec = Math.round((tsMs - turnStartedAtMs) / 1000);
          }
          if (p.last_agent_message) {
            latestCommentary = String(p.last_agent_message).replace(/\s+/g, ' ').trim();
          }
          recentActions.push({
            tsMs,
            timeStr: fmtClockTime(tsMs),
            kind: evType === 'turn_aborted' ? 'ABORT' : 'DONE',
            icon: evType === 'turn_aborted' ? '🛑' : '✅',
            summary:
              evType === 'turn_aborted'
                ? '回合已中止'
                : `回合完成 (耗时 ${lastTurnDurationSec}s)`,
          });
        } else if (evType === 'error' || evType === 'stream_error') {
          const msg = `${JSON.stringify(p.codex_error_info || {})} ${p.message || ''}`;
          lastErrorText = p.message || String(p.codex_error_info || '');
          if (/429|rate_limit|quota|overloaded|capacity/i.test(msg)) {
            rateLimitErrorCount++;
          } else {
            streamErrorCount++;
          }
        } else if (evType === 'item_completed' && p.item) {
          const it = p.item;
          const isLlmOutputItem = it.type === 'AgentMessage' || it.type === 'Reasoning';
          if (
            isLlmOutputItem &&
            Number.isFinite(p.started_at_ms) &&
            Number.isFinite(p.completed_at_ms) &&
            p.completed_at_ms >= p.started_at_ms
          ) {
            if (!firstGenMs || p.started_at_ms < firstGenMs) firstGenMs = p.started_at_ms;
            if (!lastGenMs || p.completed_at_ms > lastGenMs) lastGenMs = p.completed_at_ms;
          }

          if (it.type === 'AgentMessage') {
            const txt = (it.content || [])
              .map((c) => c.text || '')
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (txt) {
              latestCommentary = txt;
              stepCountInTurn++;
              recentActions.push({
                tsMs,
                timeStr: fmtClockTime(tsMs),
                kind: 'COMMENTARY',
                icon: '💬',
                summary: txt.slice(0, 220),
              });
            }
          } else if (it.type === 'CommandExecution') {
            cmdCountInTurn++;
            stepCountInTurn++;
            pendingTool = '';
            lastEventKind = 'CMD_DONE';
            const cStr = cleanCodexCommandText(it.command);
            currentAction = `💻 ${cStr}`;
            recentActions.push({
              tsMs,
              timeStr: fmtClockTime(tsMs),
              kind: 'CMD',
              icon: '💻',
              summary: cStr,
            });
          } else if (it.type === 'FileChange') {
            fileCountInTurn++;
            stepCountInTurn++;
            pendingTool = '';
            lastEventKind = 'FILE_DONE';
            const files = Object.keys(it.changes || {}).map((f) => basename(f));
            const fStr = `变更文件: ${files.join(', ')}`;
            currentAction = `📝 ${fStr}`;
            recentActions.push({
              tsMs,
              timeStr: fmtClockTime(tsMs),
              kind: 'FILE',
              icon: '📝',
              summary: fStr,
            });
          } else if (it.type === 'Extension' || it.type === 'McpToolCall') {
            stepCountInTurn++;
            pendingTool = '';
            const label = it.query ? `搜索: ${it.query}` : `${it.kind || it.type}`;
            currentAction = `🔍 ${label}`;
            recentActions.push({
              tsMs,
              timeStr: fmtClockTime(tsMs),
              kind: 'TOOL',
              icon: '🔍',
              summary: label,
            });
          } else if (it.type === 'Reasoning') {
            stepCountInTurn++;
            lastEventKind = 'REASONING';
          }
        } else if (evType === 'token_count' && p.info) {
          if (p.rate_limits) {
            latestRateLimits = p.rate_limits;
            if (tsMs > latestRateLimitsMs) latestRateLimitsMs = tsMs;
          }
          const last = p.info.last_token_usage || {};
          const total = p.info.total_token_usage || {};
          const maxContext = p.info.model_context_window || 258400;
          const totalOut = total.output_tokens ?? 0;

          if (totalOut !== prevTotalOutTokens && (last.output_tokens || 0) > 0) {
            prevTotalOutTokens = totalOut;
            const outTok = last.output_tokens || 0;
            const thinkTok = last.reasoning_output_tokens || 0;
            const respTok = Math.max(0, outTok - thinkTok);
            const inTok = last.input_tokens || 0;
            const cacheTok = last.cached_input_tokens || 0;
            const ctxUsed = last.total_tokens || inTok + outTok;
            const cacheHitRate = inTok > 0 ? +((cacheTok / inTok) * 100).toFixed(1) : 0;
            const thinkingRatioPct = outTok > 0 ? +((thinkTok / outTok) * 100).toFixed(1) : 0;

            const endMs = lastGenMs || tsMs;
            const startMs = reqStartMs && endMs > reqStartMs ? reqStartMs : endMs - 2500;
            const e2eSec = Math.max(0.3, (endMs - startMs) / 1000);
            const streamSec =
              firstGenMs && firstGenMs >= startMs && endMs > firstGenMs
                ? Math.max(0.25, (endMs - firstGenMs) / 1000)
                : Math.max(0.25, e2eSec * 0.68);
            const ttftSec = Math.max(0.1, +(e2eSec - streamSec).toFixed(2));
            const effectiveTps = +(outTok / e2eSec).toFixed(1);
            const streamingTps = +(outTok / streamSec).toFixed(1);

            const exactModelId = curEffort ? `${curModel}-${curEffort}` : curModel;
            const sigKeyHex = '';

            steps.push({
              turnNumber: steps.length + 1,
              userTurnIndex: Math.max(1, turnCount),
              stepIndices: [steps.length + 1],
              requestedEnum: exactModelId,
              modelEnum: exactModelId,
              requestedModelId: exactModelId,
              exactModelId,
              modelLabel: `Codex ${curModel} (${curEffort || 'med'})`,
              modelTier: curEffort || 'med',
              responseModel: curModel,
              isRouteMismatch: false,
              apiProvider: 'OPENAI_CODEX',
              sessionID: threadId,
              responseId: latestResponseId,
              messageId: '',
              traceId: latestResponseId.slice(0, 18),
              retries: 0,
              rateLimitRetries: 0,
              netRetries: 0,
              retryReason: '',
              retryWaitSec: 0,
              retryError: '',
              sigKeyHex,
              sigBytes: sigKeyHex ? 20 : 0,
              inputTokens: Math.max(0, inTok - cacheTok),
              outputTokens: outTok,
              thinkingTokens: thinkTok,
              responseTokens: respTok,
              thinkingRatioPct,
              cacheReadTokens: cacheTok,
              ttftSec,
              pureQueueSec: 0,
              streamSec: +streamSec.toFixed(2),
              activeGenSec: +streamSec.toFixed(2),
              totalSec: +e2eSec.toFixed(2),
              isBufferedFlush: outTok < 60,
              streamingTps,
              effectiveTps,
              contextUsed: ctxUsed,
              maxContext,
              cacheHitRate,
            });

            reqStartMs = nextReqStartMs || tsMs;
            firstGenMs = null;
            lastGenMs = null;
            nextReqStartMs = null;
          }
        }
      }
    }

    // Aggregate summary across steps
    let totalOutputTokens = 0;
    let totalThinkingTokens = 0;
    let totalSubstantiveTokens = 0;
    let totalSubstantiveGenSec = 0;
    let totalAllGenSec = 0;
    let totalE2ESec = 0;
    let peakStreamingTps = 0;
    let peakEffectiveTps = 0;
    let lastSubstantiveStep = null;

    for (const s of steps) {
      totalOutputTokens += s.outputTokens;
      totalThinkingTokens += s.thinkingTokens;
      totalAllGenSec += s.activeGenSec;
      totalE2ESec += s.totalSec;
      if (!s.isBufferedFlush) {
        totalSubstantiveTokens += s.outputTokens;
        totalSubstantiveGenSec += s.activeGenSec;
        lastSubstantiveStep = s;
        if (s.streamingTps > peakStreamingTps) peakStreamingTps = s.streamingTps;
      }
      if (s.effectiveTps > peakEffectiveTps) peakEffectiveTps = s.effectiveTps;
    }
    if (peakStreamingTps === 0 && steps.length > 0) {
      peakStreamingTps = Math.max(...steps.map((s) => s.streamingTps));
    }

    const avgEffectiveTps = totalE2ESec > 0.05 ? +(totalOutputTokens / totalE2ESec).toFixed(1) : 0;
    const avgStreamingTps =
      totalSubstantiveGenSec > 0.4
        ? +(totalSubstantiveTokens / totalSubstantiveGenSec).toFixed(1)
        : totalAllGenSec > 0.4
          ? +(totalOutputTokens / totalAllGenSec).toFixed(1)
          : avgEffectiveTps;
    const avgThinkingRatioPct =
      totalOutputTokens > 0 ? +((totalThinkingTokens / totalOutputTokens) * 100).toFixed(1) : 0;
    const latestStep = steps.length > 0 ? steps[steps.length - 1] : null;
    const headlineStreamingTps =
      lastSubstantiveStep?.streamingTps || avgStreamingTps || latestStep?.streamingTps || 0;

    const result = {
      hasUnclosedTurn: Boolean(activeTurnId),
      activeTurnId,
      targetWorkdir,
      turnCount: Math.max(turnCount, 1),
      turnStartedAtMs,
      turnCompletedAtMs,
      lastTurnDurationSec,
      lastRecordMs,
      curModel,
      curEffort,
      stepCountInTurn,
      cmdCountInTurn,
      fileCountInTurn,
      latestCommentary,
      currentAction,
      pendingTool,
      lastEventKind,
      recentActions: recentActions.slice(-16),
      latestRateLimits,
      latestRateLimitsMs,
      compactionCount,
      streamErrorCount,
      rateLimitErrorCount,
      lastErrorText,
      steps,
      codexTurns,
      summary: {
        totalInvocations: steps.length,
        totalOutputTokens,
        totalThinkingTokens,
        avgThinkingRatioPct,
        totalRetries: rateLimitErrorCount + streamErrorCount,
        totalRateLimitRetries: rateLimitErrorCount,
        totalNetRetries: streamErrorCount,
        routeMismatchCount: 0,
        sessionDriftCount: 0,
        headlineStreamingTps,
        avgStreamingTps,
        avgEffectiveTps,
        peakStreamingTps,
        peakEffectiveTps,
        sigKeyHex: latestStep?.sigKeyHex || '',
        sigBytes: latestStep?.sigBytes || 0,
        stopReason: activeTurnId ? 'IN_PROGRESS' : 'COMPLETED',
        healthLevel: rateLimitErrorCount > 0 ? 'WARN' : 'OK',
        healthBadges: [],
      },
    };

    codexRolloutCache.set(cleanPath, {
      fileSize: st.size,
      parsedAtMs: Date.now(),
      result,
    });
    return result;
  } catch {
    return null;
  }
}

function readCodexBridgeActiveMap() {
  try {
    if (!existsSync(CODEX_BRIDGE_ACTIVE_FILE)) return {};
    return JSON.parse(readFileSync(CODEX_BRIDGE_ACTIVE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function getCodexFleetData(nowMs) {
  const codexTasks = [];
  const codexParsedMap = new Map();
  const codexQuotaCandidates = [];

  if (!existsSync(CODEX_STATE_DB)) {
    return { codexTasks, codexParsedMap, codexQuota: null };
  }

  const bridgeActiveMap = readCodexBridgeActiveMap();
  const catalogTitles = new Map();
  const activeChatTurnIds = new Set();

  // Read catalog display titles & active_chat_turns from sqlite/codex.db
  if (existsSync(CODEX_CATALOG_DB)) {
    try {
      const catDb = new DatabaseSync(CODEX_CATALOG_DB, { open: true, readOnly: true });
      try {
        const tRows = catDb
          .prepare(
            "SELECT thread_id, display_title FROM local_thread_catalog WHERE host_id = 'local' ORDER BY rowid DESC LIMIT 30"
          )
          .all();
        for (const r of tRows) {
          if (r.thread_id && r.display_title) catalogTitles.set(r.thread_id, r.display_title);
        }
        const actRows = catDb.prepare('SELECT thread_id, observed_at_ms FROM active_chat_turns').all();
        for (const a of actRows) {
          if (a.thread_id && nowMs - (a.observed_at_ms || 0) < 300000) {
            activeChatTurnIds.add(a.thread_id);
          }
        }
      } finally {
        catDb.close();
      }
    } catch {
      // ignore catalog db lock/read errors
    }
  }

  let rows = [];
  try {
    const db = new DatabaseSync(CODEX_STATE_DB, { open: true, readOnly: true });
    try {
      rows = db
        .prepare(
          'SELECT id, rollout_path, cwd, model, reasoning_effort, tokens_used, updated_at, created_at, name, title, source, originator, agent_role, agent_nickname, attached_thread_parent_id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 15'
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    return { codexTasks, codexParsedMap, codexQuota: null };
  }

  for (const row of rows) {
    const threadId = row.id;
    const convKey = `codex:${threadId}`;
    const rollout = parseCodexRolloutCached(
      row.rollout_path,
      threadId,
      row.model || 'gpt-6.1-sol',
      row.reasoning_effort || 'medium'
    );

    if (rollout?.latestRateLimits) {
      codexQuotaCandidates.push({
        rateLimits: rollout.latestRateLimits,
        observedAtMs: rollout.latestRateLimitsMs || rollout.lastRecordMs || 0,
      });
    }

    const bridgeEntry = bridgeActiveMap[threadId] || null;
    const isBridgeRunning = Boolean(bridgeEntry && nowMs - (bridgeEntry.updatedAtMs || 0) < 240000);
    const isRolloutRunning = Boolean(
      rollout && rollout.hasUnclosedTurn && nowMs - rollout.lastRecordMs < 240000
    );
    const isDesktopTurnActive = activeChatTurnIds.has(threadId);
    const isRunning = isRolloutRunning || isBridgeRunning || isDesktopTurnActive;

    const mtimeMs = Math.max(
      (row.updated_at || 0) * 1000,
      rollout?.lastRecordMs || 0,
      bridgeEntry?.updatedAtMs || 0
    );

    const effectiveCwd =
      bridgeEntry?.workdir ||
      rollout?.targetWorkdir ||
      extractTargetWorkdirFromText(row.title) ||
      row.cwd ||
      '';
    const cleanCwd = String(effectiveCwd).replace(/^\\\\\?\\/, '');
    const workspaceLabel = basename(cleanCwd) || 'Codex';
    const rawTitle =
      row.name ||
      catalogTitles.get(threadId) ||
      bridgeEntry?.title ||
      stripSystemPromptHeader(row.title).slice(0, 72) ||
      threadId.slice(0, 8);

    let stateCode = 'IDLE';
    let stateLabel = '空闲就绪';
    let stateDetail = 'Codex 回合已完成';

    if (isRunning) {
      if (rollout?.pendingTool) {
        stateCode = 'TOOL_RUNNING';
        stateLabel = 'Codex 执行中';
        stateDetail = `正在执行: ${rollout.pendingTool}`;
      } else if (rollout?.lastEventKind === 'REASONING') {
        stateCode = 'THINKING';
        stateLabel = 'Codex 思考中';
        stateDetail = rollout.latestCommentary
          ? `进展: ${rollout.latestCommentary.slice(0, 80)}`
          : 'Codex 正在推理与规划下一步...';
      } else {
        stateCode = 'RUNNING';
        stateLabel = 'Codex 运行中';
        stateDetail =
          bridgeEntry?.lastDelta ||
          rollout?.latestCommentary ||
          rollout?.currentAction ||
          'Codex 正在活跃执行任务';
      }
    } else if (rollout?.latestCommentary) {
      stateDetail = `最后汇报: ${rollout.latestCommentary.slice(0, 90)}`;
    }

    const latestStep =
      rollout && rollout.steps.length > 0 ? rollout.steps[rollout.steps.length - 1] : null;
    const curModel = rollout?.curModel || row.model || 'gpt-6.1-sol';
    const curEffort = rollout?.curEffort || row.reasoning_effort || 'medium';
    const exactModelId = latestStep?.exactModelId || `${curModel}-${curEffort}`;
    const sigKeyHex = rollout?.summary?.sigKeyHex || '';
    const sigBytes = rollout?.summary?.sigBytes || 0;

    const fpCheck = recordModelFingerprint({
      convId: convKey,
      convTitle: rawTitle,
      responseModel: curModel,
      exactModelId,
      sigKeyHex,
      sigBytes,
      apiProvider: 'OPENAI_CODEX',
      stepCount: rollout?.steps?.length || 1,
    });

    const diagTag = buildDiagSummaryTag(latestStep, rollout?.summary || {}, fpCheck);

    const contextUsed = latestStep?.contextUsed || 0;
    const maxContext = latestStep?.maxContext || 258400;
    const contextPct = maxContext > 0 ? +((contextUsed / maxContext) * 100).toFixed(1) : 0;

    const turnStartMs = rollout?.turnStartedAtMs || bridgeEntry?.startedAtMs || mtimeMs;
    const elapsedSec = isRunning
      ? Math.max(1, Math.floor((nowMs - turnStartMs) / 1000))
      : rollout?.lastTurnDurationSec || 0;

    const codexProgress = {
      threadId,
      isRunning,
      turnNumber: rollout?.turnCount || 1,
      stepCount: rollout?.stepCountInTurn || 0,
      cmdCount: rollout?.cmdCountInTurn || 0,
      fileChangeCount: rollout?.fileCountInTurn || 0,
      elapsedSec,
      latestCommentary: bridgeEntry?.lastDelta || rollout?.latestCommentary || '',
      currentAction: bridgeEntry?.currentAction || rollout?.currentAction || '',
      pendingTool: rollout?.pendingTool || '',
      recentActions: rollout?.recentActions || [],
      bridgePid: bridgeEntry?.pid || null,
    };

    const turns = aggregateStepsToTurns({
      convId: convKey,
      engine: 'CODEX',
      steps: rollout?.steps || [],
      codexTurns: rollout?.codexTurns || [],
      isConvRunning: isRunning,
      fallbackModelLabel: `Codex ${curModel} (${curEffort})`,
      fallbackExactModelId: exactModelId,
    });
    const turnMetrics = computeConversationTurnMetrics(turns, rollout?.steps || [], isRunning);

    if (rollout) {
      codexParsedMap.set(convKey, {
        ...rollout,
        title: rawTitle,
        workspaceLabel,
        stateCode,
        stateDetail,
        turns,
        turnMetrics,
      });
    }

    codexTasks.push({
      engine: 'CODEX',
      conversationId: convKey,
      rawThreadId: threadId,
      title: rawTitle,
      workspaceLabel,
      cwdPath: cleanCwd,
      isSubagent: Boolean(row.attached_thread_parent_id || row.agent_role),
      isArchived: false,
      subagentRole: row.agent_role || '',
      mtimeMs,
      stepCount: rollout?.steps?.length || 1,
      lastStepIndex: rollout?.steps?.length || 1,
      stateCode,
      stateLabel,
      stateDetail,
      isRunning,
      runningBgCount: 0,
      backgroundTasks: [],
      codexProgress,
      modelLabel: `Codex ${curModel} (${curEffort})`,
      exactModelId,
      requestedModelId: exactModelId,
      responseModel: curModel,
      modelTier: curEffort,
      apiProvider: 'OPENAI_CODEX',
      isRouteMismatch: false,
      sigKeyHex,
      sigBytes,
      fpStatus: fpCheck.status,
      fpBaselineKeyHex: fpCheck.baselineKeyHex || '',
      diagTag,
      sessionID: threadId,
      sessionDriftCount: 0,
      traceId: latestStep?.traceId || '',
      responseId: latestStep?.responseId || '',
      retries: latestStep?.retries || 0,
      totalRetries: rollout?.summary?.totalRetries || 0,
      thinkingRatioPct: latestStep?.thinkingRatioPct ?? 0,
      avgThinkingRatioPct: rollout?.summary?.avgThinkingRatioPct ?? 0,
      healthLevel: rollout?.summary?.healthLevel || 'OK',
      healthBadges: [],
      modelEnum: exactModelId,
      streamingTps: turnMetrics.currentTurn?.streamingTps || rollout?.summary?.headlineStreamingTps || 0,
      effectiveTps: turnMetrics.currentTurn?.effectiveTps || latestStep?.effectiveTps || 0,
      avgStreamingTps: turnMetrics.avgStreamingTps || rollout?.summary?.avgStreamingTps || 0,
      avgEffectiveTps: turnMetrics.avgEffectiveTps || rollout?.summary?.avgEffectiveTps || 0,
      ttftSec: latestStep?.ttftSec || 0,
      streamSec: latestStep?.streamSec || 0,
      outputTokens: latestStep?.outputTokens || 0,
      thinkingTokens: latestStep?.thinkingTokens || 0,
      responseTokens: latestStep?.responseTokens || 0,
      cacheHitRate: turnMetrics.currentTurn?.cacheHitRate ?? latestStep?.cacheHitRate ?? 0,
      avgCacheHitRate: turnMetrics.avgCacheHitRate ?? 0,
      cacheReadTokens: turnMetrics.currentTurn?.cacheReadTokens ?? latestStep?.cacheReadTokens ?? 0,
      totalCacheReadTokens: turnMetrics.totalCacheReadTokens || 0,
      contextUsed,
      maxContext,
      contextPct,
      totalOutputTokens: rollout?.summary?.totalOutputTokens || row.tokens_used || 0,
      totalAllTokens: turnMetrics.totalAllTokens || row.tokens_used || 0,
      totalInvocations: rollout?.summary?.totalInvocations || 1,
      isCurrentRunning: turnMetrics.isCurrentRunning,
      currentTurn: turnMetrics.currentTurn,
      turns,
    });
  }

  codexTasks.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  const codexQuota = pickLatestCodexQuota(codexQuotaCandidates);
  return { codexTasks, codexParsedMap, codexQuota };
}

async function navigateCodexDesktopThread(threadId) {
  const pipes = readdirSync('\\\\.\\pipe\\').filter((p) => p.startsWith('codex-app-tools-'));
  if (pipes.length === 0) {
    throw new Error('未检测到运行中的 Codex Desktop 命名管道');
  }
  const pipePath = `\\\\.\\pipe\\${pipes[0]}`;
  return new Promise((resolve, reject) => {
    const sock = createConnection(pipePath);
    const rpcMsg = {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { threadId },
        callerSource: 'codex',
        callId: `agy-nav-${Date.now()}`,
        hostId: 'local',
        namespace: 'codex_app',
        threadId,
        tool: 'navigate_to_codex_page',
        turnId: `agy-turn-${Date.now()}`,
      },
    };
    const payload = Buffer.from(JSON.stringify(rpcMsg), 'utf8');
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('连接 Codex Desktop 超时'));
    }, 3000);
    sock.on('connect', () => sock.write(frame));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len) {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let lastTelemetryCallMs = 0;

async function buildTelemetryPayload(requestedConvId) {
  const nowMs = Date.now();
  lastTelemetryCallMs = nowMs;
  const [modelCatalog, quotaGroups] = await Promise.all([
    getModelCatalogMap(),
    getUserQuotaGroups(),
  ]);
  mergeCatalogQuotaFallback(modelCatalog, quotaGroups);
  const selectedModelEnum = getSelectedModelFromState();
  const selectedModelInfo = modelCatalog.get(selectedModelEnum) || null;
  const hookState = readLiveHookState();

  // 1. Discover all active/recent trajectories from LS + disk
  const candidateMap = new Map();
  let lsTrajLoaded = false;
  try {
    const lsTraj = await callLsRpc('GetAllCascadeTrajectories', {});
    const summaries = lsTraj.trajectorySummaries || {};
    lsTrajLoaded = true;
    for (const [cid, info] of Object.entries(summaries)) {
      const mtimeMs = info.lastModifiedTime ? new Date(info.lastModifiedTime).getTime() : 0;
      const parentId = info.trajectoryMetadata?.parentConversationId || '';
      const subagentRole = info.trajectoryMetadata?.subagentSpec?.role || '';
      candidateMap.set(cid, {
        conversationId: cid,
        title: info.annotations?.title || info.summary || readConversationTitle(cid),
        lsStatus: info.status || 'CASCADE_RUN_STATUS_IDLE',
        stepCount: info.stepCount || 0,
        mtimeMs,
        workspaceLabel: extractWorkspaceLabel(info.workspaces),
        parentConversationId: parentId,
        isSubagent: Boolean(parentId || subagentRole),
        isArchived: false,
        subagentRole,
      });
    }
  } catch {
    // fallback to disk scan if GetAllCascadeTrajectories fails
  }

  try {
    if (existsSync(BRAIN_DIR)) {
      const entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const cid = d.name;
        const transcriptPath = join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;
        const st = statSync(transcriptPath);
        if (candidateMap.has(cid)) {
          const existing = candidateMap.get(cid);
          if (st.mtimeMs > existing.mtimeMs) existing.mtimeMs = st.mtimeMs;
        } else {
          candidateMap.set(cid, {
            conversationId: cid,
            title: readConversationTitle(cid),
            lsStatus: 'CASCADE_RUN_STATUS_IDLE',
            stepCount: 0,
            mtimeMs: st.mtimeMs,
            workspaceLabel: 'Local',
            parentConversationId: '',
            isSubagent: false,
            isArchived: lsTrajLoaded,
            subagentRole: '',
          });
        }
      }
    }
  } catch {
    // ignore disk scan errors
  }

  const candidates = Array.from(candidateMap.values());
  const rootMap = buildRootMap(candidates, BRAIN_DIR);

  // Pre-select roots + their active/recent subagent children
  const initialCandidates = preselect(candidates, rootMap.rootOf);

  const enrichedCandidates = initialCandidates.map((item) => {
    const transcriptInfo = inspectTranscriptAndBgCandidates(item.conversationId);
    if (transcriptInfo && transcriptInfo.mtimeMs > item.mtimeMs) {
      item.mtimeMs = transcriptInfo.mtimeMs;
    }
    const bgCands = (transcriptInfo?.bgCandidates || []).filter((c) => !c.transcriptFinished && !c.isDaemon);
    const unresolvedBgCount = bgCands.filter((c) => {
      const cached = bgStepResolvedCache.get(`${item.conversationId}:${c.stepIndex}`);
      return !cached || cached.isRunning;
    }).length;
    const isRecentEnoughForBg = nowMs - item.mtimeMs < 6 * 3600 * 1000;
    return {
      ...item,
      transcriptInfo,
      hasUnclosedBg: isRecentEnoughForBg && unresolvedBgCount > 0,
    };
  });

  const sortedCandidates = finalSelect(enrichedCandidates, rootMap.rootOf);

  const fleetTasks = await Promise.all(
    sortedCandidates.map(async (item) => {
      const transcriptInfo = item.transcriptInfo;
      const [parsed, backgroundTasks] = await Promise.all([
        getParsedConversationSteps(
          item.conversationId,
          item.stepCount || transcriptInfo?.totalSteps || 0,
          item.mtimeMs,
          modelCatalog,
          selectedModelEnum,
          quotaGroups
        ),
        resolveBackgroundTasks(item.conversationId, transcriptInfo?.bgCandidates || [], nowMs),
      ]);

      const latestStep = parsed.steps.length > 0 ? parsed.steps[parsed.steps.length - 1] : null;
      const workState = resolveTaskWorkingState(
        item.conversationId,
        item.lsStatus,
        transcriptInfo,
        hookState,
        nowMs
      );

      const runningBgList = backgroundTasks.filter((b) => b.isRunning);
      const activeNonDaemonBgList = runningBgList.filter((b) => !b.isDaemon);
      const runningDaemonList = runningBgList.filter((b) => b.isDaemon);
      const runningBgCount = activeNonDaemonBgList.length;
      const runningDaemonCount = runningDaemonList.length;

      // Only promote stateCode to BG_RUNNING for active non-daemon background tasks;
      // daemon services (e.g. uvicorn web servers) keep IDLE state with a clear label.
      let finalStateCode = workState.stateCode;
      let finalStateLabel = workState.stateLabel;
      let finalStateDetail = workState.stateDetail;
      if (!workState.isRunning && runningBgCount > 0) {
        finalStateCode = 'BG_RUNNING';
        finalStateLabel = runningBgCount > 1 ? `后台运行 (${runningBgCount})` : '后台任务中';
        const firstBg = activeNonDaemonBgList[0];
        finalStateDetail = `回合已完成 · 后台正在执行 ${firstBg.taskId}: ${firstBg.toolSummary || firstBg.commandLine}`;
      } else if (!workState.isRunning && runningDaemonCount > 0) {
        const firstDaemon = runningDaemonList[0];
        finalStateLabel = '已就绪 · 常驻服务';
        finalStateDetail = `回合已完成 · 常驻服务运行中 (${firstDaemon.toolSummary || firstDaemon.commandLine})`;
      }

      const contextUsed = latestStep?.contextUsed || 0;
      const maxContext = latestStep?.maxContext || 256000;
      const contextPct = maxContext > 0 ? +((contextUsed / maxContext) * 100).toFixed(1) : 0;

      const resolvedExactId =
        latestStep?.exactModelId ||
        selectedModelInfo?.modelId ||
        latestStep?.responseModel ||
        '--';
      const resolvedResponseModel = latestStep?.responseModel || '--';
      const sigKeyHex = parsed.summary.sigKeyHex || '';
      const sigBytes = parsed.summary.sigBytes || 0;
      const apiProvider = latestStep?.apiProvider || '--';
      const stepCount = item.stepCount || transcriptInfo?.totalSteps || 0;

      const fpCheck = recordModelFingerprint({
        convId: item.conversationId,
        convTitle: item.title,
        responseModel: resolvedResponseModel,
        exactModelId: resolvedExactId,
        sigKeyHex,
        sigBytes,
        apiProvider,
        stepCount,
      });

      const diagTag = buildDiagSummaryTag(latestStep, parsed.summary, fpCheck);
      const agyTurns = aggregateStepsToTurns({
        convId: item.conversationId,
        engine: 'AGY',
        steps: parsed.steps,
        userTurns: transcriptInfo?.userTurns || [],
        wakeTurns: transcriptInfo?.wakeTurns || [],
        firstCreatedAtMs: transcriptInfo?.firstCreatedAtMs || 0,
        isConvRunning: workState.isRunning,
        fallbackModelLabel: latestStep?.modelLabel || selectedModelInfo?.label || 'Auto',
        fallbackExactModelId: resolvedExactId,
      });
      const turnMetrics = computeConversationTurnMetrics(
        agyTurns,
        parsed.steps,
        workState.isRunning
      );

      return {
        engine: 'AGY',
        conversationId: item.conversationId,
        parentConversationId: item.parentConversationId || '',
        title: item.title,
        workspaceLabel: item.workspaceLabel,
        isSubagent: item.isSubagent,
        isArchived: Boolean(item.isArchived),
        subagentRole: item.subagentRole,
        mtimeMs: item.mtimeMs,
        stepCount,
        lastStepIndex: transcriptInfo?.lastStepIndex ?? null,
        stateCode: finalStateCode,
        stateLabel: finalStateLabel,
        stateDetail: finalStateDetail,
        isRunning: workState.isRunning,
        runningBgCount,
        runningDaemonCount,
        codexThreadIds: transcriptInfo?.codexThreadIds || [],
        backgroundTasks,
        codexProgress: null,
        linkedCodex: null,
        modelLabel: latestStep?.modelLabel || selectedModelInfo?.label || 'Auto',
        exactModelId: resolvedExactId,
        requestedModelId: latestStep?.requestedModelId || selectedModelInfo?.modelId || '--',
        responseModel: resolvedResponseModel,
        execModelId: latestStep?.execModelId || '',
        execModelLabel: latestStep?.execModelLabel || '',
        modelTier: latestStep?.modelTier || selectedModelInfo?.tier || '',
        modelDescription: latestStep?.modelDescription || selectedModelInfo?.tagDescription || '',
        apiProvider,
        isRouteMismatch: Boolean(latestStep?.isRouteMismatch),
        sigKeyHex,
        sigBytes,
        fpStatus: fpCheck.status,
        fpBaselineKeyHex: fpCheck.baselineKeyHex || '',
        diagTag,
        sessionID: latestStep?.sessionID || '',
        sessionDriftCount: parsed.summary.sessionDriftCount || 0,
        traceId: latestStep?.traceId || '',
        responseId: latestStep?.responseId || '',
        retries: latestStep?.retries || 0,
        totalRetries: parsed.summary.totalRetries || 0,
        thinkingRatioPct: latestStep?.thinkingRatioPct ?? 0,
        avgThinkingRatioPct: parsed.summary.avgThinkingRatioPct ?? 0,
        healthLevel: parsed.summary.healthLevel || 'OK',
        healthBadges: parsed.summary.healthBadges || [],
        modelEnum: latestStep?.modelEnum || selectedModelEnum || '--',
        streamingTps: turnMetrics.currentTurn?.streamingTps || 0,
        effectiveTps: turnMetrics.currentTurn?.effectiveTps || 0,
        avgStreamingTps: turnMetrics.avgStreamingTps || parsed.summary.avgStreamingTps || 0,
        avgEffectiveTps: turnMetrics.avgEffectiveTps || parsed.summary.avgEffectiveTps || 0,
        ttftSec: latestStep?.ttftSec || 0,
        streamSec: latestStep?.streamSec || 0,
        outputTokens: latestStep?.outputTokens || 0,
        thinkingTokens: latestStep?.thinkingTokens || 0,
        responseTokens: latestStep?.responseTokens || 0,
        cacheHitRate: turnMetrics.currentTurn?.cacheHitRate ?? 0,
        avgCacheHitRate: turnMetrics.avgCacheHitRate ?? 0,
        cacheReadTokens: turnMetrics.currentTurn?.cacheReadTokens ?? 0,
        totalCacheReadTokens: turnMetrics.totalCacheReadTokens || 0,
        contextUsed,
        maxContext,
        contextPct,
        totalOutputTokens: parsed.summary.totalOutputTokens || 0,
        totalAllTokens: turnMetrics.totalAllTokens || 0,
        totalInvocations: parsed.summary.totalInvocations || 0,
        isCurrentRunning: turnMetrics.isCurrentRunning,
        currentTurn: turnMetrics.currentTurn,
        turns: agyTurns,
      };
    })
  );

  // Fetch local OpenAI Codex Desktop / CLI tasks and live progress
  const { codexTasks, codexParsedMap, codexQuota } = getCodexFleetData(nowMs);
  if (codexQuota) {
    quotaGroups.codex = codexQuota;
  }

  // Cross-link Antigravity conversations with ACTIVE (or just-finished) Codex sessions
  for (const agyTask of fleetTasks) {
    if (agyTask.isSubagent) {
      continue;
    }
    const explicitIds = Array.isArray(agyTask.codexThreadIds) ? agyTask.codexThreadIds : [];
    let matchingCodex = null;
    let isExplicitMatch = false;
    if (explicitIds.length > 0) {
      for (const tid of explicitIds) {
        const found = codexTasks.find((ct) => ct.rawThreadId.toLowerCase() === tid.toLowerCase());
        if (found) {
          matchingCodex = found;
          isExplicitMatch = true;
          break;
        }
      }
    }
    // Workspace fallback ONLY matches actively running Codex tasks (never attach stale finished ones)
    if (!matchingCodex && agyTask.workspaceLabel && agyTask.workspaceLabel !== 'Global') {
      matchingCodex = codexTasks.find(
        (ct) =>
          ct.isRunning &&
          ct.workspaceLabel.toLowerCase() === agyTask.workspaceLabel.toLowerCase()
      );
    }
    // Only keep linkedCodex attached while Codex is running, or within 2 minutes of explicit completion
    const isFreshExplicitCompletion =
      isExplicitMatch && matchingCodex && nowMs - matchingCodex.mtimeMs < 2 * 60 * 1000;
    if (matchingCodex && matchingCodex.codexProgress && (matchingCodex.isRunning || isFreshExplicitCompletion)) {
      agyTask.linkedCodex = {
        conversationId: matchingCodex.conversationId,
        rawThreadId: matchingCodex.rawThreadId,
        title: matchingCodex.title,
        exactModelId: matchingCodex.exactModelId,
        stateLabel: matchingCodex.stateLabel,
        isRunning: matchingCodex.isRunning,
        mtimeMs: matchingCodex.mtimeMs,
        progress: matchingCodex.codexProgress,
      };
      // If AGY foreground turn finished/timed out while its delegated Codex task is still actively running,
      // promote AGY card to show active synergy!
      if (!agyTask.isRunning && agyTask.runningBgCount === 0 && matchingCodex.isRunning) {
        agyTask.stateCode = 'BG_RUNNING';
        agyTask.stateLabel = '协同 Codex 中';
        agyTask.stateDetail = `已委派 Codex (${matchingCodex.exactModelId}) 正在执行: ${matchingCodex.stateDetail}`;
      }
    }
  }

  // Combine AGY tasks + top 12 Codex tasks into unified fleetTasks list
  const combinedFleet = [...fleetTasks, ...codexTasks.slice(0, 12)];

  // Reconcile per-turn history & local token-weighted quota estimates
  reconcileAndPersistHistory({ fleetTasks: combinedFleet, nowMs });

  // Track unexplained account quota drops & solo calibration window
  const localConvEstimates = getLocalQuotaEstimatesByConv();
  const familyQuotaUsage = updateFamilyQuotaTracker({ quotaGroups, codexQuota, localConvEstimates, nowMs });
  const quotaCalibration = updateQuotaCalibrationTracker({ quotaGroups, codexQuota, localConvEstimates, nowMs });

  // Nest subagents/swarm workers into roots, merge totals, and apply dismiss state
  const { roots, byId } = finalizeFleet({ tasks: combinedFleet, rootMap, nowMs });

  flushFingerprintLedger(false);
  const fpLedger = loadFingerprintLedger();

  const runningTasksCount = combinedFleet.filter((t) => t.isRunning).length;
  const runningCodexCount = codexTasks.filter((t) => t.isRunning).length;
  const runningBgTasksCount = fleetTasks.reduce((acc, t) => acc + (t.runningBgCount || 0), 0);

  const activeConvId =
    requestedConvId && requestedConvId !== 'auto'
      ? requestedConvId
      : roots[0]?.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';

  const isCodexTarget = String(activeConvId).startsWith('codex:');
  const codexTargetParsed = isCodexTarget ? codexParsedMap.get(activeConvId) : null;

  const targetTranscript =
    !isCodexTarget && activeConvId ? inspectTranscriptAndBgCandidates(activeConvId) : null;
  const targetCandidate = !isCodexTarget ? candidateMap.get(activeConvId) : null;
  const targetParsed = isCodexTarget
    ? codexTargetParsed || { steps: [], summary: {} }
    : activeConvId
      ? await getParsedConversationSteps(
          activeConvId,
          targetCandidate?.stepCount || targetTranscript?.totalSteps || 0,
          targetCandidate?.mtimeMs || targetTranscript?.mtimeMs || 0,
          modelCatalog,
          selectedModelEnum,
          quotaGroups
        )
      : { steps: [], summary: {} };

  const targetWorkState = isCodexTarget
    ? {
        stateCode: codexTargetParsed?.stateCode || 'IDLE',
        stateDetail: codexTargetParsed?.stateDetail || 'Codex 会话详情',
      }
    : resolveTaskWorkingState(
        activeConvId,
        targetCandidate?.lsStatus || 'CASCADE_RUN_STATUS_IDLE',
        targetTranscript,
        hookState,
        nowMs
      );

  const latestStep =
    targetParsed.steps.length > 0 ? targetParsed.steps[targetParsed.steps.length - 1] : null;

  const selectedResolvedQuota = resolveQuotaForModel(
    selectedModelInfo?.label || selectedModelEnum,
    selectedModelInfo,
    quotaGroups
  );

  const selectedFleetTask = byId.get(activeConvId) || null;
  let activeTurns = selectedFleetTask?.turns || null;
  if (!activeTurns && activeConvId) {
    const computedTurns = aggregateStepsToTurns({
      convId: activeConvId,
      engine: isCodexTarget ? 'CODEX' : 'AGY',
      steps: targetParsed.steps || [],
      userTurns: targetTranscript?.userTurns || [],
      wakeTurns: targetTranscript?.wakeTurns || [],
      firstCreatedAtMs: targetTranscript?.firstCreatedAtMs || 0,
      codexTurns: codexTargetParsed?.codexTurns || [],
      isConvRunning: Boolean(targetWorkState.stateCode && targetWorkState.stateCode !== 'IDLE'),
      fallbackModelLabel: latestStep?.modelLabel || selectedModelInfo?.label || 'Auto',
      fallbackExactModelId: latestStep?.exactModelId || selectedModelInfo?.modelId || '--',
    });
    const persisted = getPersistedTurnsForConversation(activeConvId);
    if (persisted.length > 0) {
      const pMap = new Map(persisted.map((pt) => [pt.turnId, pt]));
      activeTurns = computedTurns.map((ct) => {
        const pt = pMap.get(ct.turnId);
        return pt?.quotaUsage ? { ...ct, quotaUsage: pt.quotaUsage } : ct;
      });
    } else {
      activeTurns = computedTurns;
    }
  }
  const activeTurnMetrics = computeConversationTurnMetrics(
    activeTurns || [],
    targetParsed.steps || [],
    Boolean(selectedFleetTask?.isRunning || (targetWorkState.stateCode && targetWorkState.stateCode !== 'IDLE'))
  );

  // Strip heavy per-turn step arrays from fleetTasks items (full turns live on top-level `turns` for activeConvId)
  const sanitizedFleet = roots.map((t) => {
    const { turns: _dropTurns, currentTurn, ...rest } = t;
    let compactCurrent = null;
    if (currentTurn) {
      const { steps: _dropSteps, ...ctRest } = currentTurn;
      compactCurrent = ctRest;
    }
    return {
      ...rest,
      currentTurn: compactCurrent,
      totalTurnsCount: t.totalTurnsCount || (Array.isArray(_dropTurns) ? _dropTurns.length : 0),
    };
  });

  let uiMtimeVer = 10;
  try {
    let maxMt = 0;
    for (const f of ['index.html', ...UI_SCRIPTS]) {
      const fp = join(__dirname, f);
      if (existsSync(fp)) maxMt = Math.max(maxMt, statSync(fp).mtimeMs);
    }
    uiMtimeVer = Math.floor(maxMt / 1000) || 10;
  } catch {}

  return {
    uiVersion: uiMtimeVer,
    timestampMs: nowMs,
    activeConversationId: activeConvId,
    activeConversationTitle: isCodexTarget
      ? `[Codex] ${codexTargetParsed?.title || activeConvId}`
      : targetCandidate?.title ||
        (activeConvId ? readConversationTitle(activeConvId) : 'No Active Session'),
    liveStatus: targetWorkState.stateCode,
    liveDetail: targetWorkState.stateDetail,
    fleetOverview: {
      runningTasksCount,
      runningCodexCount,
      runningBgTasksCount,
      totalTrackedTasks: roots.length,
      totalCodexTasks: codexTasks.length,
    },
    familyQuotaUsage,
    quotaCalibration,
    pluginUpdate: getPluginUpdateStatus(),
    fingerprintLedger: {
      filePath: FINGERPRINT_LEDGER_FILE,
      updatedAtMs: fpLedger.updatedAtMs,
      baselines: Object.values(fpLedger.baselines),
      unackedCount: fpLedger.events.filter((e) => !e.acknowledged).length,
      events: fpLedger.events.slice(0, 15),
    },
    fleetTasks: sanitizedFleet,
    quotaGroups,
    codexQuota,
    selectedModel: {
      modelEnum: selectedModelEnum,
      label: selectedModelInfo?.label || selectedModelEnum || 'Auto',
      quotaRemainingFraction:
        selectedResolvedQuota.fiveHour?.remainingFraction ??
        selectedModelInfo?.remainingFraction ??
        null,
      quotaResetTime:
        selectedResolvedQuota.fiveHour?.resetTime ?? selectedModelInfo?.resetTime ?? null,
      quotaWeeklyRemainingFraction: selectedResolvedQuota.weekly?.remainingFraction ?? null,
      quotaWeeklyResetTime: selectedResolvedQuota.weekly?.resetTime ?? null,
    },
    latest: latestStep,
    summary: {
      ...(targetParsed.summary || {}),
      avgCacheHitRate:
        selectedFleetTask?.sessionTotals?.cacheHitRate ?? activeTurnMetrics.avgCacheHitRate,
      totalCacheReadTokens:
        selectedFleetTask?.sessionTotals?.cacheReadTokens ?? activeTurnMetrics.totalCacheReadTokens,
      totalAllTokens:
        selectedFleetTask?.sessionTotals?.totalTokens ?? activeTurnMetrics.totalAllTokens,
      sessionTotals: selectedFleetTask?.sessionTotals || null,
      subagents: selectedFleetTask?.subagents || [],
      isCurrentRunning: activeTurnMetrics.isCurrentRunning,
      currentTurn: activeTurnMetrics.currentTurn
        ? (() => {
            const { steps: _s, ...ct } = activeTurnMetrics.currentTurn;
            return ct;
          })()
        : null,
    },
    turns: (activeTurns || []).map((tr) =>
      Array.isArray(tr.steps) && tr.steps.length > 25 ? { ...tr, steps: tr.steps.slice(-25) } : tr
    ),
    steps: targetParsed.steps.slice(-25),
  };
}

async function handleActionRequest(data) {
  const action = data?.action;
  const quotaRes = handleQuotaAction(data, Date.now());
  if (quotaRes) return quotaRes;
  const updaterRes = await handleUpdaterAction(data);
  if (updaterRes) return updaterRes;

  if (action === 'ack_fingerprint') {
    acknowledgeFingerprintChanges(data?.modelFamily || '');
    return {
      ok: true,
      message: data?.modelFamily
        ? `已将 ${data.modelFamily} 当前指纹更新为本地基线`
        : '已确认全部指纹变更并更新本地基线',
    };
  }

  if (action === 'open_codex_thread') {
    const rawThreadId = String(data?.threadId || data?.conversationId || '').replace(/^codex:/, '');
    if (!rawThreadId) {
      return { ok: false, error: 'Missing threadId for open_codex_thread' };
    }
    try {
      await navigateCodexDesktopThread(rawThreadId);
      return {
        ok: true,
        message: `已在 Codex Desktop 跳转至会话 ${rawThreadId.slice(0, 8)}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err),
      };
    }
  }

  if (action === 'stop_codex_turn') {
    const rawThreadId = String(data?.threadId || data?.conversationId || '').replace(/^codex:/, '');
    try {
      const map = readCodexBridgeActiveMap();
      const entry = map[rawThreadId];
      if (entry && entry.pid) {
        try {
          process.kill(entry.pid);
        } catch {}
      }
      delete map[rawThreadId];
      writeFileSync(CODEX_BRIDGE_ACTIVE_FILE, JSON.stringify(map, null, 2), 'utf8');
      return { ok: true, message: `已发送停止信号至 Codex 任务 (${rawThreadId.slice(0, 8)})` };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  const convId = data?.conversationId;
  const stepIndex = Number(data?.stepIndex);
  const stepIndices = Array.isArray(data?.stepIndices)
    ? data.stepIndices.map(Number).filter((n) => !Number.isNaN(n))
    : !Number.isNaN(stepIndex)
      ? [stepIndex]
      : [];

  if (!action || !convId) {
    return { ok: false, error: 'Missing action or conversationId' };
  }

  try {
    if (action === 'dismiss_task') {
      dismissConversation(convId, Date.now());
      return { ok: true, message: '已从最近活跃中关闭该卡片' };
    }

    if (action === 'restore_task') {
      restoreConversation(convId);
      return { ok: true, message: '已恢复卡片到最近活跃列表' };
    }

    if (action === 'kill_bg_task') {
      if (stepIndices.length === 0) {
        return { ok: false, error: 'Missing stepIndex for kill_bg_task' };
      }
      await callLsRpc('CancelCascadeSteps', {
        cascadeId: convId,
        stepIndices,
      });
      const label = stepIndices.map((idx) => `task-${idx}`).join(', ');
      return { ok: true, message: `已停止后台任务 ${label}` };
    }

    if (action === 'cancel_turn') {
      await callLsRpc('CancelCascadeInvocation', {
        cascadeId: convId,
        killBackgroundTasks: Boolean(data?.killBackgroundTasks),
      });
      return {
        ok: true,
        message: data?.killBackgroundTasks ? '已停止回合并清理后台任务' : '已停止当前回合',
      };
    }

    if (action === 'force_stop_tree') {
      await callLsRpc('CancelCascadeInvocation', {
        cascadeId: convId,
        killBackgroundTasks: true,
      }).catch(() => {});
      await callLsRpc('ForceStopCascadeTree', {
        conversationId: convId,
      });
      return { ok: true, message: '已强制停止该会话及全部子代理/后台进程' };
    }

    if (action === 'send_to_bg') {
      await callLsRpc('SendStepsToBackground', {
        conversationId: convId,
        stepIndices: [stepIndex],
      });
      return { ok: true, message: `已将步骤 #${stepIndex} 转为后台运行` };
    }

    if (action === 'tail_bg_log') {
      const preview = readTaskLogPreview(convId, stepIndex, 35);
      return {
        ok: true,
        exists: preview.exists,
        sizeBytes: preview.sizeBytes,
        log: preview.tailLines.join('\n') || '(日志文件暂无输出)',
      };
    }

    return { ok: false, error: `Unknown action: ${action}` };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

const app = new SidecarApp();

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
};

const UI_SCRIPTS = ['ui_i18n.js', 'ui_card_metrics.js', 'ui_subagent_tray.js', 'ui_turn_list.js', 'ui_inline_detail.js', 'ui_quota_calibration.js', 'ui_updater.js', 'ui_fleet_cards.js'];

function renderAssembledIndexHtml() {
  let html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  for (const f of UI_SCRIPTS) {
    html = html.replace(`<script src="/${f}"></script>`, `<script>\n${readFileSync(join(__dirname, f), 'utf-8')}\n</script>`);
  }
  return html;
}

for (const p of ['/', '/index.html']) app.page(p, () => new Response(renderAssembledIndexHtml(), { contentType: 'text/html; charset=utf-8', headers: noCacheHeaders }));
for (const f of UI_SCRIPTS) app.page(`/${f}`, () => new Response(readFileSync(join(__dirname, f), 'utf-8'), { contentType: 'application/javascript; charset=utf-8', headers: noCacheHeaders }));
app.api('/api/telemetry', async (data) => buildTelemetryPayload(data?.conversationId), 'POST');
app.api('/api/telemetry', async (data) => buildTelemetryPayload(data?.conversationId), 'GET');
app.api('/api/action', async (data) => handleActionRequest(data), 'POST');
app.run();
startBackgroundUpdateChecker();

// Background sampler so turn history & quota deltas stay tracked even when HUD pane is closed
let bgSampleRunning = false;
setInterval(async () => {
  if (bgSampleRunning || !LS_ADDR || Date.now() - lastTelemetryCallMs < 3500) return;
  bgSampleRunning = true;
  try {
    await buildTelemetryPayload('auto');
  } catch {
    // ignore background sampling errors
  } finally {
    bgSampleRunning = false;
  }
}, 4000).unref();
