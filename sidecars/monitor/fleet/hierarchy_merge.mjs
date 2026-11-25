import { turnToTotals, addTotals } from '../usage_contract.mjs';

function findTargetParentTurn(parentTurns, childStartedAtMs, childMtimeMs) {
  if (!Array.isArray(parentTurns) || parentTurns.length === 0) return null;
  const ts = childStartedAtMs || childMtimeMs || 0;
  if (!ts) {
    return parentTurns[parentTurns.length - 1];
  }

  let matched = null;
  let firstValid = null;
  for (const pt of parentTurns) {
    const pStart = pt.startedAtMs || 0;
    if (pStart > 0) {
      if (!firstValid) firstValid = pt;
      if (pStart <= ts) {
        matched = pt;
      }
    }
  }

  if (matched) return matched;
  if (firstValid && ts < (firstValid.startedAtMs || 0)) {
    return parentTurns[0];
  }
  return parentTurns[parentTurns.length - 1];
}

export function nestSubagents({
  tasks = [],
  rootOf = new Map(),
  childrenByRoot = new Map(),
  linkMeta = new Map(),
  loadRecord = null,
}) {
  const taskById = new Map();
  for (const t of tasks) {
    if (t?.conversationId) {
      taskById.set(t.conversationId, t);
    }
  }

  const rootTasks = [];
  const liveChildrenByRoot = new Map();
  for (const t of tasks) {
    const rid = rootOf.get(t.conversationId);
    if (rid && rid !== t.conversationId && taskById.has(rid)) {
      if (!liveChildrenByRoot.has(rid)) liveChildrenByRoot.set(rid, new Set());
      liveChildrenByRoot.get(rid).add(t.conversationId);
    } else {
      rootTasks.push(t);
    }
  }

  const roots = [];
  const byId = new Map();

  for (const rawRoot of rootTasks) {
    const R = { ...rawRoot };
    R.turns = Array.isArray(rawRoot.turns)
      ? rawRoot.turns.map((t) => ({ ...t, subagentTurns: [] }))
      : [];

    const childIds = new Set([
      ...(childrenByRoot.get(R.conversationId) || []),
      ...(liveChildrenByRoot.get(R.conversationId) || []),
    ]);
    childIds.delete(R.conversationId);

    const subagentSummaries = [];
    const childPrunedTotalsList = [];
    const unattachedChildTurnTotals = [];

    for (const cid of childIds) {
      const liveChild = taskById.get(cid) || null;
      const rec = loadRecord ? loadRecord(cid) : null;
      if (!liveChild && !rec) continue;

      const childTurns = liveChild ? liveChild.turns || [] : rec?.turns || [];
      const childMtimeMs = liveChild?.mtimeMs || rec?.updatedAtMs || 0;
      const childPruned = rec?.prunedTotals || null;
      if (childPruned) childPrunedTotalsList.push(childPruned);

      const meta = linkMeta.get(cid);
      const role = liveChild?.subagentRole || meta?.role || rec?.subagentRole || meta?.name || '';
      const title = liveChild?.title || rec?.title || meta?.name || cid.slice(0, 8);
      const label = role || meta?.name || title;

      const attachedTurnNumbers = new Set();
      const childTurnTotalsList = [];

      for (const ct of childTurns) {
        const ctTotals = turnToTotals(ct);
        childTurnTotalsList.push(ctTotals);

        const targetParent = findTargetParentTurn(
          R.turns,
          ct.startedAtMs || meta?.spawnedAtMs || 0,
          childMtimeMs
        );
        if (targetParent) {
          attachedTurnNumbers.add(targetParent.turnNumber);
          targetParent.subagentTurns.push({
            conversationId: cid,
            label,
            turnNumber: ct.turnNumber,
            startedAtMs: ct.startedAtMs || 0,
            isRunning: Boolean(ct.isRunning),
            totals: ctTotals,
          });
        } else {
          unattachedChildTurnTotals.push(ctTotals);
        }
      }

      const childTotals = addTotals(childPruned, ...childTurnTotalsList);
      const lastChildTurn = childTurns.length > 0 ? childTurns[childTurns.length - 1] : null;

      subagentSummaries.push({
        conversationId: cid,
        title,
        role,
        subagentType: liveChild?.subagentType || '',
        isRunning: Boolean(liveChild?.isRunning),
        stateCode: liveChild?.stateCode || 'IDLE',
        stateLabel: liveChild?.stateLabel || '空闲就绪',
        modelLabel: liveChild?.modelLabel || lastChildTurn?.modelLabel || '--',
        exactModelId: liveChild?.exactModelId || lastChildTurn?.exactModelId || '--',
        mtimeMs: childMtimeMs,
        totals: childTotals,
        attachedTurnNumbers: Array.from(attachedTurnNumbers).sort((a, b) => a - b),
        source: liveChild ? 'live' : 'history',
        engine: liveChild?.engine || rec?.engine || 'AGY',
      });

      if (liveChild) {
        const childClone = {
          ...liveChild,
          turns: Array.isArray(liveChild.turns) ? liveChild.turns.map((t) => ({ ...t })) : [],
          sessionTotals: childTotals,
          totalAllTokens: childTotals.totalTokens,
          totalCacheReadTokens: childTotals.cacheReadTokens,
          avgCacheHitRate: childTotals.cacheHitRate,
          totalTurnsCount: (liveChild.turns?.length || 0) + (childPruned?.turnsCount || 0),
        };
        byId.set(cid, childClone);
      }
    }

    for (const pt of R.turns) {
      const subTurns = pt.subagentTurns || [];
      const uniqueSubIds = new Set(subTurns.map((st) => st.conversationId));
      const agg = addTotals(turnToTotals(pt), ...subTurns.map((st) => st.totals));
      agg.subagentCount = uniqueSubIds.size;
      pt.aggregate = agg;
    }

    const rootRec = loadRecord ? loadRecord(R.conversationId) : null;
    R.sessionTotals = addTotals(
      rootRec?.prunedTotals,
      ...R.turns.map((t) => t.aggregate || turnToTotals(t)),
      ...childPrunedTotalsList,
      ...unattachedChildTurnTotals
    );

    if (R.turns.length > 0) {
      const { steps: _dropSteps, ...ctRest } = R.turns[R.turns.length - 1];
      R.currentTurn = ctRest;
    } else {
      R.currentTurn = null;
    }

    subagentSummaries.sort((a, b) => {
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });

    R.subagents = subagentSummaries;
    R.subagentRunningCount = subagentSummaries.filter((s) => s.isRunning).length;

    if (!R.isRunning && !(R.runningBgCount > 0) && R.subagentRunningCount > 0) {
      const firstRun = subagentSummaries.find((s) => s.isRunning) || subagentSummaries[0];
      R.stateCode = 'SUB_RUNNING';
      R.stateLabel = `子代理运行中 (${R.subagentRunningCount})`;
      R.stateDetail = `回合已完成 · 子代理 ${firstRun?.role || firstRun?.title || ''} 仍在执行`;
    }

    R.activityMtimeMs = Math.max(
      R.mtimeMs || 0,
      ...subagentSummaries.map((s) => s.mtimeMs || 0)
    );
    R.totalAllTokens = R.sessionTotals.totalTokens;
    R.totalCacheReadTokens = R.sessionTotals.cacheReadTokens;
    R.avgCacheHitRate = R.sessionTotals.cacheHitRate;
    R.totalTurnsCount = R.turns.length + (rootRec?.prunedTotals?.turnsCount || 0);

    byId.set(R.conversationId, R);
    roots.push(R);
  }

  return { roots, byId };
}
