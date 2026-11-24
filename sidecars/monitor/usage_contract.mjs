export const POOL_KEYS = ['gemini', '3p', 'codex'];

function round2(n) {
  return +Number(n).toFixed(2);
}

function normalizePoolBucket(b) {
  if (!b || typeof b !== 'object') return null;
  const f5 = typeof b.fiveHourUsedPct === 'number' && Number.isFinite(b.fiveHourUsedPct)
    ? b.fiveHourUsedPct
    : null;
  const fw = typeof b.weeklyUsedPct === 'number' && Number.isFinite(b.weeklyUsedPct)
    ? b.weeklyUsedPct
    : null;
  const wt = typeof b.weightedTokens === 'number' && Number.isFinite(b.weightedTokens)
    ? b.weightedTokens
    : 0;
  return {
    fiveHourUsedPct: f5,
    weeklyUsedPct: fw,
    weightedTokens: wt,
    isApproxConcurrent: Boolean(b.isApproxConcurrent),
    isEstimated: Boolean(b.isEstimated),
  };
}

export function normalizeQuotaUsage(q, fallbackPool = 'gemini') {
  if (!q || typeof q !== 'object') return null;

  if (q.byPool && typeof q.byPool === 'object') {
    const byPool = {};
    let anyApprox = Boolean(q.isApproxConcurrent);
    let anyEst = Boolean(q.isEstimated || q.source === 'local_token_estimate');
    for (const key of Object.keys(q.byPool)) {
      const bucket = normalizePoolBucket(q.byPool[key]);
      if (bucket) {
        if (anyEst) bucket.isEstimated = true;
        byPool[key] = bucket;
        if (bucket.isApproxConcurrent) anyApprox = true;
        if (bucket.isEstimated) anyEst = true;
      }
    }
    return {
      byPool,
      isApproxConcurrent: anyApprox,
      isEstimated: anyEst,
      source: q.source || 'local_token_estimate',
    };
  }

  const f5 = typeof q.fiveHourUsedPct === 'number' && Number.isFinite(q.fiveHourUsedPct)
    ? q.fiveHourUsedPct
    : null;
  const fw = typeof q.weeklyUsedPct === 'number' && Number.isFinite(q.weeklyUsedPct)
    ? q.weeklyUsedPct
    : null;
  if (f5 === null && fw === null && q.source !== 'live_snapshot') {
    return null;
  }

  const targetPool =
    q.source === 'codex_rollout'
      ? 'codex'
      : POOL_KEYS.includes(fallbackPool)
        ? fallbackPool
        : 'gemini';
  const approx = Boolean(q.isApproxConcurrent);
  const est = Boolean(q.isEstimated || q.source === 'local_token_estimate');

  return {
    byPool: {
      [targetPool]: {
        fiveHourUsedPct: f5,
        weeklyUsedPct: fw,
        weightedTokens: typeof q.weightedTokens === 'number' ? q.weightedTokens : 0,
        isApproxConcurrent: approx,
        isEstimated: est,
      },
    },
    isApproxConcurrent: approx,
    isEstimated: est,
    source: q.source || 'local_token_estimate',
  };
}

function cloneQuotaUsage(q) {
  const byPool = {};
  for (const [k, v] of Object.entries(q.byPool || {})) {
    byPool[k] = { ...v };
  }
  return {
    byPool,
    isApproxConcurrent: Boolean(q.isApproxConcurrent),
    isEstimated: Boolean(q.isEstimated || q.source === 'local_token_estimate'),
    source: q.source || 'local_token_estimate',
  };
}

export function mergeQuotaUsage(a, b) {
  const na = normalizeQuotaUsage(a);
  const nb = normalizeQuotaUsage(b);
  if (!na && !nb) return null;
  if (!na) return cloneQuotaUsage(nb);
  if (!nb) return cloneQuotaUsage(na);

  const byPool = {};
  const keys = new Set([
    ...POOL_KEYS,
    ...Object.keys(na.byPool || {}),
    ...Object.keys(nb.byPool || {}),
  ]);

  let anyApprox = Boolean(na.isApproxConcurrent || nb.isApproxConcurrent);
  let anyEst = Boolean(na.isEstimated || nb.isEstimated);
  for (const pool of keys) {
    const pa = na.byPool?.[pool];
    const pb = nb.byPool?.[pool];
    if (!pa && !pb) continue;
    if (!pa) {
      byPool[pool] = { ...pb };
      if (pb.isApproxConcurrent) anyApprox = true;
      if (pb.isEstimated) anyEst = true;
      continue;
    }
    if (!pb) {
      byPool[pool] = { ...pa };
      if (pa.isApproxConcurrent) anyApprox = true;
      if (pa.isEstimated) anyEst = true;
      continue;
    }
    const fiveHourUsedPct =
      pa.fiveHourUsedPct === null && pb.fiveHourUsedPct === null
        ? null
        : round2((pa.fiveHourUsedPct ?? 0) + (pb.fiveHourUsedPct ?? 0));
    const weeklyUsedPct =
      pa.weeklyUsedPct === null && pb.weeklyUsedPct === null
        ? null
        : round2((pa.weeklyUsedPct ?? 0) + (pb.weeklyUsedPct ?? 0));
    const weightedTokens = Math.round((pa.weightedTokens || 0) + (pb.weightedTokens || 0));
    const isApproxConcurrent = Boolean(pa.isApproxConcurrent || pb.isApproxConcurrent);
    const isEstimated = Boolean(pa.isEstimated || pb.isEstimated);
    if (isApproxConcurrent) anyApprox = true;
    if (isEstimated) anyEst = true;
    byPool[pool] = { fiveHourUsedPct, weeklyUsedPct, weightedTokens, isApproxConcurrent, isEstimated };
  }

  return {
    byPool,
    isApproxConcurrent: anyApprox,
    isEstimated: anyEst,
    source: na.source === nb.source ? na.source : 'merged',
  };
}

export function emptyTotals() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    turnsCount: 0,
    cacheHitRate: 0,
    byModel: [],
    quotaUsage: null,
  };
}

function cloneModelEntry(m) {
  const exactModelId = m.exactModelId || m.modelKey || m.modelLabel || '--';
  const modelLabel = m.modelLabel || exactModelId;
  const modelKey = m.modelKey || exactModelId || modelLabel;
  return {
    modelKey,
    modelLabel,
    exactModelId,
    quotaGroupKey: m.quotaGroupKey || 'gemini',
    stepCount: m.stepCount || 0,
    inputTokens: m.inputTokens || 0,
    cacheReadTokens: m.cacheReadTokens || 0,
    outputTokens: m.outputTokens || 0,
    totalTokens: m.totalTokens || 0,
  };
}

export function turnToTotals(turn) {
  if (!turn || typeof turn !== 'object') return emptyTotals();
  const inputTokens = turn.inputTokens || 0;
  const cacheReadTokens = turn.cacheReadTokens || 0;
  const outputTokens = turn.outputTokens || 0;
  const thinkingTokens = turn.thinkingTokens || 0;
  const totalPrompt = inputTokens + cacheReadTokens;
  const totalTokens = turn.totalTokens ?? totalPrompt + outputTokens;
  const stepCount = turn.stepCount || 0;
  const cacheHitRate =
    totalPrompt > 0 ? +((cacheReadTokens / totalPrompt) * 100).toFixed(1) : 0;

  let byModel = [];
  if (Array.isArray(turn.byModel) && turn.byModel.length > 0) {
    byModel = turn.byModel.map(cloneModelEntry).sort((a, b) => b.totalTokens - a.totalTokens);
  } else if (totalTokens > 0 || stepCount > 0 || turn.exactModelId || turn.modelLabel) {
    const exactModelId = turn.exactModelId || turn.responseModel || '--';
    const modelLabel = turn.modelLabel || exactModelId;
    byModel = [
      {
        modelKey: exactModelId || modelLabel,
        modelLabel,
        exactModelId,
        quotaGroupKey: turn.quotaGroupKey || 'gemini',
        stepCount,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
      },
    ];
  }

  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    totalTokens,
    stepCount,
    turnsCount: 1,
    cacheHitRate,
    byModel,
    quotaUsage: normalizeQuotaUsage(turn.quotaUsage, turn.quotaGroupKey || 'gemini'),
  };
}

export function addTotals(...list) {
  const acc = emptyTotals();
  const modelMap = new Map();
  let quota = null;

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    acc.inputTokens += item.inputTokens || 0;
    acc.cacheReadTokens += item.cacheReadTokens || 0;
    acc.outputTokens += item.outputTokens || 0;
    acc.thinkingTokens += item.thinkingTokens || 0;
    acc.totalTokens += item.totalTokens || 0;
    acc.stepCount += item.stepCount || 0;
    acc.turnsCount += item.turnsCount || 0;

    if (Array.isArray(item.byModel)) {
      for (const raw of item.byModel) {
        if (!raw) continue;
        const m = cloneModelEntry(raw);
        const existing = modelMap.get(m.modelKey);
        if (!existing) {
          modelMap.set(m.modelKey, m);
        } else {
          existing.stepCount += m.stepCount;
          existing.inputTokens += m.inputTokens;
          existing.cacheReadTokens += m.cacheReadTokens;
          existing.outputTokens += m.outputTokens;
          existing.totalTokens += m.totalTokens;
          if ((!existing.modelLabel || existing.modelLabel === '--') && m.modelLabel) {
            existing.modelLabel = m.modelLabel;
          }
          if ((!existing.exactModelId || existing.exactModelId === '--') && m.exactModelId) {
            existing.exactModelId = m.exactModelId;
          }
        }
      }
    }

    if (item.quotaUsage) {
      quota = mergeQuotaUsage(quota, item.quotaUsage);
    }
  }

  const totalPrompt = acc.inputTokens + acc.cacheReadTokens;
  acc.cacheHitRate =
    totalPrompt > 0 ? +((acc.cacheReadTokens / totalPrompt) * 100).toFixed(1) : 0;
  acc.byModel = Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  acc.quotaUsage = quota;
  return acc;
}
