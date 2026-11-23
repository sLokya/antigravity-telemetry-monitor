import { FLEET_LIMITS } from './contract.mjs';

export function buildRootOf(
  candidates = [],
  scannedLinks = new Map(),
  maxDepth = FLEET_LIMITS.maxRootDepth
) {
  const candMap = new Map();
  for (const c of candidates) {
    if (c?.conversationId) {
      candMap.set(c.conversationId, c);
    }
  }

  const parentOf = new Map();
  for (const c of candidates) {
    if (c?.conversationId && c.parentConversationId) {
      parentOf.set(c.conversationId, c.parentConversationId);
    }
  }
  for (const [childId, link] of scannedLinks.entries()) {
    if (!parentOf.has(childId) && link?.parentId) {
      parentOf.set(childId, link.parentId);
    }
  }

  const rootOf = new Map();
  const childrenByRoot = new Map();
  const linkMeta = new Map();

  for (const [id, parentId] of parentOf.entries()) {
    const cand = candMap.get(id);
    const scanned = scannedLinks.get(id);
    linkMeta.set(id, {
      parentId,
      name: scanned?.name || '',
      role: cand?.subagentRole || scanned?.name || '',
      spawnedAtMs: scanned?.spawnedAtMs || 0,
    });

    const visited = new Set([id]);
    let cur = id;
    let depth = 0;
    while (depth < maxDepth && parentOf.has(cur)) {
      const p = parentOf.get(cur);
      if (!p || visited.has(p) || !candMap.has(p)) break;
      visited.add(p);
      cur = p;
      depth += 1;
    }

    if (cur !== id) {
      rootOf.set(id, cur);
      if (!childrenByRoot.has(cur)) childrenByRoot.set(cur, new Set());
      childrenByRoot.get(cur).add(id);
    }
  }

  return { rootOf, childrenByRoot, linkMeta };
}

function comparePreselect(a, b) {
  const aRun = a.lsStatus === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
  const bRun = b.lsStatus === 'CASCADE_RUN_STATUS_RUNNING' ? 1 : 0;
  if (aRun !== bRun) return bRun - aRun;
  if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
  if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
  return (b.mtimeMs || 0) - (a.mtimeMs || 0);
}

function compareFinal(a, b) {
  const aActive = a.lsStatus === 'CASCADE_RUN_STATUS_RUNNING' || a.hasUnclosedBg ? 1 : 0;
  const bActive = b.lsStatus === 'CASCADE_RUN_STATUS_RUNNING' || b.hasUnclosedBg ? 1 : 0;
  if (aActive !== bActive) return bActive - aActive;
  if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
  if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
  return (b.mtimeMs || 0) - (a.mtimeMs || 0);
}

export function preselect(candidates = [], rootOf = new Map(), limits = FLEET_LIMITS) {
  const sorted = [...candidates].sort(comparePreselect);
  const nonChildren = sorted.filter((c) => !rootOf.has(c.conversationId));
  const selectedRoots = nonChildren.slice(0, limits.preselectRoots);
  const rootSet = new Set(selectedRoots.map((c) => c.conversationId));

  const selectedChildren = sorted
    .filter((c) => rootSet.has(rootOf.get(c.conversationId)))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, limits.maxChildren);

  return [...selectedRoots, ...selectedChildren];
}

export function finalSelect(enriched = [], rootOf = new Map(), limits = FLEET_LIMITS) {
  const sorted = [...enriched].sort(compareFinal);
  const roots = sorted.filter((c) => !rootOf.has(c.conversationId));
  const selectedRoots = roots.slice(0, limits.finalRoots);
  const rootSet = new Set(selectedRoots.map((c) => c.conversationId));

  const selectedChildren = sorted
    .filter((c) => rootSet.has(rootOf.get(c.conversationId)))
    .slice(0, limits.maxChildren);

  return [...selectedRoots, ...selectedChildren];
}
