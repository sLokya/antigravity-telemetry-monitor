import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const QUOTA_RATES_OVERRIDE_FILE = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'telemetry_quota_rates.json'
);

export const FAMILY_QUOTA_STATE_FILE = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'telemetry_family_quota.json'
);

export const CALIBRATION_STATE_FILE = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'telemetry_quota_calibration.json'
);

export const DEFAULT_FAMILY_DETECTION = Object.freeze({
  minFiveHourExcessPct: 2.0,
  minWeeklyExcessPct: 1.0,
  minRelativeRatio: 0.35,
  refillResetPct: 1.0,
  resetShiftMs: 10 * 60 * 1000,
});

export const DEFAULT_CALIBRATION_RULES = Object.freeze({
  minActualDrop5hPct: 2.0,
  minLocalEst5hPct: 0.3,
  minWeeklyDropForRatioPct: 0.5,
  overestimateMinDiffPct: 2.0,
  overestimateMinRatio: 1.35,
  overestimateSettleMs: 20 * 1000,
  minScaleFactor: 0.2,
  maxScaleFactor: 5.0,
  minWTokPer1Pct5h: 2000,
  maxWTokPer1Pct5h: 20000000,
});

export const DEFAULT_TOKEN_WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  output: 5.0,
});

// Calibrated from solo-turn baselines (upper-quartile wTok per 1% of 5h quota)
// so shared-account / concurrent usage cannot contaminate per-turn cost.
export const DEFAULT_POOL_RATES = Object.freeze({
  gemini: Object.freeze({ wTokPer1Pct5h: 800000, weeklyTo5hRatio: 0.25 }),
  '3p': Object.freeze({ wTokPer1Pct5h: 85000, weeklyTo5hRatio: 0.5 }),
  codex: Object.freeze({ wTokPer1Pct5h: 80000, weeklyTo5hRatio: 0.25 }),
});

export const DEFAULT_MODEL_PATTERNS = Object.freeze([
  { match: /claude.*opus/i, pool: '3p', wTokPer1Pct5h: 85000, weeklyTo5hRatio: 0.5 },
  { match: /claude.*sonnet/i, pool: '3p', wTokPer1Pct5h: 170000, weeklyTo5hRatio: 0.5 },
  { match: /claude.*haiku/i, pool: '3p', wTokPer1Pct5h: 450000, weeklyTo5hRatio: 0.5 },
  { match: /\bastra\b/i, pool: 'codex', wTokPer1Pct5h: 8000, weeklyTo5hRatio: 0.16 },
  { match: /\bsol\b|\bcodex\b/i, pool: 'codex', wTokPer1Pct5h: 80000, weeklyTo5hRatio: 0.25 },
  { match: /\b(hydrogen|flash|lite|mini)\b/i, pool: 'gemini', wTokPer1Pct5h: 1800000, weeklyTo5hRatio: 0.25 },
  { match: /\b(neon|carbon|pro|gemini)\b/i, pool: 'gemini', wTokPer1Pct5h: 800000, weeklyTo5hRatio: 0.25 },
]);

let cachedConfig = null;
let cachedAtMs = 0;
let cachedMtimeMs = -1;

function validPos(n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

function validNonNeg(n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadQuotaRatesConfig(nowMs = Date.now()) {
  if (cachedConfig && nowMs - cachedAtMs < 5000) {
    return cachedConfig;
  }
  cachedAtMs = nowMs;

  let mtimeMs = -1;
  try {
    if (existsSync(QUOTA_RATES_OVERRIDE_FILE)) {
      mtimeMs = statSync(QUOTA_RATES_OVERRIDE_FILE).mtimeMs;
    }
  } catch {
    mtimeMs = -1;
  }

  if (cachedConfig && mtimeMs === cachedMtimeMs) {
    return cachedConfig;
  }
  cachedMtimeMs = mtimeMs;

  let userOverride = null;
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(QUOTA_RATES_OVERRIDE_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        userOverride = parsed;
      }
    } catch {
      userOverride = null;
    }
  }

  const weights = {
    input: validNonNeg(userOverride?.tokenWeights?.input, DEFAULT_TOKEN_WEIGHTS.input),
    cacheRead: validNonNeg(userOverride?.tokenWeights?.cacheRead, DEFAULT_TOKEN_WEIGHTS.cacheRead),
    output: validNonNeg(userOverride?.tokenWeights?.output, DEFAULT_TOKEN_WEIGHTS.output),
  };

  const pools = {};
  for (const [pk, def] of Object.entries(DEFAULT_POOL_RATES)) {
    const ov = userOverride?.pools?.[pk];
    pools[pk] = {
      wTokPer1Pct5h: validPos(ov?.wTokPer1Pct5h, def.wTokPer1Pct5h),
      weeklyTo5hRatio: validNonNeg(ov?.weeklyTo5hRatio, def.weeklyTo5hRatio),
    };
  }

  const customModels = {};
  if (userOverride?.models && typeof userOverride.models === 'object') {
    for (const [mk, ov] of Object.entries(userOverride.models)) {
      if (!ov || typeof ov !== 'object') continue;
      customModels[mk.toLowerCase()] = {
        pool: typeof ov.pool === 'string' ? ov.pool : null,
        wTokPer1Pct5h: validPos(ov.wTokPer1Pct5h, 0),
        weeklyTo5hRatio: validNonNeg(ov.weeklyTo5hRatio, -1),
      };
    }
  }

  const familyDetection = {
    minFiveHourExcessPct: validPos(
      userOverride?.familyDetection?.minFiveHourExcessPct,
      DEFAULT_FAMILY_DETECTION.minFiveHourExcessPct
    ),
    minWeeklyExcessPct: validPos(
      userOverride?.familyDetection?.minWeeklyExcessPct,
      DEFAULT_FAMILY_DETECTION.minWeeklyExcessPct
    ),
    minRelativeRatio: validNonNeg(
      userOverride?.familyDetection?.minRelativeRatio,
      DEFAULT_FAMILY_DETECTION.minRelativeRatio
    ),
    refillResetPct: validPos(
      userOverride?.familyDetection?.refillResetPct,
      DEFAULT_FAMILY_DETECTION.refillResetPct
    ),
    resetShiftMs: validPos(
      userOverride?.familyDetection?.resetShiftMs,
      DEFAULT_FAMILY_DETECTION.resetShiftMs
    ),
  };

  cachedConfig = { weights, pools, customModels, familyDetection };
  return cachedConfig;
}

export function resolveModelQuotaRate(modelText, poolKey, config = loadQuotaRatesConfig()) {
  const safePool = config.pools[poolKey] ? poolKey : 'gemini';
  const poolDef = config.pools[safePool];
  const raw = String(modelText || '').trim();
  const lower = raw.toLowerCase();

  if (lower && config.customModels) {
    for (const [key, ov] of Object.entries(config.customModels)) {
      if (lower.includes(key)) {
        const targetPool = ov.pool && config.pools[ov.pool] ? ov.pool : safePool;
        const base = config.pools[targetPool] || poolDef;
        return {
          pool: targetPool,
          wTokPer1Pct5h: ov.wTokPer1Pct5h > 0 ? ov.wTokPer1Pct5h : base.wTokPer1Pct5h,
          weeklyTo5hRatio: ov.weeklyTo5hRatio >= 0 ? ov.weeklyTo5hRatio : base.weeklyTo5hRatio,
        };
      }
    }
  }

  for (const pat of DEFAULT_MODEL_PATTERNS) {
    if (pat.match.test(raw)) {
      const targetPool = config.pools[poolKey] ? poolKey : pat.pool;
      const base = config.pools[targetPool] || poolDef;
      const defPool = DEFAULT_POOL_RATES[targetPool];
      const poolScale = defPool?.wTokPer1Pct5h > 0 ? base.wTokPer1Pct5h / defPool.wTokPer1Pct5h : 1;
      return {
        pool: targetPool,
        wTokPer1Pct5h: Math.round(pat.wTokPer1Pct5h * poolScale),
        weeklyTo5hRatio: base.weeklyTo5hRatio !== defPool?.weeklyTo5hRatio
          ? base.weeklyTo5hRatio
          : pat.weeklyTo5hRatio,
      };
    }
  }

  return {
    pool: safePool,
    wTokPer1Pct5h: poolDef.wTokPer1Pct5h,
    weeklyTo5hRatio: poolDef.weeklyTo5hRatio,
  };
}

export function invalidateQuotaRatesCache() {
  cachedConfig = null;
  cachedAtMs = 0;
  cachedMtimeMs = -1;
}

export function readRawQuotaRatesOverride(overrideFile = QUOTA_RATES_OVERRIDE_FILE) {
  try {
    if (!existsSync(overrideFile)) return null;
    const parsed = JSON.parse(readFileSync(overrideFile, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveQuotaPoolRateOverride(
  poolKey,
  { wTokPer1Pct5h, weeklyTo5hRatio, calibratedAtMs = Date.now(), note = '' },
  overrideFile = QUOTA_RATES_OVERRIDE_FILE
) {
  if (!DEFAULT_POOL_RATES[poolKey]) {
    throw new Error(`Unknown quota pool: ${poolKey}`);
  }
  const existing = readRawQuotaRatesOverride(overrideFile) || {};
  const nextPools = { ...(existing.pools || {}) };
  const prevPool = nextPools[poolKey] || {};
  const nextEntry = {
    ...prevPool,
    wTokPer1Pct5h: Math.round(validPos(wTokPer1Pct5h, DEFAULT_POOL_RATES[poolKey].wTokPer1Pct5h)),
    weeklyTo5hRatio: +validNonNeg(weeklyTo5hRatio, DEFAULT_POOL_RATES[poolKey].weeklyTo5hRatio).toFixed(4),
    calibratedAtMs,
  };
  if (note) nextEntry.note = note;
  nextPools[poolKey] = nextEntry;

  const nextDoc = {
    ...existing,
    updatedAtMs: calibratedAtMs,
    pools: nextPools,
  };
  const dir = dirname(overrideFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(overrideFile, JSON.stringify(nextDoc, null, 2), 'utf-8');
  if (overrideFile === QUOTA_RATES_OVERRIDE_FILE) {
    invalidateQuotaRatesCache();
  }
  return nextEntry;
}

export function resetQuotaRatesOverride(poolKey = '', overrideFile = QUOTA_RATES_OVERRIDE_FILE) {
  const existing = readRawQuotaRatesOverride(overrideFile);
  if (!existing) {
    if (overrideFile === QUOTA_RATES_OVERRIDE_FILE) invalidateQuotaRatesCache();
    return { removedAll: true };
  }

  if (!poolKey) {
    try {
      if (existsSync(overrideFile)) unlinkSync(overrideFile);
    } catch {
      writeFileSync(overrideFile, JSON.stringify({ updatedAtMs: Date.now(), pools: {} }, null, 2), 'utf-8');
    }
    if (overrideFile === QUOTA_RATES_OVERRIDE_FILE) invalidateQuotaRatesCache();
    return { removedAll: true };
  }

  const nextPools = { ...(existing.pools || {}) };
  delete nextPools[poolKey];
  const hasOtherOverrides =
    Object.keys(nextPools).length > 0 ||
    (existing.models && Object.keys(existing.models).length > 0) ||
    Boolean(existing.tokenWeights) ||
    Boolean(existing.familyDetection);

  if (!hasOtherOverrides) {
    try {
      if (existsSync(overrideFile)) unlinkSync(overrideFile);
    } catch {
      writeFileSync(overrideFile, JSON.stringify({ updatedAtMs: Date.now(), pools: {} }, null, 2), 'utf-8');
    }
  } else {
    writeFileSync(
      overrideFile,
      JSON.stringify({ ...existing, updatedAtMs: Date.now(), pools: nextPools }, null, 2),
      'utf-8'
    );
  }
  if (overrideFile === QUOTA_RATES_OVERRIDE_FILE) invalidateQuotaRatesCache();
  return { removedAll: !hasOtherOverrides };
}
