import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FAMILY_QUOTA_STATE_FILE, loadQuotaRatesConfig } from './contract.mjs';

const POOLS = ['gemini', '3p', 'codex'];
const WINDOWS = ['fiveHour', 'weekly'];
const FLUSH_INTERVAL_MS = 4000;

let state = null;
let dirty = false;
let lastFlushMs = 0;

function round2(n) {
  return +Number(n).toFixed(2);
}

function round4(n) {
  return +Number(n).toFixed(4);
}

function readBucketPct(bucket) {
  const frac = bucket?.remainingFraction;
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return null;
  return round4(Math.min(1, Math.max(0, frac)) * 100);
}

function parseIsoMs(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function loadState(stateFile = FAMILY_QUOTA_STATE_FILE) {
  if (state && state._file === stateFile) return state;
  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.pools && typeof parsed.pools === 'object') {
        state = {
          _file: stateFile,
          version: 1,
          updatedAtMs: Number(parsed.updatedAtMs) || Date.now(),
          knownConvEst:
            parsed.knownConvEst && typeof parsed.knownConvEst === 'object'
              ? parsed.knownConvEst
              : {},
          pools: parsed.pools,
        };
        return state;
      }
    }
  } catch {
    // start fresh on corrupt state file
  }
  state = {
    _file: stateFile,
    version: 1,
    updatedAtMs: 0,
    knownConvEst: null, // null signals uninitialized baseline
    pools: {},
  };
  return state;
}

function saveState(st, nowMs, force = false) {
  if (!st || !st._file) return;
  if (!force && (!dirty || nowMs - lastFlushMs < FLUSH_INTERVAL_MS)) return;
  try {
    const dir = dirname(st._file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const { _file: _drop, ...serializable } = st;
    serializable.updatedAtMs = nowMs;
    writeFileSync(st._file, JSON.stringify(serializable, null, 2), 'utf-8');
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
      if (h5 > 0 || wk > 0) {
        entry[pk] = { h5: round4(h5), wk: round4(wk) };
      }
    }
    if (Object.keys(entry).length > 0) {
      out[cid] = entry;
    }
  }
  return out;
}

function computeLocalDeltas(st, localConvEstimates) {
  const deltas = {};
  for (const pk of POOLS) {
    deltas[pk] = { fiveHour: 0, weekly: 0 };
  }

  const nextKnown = cloneConvEstimates(localConvEstimates);
  if (st.knownConvEst === null) {
    st.knownConvEst = nextKnown;
    dirty = true;
    return { deltas, isFirstInit: true };
  }

  for (const [cid, currPools] of Object.entries(nextKnown)) {
    const prevPools = st.knownConvEst[cid] || {};
    for (const pk of POOLS) {
      const c = currPools[pk];
      if (!c) continue;
      const p = prevPools[pk] || { h5: 0, wk: 0 };
      if (c.h5 > p.h5) {
        deltas[pk].fiveHour += c.h5 - p.h5;
        dirty = true;
      }
      if (c.wk > p.wk) {
        deltas[pk].weekly += c.wk - p.wk;
        dirty = true;
      }
    }
  }

  // Keep memory/disk compact while retaining all currently tracked conversations
  st.knownConvEst = nextKnown;
  return { deltas, isFirstInit: false };
}

function updateWindowState(winState, currPct, currReset, localDelta, cfg, nowMs) {
  if (currPct === null) {
    return winState || null;
  }

  if (!winState || typeof winState.baselineRemainingPct !== 'number') {
    dirty = true;
    return {
      baselineRemainingPct: currPct,
      lastRemainingPct: currPct,
      resetTime: currReset || null,
      localEstPct: 0,
      startedAtMs: nowMs,
      lastDivergeAtMs: 0,
      lastExcessPct: 0,
    };
  }

  const prevResetMs = parseIsoMs(winState.resetTime);
  const currResetMs = parseIsoMs(currReset);
  const resetJumped =
    prevResetMs > 0 && currResetMs > 0 && currResetMs - prevResetMs > cfg.resetShiftMs;
  const refilled = currPct > winState.lastRemainingPct + cfg.refillResetPct;

  if (resetJumped || refilled) {
    dirty = true;
    return {
      baselineRemainingPct: currPct,
      lastRemainingPct: currPct,
      resetTime: currReset || null,
      localEstPct: 0,
      startedAtMs: nowMs,
      lastDivergeAtMs: 0,
      lastExcessPct: 0,
    };
  }

  if (localDelta > 0) {
    winState.localEstPct = round4((winState.localEstPct || 0) + localDelta);
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

export function updateFamilyQuotaTracker({
  quotaGroups = null,
  codexQuota = null,
  localConvEstimates = {},
  nowMs = Date.now(),
  stateFile = FAMILY_QUOTA_STATE_FILE,
} = {}) {
  const cfg = loadQuotaRatesConfig(nowMs).familyDetection;
  const st = loadState(stateFile);
  const snapshots = extractPoolSnapshots(quotaGroups, codexQuota);
  const { deltas, isFirstInit } = computeLocalDeltas(st, localConvEstimates);

  const byPool = {};
  let latestDivergeAtMs = 0;

  for (const pk of POOLS) {
    const snap = snapshots[pk];
    if (!st.pools[pk]) st.pools[pk] = { fiveHour: null, weekly: null };

    for (const win of WINDOWS) {
      const bucket = snap?.[win] || null;
      const currPct = readBucketPct(bucket);
      const currReset = bucket?.resetTime || null;
      const deltaLocal = isFirstInit ? 0 : deltas[pk][win];
      st.pools[pk][win] = updateWindowState(
        st.pools[pk][win],
        currPct,
        currReset,
        deltaLocal,
        cfg,
        nowMs
      );
    }

    const h5 = st.pools[pk].fiveHour;
    const wk = st.pools[pk].weekly;

    const h5Actual = h5 ? Math.max(0, h5.baselineRemainingPct - h5.lastRemainingPct) : 0;
    const h5Local = h5 ? Math.max(0, h5.localEstPct || 0) : 0;
    const h5Excess = Math.max(0, h5Actual - h5Local);

    const wkActual = wk ? Math.max(0, wk.baselineRemainingPct - wk.lastRemainingPct) : 0;
    const wkLocal = wk ? Math.max(0, wk.localEstPct || 0) : 0;
    const wkExcess = Math.max(0, wkActual - wkLocal);

    const h5Triggered =
      h5 !== null &&
      h5Excess >= cfg.minFiveHourExcessPct &&
      h5Excess >= h5Local * cfg.minRelativeRatio;
    const wkTriggered =
      wk !== null &&
      wkExcess >= cfg.minWeeklyExcessPct &&
      wkExcess >= wkLocal * cfg.minRelativeRatio;

    if (h5Triggered || wkTriggered) {
      if (h5 && h5Excess > (h5.lastExcessPct || 0) + 0.05) {
        h5.lastDivergeAtMs = nowMs;
        h5.lastExcessPct = round4(h5Excess);
        dirty = true;
      }
      if (wk && wkExcess > (wk.lastExcessPct || 0) + 0.05) {
        wk.lastDivergeAtMs = nowMs;
        wk.lastExcessPct = round4(wkExcess);
        dirty = true;
      }

      const poolDivergeAt = Math.max(h5?.lastDivergeAtMs || 0, wk?.lastDivergeAtMs || 0) || nowMs;
      if (poolDivergeAt > latestDivergeAtMs) latestDivergeAtMs = poolDivergeAt;

      byPool[pk] = {
        fiveHourUsedPct: h5Excess >= 0.01 ? round2(h5Excess) : null,
        weeklyUsedPct: wkExcess >= 0.01 ? round2(wkExcess) : null,
        actualDrop5hPct: round2(h5Actual),
        localEst5hPct: round2(h5Local),
        actualDropWeeklyPct: round2(wkActual),
        localEstWeeklyPct: round2(wkLocal),
        confidence: h5Local < 0.1 && wkLocal < 0.05 ? 'idle_pure' : 'active_gap',
        isEstimated: true,
      };
    }
  }

  saveState(st, nowMs, isFirstInit);

  if (Object.keys(byPool).length === 0) {
    return null;
  }

  return {
    active: true,
    updatedAtMs: latestDivergeAtMs || nowMs,
    byPool,
    isEstimated: true,
    source: 'family_quota_gap',
  };
}

export function resetFamilyQuotaTracker({
  poolKey = '',
  nowMs = Date.now(),
  stateFile = FAMILY_QUOTA_STATE_FILE,
} = {}) {
  const st = loadState(stateFile);
  const targetPools = poolKey && POOLS.includes(poolKey) ? [poolKey] : POOLS;
  for (const pk of targetPools) {
    const p = st.pools?.[pk];
    if (!p) continue;
    for (const win of WINDOWS) {
      const w = p[win];
      if (!w || typeof w.lastRemainingPct !== 'number') continue;
      w.baselineRemainingPct = w.lastRemainingPct;
      w.localEstPct = 0;
      w.startedAtMs = nowMs;
      w.lastDivergeAtMs = 0;
      w.lastExcessPct = 0;
    }
  }
  // Re-seed knownConvEst on next poll so rate changes never create synthetic local deltas
  st.knownConvEst = null;
  dirty = true;
  saveState(st, nowMs, true);
  return true;
}

export function clearFamilyQuotaCacheForTest() {
  state = null;
  dirty = false;
  lastFlushMs = 0;
}
