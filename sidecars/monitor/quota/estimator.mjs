import { loadQuotaRatesConfig, resolveModelQuotaRate } from './contract.mjs';

function round2(n) {
  return +Number(n).toFixed(2);
}

export function computeWeightedTokens(
  inputTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0,
  weights = loadQuotaRatesConfig().weights
) {
  const inT = Math.max(0, Number(inputTokens) || 0);
  const cacheT = Math.max(0, Number(cacheReadTokens) || 0);
  const outT = Math.max(0, Number(outputTokens) || 0);
  return inT * weights.input + cacheT * weights.cacheRead + outT * weights.output;
}

function inferFallbackPool(meta) {
  if (meta?.quotaGroupKey && (meta.quotaGroupKey === '3p' || meta.quotaGroupKey === 'codex' || meta.quotaGroupKey === 'gemini')) {
    return meta.quotaGroupKey;
  }
  const text = `${meta?.exactModelId || ''} ${meta?.modelLabel || ''} ${meta?.responseModel || ''}`;
  if (meta?.apiProvider === 'OPENAI_CODEX' || /\bastra\b|\bsol\b|\bcodex\b/i.test(text)) return 'codex';
  if (/claude|sonnet|opus|haiku|gpt/i.test(text)) return '3p';
  return 'gemini';
}

export function estimateQuotaFromByModel(byModel = [], fallbackMeta = null) {
  const config = loadQuotaRatesConfig();
  const accumByPool = new Map();

  const entries = Array.isArray(byModel) && byModel.length > 0
    ? byModel
    : fallbackMeta &&
        ((fallbackMeta.inputTokens || 0) > 0 ||
          (fallbackMeta.cacheReadTokens || 0) > 0 ||
          (fallbackMeta.outputTokens || 0) > 0 ||
          (fallbackMeta.totalTokens || 0) > 0)
      ? [
          {
            exactModelId: fallbackMeta.exactModelId || fallbackMeta.modelLabel || '',
            modelLabel: fallbackMeta.modelLabel || '',
            responseModel: fallbackMeta.responseModel || '',
            quotaGroupKey: inferFallbackPool(fallbackMeta),
            inputTokens: fallbackMeta.inputTokens || 0,
            cacheReadTokens: fallbackMeta.cacheReadTokens || 0,
            outputTokens: fallbackMeta.outputTokens || 0,
            totalTokens: fallbackMeta.totalTokens || 0,
          },
        ]
      : [];

  for (const m of entries) {
    if (!m || typeof m !== 'object') continue;
    const rawIn = Number(m.inputTokens) || 0;
    const rawCache = Number(m.cacheReadTokens) || 0;
    const rawOut = Number(m.outputTokens) || 0;
    const rawTotal = Number(m.totalTokens) || rawIn + rawCache + rawOut;
    if (rawTotal <= 0 && rawIn <= 0 && rawCache <= 0 && rawOut <= 0) continue;

    // If only totalTokens was stored without split, treat as uncached input fallback
    const wTok =
      rawIn > 0 || rawCache > 0 || rawOut > 0
        ? computeWeightedTokens(rawIn, rawCache, rawOut, config.weights)
        : rawTotal * config.weights.input;
    if (wTok <= 0) continue;

    const modelText = `${m.exactModelId || ''} ${m.modelLabel || ''} ${m.responseModel || ''}`;
    const rate = resolveModelQuotaRate(modelText, m.quotaGroupKey || fallbackMeta?.quotaGroupKey || 'gemini', config);
    const pct5h = wTok / rate.wTokPer1Pct5h;
    const pctWeek = pct5h * rate.weeklyTo5hRatio;

    const cur = accumByPool.get(rate.pool) || { sum5h: 0, sumWeek: 0, sumWTok: 0 };
    cur.sum5h += pct5h;
    cur.sumWeek += pctWeek;
    cur.sumWTok += wTok;
    accumByPool.set(rate.pool, cur);
  }

  if (accumByPool.size === 0) return null;

  const byPool = {};
  for (const [pool, acc] of accumByPool.entries()) {
    byPool[pool] = {
      fiveHourUsedPct: round2(acc.sum5h),
      weeklyUsedPct: round2(acc.sumWeek),
      weightedTokens: Math.round(acc.sumWTok),
      isApproxConcurrent: false,
      isEstimated: true,
    };
  }

  return {
    byPool,
    isApproxConcurrent: false,
    isEstimated: true,
    source: 'local_token_estimate',
  };
}

export function estimateTurnQuotaUsage(turn) {
  if (!turn || typeof turn !== 'object') return null;
  return estimateQuotaFromByModel(turn.byModel, {
    exactModelId: turn.exactModelId || turn.responseModel || '',
    modelLabel: turn.modelLabel || '',
    responseModel: turn.responseModel || '',
    apiProvider: turn.apiProvider || '',
    quotaGroupKey: turn.quotaGroupKey || '',
    inputTokens: turn.inputTokens || 0,
    cacheReadTokens: turn.cacheReadTokens || 0,
    outputTokens: turn.outputTokens || 0,
    totalTokens: turn.totalTokens || 0,
  });
}

export function estimateTotalsQuotaUsage(totals) {
  if (!totals || typeof totals !== 'object') return null;
  return estimateQuotaFromByModel(totals.byModel, {
    exactModelId: '',
    modelLabel: '',
    quotaGroupKey: 'gemini',
    inputTokens: totals.inputTokens || 0,
    cacheReadTokens: totals.cacheReadTokens || 0,
    outputTokens: totals.outputTokens || 0,
    totalTokens: totals.totalTokens || 0,
  });
}
