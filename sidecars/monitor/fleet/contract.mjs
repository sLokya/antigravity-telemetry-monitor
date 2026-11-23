import { join } from 'node:path';
import { homedir } from 'node:os';

export const FLEET_LIMITS = {
  preselectRoots: 35,
  finalRoots: 24,
  maxChildren: 30,
  linkScanRecent: 40,
  maxRootDepth: 6,
};

export const UI_PREFS_FILE = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'telemetry_ui_prefs.json'
);

/**
 * @typedef {Object} SubagentSummary
 * @property {string} conversationId
 * @property {string} title
 * @property {string} role
 * @property {boolean} isRunning
 * @property {string} stateCode
 * @property {string} stateLabel
 * @property {string} modelLabel
 * @property {string} exactModelId
 * @property {number} mtimeMs
 * @property {SessionTotals} totals
 * @property {number[]} attachedTurnNumbers
 * @property {'live'|'history'} source
 * @property {string} engine
 */

/**
 * @typedef {Object} SessionTotals
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} outputTokens
 * @property {number} thinkingTokens
 * @property {number} totalTokens
 * @property {number} stepCount
 * @property {number} turnsCount
 * @property {number} cacheHitRate
 * @property {Array<Object>} byModel
 * @property {Object|null} quotaUsage
 */

/**
 * @typedef {Object} RootTaskExtras
 * @property {SessionTotals} sessionTotals
 * @property {SubagentSummary[]} subagents
 * @property {number} subagentRunningCount
 * @property {number} activityMtimeMs
 * @property {boolean} isDismissed
 */
