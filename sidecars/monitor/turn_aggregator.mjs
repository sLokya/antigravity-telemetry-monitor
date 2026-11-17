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

  for (const s of groupSteps) {
    inputTokens += s.inputTokens || 0;
    cacheReadTokens += s.cacheReadTokens || 0;
    outputTokens += s.outputTokens || 0;
    thinkingTokens += s.thinkingTokens || 0;
    responseTokens += s.responseTokens || 0;
    totalE2ESec += s.totalSec || 0;
    retries += s.retries || 0;
    rateLimitRetries += s.rateLimitRetries || 0;
    netRetries += s.netRetries || 0;
    if (s.isRouteMismatch) hasRouteMismatch = true;
    if (s.isCacheShock) hasCacheShock = true;
    if (s.isCotCollapsed) hasCotCollapsed = true;

    if (!s.isBufferedFlush && (s.streamingTps || 0) > 0 && (s.activeGenSec || 0) > 0) {
      substantiveOut += s.outputTokens || 0;
      substantiveSec += s.activeGenSec || 0;
      lastSubstantive = s;
    }
  }

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
    quotaGroupKey: resolveQuotaGroupKey(
      meta.engine,
      `${modelLabel} ${exactModelId} ${responseModel}`
    ),
    stepCount: groupSteps.length,
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
    quotaUsage: meta.quotaUsage || null,
    steps: compactSteps,
  };
}

function computeCodexTurnQuota(startRl, endRl) {
  if (!startRl || !endRl) return null;
  const calcBucket = (startB, endB) => {
    if (!startB || !endB) return null;
    if (
      typeof startB.used_percent !== 'number' ||
      typeof endB.used_percent !== 'number'
    ) {
      return null;
    }
    if (startB.resets_at && endB.resets_at && startB.resets_at !== endB.resets_at) {
      return null;
    }
    if (endB.used_percent < startB.used_percent) return null;
    return +(endB.used_percent - startB.used_percent).toFixed(2);
  };
  const fiveHourUsedPct = calcBucket(startRl.primary, endRl.primary);
  const weeklyUsedPct = calcBucket(startRl.secondary, endRl.secondary);
  if (fiveHourUsedPct === null && weeklyUsedPct === null) return null;
  return {
    fiveHourUsedPct,
    weeklyUsedPct,
    isApproxConcurrent: false,
    source: 'codex_rollout',
  };
}

export function aggregateStepsToTurns({
  convId,
  engine,
  steps = [],
  userTurns = [],
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
      const idx = s.userTurnIndex || 1;
      if (!byIdx.has(idx)) {
        byIdx.set(idx, {
          meta: {
            turnIndex: idx,
            turnId: `t-${idx}`,
            promptPreview: `Codex 轮次 #${idx}`,
            startedAtMs: 0,
            completedAtMs: 0,
            isAborted: false,
            startRateLimits: null,
            endRateLimits: null,
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
      const quotaUsage = computeCodexTurnQuota(m.startRateLimits, m.endRateLimits);
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
          quotaUsage,
          fallbackModelLabel,
          fallbackExactModelId,
        })
      );
    }
    return turns;
  }

  // Antigravity: map generatorMetadata steps to transcript USER_INPUT boundaries
  const sortedUt = [...userTurns].sort((a, b) => a.stepIndex - b.stepIndex);
  if (sortedUt.length === 0) {
    if (steps.length > 0) {
      turns.push(
        summarizeStepGroup(steps, {
          engine,
          turnId: `${convId}:t-1`,
          turnNumber: 1,
          promptPreview: '会话轮次 #1',
          startedAtMs: 0,
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
        promptPreview: b.ut.promptPreview || `轮次 #${b.turnNumber}`,
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
