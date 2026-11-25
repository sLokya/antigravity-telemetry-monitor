import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractUserPromptPreview } from './turn_aggregator.mjs';

const CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB read chunk for streaming full rollout without truncation
const MAX_CACHE_ENTRIES = 64;
const codexRolloutCache = new Map();

export function cleanCodexCommandText(cmdArrOrStr) {
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

export function fmtClockTime(tsMs) {
  if (!tsMs) return '';
  const d = new Date(tsMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function extractTargetWorkdirFromText(txt) {
  if (!txt) return '';
  const s = String(txt);
  const m = s.match(/本次任务的实际目标工作目录为\s*`([^`]+)`/);
  if (m) return m[1].trim();
  const wsMatch = s.match(/`((?:[a-zA-Z]:[\\/]|\/)[^`\r\n]+)`/);
  return wsMatch ? wsMatch[1].trim() : '';
}

export function stripSystemPromptHeader(txt) {
  if (!txt) return '';
  return String(txt)
    .replace(/^\[系统(?:工作区与)?自主执行指令[\s\S]*?\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createInitialParserState(defaultModel, defaultEffort, mtimeMs) {
  return {
    pendingTail: '',
    curModel: defaultModel || 'gpt-6.1-sol',
    curEffort: defaultEffort || 'medium',
    targetWorkdir: '',
    turnCount: 0,
    activeTurnId: null,
    turnStartedAtMs: 0,
    turnCompletedAtMs: 0,
    lastTurnDurationSec: 0,
    lastRecordMs: mtimeMs || 0,

    stepCountInTurn: 0,
    cmdCountInTurn: 0,
    fileCountInTurn: 0,
    latestCommentary: '',
    currentAction: '',
    pendingTool: '',
    lastEventKind: 'IDLE',
    recentActions: [],

    reqStartMs: null,
    firstGenMs: null,
    lastGenMs: null,
    nextReqStartMs: null,
    prevTotalOutTokens: -1,
    prevTotalTokens: -1,
    latestResponseId: '',
    latestRateLimits: null,
    latestRateLimitsMs: 0,
    latestTotalTokenUsage: null,
    compactionCount: 0,
    streamErrorCount: 0,
    rateLimitErrorCount: 0,
    lastErrorText: '',
    steps: [],
    codexTurns: [],
    activeTurnObj: null,
    pendingUserPrompt: '',
  };
}

function pushRecentAction(s, tsMs, kind, icon, summary) {
  s.recentActions.push({ tsMs, timeStr: fmtClockTime(tsMs), kind, icon, summary });
  if (s.recentActions.length > 48) s.recentActions = s.recentActions.slice(-24);
}

function processRolloutLine(s, rawLine, threadId) {
  const line = rawLine.trim();
  if (!line) return;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const tsMs = Date.parse(obj.timestamp) || 0;
  if (tsMs > s.lastRecordMs) s.lastRecordMs = tsMs;
  const p = obj.payload || {};

  if (obj.type === 'session_meta') {
    if (p.target_workdir) s.targetWorkdir = p.target_workdir;
    return;
  }
  if (obj.type === 'turn_context') {
    if (p.model) s.curModel = p.model;
    if (p.effort) s.curEffort = p.effort;
    if (!s.reqStartMs && tsMs) s.reqStartMs = tsMs;
    return;
  }
  if (obj.type === 'compacted') {
    s.compactionCount++;
    return;
  }
  if (obj.type === 'token_usage_record') {
    if (p.response_id) s.latestResponseId = p.response_id;
    if (tsMs) s.lastGenMs = tsMs;
    return;
  }
  if (obj.type === 'response_item') {
    const pType = p.type || '';
    if (pType === 'reasoning') {
      s.lastEventKind = 'REASONING';
      if (!s.firstGenMs && tsMs) s.firstGenMs = tsMs;
      if (tsMs) s.lastGenMs = tsMs;
    } else if (pType === 'message' && p.role === 'user') {
      const uTxt = (p.content || []).map((c) => c.text || '').join(' ');
      const wd = extractTargetWorkdirFromText(uTxt);
      if (wd) s.targetWorkdir = wd;
      const cleanPrompt = extractUserPromptPreview(stripSystemPromptHeader(uTxt));
      if (cleanPrompt) {
        s.pendingUserPrompt = cleanPrompt;
        if (s.activeTurnObj && !s.activeTurnObj.promptPreview) {
          s.activeTurnObj.promptPreview = cleanPrompt;
        }
      }
    } else if (pType === 'message' && p.role === 'assistant') {
      s.lastEventKind = 'AGENT_MSG';
      if (!s.firstGenMs && tsMs) s.firstGenMs = tsMs;
      if (tsMs) s.lastGenMs = tsMs;
    } else if (pType === 'custom_tool_call' || pType === 'function_call') {
      s.lastEventKind = 'TOOL_CALL';
      if (!s.firstGenMs && tsMs) s.firstGenMs = tsMs;
      if (tsMs) s.lastGenMs = tsMs;
      const toolName = p.name || 'tool';
      const summary = cleanCodexCommandText(p.input || p.arguments || toolName);
      s.pendingTool = toolName === 'exec' ? summary : `${toolName}: ${summary}`;
      s.currentAction = `⚡ 正在执行: ${s.pendingTool}`;
    } else if (
      pType === 'custom_tool_call_output' ||
      pType === 'function_call_output' ||
      pType === 'local_shell_call_output'
    ) {
      if (typeof p.output === 'string' && p.output.includes('本次任务的实际目标工作目录为')) {
        const wd = extractTargetWorkdirFromText(p.output);
        if (wd) s.targetWorkdir = wd;
      }
      s.pendingTool = '';
      if (tsMs) s.nextReqStartMs = tsMs;
    }
    return;
  }

  if (obj.type !== 'event_msg') return;
  const evType = p.type || '';

  if (evType === 'thread_settings_applied') {
    const stg = p.thread_settings || {};
    if (stg.model) s.curModel = stg.model;
    if (stg.reasoning_effort) s.curEffort = stg.reasoning_effort;
  } else if (evType === 'task_started') {
    s.turnCount++;
    s.activeTurnId = p.turn_id || `turn-${s.turnCount}`;
    s.turnStartedAtMs = tsMs;
    s.turnCompletedAtMs = 0;
    s.stepCountInTurn = 0;
    s.cmdCountInTurn = 0;
    s.fileCountInTurn = 0;
    s.pendingTool = '';
    s.currentAction = '';
    s.lastEventKind = 'REASONING';
    s.reqStartMs = tsMs;
    s.firstGenMs = null;
    s.lastGenMs = null;
    s.nextReqStartMs = null;
    s.activeTurnObj = {
      turnIndex: s.turnCount,
      turnId: s.activeTurnId,
      promptPreview: s.pendingUserPrompt || '',
      startedAtMs: tsMs,
      completedAtMs: 0,
      isAborted: false,
    };
    s.pendingUserPrompt = '';
    s.codexTurns.push(s.activeTurnObj);
  } else if (evType === 'task_complete' || evType === 'turn_aborted') {
    if (s.activeTurnObj) {
      s.activeTurnObj.completedAtMs = tsMs;
      s.activeTurnObj.isAborted = evType === 'turn_aborted';
      s.activeTurnObj = null;
    }
    s.activeTurnId = null;
    s.turnCompletedAtMs = tsMs;
    s.pendingTool = '';
    s.currentAction = '';
    s.lastEventKind = 'IDLE';
    if (p.duration_ms) {
      s.lastTurnDurationSec = Math.round(p.duration_ms / 1000);
    } else if (s.turnStartedAtMs && tsMs > s.turnStartedAtMs) {
      s.lastTurnDurationSec = Math.round((tsMs - s.turnStartedAtMs) / 1000);
    }
    if (p.last_agent_message) {
      s.latestCommentary = String(p.last_agent_message).replace(/\s+/g, ' ').trim();
    }
    pushRecentAction(
      s,
      tsMs,
      evType === 'turn_aborted' ? 'ABORT' : 'DONE',
      evType === 'turn_aborted' ? '🛑' : '✅',
      evType === 'turn_aborted' ? '回合已中止' : `回合完成 (耗时 ${s.lastTurnDurationSec}s)`
    );
  } else if (evType === 'error' || evType === 'stream_error') {
    const msg = `${JSON.stringify(p.codex_error_info || {})} ${p.message || ''}`;
    s.lastErrorText = p.message || String(p.codex_error_info || '');
    if (/429|rate_limit|quota|overloaded|capacity/i.test(msg)) {
      s.rateLimitErrorCount++;
    } else {
      s.streamErrorCount++;
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
      if (!s.firstGenMs || p.started_at_ms < s.firstGenMs) s.firstGenMs = p.started_at_ms;
      if (!s.lastGenMs || p.completed_at_ms > s.lastGenMs) s.lastGenMs = p.completed_at_ms;
    }

    if (it.type === 'AgentMessage') {
      const txt = (it.content || []).map((c) => c.text || '').join(' ').replace(/\s+/g, ' ').trim();
      if (txt) {
        s.latestCommentary = txt;
        s.stepCountInTurn++;
        pushRecentAction(s, tsMs, 'COMMENTARY', '💬', txt.slice(0, 220));
      }
    } else if (it.type === 'CommandExecution') {
      s.cmdCountInTurn++;
      s.stepCountInTurn++;
      s.pendingTool = '';
      s.lastEventKind = 'CMD_DONE';
      const cStr = cleanCodexCommandText(it.command);
      s.currentAction = `💻 ${cStr}`;
      pushRecentAction(s, tsMs, 'CMD', '💻', cStr);
    } else if (it.type === 'FileChange') {
      s.fileCountInTurn++;
      s.stepCountInTurn++;
      s.pendingTool = '';
      s.lastEventKind = 'FILE_DONE';
      const files = Object.keys(it.changes || {}).map((f) => basename(f));
      const fStr = `变更文件: ${files.join(', ')}`;
      s.currentAction = `📝 ${fStr}`;
      pushRecentAction(s, tsMs, 'FILE', '📝', fStr);
    } else if (it.type === 'Extension' || it.type === 'McpToolCall') {
      s.stepCountInTurn++;
      s.pendingTool = '';
      const label = it.query ? `搜索: ${it.query}` : `${it.kind || it.type}`;
      s.currentAction = `🔍 ${label}`;
      pushRecentAction(s, tsMs, 'TOOL', '🔍', label);
    } else if (it.type === 'Reasoning') {
      s.stepCountInTurn++;
      s.lastEventKind = 'REASONING';
    }
  } else if (evType === 'token_count') {
    if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) {
      s.latestRateLimits = p.rate_limits;
      if (tsMs > s.latestRateLimitsMs) s.latestRateLimitsMs = tsMs;
    }
    if (!p.info) return;

    const last = p.info.last_token_usage || {};
    const total = p.info.total_token_usage || {};
    const maxContext = p.info.model_context_window || 258400;
    const totalOut = total.output_tokens ?? 0;
    const totalAll = total.total_tokens ?? 0;
    s.latestTotalTokenUsage = total;

    const isNewStep =
      (totalOut !== s.prevTotalOutTokens || totalAll !== s.prevTotalTokens) &&
      ((last.output_tokens || 0) > 0 || (last.input_tokens || 0) > 0);

    if (isNewStep) {
      s.prevTotalOutTokens = totalOut;
      s.prevTotalTokens = totalAll;
      const outTok = last.output_tokens || 0;
      const thinkTok = last.reasoning_output_tokens || 0;
      const respTok = Math.max(0, outTok - thinkTok);
      const inTok = last.input_tokens || 0;
      const cacheTok = last.cached_input_tokens || 0;
      const ctxUsed = last.total_tokens || inTok + outTok;
      const cacheHitRate = inTok > 0 ? +((cacheTok / inTok) * 100).toFixed(1) : 0;
      const thinkingRatioPct = outTok > 0 ? +((thinkTok / outTok) * 100).toFixed(1) : 0;

      const endMs = s.lastGenMs || tsMs;
      const startMs = s.reqStartMs && endMs > s.reqStartMs ? s.reqStartMs : endMs - 2500;
      const e2eSec = Math.max(0.3, (endMs - startMs) / 1000);
      const streamSec =
        s.firstGenMs && s.firstGenMs >= startMs && endMs > s.firstGenMs
          ? Math.max(0.25, (endMs - s.firstGenMs) / 1000)
          : Math.max(0.25, e2eSec * 0.68);
      const ttftSec = Math.max(0.1, +(e2eSec - streamSec).toFixed(2));
      const effectiveTps = +(outTok / e2eSec).toFixed(1);
      const streamingTps = +(outTok / streamSec).toFixed(1);

      const exactModelId = s.curEffort ? `${s.curModel}-${s.curEffort}` : s.curModel;

      s.steps.push({
        turnNumber: s.steps.length + 1,
        // Keep pre-task_started steps at index 0 so they never collide with turn 1
        userTurnIndex: s.turnCount > 0 ? s.turnCount : 0,
        stepIndices: [s.steps.length + 1],
        requestedEnum: exactModelId,
        modelEnum: exactModelId,
        requestedModelId: exactModelId,
        exactModelId,
        modelLabel: `Codex ${s.curModel} (${s.curEffort || 'med'})`,
        modelTier: s.curEffort || 'med',
        responseModel: s.curModel,
        isRouteMismatch: false,
        apiProvider: 'OPENAI_CODEX',
        sessionID: threadId,
        responseId: s.latestResponseId,
        messageId: '',
        traceId: s.latestResponseId.slice(0, 18),
        retries: 0,
        rateLimitRetries: 0,
        netRetries: 0,
        retryReason: '',
        retryWaitSec: 0,
        retryError: '',
        sigKeyHex: '',
        sigBytes: 0,
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

      s.reqStartMs = s.nextReqStartMs || tsMs;
      s.firstGenMs = null;
      s.lastGenMs = null;
      s.nextReqStartMs = null;
    }
  }
}

function buildRolloutResult(s) {
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalSubstantiveTokens = 0;
  let totalSubstantiveGenSec = 0;
  let totalAllGenSec = 0;
  let totalE2ESec = 0;
  let peakStreamingTps = 0;
  let peakEffectiveTps = 0;
  let lastSubstantiveStep = null;

  for (const step of s.steps) {
    totalOutputTokens += step.outputTokens;
    totalThinkingTokens += step.thinkingTokens;
    totalAllGenSec += step.activeGenSec;
    totalE2ESec += step.totalSec;
    if (!step.isBufferedFlush) {
      totalSubstantiveTokens += step.outputTokens;
      totalSubstantiveGenSec += step.activeGenSec;
      lastSubstantiveStep = step;
      if (step.streamingTps > peakStreamingTps) peakStreamingTps = step.streamingTps;
    }
    if (step.effectiveTps > peakEffectiveTps) peakEffectiveTps = step.effectiveTps;
  }
  if (peakStreamingTps === 0 && s.steps.length > 0) {
    peakStreamingTps = Math.max(...s.steps.map((st) => st.streamingTps));
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
  const latestStep = s.steps.length > 0 ? s.steps[s.steps.length - 1] : null;
  const headlineStreamingTps =
    lastSubstantiveStep?.streamingTps || avgStreamingTps || latestStep?.streamingTps || 0;

  return {
    isCompleteFromStart: true,
    hasUnclosedTurn: Boolean(s.activeTurnId),
    activeTurnId: s.activeTurnId,
    targetWorkdir: s.targetWorkdir,
    turnCount: Math.max(s.turnCount, 1),
    turnStartedAtMs: s.turnStartedAtMs,
    turnCompletedAtMs: s.turnCompletedAtMs,
    lastTurnDurationSec: s.lastTurnDurationSec,
    lastRecordMs: s.lastRecordMs,
    curModel: s.curModel,
    curEffort: s.curEffort,
    stepCountInTurn: s.stepCountInTurn,
    cmdCountInTurn: s.cmdCountInTurn,
    fileCountInTurn: s.fileCountInTurn,
    latestCommentary: s.latestCommentary,
    currentAction: s.currentAction,
    pendingTool: s.pendingTool,
    lastEventKind: s.lastEventKind,
    recentActions: s.recentActions.slice(-16),
    latestRateLimits: s.latestRateLimits,
    latestRateLimitsMs: s.latestRateLimitsMs,
    latestTotalTokenUsage: s.latestTotalTokenUsage,
    compactionCount: s.compactionCount,
    streamErrorCount: s.streamErrorCount,
    rateLimitErrorCount: s.rateLimitErrorCount,
    lastErrorText: s.lastErrorText,
    steps: s.steps,
    codexTurns: s.codexTurns,
    summary: {
      totalInvocations: s.steps.length,
      totalOutputTokens,
      totalThinkingTokens,
      avgThinkingRatioPct,
      totalRetries: s.rateLimitErrorCount + s.streamErrorCount,
      totalRateLimitRetries: s.rateLimitErrorCount,
      totalNetRetries: s.streamErrorCount,
      routeMismatchCount: 0,
      sessionDriftCount: 0,
      headlineStreamingTps,
      avgStreamingTps,
      avgEffectiveTps,
      peakStreamingTps,
      peakEffectiveTps,
      sigKeyHex: latestStep?.sigKeyHex || '',
      sigBytes: latestStep?.sigBytes || 0,
      stopReason: s.activeTurnId ? 'IN_PROGRESS' : 'COMPLETED',
      healthLevel: s.rateLimitErrorCount > 0 ? 'WARN' : 'OK',
      healthBadges: [],
    },
  };
}

function pruneRolloutCache() {
  if (codexRolloutCache.size <= MAX_CACHE_ENTRIES) return;
  const entries = Array.from(codexRolloutCache.entries()).sort(
    (a, b) => (a[1].parsedAtMs || 0) - (b[1].parsedAtMs || 0)
  );
  const removeCount = entries.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < removeCount; i++) {
    codexRolloutCache.delete(entries[i][0]);
  }
}

export function parseCodexRolloutCached(rawRolloutPath, threadId, defaultModel, defaultEffort) {
  if (!rawRolloutPath) return null;
  const cleanPath = String(rawRolloutPath).replace(/^\\\\\?\\/, '');
  if (!existsSync(cleanPath)) return null;

  try {
    const fd = openSync(cleanPath, 'r');
    let st;
    let parserState;
    let startOffset = 0;

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

      if (cached && cached.parserState && st.size >= cached.byteOffset) {
        parserState = cached.parserState;
        startOffset = cached.byteOffset;
        if (st.mtimeMs > parserState.lastRecordMs) {
          parserState.lastRecordMs = st.mtimeMs;
        }
      } else {
        parserState = createInitialParserState(defaultModel, defaultEffort, st.mtimeMs);
        startOffset = 0;
      }

      // Stream full file from startOffset to st.size in bounded chunks (zero 1.5MB truncation!)
      let pos = startOffset;
      const decoder = new StringDecoder('utf8');
      const chunkBuf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, st.size - pos)));
      while (pos < st.size) {
        const toRead = Math.min(chunkBuf.length, st.size - pos);
        const bytesRead = readSync(fd, chunkBuf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;

        const decoded = decoder.write(chunkBuf.subarray(0, bytesRead));
        const text = parserState.pendingTail + decoded;
        const lines = text.split('\n');
        parserState.pendingTail = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          processRolloutLine(parserState, lines[i], threadId);
        }
      }
      const trailingUtf8 = decoder.end();
      if (trailingUtf8) {
        parserState.pendingTail += trailingUtf8;
      }

      // If the file ends without a trailing newline but contains a complete JSON line, parse it cleanly
      const trimmedTail = parserState.pendingTail.trim();
      if (trimmedTail && trimmedTail.startsWith('{') && trimmedTail.endsWith('}')) {
        try {
          JSON.parse(trimmedTail);
          processRolloutLine(parserState, trimmedTail, threadId);
          parserState.pendingTail = '';
        } catch {
          // Wait for remaining bytes on next append
        }
      }
    } finally {
      closeSync(fd);
    }

    const result = buildRolloutResult(parserState);
    codexRolloutCache.set(cleanPath, {
      fileSize: st.size,
      byteOffset: st.size,
      parsedAtMs: Date.now(),
      parserState,
      result,
    });
    pruneRolloutCache();
    return result;
  } catch {
    return null;
  }
}

export function clearCodexRolloutCacheForTest() {
  codexRolloutCache.clear();
}
