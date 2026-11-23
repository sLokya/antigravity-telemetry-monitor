import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  normalizeQuotaUsage,
  emptyTotals,
  turnToTotals,
  addTotals,
  poolTokensFromTurn,
} from './usage_contract.mjs';

const HOME = homedir();
const SCRATCH_DIR = join(HOME, '.gemini', 'antigravity', 'scratch');
export const TASK_HISTORY_FILE = join(SCRATCH_DIR, 'telemetry_task_history.json');

const MAX_CONVERSATIONS = 100;
const MAX_TURNS_PER_CONV = 80;
const FLUSH_INTERVAL_MS = 3000;

let inMemoryStore = null;
let storeDirty = false;
let lastFlushMs = 0;
const lastPoolSnapshots = new Map(); // poolKey -> { pct5h, reset5h, pctWeek, resetWeek, atMs }

function loadStore() {
  if (inMemoryStore) return inMemoryStore;
  try {
    if (existsSync(TASK_HISTORY_FILE)) {
      const parsed = JSON.parse(readFileSync(TASK_HISTORY_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.conversations) {
        inMemoryStore = {
          version: 1,
          updatedAtMs: parsed.updatedAtMs || Date.now(),
          conversations: parsed.conversations,
        };
        return inMemoryStore;
      }
    }
  } catch {
    // fallback to fresh store
  }
  inMemoryStore = {
    version: 1,
    updatedAtMs: Date.now(),
    conversations: {},
  };
  return inMemoryStore;
}

function pruneStore(store) {
  const entries = Object.entries(store.conversations || {});
  if (entries.length <= MAX_CONVERSATIONS) return;
  entries.sort((a, b) => (b[1]?.updatedAtMs || 0) - (a[1]?.updatedAtMs || 0));
  const kept = {};
  for (const [cid, conv] of entries.slice(0, MAX_CONVERSATIONS)) {
    kept[cid] = conv;
  }
  store.conversations = kept;
}

export function flushTaskHistory(force = false) {
  if (!inMemoryStore) return;
  const now = Date.now();
  if (!force && (!storeDirty || now - lastFlushMs < FLUSH_INTERVAL_MS)) return;
  try {
    if (!existsSync(SCRATCH_DIR)) {
      mkdirSync(SCRATCH_DIR, { recursive: true });
    }
    pruneStore(inMemoryStore);
    inMemoryStore.updatedAtMs = now;
    writeFileSync(TASK_HISTORY_FILE, JSON.stringify(inMemoryStore, null, 2), 'utf-8');
    storeDirty = false;
    lastFlushMs = now;
  } catch {
    // ignore disk write errors
  }
}

function readPoolState(quotaGroups, poolKey) {
  const grp = quotaGroups?.[poolKey];
  if (!grp) return null;
  const f5 = grp.fiveHour?.remainingFraction;
  const fw = grp.weekly?.remainingFraction;
  return {
    pct5h: typeof f5 === 'number' ? +(f5 * 100).toFixed(3) : null,
    reset5h: grp.fiveHour?.resetTime || null,
    pctWeek: typeof fw === 'number' ? +(fw * 100).toFixed(3) : null,
    resetWeek: grp.weekly?.resetTime || null,
  };
}

function migrateQuotaTrack(qt, fallbackPool = 'gemini') {
  if (!qt || typeof qt !== 'object') return null;
  if (qt.pools && typeof qt.pools === 'object') return qt;
  const pool = fallbackPool || 'gemini';
  const hasLegacyVals =
    (qt.accum5hUsed || 0) !== 0 ||
    (qt.accumWeekUsed || 0) !== 0 ||
    Boolean(qt.isApproxConcurrent) ||
    (qt.lastAttributedTokens || 0) !== 0;
  const pools = hasLegacyVals
    ? {
        [pool]: {
          accum5hUsed: qt.accum5hUsed || 0,
          accumWeekUsed: qt.accumWeekUsed || 0,
          isApproxConcurrent: Boolean(qt.isApproxConcurrent),
          lastAttributedTokens: qt.lastAttributedTokens || 0,
        },
      }
    : {};
  delete qt.accum5hUsed;
  delete qt.accumWeekUsed;
  delete qt.isApproxConcurrent;
  delete qt.lastAttributedTokens;
  qt.pools = pools;
  return qt;
}

function sumQuotaTrackAccum(qt) {
  let sum5h = 0;
  let sumWeek = 0;
  for (const p of Object.values(qt?.pools || {})) {
    sum5h += p?.accum5hUsed || 0;
    sumWeek += p?.accumWeekUsed || 0;
  }
  return { sum5h, sumWeek };
}

function toPublicQuotaUsage(track, nativeQuota, fallbackPool = 'gemini') {
  if (nativeQuota && nativeQuota.source === 'codex_rollout') {
    return normalizeQuotaUsage(nativeQuota, 'codex');
  }
  const normTrack = migrateQuotaTrack(
    track && typeof track === 'object' ? { ...track, pools: track.pools ? { ...track.pools } : undefined } : null,
    fallbackPool
  );
  if (!normTrack || !normTrack.observedLive) {
    return null;
  }
  const byPool = {};
  let anyApprox = false;
  const entries = Object.entries(normTrack.pools || {});
  if (entries.length === 0) {
    const pk = fallbackPool || 'gemini';
    byPool[pk] = {
      fiveHourUsedPct: 0,
      weeklyUsedPct: 0,
      isApproxConcurrent: false,
    };
  } else {
    for (const [pk, p] of entries) {
      const approx = Boolean(p?.isApproxConcurrent);
      if (approx) anyApprox = true;
      byPool[pk] = {
        fiveHourUsedPct: +(p?.accum5hUsed || 0).toFixed(2),
        weeklyUsedPct: +(p?.accumWeekUsed || 0).toFixed(2),
        isApproxConcurrent: approx,
      };
    }
  }
  return {
    byPool,
    isApproxConcurrent: anyApprox,
    source: 'live_snapshot',
  };
}

function stripHeavyStepsForArchive(turn) {
  const { steps, ...rest } = turn;
  return {
    ...rest,
    steps: Array.isArray(steps) ? steps.slice(-25) : [],
  };
}

export function reconcileAndPersistHistory({ fleetTasks = [], quotaGroups = {}, nowMs = Date.now() }) {
  const store = loadStore();
  const liveTurnRefsByPool = new Map([
    ['gemini', []],
    ['3p', []],
    ['codex', []],
  ]);

  // 1. Merge incoming live turns with persisted history per conversation
  for (const task of fleetTasks) {
    const cid = task.conversationId;
    if (!cid) continue;

    let convRec = store.conversations[cid];
    if (!convRec) {
      convRec = {
        conversationId: cid,
        title: task.title || cid.slice(0, 8),
        engine: task.engine || 'AGY',
        workspaceLabel: task.workspaceLabel || 'Local',
        parentConversationId: task.parentConversationId || '',
        subagentRole: task.subagentRole || '',
        updatedAtMs: task.mtimeMs || nowMs,
        prunedTotals: null,
        turns: [],
      };
      store.conversations[cid] = convRec;
    } else {
      convRec.title = task.title || convRec.title;
      convRec.engine = task.engine || convRec.engine;
      convRec.workspaceLabel = task.workspaceLabel || convRec.workspaceLabel;
      convRec.updatedAtMs = Math.max(convRec.updatedAtMs || 0, task.mtimeMs || nowMs);
      if (task.parentConversationId && task.parentConversationId !== convRec.parentConversationId) {
        convRec.parentConversationId = task.parentConversationId;
        storeDirty = true;
      }
      if (task.subagentRole && task.subagentRole !== convRec.subagentRole) {
        convRec.subagentRole = task.subagentRole;
        storeDirty = true;
      }
    }

    const existingMap = new Map();
    for (const pt of convRec.turns || []) {
      if (pt?.turnId) existingMap.set(pt.turnId, pt);
    }

    const incomingTurns = Array.isArray(task.turns) ? task.turns : [];
    const mergedOrder = [];

    for (let tIdx = 0; tIdx < incomingTurns.length; tIdx++) {
      const inc = incomingTurns[tIdx];
      const isLastTurn = tIdx === incomingTurns.length - 1;
      const prev = existingMap.get(inc.turnId);
      const isJustFinishedTurn =
        isLastTurn && inc.completedAtMs && nowMs - inc.completedAtMs < 15000;
      let quotaTrack = prev?.quotaTrack || null;
      const incPoolToks = poolTokensFromTurn(inc);

      if (!quotaTrack) {
        const shouldTrackLive = Boolean(inc.isRunning || isJustFinishedTurn);
        const pools = {};
        for (const [pk, tok] of Object.entries(incPoolToks)) {
          pools[pk] = {
            accum5hUsed: 0,
            accumWeekUsed: 0,
            isApproxConcurrent: false,
            lastAttributedTokens: inc.isRunning ? tok || 0 : 0,
          };
        }
        quotaTrack = {
          observedLive: shouldTrackLive,
          firstObservedMs: nowMs,
          completedObservedMs: inc.isRunning ? 0 : nowMs,
          pools,
        };
        storeDirty = true;
      } else {
        if (!quotaTrack.pools || typeof quotaTrack.pools !== 'object') {
          migrateQuotaTrack(quotaTrack, prev?.quotaGroupKey || inc.quotaGroupKey || 'gemini');
          storeDirty = true;
        }
        const { sum5h, sumWeek } = sumQuotaTrackAccum(quotaTrack);
        // Auto-heal historical already-finished turns falsely tagged live before turn-level fix
        if (
          quotaTrack.observedLive &&
          !inc.isRunning &&
          quotaTrack.firstObservedMs === quotaTrack.completedObservedMs &&
          sum5h === 0 &&
          sumWeek === 0
        ) {
          quotaTrack.observedLive = false;
          storeDirty = true;
        }
        if (!inc.isRunning && !quotaTrack.completedObservedMs) {
          quotaTrack.completedObservedMs = nowMs;
          storeDirty = true;
        }
        if (inc.isRunning && quotaTrack.completedObservedMs) {
          quotaTrack.completedObservedMs = 0;
          quotaTrack.observedLive = true;
          storeDirty = true;
        }
      }

      // Preserve Codex native rate_limits delta if previously recorded
      const rawNativeQuota = inc.quotaUsage?.source === 'codex_rollout'
        ? inc.quotaUsage
        : prev?.quotaUsage?.source === 'codex_rollout'
          ? prev.quotaUsage
          : null;
      const nativeQuota = rawNativeQuota ? normalizeQuotaUsage(rawNativeQuota, 'codex') : null;

      if (
        !prev ||
        prev.totalTokens !== inc.totalTokens ||
        prev.status !== inc.status ||
        prev.stepCount !== inc.stepCount ||
        (!prev.byModel && Array.isArray(inc.byModel))
      ) {
        storeDirty = true;
      }

      const merged = stripHeavyStepsForArchive({
        ...inc,
        quotaUsage: nativeQuota,
        quotaTrack,
      });

      existingMap.set(inc.turnId, merged);
      mergedOrder.push(inc.turnId);

      // Register for live quota attribution across every active model pool in this turn
      if (!nativeQuota && quotaTrack.observedLive) {
        const withinCompletionGrace =
          quotaTrack.completedObservedMs > 0 && nowMs - quotaTrack.completedObservedMs < 90000;
        if (merged.isRunning || withinCompletionGrace) {
          const mergedPoolToks = poolTokensFromTurn(merged);
          const targetPools = new Set();
          for (const [pk, tok] of Object.entries(mergedPoolToks)) {
            if (tok > 0) targetPools.add(pk);
          }
          if (merged.quotaGroupKey) targetPools.add(merged.quotaGroupKey);

          for (const pk of targetPools) {
            if (!liveTurnRefsByPool.has(pk)) continue;
            if (!quotaTrack.pools[pk]) {
              quotaTrack.pools[pk] = {
                accum5hUsed: 0,
                accumWeekUsed: 0,
                isApproxConcurrent: false,
                lastAttributedTokens: 0,
              };
            }
            const curPoolTok = mergedPoolToks[pk] || 0;
            const pendingDeltaTokens = Math.max(
              0,
              curPoolTok - (quotaTrack.pools[pk].lastAttributedTokens || 0)
            );
            liveTurnRefsByPool.get(pk).push({
              turn: merged,
              poolKey: pk,
              poolTokens: curPoolTok,
              pendingDeltaTokens,
            });
          }
        }
      }
    }

    // Keep archived older turns that may have scrolled out of live tail (e.g. Codex 1.5MB tail)
    const liveIdSet = new Set(mergedOrder);
    const hasStepTurn =
      task.engine !== 'CODEX' && mergedOrder.some((id) => id.includes(':step:'));
    const legacyWholeId = `${cid}:t-1`;
    const archivedOlder = (convRec.turns || [])
      .filter((pt) => {
        if (!pt?.turnId || liveIdSet.has(pt.turnId)) return false;
        if (hasStepTurn && pt.turnId === legacyWholeId) {
          storeDirty = true;
          return false;
        }
        return true;
      })
      .map((pt) => ({ ...pt, isRunning: false, status: pt.status === 'RUNNING' ? 'DONE' : pt.status }));

    const combinedAll = [
      ...archivedOlder,
      ...mergedOrder.map((id) => existingMap.get(id)),
    ];
    if (combinedAll.length > MAX_TURNS_PER_CONV) {
      const overflow = combinedAll.slice(0, combinedAll.length - MAX_TURNS_PER_CONV);
      const overflowTotals = overflow.map((t) =>
        turnToTotals({
          ...t,
          quotaUsage: toPublicQuotaUsage(t.quotaTrack, t.quotaUsage, t.quotaGroupKey),
        })
      );
      convRec.prunedTotals = addTotals(convRec.prunedTotals || emptyTotals(), ...overflowTotals);
      storeDirty = true;
    }
    convRec.turns = combinedAll.slice(-MAX_TURNS_PER_CONV);
  }

  // 2. Attribute pool quota drops to active / just-finished live turns per pool
  for (const poolKey of ['gemini', '3p', 'codex']) {
    const curr = readPoolState(quotaGroups, poolKey);
    if (!curr) continue;
    const prev = lastPoolSnapshots.get(poolKey);
    let drop5h = 0;
    let dropWeek = 0;

    if (prev) {
      if (
        prev.pct5h !== null &&
        curr.pct5h !== null &&
        (!prev.reset5h || !curr.reset5h || prev.reset5h === curr.reset5h) &&
        prev.pct5h >= curr.pct5h
      ) {
        drop5h = +(prev.pct5h - curr.pct5h).toFixed(3);
      }
      if (
        prev.pctWeek !== null &&
        curr.pctWeek !== null &&
        (!prev.resetWeek || !curr.resetWeek || prev.resetWeek === curr.resetWeek) &&
        prev.pctWeek >= curr.pctWeek
      ) {
        dropWeek = +(prev.pctWeek - curr.pctWeek).toFixed(3);
      }
    }

    lastPoolSnapshots.set(poolKey, { ...curr, atMs: nowMs });

    const candidates = liveTurnRefsByPool.get(poolKey) || [];
    if ((drop5h > 0 || dropWeek > 0) && candidates.length > 0) {
      const totalWeight = candidates.reduce((acc, c) => acc + Math.max(1, c.pendingDeltaTokens), 0);
      const isConcurrent = candidates.length > 1;
      for (const c of candidates) {
        const weight = Math.max(1, c.pendingDeltaTokens);
        const share = totalWeight > 0 ? weight / totalWeight : 1 / candidates.length;
        const qt = c.turn.quotaTrack;
        if (!qt.pools) qt.pools = {};
        if (!qt.pools[c.poolKey]) {
          qt.pools[c.poolKey] = {
            accum5hUsed: 0,
            accumWeekUsed: 0,
            isApproxConcurrent: false,
            lastAttributedTokens: 0,
          };
        }
        const pt = qt.pools[c.poolKey];
        pt.accum5hUsed = +((pt.accum5hUsed || 0) + drop5h * share).toFixed(3);
        pt.accumWeekUsed = +((pt.accumWeekUsed || 0) + dropWeek * share).toFixed(3);
        if (isConcurrent) pt.isApproxConcurrent = true;
        pt.lastAttributedTokens = c.poolTokens || 0;
      }
      storeDirty = true;
    }
  }

  // 3. Attach public quotaUsage onto fleetTasks.turns without exposing internal quotaTrack
  for (const task of fleetTasks) {
    const convRec = store.conversations[task.conversationId];
    if (!convRec) continue;
    const publicTurns = (convRec.turns || []).map((t) => {
      const { quotaTrack, ...cleanTurn } = t;
      return {
        ...cleanTurn,
        quotaUsage: toPublicQuotaUsage(quotaTrack, t.quotaUsage, t.quotaGroupKey),
      };
    });
    task.turns = publicTurns;
    if (publicTurns.length > 0) {
      task.currentTurn = publicTurns[publicTurns.length - 1];
    }
    task.totalTurnsCount = publicTurns.length + (convRec.prunedTotals?.turnsCount || 0);
  }

  flushTaskHistory(false);
}

export function getConversationRecord(convId) {
  const store = loadStore();
  const convRec = store.conversations?.[convId];
  if (!convRec) return null;
  const publicTurns = Array.isArray(convRec.turns)
    ? convRec.turns.map((t) => {
        const { quotaTrack, ...cleanTurn } = t;
        return {
          ...cleanTurn,
          quotaUsage: toPublicQuotaUsage(quotaTrack, t.quotaUsage, t.quotaGroupKey),
        };
      })
    : [];
  return {
    conversationId: convRec.conversationId || convId,
    title: convRec.title || '',
    engine: convRec.engine || 'AGY',
    parentConversationId: convRec.parentConversationId || '',
    subagentRole: convRec.subagentRole || '',
    updatedAtMs: convRec.updatedAtMs || 0,
    prunedTotals: convRec.prunedTotals ? addTotals(convRec.prunedTotals) : null,
    turns: publicTurns,
  };
}

export function getPersistedTurnsForConversation(convId) {
  return getConversationRecord(convId)?.turns || [];
}
