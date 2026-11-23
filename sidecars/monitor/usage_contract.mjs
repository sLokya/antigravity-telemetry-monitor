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
  return {
    fiveHourUsedPct: f5,
    weeklyUsedPct: fw,
    isApproxConcurrent: Boolean(b.isApproxConcurrent),
  };
}

export function normalizeQuotaUsage(q, fallbackPool = 'gemini') {
  if (!q || typeof q !== 'object') return null;

  if (q.byPool && typeof q.byPool === 'object') {
    const byPool = {};
    let anyApprox = Boolean(q.isApproxConcurrent);
    for (const key of Object.keys(q.byPool)) {
      const bucket = normalizePoolBucket(q.byPool[key]);
      if (bucket) {
        byPool[key] = bucket;
        if (bucket.isApproxConcurrent) anyApprox = true;
      }
    }
    return {
      byPool,
      isApproxConcurrent: anyApprox,
      source: q.source || 'live_snapshot',
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

  return {
    byPool: {
      [targetPool]: {
        fiveHourUsedPct: f5,
        weeklyUsedPct: fw,
        isApproxConcurrent: approx,
      },
    },
    isApproxConcurrent: approx,
    source: q.source || 'live_snapshot',
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
    source: q.source || 'live_snapshot',
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
  for (const pool of keys) {
    const pa = na.byPool?.[pool];
    const pb = nb.byPool?.[pool];
    if (!pa && !pb) continue;
    if (!pa) {
      byPool[pool] = { ...pb };
      if (pb.isApproxConcurrent) anyApprox = true;
      continue;
    }
    if (!pb) {
      byPool[pool] = { ...pa };
      if (pa.isApproxConcurrent) anyApprox = true;
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
    const isApproxConcurrent = Boolean(pa.isApproxConcurrent || pb.isApproxConcurrent);
    if (isApproxConcurrent) anyApprox = true;
    byPool[pool] = { fiveHourUsedPct, weeklyUsedPct, isApproxConcurrent };
  }

  return {
    byPool,
    isApproxConcurrent: anyApprox,
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

export function poolTokensFromTurn(turn) {
  const out = {};
  if (!turn || typeof turn !== 'object') return out;
  if (Array.isArray(turn.byModel) && turn.byModel.length > 0) {
    for (const m of turn.byModel) {
      const k = m.quotaGroupKey || turn.quotaGroupKey || 'gemini';
      out[k] = (out[k] || 0) + (m.totalTokens || 0);
    }
    return out;
  }
  const k = turn.quotaGroupKey || 'gemini';
  out[k] = turn.totalTokens || 0;
  return out;
}
