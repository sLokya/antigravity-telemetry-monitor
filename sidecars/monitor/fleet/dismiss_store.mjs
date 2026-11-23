import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { UI_PREFS_FILE } from './contract.mjs';

let cachedPrefs = null;

function loadPrefs() {
  if (cachedPrefs) return cachedPrefs;
  try {
    if (existsSync(UI_PREFS_FILE)) {
      const parsed = JSON.parse(readFileSync(UI_PREFS_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        cachedPrefs = {
          version: 1,
          dismissed: parsed.dismissed && typeof parsed.dismissed === 'object' ? { ...parsed.dismissed } : {},
        };
        return cachedPrefs;
      }
    }
  } catch {
    // ignore read/parse error and start empty
  }
  cachedPrefs = { version: 1, dismissed: {} };
  return cachedPrefs;
}

function savePrefs(prefs) {
  try {
    const dir = dirname(UI_PREFS_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(UI_PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch {
    // ignore disk write errors
  }
}

export function dismissConversation(cid, nowMs = Date.now()) {
  if (!cid) return false;
  const prefs = loadPrefs();
  prefs.dismissed[cid] = nowMs;
  savePrefs(prefs);
  return true;
}

export function restoreConversation(cid) {
  if (!cid) return false;
  const prefs = loadPrefs();
  if (Object.prototype.hasOwnProperty.call(prefs.dismissed, cid)) {
    delete prefs.dismissed[cid];
    savePrefs(prefs);
  }
  return true;
}

export function applyDismissFlags(roots = []) {
  const prefs = loadPrefs();
  let changed = false;

  for (const r of roots) {
    const cid = r?.conversationId;
    if (!cid) continue;
    const dismissedAt = prefs.dismissed[cid];
    if (!dismissedAt) {
      r.isDismissed = false;
      continue;
    }
    const isInProgress = Boolean(
      r.isRunning ||
        (r.runningBgCount || 0) > 0 ||
        (r.subagentRunningCount || 0) > 0 ||
        r.linkedCodex?.isRunning
    );
    const actMs = r.activityMtimeMs || r.mtimeMs || 0;
    if (isInProgress || actMs > dismissedAt + 1500) {
      delete prefs.dismissed[cid];
      r.isDismissed = false;
      changed = true;
    } else {
      r.isDismissed = true;
    }
  }

  if (changed) {
    savePrefs(prefs);
  }
}
