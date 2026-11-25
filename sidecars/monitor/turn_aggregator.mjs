import { estimateQuotaFromByModel } from './quota/index.mjs';

export function extractUserPromptPreview(rawContent, maxLen = 90) {
  if (!rawContent) return '';
  let text = String(rawContent);
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*$/i, '')
      .replace(/<[^>]+>/g, ' ');
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

const SYS_MSG_BOILERPLATE_RE =
  /The following is a <SYSTEM_MESSAGE> not actually sent by the user\.\s*It is provided by the system as important information to pay attention to\./gi;

export function buildWakeTurn(obj, idx, prevCreatedMs, prevWasSys, existingCount) {
  if (!obj || obj.type !== 'SYSTEM_MESSAGE') return null;
  const createdAtMs = obj.created_at ? Date.parse(obj.created_at) || 0 : 0;
  const isNewWake =
    existingCount === 0 ||
    (!prevWasSys && prevCreatedMs > 0 && createdAtMs > 0 && createdAtMs - prevCreatedMs >= 20000);
  if (!isNewWake) return null;
  const stripped = String(obj.content || '').replace(SYS_MSG_BOILERPLATE_RE, '');
  return {
    stepIndex: obj.step_index ?? idx,
    createdAtMs,
    promptPreview: extractUserPromptPreview(stripped),
  };
}

export function resolveQuotaGroupKey(engine, modelText) {
  if (engine === 'CODEX') return 'codex';
  return /claude|sonnet|opus|gpt/i.test(String(modelText || '')) ? '3p' : 'gemini';
}

function summarizeStepGroup(groupSteps, meta) {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let substantiveOut = 0;
  let substantiveSec = 0;
  let totalE2ESec = 0;
  let retries = 0;
  let rateLimitRetries = 0;
  let netRetries = 0;
  let hasRouteMismatch = false;
  let hasCacheShock = false;
  let hasCotCollapsed = false;
  let lastSubstantive = null;

  const byModelMap = new Map();

  for (const s of groupSteps) {
    const sIn = s.inputTokens || 0;
    const sCache = s.cacheReadTokens || 0;
    const sOut = s.outputTokens || 0;
    inputTokens += sIn;
    cacheReadTokens += sCache;
    outputTokens += sOut;
    thinkingTokens += s.thinkingTokens || 0;
    responseTokens += s.responseTokens || 0;
    totalE2ESec += s.totalSec || 0;
    retries += s.retries || 0;
    rateLimitRetries += s.rateLimitRetries || 0;
    netRetries += s.netRetries || 0;
    if (s.isRouteMismatch) hasRouteMismatch = true;
    if (s.isCacheShock) hasCacheShock = true;
    if (s.isCotCollapsed) hasCotCollapsed = true;

    const mExact = s.exactModelId || s.modelLabel || meta.fallbackExactModelId || '--';
    const mLabel = s.modelLabel || mExact || meta.fallbackModelLabel || 'Auto';
    const mKey = s.exactModelId || s.modelLabel || mExact;
    let mRec = byModelMap.get(mKey);
    if (!mRec) {
      mRec = {
        modelKey: mKey,
        modelLabel: mLabel,
        exactModelId: mExact,
        quotaGroupKey: resolveQuotaGroupKey(
          meta.engine,
          `${mLabel} ${mExact} ${s.responseModel || ''}`
        ),
        stepCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      byModelMap.set(mKey, mRec);
    }
    mRec.stepCount += 1;
    mRec.inputTokens += sIn;
    mRec.cacheReadTokens += sCache;
    mRec.outputTokens += sOut;
    mRec.totalTokens += sIn + sCache + sOut;

    if (!s.isBufferedFlush && (s.streamingTps || 0) > 0 && (s.activeGenSec || 0) > 0) {
      substantiveOut += sOut;
      substantiveSec += s.activeGenSec || 0;
      lastSubstantive = s;
    }
  }

  const byModel = Array.from(byModelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);

  const latest = groupSteps.length > 0 ? groupSteps[groupSteps.length - 1] : null;
  const totalPromptTokens = inputTokens + cacheReadTokens;
  const totalTokens = totalPromptTokens + outputTokens;
  const cacheHitRate =
    totalPromptTokens > 0 ? +((cacheReadTokens / totalPromptTokens) * 100).toFixed(1) : 0;
  const streamingTps =
    substantiveSec > 0.2
      ? +(substantiveOut / substantiveSec).toFixed(1)
      : lastSubstantive?.streamingTps || 0;
  const effectiveTps = totalE2ESec > 0.05 ? +(outputTokens / totalE2ESec).toFixed(1) : 0;
  const modelLabel = latest?.modelLabel || meta.fallbackModelLabel || 'Auto';
  const exactModelId = latest?.exactModelId || meta.fallbackExactModelId || '--';
  const responseModel = latest?.responseModel || exactModelId || '--';

  const compactSteps = groupSteps.map((s) => ({
    turnNumber: s.turnNumber,
    exactModelId: s.exactModelId,
    responseModel: s.responseModel,
    apiProvider: s.apiProvider,
    streamingTps: s.streamingTps,
    effectiveTps: s.effectiveTps,
    isBufferedFlush: Boolean(s.isBufferedFlush),
    ttftSec: s.ttftSec,
    streamSec: s.streamSec,
    thinkingRatioPct: s.thinkingRatioPct,
    inputTokens: s.inputTokens || 0,
    cacheReadTokens: s.cacheReadTokens || 0,
    outputTokens: s.outputTokens || 0,
    thinkingTokens: s.thinkingTokens || 0,
    responseTokens: s.responseTokens || 0,
    cacheHitRate: s.cacheHitRate || 0,
    retries: s.retries || 0,
    rateLimitRetries: s.rateLimitRetries || 0,
    netRetries: s.netRetries || 0,
    retryReason: s.retryReason || '',
    retryError: s.retryError || '',
    pureQueueSec: s.pureQueueSec || 0,
    isRouteMismatch: Boolean(s.isRouteMismatch),
    isCotCollapsed: Boolean(s.isCotCollapsed),
    isCacheShock: Boolean(s.isCacheShock),
  }));

  const quotaGroupKey = resolveQuotaGroupKey(
    meta.engine,
    `${modelLabel} ${exactModelId} ${responseModel}`
  );
  const quotaUsage = estimateQuotaFromByModel(byModel, {
    exactModelId,
    modelLabel,
    quotaGroupKey,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
  });

  return {
    turnId: meta.turnId,
    turnNumber: meta.turnNumber,
    promptPreview: meta.promptPreview || `轮次 #${meta.turnNumber}`,
    startedAtMs: meta.startedAtMs || 0,
    completedAtMs: meta.completedAtMs || 0,
    isRunning: Boolean(meta.isRunning),
    status: meta.isRunning ? 'RUNNING' : meta.isAborted ? 'ABORTED' : 'DONE',
    modelLabel,
    exactModelId,
    responseModel,
    apiProvider: latest?.apiProvider || (meta.engine === 'CODEX' ? 'OPENAI_CODEX' : '--'),
    quotaGroupKey,
    stepCount: groupSteps.length,
    modelCount: byModel.length,
    byModel,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    totalTokens,
    cacheHitRate,
    streamingTps,
    effectiveTps,
    ttftSec: latest?.ttftSec || 0,
    totalSec: +totalE2ESec.toFixed(2),
    contextUsed: latest?.contextUsed || 0,
    maxContext: latest?.maxContext || 256000,
    retries,
    rateLimitRetries,
    netRetries,
    hasRouteMismatch,
    hasCacheShock,
    hasCotCollapsed,
    quotaUsage,
    steps: compactSteps,
  };
}

export function aggregateStepsToTurns({
  convId,
  engine,
  steps = [],
  userTurns = [],
  wakeTurns = [],
  firstCreatedAtMs = 0,
  codexTurns = [],
  isConvRunning = false,
  fallbackModelLabel = 'Auto',
  fallbackExactModelId = '--',
}) {
  const turns = [];

  if (engine === 'CODEX') {
    const byIdx = new Map();
    for (const ct of codexTurns) {
      byIdx.set(ct.turnIndex, { meta: ct, steps: [] });
    }
    for (const s of steps) {
      const idx = typeof s.userTurnIndex === 'number' ? s.userTurnIndex : 1;
      if (!byIdx.has(idx)) {
        byIdx.set(idx, {
          meta: {
            turnIndex: idx,
            turnId: `t-${idx}`,
            promptPreview: `Codex 轮次 #${idx}`,
            startedAtMs: 0,
            completedAtMs: 0,
            isAborted: false,
          },
          steps: [],
        });
      }
      byIdx.get(idx).steps.push(s);
    }

    const sortedEntries = Array.from(byIdx.entries()).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < sortedEntries.length; i++) {
      const [turnIdx, bucket] = sortedEntries[i];
      const isLast = i === sortedEntries.length - 1;
      const m = bucket.meta;
      turns.push(
        summarizeStepGroup(bucket.steps, {
          engine,
          turnId: `${convId}:${m.turnId || `t-${turnIdx}`}`,
          turnNumber: i + 1,
          promptPreview: m.promptPreview || `Codex 轮次 #${i + 1}`,
          startedAtMs: m.startedAtMs || 0,
          completedAtMs: m.completedAtMs || 0,
          isRunning: isLast && isConvRunning,
          isAborted: Boolean(m.isAborted),
          fallbackModelLabel,
          fallbackExactModelId,
        })
      );
    }
    return turns;
  }

  // Antigravity: map generatorMetadata steps to transcript USER_INPUT boundaries (or wake turns for subagents)
  const isWakeSource = userTurns.length === 0 && wakeTurns.length > 0;
  const boundaries = userTurns.length > 0 ? userTurns : wakeTurns;
  const sortedUt = [...boundaries].sort((a, b) => a.stepIndex - b.stepIndex);
  if (sortedUt.length === 0) {
    if (steps.length > 0) {
      turns.push(
        summarizeStepGroup(steps, {
          engine,
          turnId: `${convId}:t-1`,
          turnNumber: 1,
          promptPreview: '会话轮次 #1',
          startedAtMs: firstCreatedAtMs || 0,
          completedAtMs: 0,
          isRunning: isConvRunning,
          isAborted: false,
          quotaUsage: null,
          fallbackModelLabel,
          fallbackExactModelId,
        })
      );
    }
    return turns;
  }

  const buckets = sortedUt.map((ut, idx) => ({
    ut,
    turnNumber: idx + 1,
    steps: [],
  }));

  for (const s of steps) {
    const indices = Array.isArray(s.stepIndices) && s.stepIndices.length > 0 ? s.stepIndices : null;
    const minIdx = indices ? Math.min(...indices) : null;
    let targetIdx = buckets.length - 1;
    if (minIdx !== null) {
      targetIdx = 0;
      for (let b = 0; b < buckets.length; b++) {
        if (buckets[b].ut.stepIndex <= minIdx) {
          targetIdx = b;
        } else {
          break;
        }
      }
    }
    buckets[targetIdx].steps.push(s);
  }

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const isLast = i === buckets.length - 1;
    const nextUt = !isLast ? buckets[i + 1].ut : null;
    turns.push(
      summarizeStepGroup(b.steps, {
        engine,
        turnId: `${convId}:step:${b.ut.stepIndex}`,
        turnNumber: b.turnNumber,
        promptPreview: b.ut.promptPreview || `${isWakeSource ? '唤醒' : '轮次'} #${b.turnNumber}`,
        startedAtMs: b.ut.createdAtMs || 0,
        completedAtMs: isLast && isConvRunning ? 0 : nextUt?.createdAtMs || 0,
        isRunning: isLast && isConvRunning,
        isAborted: false,
        quotaUsage: null,
        fallbackModelLabel,
        fallbackExactModelId,
      })
    );
  }

  return turns;
}

export function computeConversationTurnMetrics(turns = [], steps = [], isConvRunning = false) {
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalSubstantiveOut = 0;
  let totalSubstantiveSec = 0;
  let totalE2ESec = 0;

  for (const s of steps) {
    totalInput += s.inputTokens || 0;
    totalCacheRead += s.cacheReadTokens || 0;
    totalOutput += s.outputTokens || 0;
    totalE2ESec += s.totalSec || 0;
    if (!s.isBufferedFlush && (s.streamingTps || 0) > 0 && (s.activeGenSec || 0) > 0) {
      totalSubstantiveOut += s.outputTokens || 0;
      totalSubstantiveSec += s.activeGenSec || 0;
    }
  }

  const totalPrompt = totalInput + totalCacheRead;
  const avgCacheHitRate =
    totalPrompt > 0 ? +((totalCacheRead / totalPrompt) * 100).toFixed(1) : 0;
  const avgStreamingTps =
    totalSubstantiveSec > 0.5
      ? +(totalSubstantiveOut / totalSubstantiveSec).toFixed(1)
      : 0;
  const avgEffectiveTps =
    totalE2ESec > 0.05 ? +(totalOutput / totalE2ESec).toFixed(1) : 0;
  const totalAllTokens = totalPrompt + totalOutput;

  const currentTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const isCurrentRunning = Boolean(isConvRunning && currentTurn);

  return {
    avgStreamingTps,
    avgEffectiveTps,
    avgCacheHitRate,
    totalAllTokens,
    totalInputTokens: totalInput,
    totalCacheReadTokens: totalCacheRead,
    totalOutputTokens: totalOutput,
    currentTurn,
    isCurrentRunning,
  };
}
