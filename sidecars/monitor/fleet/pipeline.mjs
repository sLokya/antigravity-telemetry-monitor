import { FLEET_LIMITS } from './contract.mjs';
import { scanSpawnLinks } from './subagent_links.mjs';
import { buildRootOf } from './candidate_select.mjs';
import { nestSubagents } from './hierarchy_merge.mjs';
import { applyDismissFlags } from './dismiss_store.mjs';
import { getConversationRecord } from '../task_history_store.mjs';

export function buildRootMap(candidates = [], brainDir) {
  const recentRoots = [...candidates]
    .filter((c) => !c.parentConversationId)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, FLEET_LIMITS.linkScanRecent);

  const scannedLinks = scanSpawnLinks(
    recentRoots.map((c) => c.conversationId),
    brainDir
  );
  return buildRootOf(candidates, scannedLinks, FLEET_LIMITS.maxRootDepth);
}

function isRootInProgress(r) {
  return (
    r.isRunning ||
    (r.runningBgCount || 0) > 0 ||
    (r.subagentRunningCount || 0) > 0 ||
    Boolean(r.linkedCodex?.isRunning)
  );
}

export function finalizeFleet({ tasks = [], rootMap = {} }) {
  const { roots, byId } = nestSubagents({
    tasks,
    rootOf: rootMap.rootOf,
    childrenByRoot: rootMap.childrenByRoot,
    linkMeta: rootMap.linkMeta,
    loadRecord: getConversationRecord,
  });

  applyDismissFlags(roots);

  roots.sort((a, b) => {
    const aActive = isRootInProgress(a) ? 1 : 0;
    const bActive = isRootInProgress(b) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aSubBg = (a.runningBgCount || 0) + (a.subagentRunningCount || 0);
    const bSubBg = (b.runningBgCount || 0) + (b.subagentRunningCount || 0);
    if (aSubBg !== bSubBg) return bSubBg - aSubBg;
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return (b.activityMtimeMs || b.mtimeMs || 0) - (a.activityMtimeMs || a.mtimeMs || 0);
  });

  return { roots, byId };
}
