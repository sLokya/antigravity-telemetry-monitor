import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CALIBRATION_STATE_FILE,
  DEFAULT_CALIBRATION_RULES,
  DEFAULT_POOL_RATES,
  QUOTA_RATES_OVERRIDE_FILE,
  getPoolRateSignature,
  loadQuotaRatesConfig,
  readRawQuotaRatesOverride,
  resolveModelQuotaRate,
  resetQuotaRatesOverride,
  saveQuotaPoolRateOverride,
} from './contract.mjs';

const POOLS = ['gemini', '3p', 'codex'];
const WINDOWS = ['fiveHour', 'weekly'];
const FLUSH_INTERVAL_MS = 4000;

let state = null;
let dirty = false;
let lastFlushMs = 0;
let lastFileMtimeMs = -1;

function round2(n) {
  return +Number(n).toFixed(2);
}

function round4(n) {
  return +Number(n).toFixed(4);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function readBucketPct(bucket) {
  if (!bucket || bucket.isFallback) return null;
  const frac = bucket?.remainingFraction;
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return null;
  return round4(Math.min(1, Math.max(0, frac)) * 100);
}

function parseIsoMs(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function loadState(stateFile = CALIBRATION_STATE_FILE) {
  let diskMtime = -1;
  try {
    if (existsSync(stateFile)) diskMtime = statSync(stateFile).mtimeMs;
  } catch {
    diskMtime = -1;
  }
  if (state && state._file === stateFile && diskMtime === lastFileMtimeMs) return state;
  lastFileMtimeMs = diskMtime;
  if (diskMtime >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.pools && typeof parsed.pools === 'object') {
        state = {
          _file: stateFile,
          version: 1,
          updatedAtMs: Number(parsed.updatedAtMs) || Date.now(),
          knownConvEst: parsed.knownConvEst && typeof parsed.knownConvEst === 'object' ? parsed.knownConvEst : {},
          reseedPools: parsed.reseedPools && typeof parsed.reseedPools === 'object' ? parsed.reseedPools : {},
          poolRateSigs: parsed.poolRateSigs && typeof parsed.poolRateSigs === 'object' ? parsed.poolRateSigs : {},
          pools: parsed.pools,
        };
        return state;
      }
    } catch { /* start fresh on corrupt state file */ }
  }
  state = { _file: stateFile, version: 1, updatedAtMs: 0, knownConvEst: null, reseedPools: {}, poolRateSigs: {}, pools: {} };
  return state;
}

function saveState(st, nowMs, force = false) {
  if (!st || !st._file) return;
  if (!force && (!dirty || nowMs - lastFlushMs < FLUSH_INTERVAL_MS)) return;
  try {
    const dir = dirname(st._file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const { _file: _drop, ...serializable } = st;
    serializable.updatedAtMs = nowMs;
    writeFileSync(st._file, JSON.stringify(serializable, null, 2), 'utf-8');
    lastFileMtimeMs = statSync(st._file).mtimeMs;
    dirty = false;
    lastFlushMs = nowMs;
  } catch {
    // ignore disk write errors
  }
}

function extractPoolSnapshots(quotaGroups, codexQuota) {
  const qg = quotaGroups && typeof quotaGroups === 'object' ? quotaGroups : {};
  return {
    gemini: qg.gemini || null,
    '3p': qg['3p'] || null,
    codex: codexQuota || qg.codex || null,
  };
}

function cloneConvEstimates(localConvEstimates) {
  const out = {};
  if (!localConvEstimates || typeof localConvEstimates !== 'object') return out;
  for (const [cid, perPool] of Object.entries(localConvEstimates)) {
    if (!perPool || typeof perPool !== 'object') continue;
    const entry = {};
    for (const pk of POOLS) {
      const v = perPool[pk];
      if (!v) continue;
      const h5 = Number(v.h5) || 0;
      const wk = Number(v.wk) || 0;
      const wTok = Number(v.wTok) || 0;
      if (h5 > 0 || wk > 0 || wTok > 0) {
        entry[pk] = { h5: round4(h5), wk: round4(wk), wTok: Math.round(wTok) };
      }
    }
    if (Object.keys(entry).length > 0) out[cid] = entry;
  }
  return out;
}

function computeLocalDeltas(st, localConvEstimates) {
  const deltas = {};
  for (const pk of POOLS) {
    deltas[pk] = { fiveHour: 0, weekly: 0, wTok: 0 };
  }

  const nextKnown = cloneConvEstimates(localConvEstimates);
  if (st.knownConvEst === null) {
    st.knownConvEst = nextKnown;
    st.reseedPools = {};
    dirty = true;
    return { deltas, isFirstInit: true, reseededPools: new Set(POOLS) };
  }

  const reseededPools = new Set(
    Object.keys(st.reseedPools || {}).filter((pk) => Boolean(st.reseedPools[pk]))
  );

  for (const [cid, currPools] of Object.entries(nextKnown)) {
    const prevPools = st.knownConvEst[cid] || {};
    for (const pk of POOLS) {
      if (reseededPools.has(pk)) continue;
      const c = currPools[pk];
      if (!c) continue;
      const p = prevPools[pk] || { h5: 0, wk: 0, wTok: 0 };
      if (c.h5 > p.h5) {
        deltas[pk].fiveHour += c.h5 - p.h5;
        dirty = true;
      }
      if (c.wk > p.wk) {
        deltas[pk].weekly += c.wk - p.wk;
        dirty = true;
      }
      if (c.wTok > p.wTok) {
        deltas[pk].wTok += c.wTok - p.wTok;
        dirty = true;
      }
    }
  }

  st.knownConvEst = nextKnown;
  if (reseededPools.size > 0) {
    st.reseedPools = {};
    dirty = true;
  }
  return { deltas, isFirstInit: false, reseededPools };
}

function updateWindowState(winState, currPct, currReset, localDelta, wTokDelta, familyCfg, nowMs) {
  if (currPct === null) return winState || null;

  if (!winState || typeof winState.baselineRemainingPct !== 'number') {
    dirty = true;
    return {
      baselineRemainingPct: currPct,
      lastRemainingPct: currPct,
      resetTime: currReset || null,
      localEstPct: 0,
      localWTok: 0,
      startedAtMs: nowMs,
      lastLocalActivityAtMs: 0,
    };
  }

  const prevResetMs = parseIsoMs(winState.resetTime);
  const currResetMs = parseIsoMs(currReset);
  const resetJumped =
    prevResetMs > 0 && currResetMs > 0 && currResetMs - prevResetMs > familyCfg.resetShiftMs;
  const refilled = currPct > winState.lastRemainingPct + familyCfg.refillResetPct;

  if (resetJumped || refilled) {
    dirty = true;
    return {
      baselineRemainingPct: currPct,
      lastRemainingPct: currPct,
      resetTime: currReset || null,
      localEstPct: 0,
      localWTok: 0,
      startedAtMs: nowMs,
      lastLocalActivityAtMs: 0,
    };
  }

  if (localDelta > 0) {
    winState.localEstPct = round4((winState.localEstPct || 0) + localDelta);
    winState.lastLocalActivityAtMs = nowMs;
    dirty = true;
  }
  if (wTokDelta > 0) {
    winState.localWTok = Math.round((winState.localWTok || 0) + wTokDelta);
    winState.lastLocalActivityAtMs = nowMs;
    dirty = true;
  }
  if (currPct !== winState.lastRemainingPct) {
    winState.lastRemainingPct = currPct;
    dirty = true;
  }
  if (currReset && currReset !== winState.resetTime) {
    winState.resetTime = currReset;
    dirty = true;
  }

  return winState;
}

function resolveEffectivePoolRate(pk, overrideFile, nowMs) {
  const def = DEFAULT_POOL_RATES[pk];
  const raw = readRawQuotaRatesOverride(overrideFile);
  const ov = raw?.pools?.[pk];
  if (overrideFile === QUOTA_RATES_OVERRIDE_FILE) {
    const cfg = loadQuotaRatesConfig(nowMs);
    return {
      wTokPer1Pct5h: cfg.pools[pk].wTokPer1Pct5h,
      weeklyTo5hRatio: cfg.pools[pk].weeklyTo5hRatio,
      isOverridden: Boolean(ov),
      calibratedAtMs: Number(ov?.calibratedAtMs) || 0,
    };
  }
  return {
    wTokPer1Pct5h: typeof ov?.wTokPer1Pct5h === 'number' && ov.wTokPer1Pct5h > 0 ? ov.wTokPer1Pct5h : def.wTokPer1Pct5h,
    weeklyTo5hRatio: typeof ov?.weeklyTo5hRatio === 'number' && ov.weeklyTo5hRatio >= 0 ? ov.weeklyTo5hRatio : def.weeklyTo5hRatio,
    isOverridden: Boolean(ov),
    calibratedAtMs: Number(ov?.calibratedAtMs) || 0,
  };
}

function evaluatePoolCalibration(pk, poolState, effectiveRate, nowMs, activeModelText = '') {
  const rules = DEFAULT_CALIBRATION_RULES;
  const def = DEFAULT_POOL_RATES[pk];
  const h5 = poolState?.fiveHour || null;
  const wk = poolState?.weekly || null;

  const actualDrop5hPct = h5 ? round2(Math.max(0, h5.baselineRemainingPct - h5.lastRemainingPct)) : 0;
  const localEst5hPct = h5 ? round2(Math.max(0, h5.localEstPct || 0)) : 0;
  const localWTok5h = h5 ? Math.round(Math.max(0, h5.localWTok || 0)) : 0;
  const actualDropWeeklyPct = wk ? round2(Math.max(0, wk.baselineRemainingPct - wk.lastRemainingPct)) : 0;
  const localEstWeeklyPct = wk ? round2(Math.max(0, wk.localEstPct || 0)) : 0;
  const lastActivityMs = Math.max(h5?.lastLocalActivityAtMs || 0, wk?.lastLocalActivityAtMs || 0);
  const settledForOverestimate =
    lastActivityMs === 0 || nowMs - lastActivityMs >= rules.overestimateSettleMs;
  const isExhaustedFloor = h5 !== null && h5.lastRemainingPct <= rules.minRemainingFloorPct;

  let activeModelRate = null;
  if (activeModelText) {
    const resolved = resolveModelQuotaRate(activeModelText, pk, loadQuotaRatesConfig(nowMs));
    activeModelRate = {
      modelId: activeModelText,
      wTokPer1Pct5h: resolved.wTokPer1Pct5h,
      weeklyTo5hRatio: resolved.weeklyTo5hRatio,
      differsFromPoolBase: resolved.wTokPer1Pct5h !== effectiveRate.wTokPer1Pct5h,
    };
  }

  const canCalibrate =
    h5 !== null &&
    !isExhaustedFloor &&
    actualDrop5hPct >= rules.minActualDrop5hPct &&
    localEst5hPct >= rules.minLocalEst5hPct;

  let proposedRate = null;
  if (canCalibrate) {
    const rawScale = localEst5hPct / actualDrop5hPct;
    const clampedScale = clamp(rawScale, rules.minScaleFactor, rules.maxScaleFactor);
    const nextWTok = Math.round(
      clamp(
        effectiveRate.wTokPer1Pct5h * clampedScale,
        rules.minWTokPer1Pct5h,
        rules.maxWTokPer1Pct5h
      )
    );
    const nextRatio =
      actualDropWeeklyPct >= rules.minWeeklyDropForRatioPct
        ? round4(clamp(actualDropWeeklyPct / actualDrop5hPct, 0.02, 1.0))
        : effectiveRate.weeklyTo5hRatio;

    proposedRate = {
      wTokPer1Pct5h: nextWTok,
      modelWTokPer1Pct5h: activeModelRate
        ? Math.round(clamp(activeModelRate.wTokPer1Pct5h * clampedScale, rules.minWTokPer1Pct5h, rules.maxWTokPer1Pct5h))
        : nextWTok,
      weeklyTo5hRatio: nextRatio,
      scaleFactor: round2(clampedScale),
      weeklyCalibrated: actualDropWeeklyPct >= rules.minWeeklyDropForRatioPct,
    };
  }

  let overestimateAlert = null;
  const overDiffPct = round2(localEst5hPct - actualDrop5hPct);
  const overRatio = actualDrop5hPct >= 0.5 ? round2(localEst5hPct / actualDrop5hPct) : 0;

  if (
    h5 !== null &&
    !isExhaustedFloor &&
    settledForOverestimate &&
    actualDrop5hPct >= rules.overestimateMinActualDrop5hPct &&
    overDiffPct >= rules.overestimateMinDiffPct &&
    localEst5hPct >= actualDrop5hPct * rules.overestimateMinRatio
  ) {
    const rawScale = clamp(localEst5hPct / actualDrop5hPct, 1.1, rules.maxScaleFactor);
    const suggestedWTokPer1Pct5h = Math.round(
      clamp(
        effectiveRate.wTokPer1Pct5h * rawScale,
        rules.minWTokPer1Pct5h,
        rules.maxWTokPer1Pct5h
      )
    );
    overestimateAlert = {
      active: true,
      poolKey: pk,
      actualDrop5hPct,
      localEst5hPct,
      diffPct: overDiffPct,
      ratio: overRatio,
      suggestedWTokPer1Pct5h,
      currentWTokPer1Pct5h: effectiveRate.wTokPer1Pct5h,
      activeModelId: activeModelRate?.modelId || '',
      currentModelWTokPer1Pct5h: activeModelRate?.wTokPer1Pct5h || effectiveRate.wTokPer1Pct5h,
      suggestedModelWTokPer1Pct5h: activeModelRate
        ? Math.round(clamp(activeModelRate.wTokPer1Pct5h * rawScale, rules.minWTokPer1Pct5h, rules.maxWTokPer1Pct5h))
        : suggestedWTokPer1Pct5h,
    };
  }

  return {
    poolKey: pk,
    hasSnapshot: h5 !== null,
    isExhaustedFloor,
    currentRemaining5hPct: h5 ? round2(h5.lastRemainingPct) : null,
    baselineRemaining5hPct: h5 ? round2(h5.baselineRemainingPct) : null,
    actualDrop5hPct,
    localEst5hPct,
    localWTok5h,
    actualDropWeeklyPct,
    localEstWeeklyPct,
    startedAtMs: h5?.startedAtMs || 0,
    soloMarkedAtMs: Number(poolState?.soloMarkedAtMs) || 0,
    soloMode: Number(poolState?.soloMarkedAtMs) > 0,
    currentRate: effectiveRate,
    activeModelRate,
    defaultRate: {
      wTokPer1Pct5h: def.wTokPer1Pct5h,
      weeklyTo5hRatio: def.weeklyTo5hRatio,
    },
    canCalibrate,
    proposedRate,
    overestimateAlert,
  };
}

export function updateQuotaCalibrationTracker({
  quotaGroups = null,
  codexQuota = null,
  localConvEstimates = {},
  activeModelByPool = {},
  nowMs = Date.now(),
  stateFile = CALIBRATION_STATE_FILE,
  overrideFile = QUOTA_RATES_OVERRIDE_FILE,
} = {}) {
  const ratesCfg = loadQuotaRatesConfig(nowMs);
  const familyCfg = ratesCfg.familyDetection;
  const st = loadState(stateFile);
  if (!st.poolRateSigs || typeof st.poolRateSigs !== 'object') st.poolRateSigs = {};
  for (const pk of POOLS) {
    const sig = getPoolRateSignature(pk, ratesCfg);
    if (st.poolRateSigs[pk] !== sig) {
      if (st.knownConvEst !== null) st.reseedPools = { ...(st.reseedPools || {}), [pk]: true };
      st.poolRateSigs[pk] = sig;
      dirty = true;
    }
  }
  const snapshots = extractPoolSnapshots(quotaGroups, codexQuota);
  const { deltas, isFirstInit, reseededPools } = computeLocalDeltas(st, localConvEstimates);

  const pools = {};
  const overestimateAlerts = [];
  let hasOverrides = false;

  for (const pk of POOLS) {
    const snap = snapshots[pk];
    if (!st.pools[pk]) st.pools[pk] = { fiveHour: null, weekly: null, soloMarkedAtMs: 0 };

    const skipDelta = isFirstInit || reseededPools.has(pk);
    for (const win of WINDOWS) {
      const bucket = snap?.[win] || null;
      const currPct = readBucketPct(bucket);
      const currReset = bucket?.resetTime || null;
      const deltaLocal = skipDelta ? 0 : deltas[pk][win];
      const deltaWTok = skipDelta ? 0 : win === 'fiveHour' ? deltas[pk].wTok : 0;
      const prevStarted = st.pools[pk][win]?.startedAtMs || 0;
      st.pools[pk][win] = updateWindowState(
        st.pools[pk][win],
        currPct,
        currReset,
        deltaLocal,
        deltaWTok,
        familyCfg,
        nowMs
      );
      if (win === 'fiveHour' && prevStarted > 0 && st.pools[pk][win]?.startedAtMs !== prevStarted) {
        st.pools[pk].soloMarkedAtMs = 0;
      }
    }

    const effectiveRate = resolveEffectivePoolRate(pk, overrideFile, nowMs);
    if (effectiveRate.isOverridden) hasOverrides = true;

    const evalPool = evaluatePoolCalibration(
      pk,
      st.pools[pk],
      effectiveRate,
      nowMs,
      activeModelByPool?.[pk] || ''
    );
    pools[pk] = evalPool;
    if (evalPool.overestimateAlert?.active) {
      overestimateAlerts.push(evalPool.overestimateAlert);
    }
  }

  saveState(st, nowMs, isFirstInit);

  return {
    updatedAtMs: nowMs,
    overrideFile,
    hasOverrides,
    minActualDrop5hPct: DEFAULT_CALIBRATION_RULES.minActualDrop5hPct,
    overestimateAlerts,
    pools,
  };
}

function resetPoolWindows(p, nowMs, soloMarkedAtMs = 0) {
  if (!p) return;
  p.soloMarkedAtMs = soloMarkedAtMs;
  for (const win of WINDOWS) {
    const w = p[win];
    if (!w || typeof w.lastRemainingPct !== 'number') continue;
    w.baselineRemainingPct = w.lastRemainingPct;
    w.localEstPct = 0;
    w.localWTok = 0;
    w.startedAtMs = nowMs;
    w.lastLocalActivityAtMs = 0;
  }
}

function markPoolsForReseed(st, targets) {
  if (targets.length === POOLS.length) {
    st.knownConvEst = null;
    st.reseedPools = {};
  } else {
    st.reseedPools = { ...(st.reseedPools || {}) };
    for (const pk of targets) st.reseedPools[pk] = true;
  }
}

export function startSoloCalibrationWindow({
  poolKey = '',
  nowMs = Date.now(),
  stateFile = CALIBRATION_STATE_FILE,
} = {}) {
  const st = loadState(stateFile);
  const targets = poolKey && POOLS.includes(poolKey) ? [poolKey] : POOLS;
  for (const pk of targets) resetPoolWindows(st.pools?.[pk], nowMs, nowMs);
  markPoolsForReseed(st, targets);
  dirty = true;
  saveState(st, nowMs, true);
  return { ok: true, poolKey: poolKey || 'all', startedAtMs: nowMs };
}

export function applyPoolCalibration({
  poolKey,
  mode = 'solo',
  nowMs = Date.now(),
  stateFile = CALIBRATION_STATE_FILE,
  overrideFile = QUOTA_RATES_OVERRIDE_FILE,
} = {}) {
  if (!poolKey || !POOLS.includes(poolKey)) {
    return { ok: false, error: `无效的配额池: ${poolKey || '--'}` };
  }
  const st = loadState(stateFile);
  const p = st.pools?.[poolKey];
  if (!p || !p.fiveHour) {
    return { ok: false, error: `${poolKey} 尚无配额采样数据` };
  }

  const effectiveRate = resolveEffectivePoolRate(poolKey, overrideFile, nowMs);
  const evalPool = evaluatePoolCalibration(poolKey, p, effectiveRate, nowMs);

  let nextWTok = effectiveRate.wTokPer1Pct5h;
  let nextRatio = effectiveRate.weeklyTo5hRatio;
  let note = '';

  if (mode === 'overestimate_fix') {
    if (!evalPool.overestimateAlert?.active) {
      return { ok: false, error: `${poolKey} 当前未检测到偏高告警` };
    }
    nextWTok = evalPool.overestimateAlert.suggestedWTokPer1Pct5h;
    note = `overestimate_fix(est=${evalPool.localEst5hPct}%,actual=${evalPool.actualDrop5hPct}%)`;
  } else {
    if (!evalPool.canCalibrate || !evalPool.proposedRate) {
      return {
        ok: false,
        error: `需先在本机独享状态下产生至少 ${DEFAULT_CALIBRATION_RULES.minActualDrop5hPct}% 账号实降与本机估算（当前实降 ${evalPool.actualDrop5hPct}% / 估算 ${evalPool.localEst5hPct}%）`,
      };
    }
    nextWTok = evalPool.proposedRate.wTokPer1Pct5h;
    nextRatio = evalPool.proposedRate.weeklyTo5hRatio;
    note = `solo_calibration(est=${evalPool.localEst5hPct}%,actual=${evalPool.actualDrop5hPct}%,wk=${evalPool.actualDropWeeklyPct}%)`;
  }

  const saved = saveQuotaPoolRateOverride(
    poolKey,
    { wTokPer1Pct5h: nextWTok, weeklyTo5hRatio: nextRatio, calibratedAtMs: nowMs, note },
    overrideFile
  );

  // Re-baseline this pool cleanly after rate update
  resetPoolWindows(p, nowMs, 0);
  markPoolsForReseed(st, [poolKey]);
  dirty = true;
  saveState(st, nowMs, true);

  return {
    ok: true,
    poolKey,
    before: effectiveRate,
    after: saved,
    message: `已校准 ${poolKey}：${effectiveRate.wTokPer1Pct5h} → ${saved.wTokPer1Pct5h} wTok/1%`,
  };
}

export function resetCalibratedPoolRates({
  poolKey = '',
  nowMs = Date.now(),
  stateFile = CALIBRATION_STATE_FILE,
  overrideFile = QUOTA_RATES_OVERRIDE_FILE,
} = {}) {
  resetQuotaRatesOverride(poolKey, overrideFile);
  const st = loadState(stateFile);
  const targets = poolKey && POOLS.includes(poolKey) ? [poolKey] : POOLS;
  for (const pk of targets) resetPoolWindows(st.pools?.[pk], nowMs, 0);
  markPoolsForReseed(st, targets);
  dirty = true;
  saveState(st, nowMs, true);
  return {
    ok: true,
    poolKey: poolKey || 'all',
    message: poolKey ? `已恢复 ${poolKey} 默认配额系数` : '已恢复全部默认配额系数',
  };
}

export function clearCalibrationCacheForTest() {
  state = null;
  dirty = false;
  lastFlushMs = 0;
  lastFileMtimeMs = -1;
}
