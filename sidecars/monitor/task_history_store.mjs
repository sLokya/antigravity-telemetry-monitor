import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { emptyTotals, turnToTotals, addTotals } from './usage_contract.mjs';
import { estimateTurnQuotaUsage, estimateTotalsQuotaUsage } from './quota/index.mjs';

const HOME = homedir();
const SCRATCH_DIR = join(HOME, '.gemini', 'antigravity', 'scratch');
export const TASK_HISTORY_FILE = join(SCRATCH_DIR, 'telemetry_task_history.json');

const MAX_CONVERSATIONS = 100;
const MAX_TURNS_PER_CONV = 80;
const FLUSH_INTERVAL_MS = 3000;

let inMemoryStore = null;
let storeDirty = false;
let lastFlushMs = 0;

function loadStore() {
  if (inMemoryStore) return inMemoryStore;
  try {
    if (existsSync(TASK_HISTORY_FILE)) {
      const parsed = JSON.parse(readFileSync(TASK_HISTORY_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.conversations) {
        inMemoryStore = {
          version: 2,
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
    version: 2,
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

function stripHeavyStepsForArchive(turn) {
  const { steps, quotaTrack: _dropTrack, ...rest } = turn;
  return {
    ...rest,
    steps: Array.isArray(steps) ? steps.slice(-25) : [],
  };
}

function toPublicTurn(t) {
  const { quotaTrack: _dropTrack, ...cleanTurn } = t;
  return {
    ...cleanTurn,
    quotaUsage: estimateTurnQuotaUsage(cleanTurn),
  };
}

function toPublicPrunedTotals(prunedTotals) {
  if (!prunedTotals || typeof prunedTotals !== 'object') return null;
  const cloned = addTotals(prunedTotals);
  cloned.quotaUsage = estimateTotalsQuotaUsage(cloned);
  return cloned;
}

export function reconcileAndPersistHistory({ fleetTasks = [], nowMs = Date.now() }) {
  const store = loadStore();

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
      storeDirty = true;
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
      const prev = existingMap.get(inc.turnId);
      const estimatedQuota = estimateTurnQuotaUsage(inc);

      if (
        !prev ||
        prev.quotaTrack ||
        prev.totalTokens !== inc.totalTokens ||
        prev.status !== inc.status ||
        prev.stepCount !== inc.stepCount ||
        (!prev.byModel && Array.isArray(inc.byModel))
      ) {
        storeDirty = true;
      }

      const merged = stripHeavyStepsForArchive({
        ...inc,
        quotaUsage: estimatedQuota,
      });

      existingMap.set(inc.turnId, merged);
      mergedOrder.push(inc.turnId);
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
      .map((pt) =>
        stripHeavyStepsForArchive({
          ...pt,
          isRunning: false,
          status: pt.status === 'RUNNING' ? 'DONE' : pt.status,
          quotaUsage: estimateTurnQuotaUsage(pt),
        })
      );

    const combinedAll = [
      ...archivedOlder,
      ...mergedOrder.map((id) => existingMap.get(id)),
    ];
    if (combinedAll.length > MAX_TURNS_PER_CONV) {
      const overflow = combinedAll.slice(0, combinedAll.length - MAX_TURNS_PER_CONV);
      const overflowTotals = overflow.map((t) => turnToTotals(toPublicTurn(t)));
      convRec.prunedTotals = toPublicPrunedTotals(
        addTotals(toPublicPrunedTotals(convRec.prunedTotals) || emptyTotals(), ...overflowTotals)
      );
      storeDirty = true;
    }
    convRec.turns = combinedAll.slice(-MAX_TURNS_PER_CONV);

    const publicTurns = convRec.turns.map(toPublicTurn);
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
  const publicTurns = Array.isArray(convRec.turns) ? convRec.turns.map(toPublicTurn) : [];
  return {
    conversationId: convRec.conversationId || convId,
    title: convRec.title || '',
    engine: convRec.engine || 'AGY',
    parentConversationId: convRec.parentConversationId || '',
    subagentRole: convRec.subagentRole || '',
    updatedAtMs: convRec.updatedAtMs || 0,
    prunedTotals: toPublicPrunedTotals(convRec.prunedTotals),
    turns: publicTurns,
  };
}

export function getPersistedTurnsForConversation(convId) {
  return getConversationRecord(convId)?.turns || [];
}

function accumulateQuotaByPool(acc, quotaUsage) {
  const byPool = quotaUsage?.byPool;
  if (!byPool || typeof byPool !== 'object') return;
  for (const [pk, b] of Object.entries(byPool)) {
    if (!b || typeof b !== 'object') continue;
    const h5 = Number(b.fiveHourUsedPct) || 0;
    const wk = Number(b.weeklyUsedPct) || 0;
    const wTok = Number(b.weightedTokens) || 0;
    if (h5 <= 0 && wk <= 0 && wTok <= 0) continue;
    if (!acc[pk]) acc[pk] = { h5: 0, wk: 0, wTok: 0 };
    acc[pk].h5 += h5;
    acc[pk].wk += wk;
    acc[pk].wTok += wTok;
  }
}

export function getLocalQuotaEstimatesByConv() {
  const store = loadStore();
  const out = {};
  for (const [cid, convRec] of Object.entries(store.conversations || {})) {
    if (!convRec || typeof convRec !== 'object') continue;
    const acc = {};
    if (convRec.prunedTotals) {
      accumulateQuotaByPool(acc, estimateTotalsQuotaUsage(convRec.prunedTotals));
    }
    for (const t of convRec.turns || []) {
      accumulateQuotaByPool(acc, estimateTurnQuotaUsage(t));
    }
    if (Object.keys(acc).length > 0) {
      out[cid] = acc;
    }
  }
  return out;
}
