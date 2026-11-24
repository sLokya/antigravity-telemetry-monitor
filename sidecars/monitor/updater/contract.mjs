import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
export const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');
export const UPDATER_STATE_FILE = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'telemetry_updater_state.json'
);

export const DEFAULT_REPO_OWNER = 'sLokya';
export const DEFAULT_REPO_NAME = 'antigravity-telemetry-monitor';
export const DEFAULT_BRANCH = 'main';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const INITIAL_CHECK_DELAY_MS = 12 * 1000;
export const FETCH_TIMEOUT_MS = 10 * 1000;
export const GIT_TIMEOUT_MS = 25 * 1000;

const FRONTEND_ONLY_RE = /^sidecars\/monitor\/(index\.html|ui_[a-z0-9_]+\.js)$/i;

export function parseGitHubSlug(urlText) {
  const raw = String(urlText || '').trim();
  if (!raw) return null;
  const m = raw.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function readLocalPluginMeta(pluginRoot = PLUGIN_ROOT) {
  const manifestPath = join(pluginRoot, 'plugin.json');
  let parsed = {};
  try {
    if (existsSync(manifestPath)) {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    }
  } catch {
    parsed = {};
  }
  const repoField =
    typeof parsed.repository === 'string'
      ? parsed.repository
      : typeof parsed.repository?.url === 'string'
        ? parsed.repository.url
        : '';
  const slug = parseGitHubSlug(repoField) || {
    owner: DEFAULT_REPO_OWNER,
    repo: DEFAULT_REPO_NAME,
  };
  return {
    name: String(parsed.name || 'agy-telemetry'),
    displayName: String(parsed.displayName || 'Antigravity Telemetry'),
    version: String(parsed.version || '0.0.0').trim(),
    owner: slug.owner,
    repo: slug.repo,
  };
}

export function parseSemver(verText) {
  const cleaned = String(verText || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
  const parts = cleaned.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function classifyChangedFiles(files = []) {
  const list = Array.isArray(files)
    ? files.map((f) => String(f || '').replace(/\\/g, '/').trim()).filter(Boolean)
    : [];
  if (list.length === 0) {
    return { frontendOnly: false, backendChanged: false, files: [] };
  }
  const frontendOnly = list.every((f) => FRONTEND_ONLY_RE.test(f));
  return {
    frontendOnly,
    backendChanged: !frontendOnly,
    files: list,
  };
}

export function loadUpdaterState(stateFile = UPDATER_STATE_FILE) {
  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return {};
}

export function saveUpdaterState(nextState, stateFile = UPDATER_STATE_FILE) {
  try {
    const dir = dirname(stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(nextState, null, 2), 'utf-8');
  } catch {
    // ignore disk write errors
  }
}
