import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CHECK_INTERVAL_MS,
  DEFAULT_BRANCH,
  FETCH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  PLUGIN_ROOT,
  UPDATER_STATE_FILE,
  compareSemver,
  loadUpdaterState,
  parseGitHubSlug,
  readLocalPluginMeta,
  saveUpdaterState,
} from './contract.mjs';

const execFileAsync = promisify(execFile);

async function runGit(args, cwd, timeout = GIT_TIMEOUT_MS) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return String(stdout || '').trim();
}

async function fetchJsonWithTimeout(url, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agy-telemetry-updater',
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLocalInstall(pluginRoot = PLUGIN_ROOT) {
  const meta = readLocalPluginMeta(pluginRoot);
  const hasGit = existsSync(join(pluginRoot, '.git'));
  if (!hasGit) {
    return {
      ...meta,
      installMode: 'archive',
      branch: DEFAULT_BRANCH,
      headSha: '',
      shortSha: '',
      isDirty: false,
      dirtyFiles: [],
      repoSlug: `${meta.owner}/${meta.repo}`,
    };
  }

  let branch = DEFAULT_BRANCH;
  let headSha = '';
  let shortSha = '';
  let dirtyFiles = [];
  let owner = meta.owner;
  let repo = meta.repo;

  try {
    const rawBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], pluginRoot, 5000);
    if (rawBranch && rawBranch !== 'HEAD') branch = rawBranch;
  } catch {}
  try {
    headSha = await runGit(['rev-parse', 'HEAD'], pluginRoot, 5000);
    shortSha = headSha.slice(0, 7);
  } catch {}
  try {
    const porcelain = await runGit(['status', '--porcelain'], pluginRoot, 5000);
    dirtyFiles = porcelain
      ? porcelain
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10)
      : [];
  } catch {}
  try {
    const remoteUrl = await runGit(['remote', 'get-url', 'origin'], pluginRoot, 5000);
    const parsed = parseGitHubSlug(remoteUrl);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    }
  } catch {}

  return {
    ...meta,
    owner,
    repo,
    repoSlug: `${owner}/${repo}`,
    installMode: 'git',
    branch,
    headSha,
    shortSha,
    isDirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

function summarizeReleaseBody(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  const text = lines.join('\n');
  return text.length > 360 ? `${text.slice(0, 357)}...` : text;
}

export async function checkForPluginUpdate({
  pluginRoot = PLUGIN_ROOT,
  stateFile = UPDATER_STATE_FILE,
  force = false,
  nowMs = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const local = await inspectLocalInstall(pluginRoot);
  const cached = loadUpdaterState(stateFile);
  const dismissedKey = String(cached.dismissedKey || '');

  if (
    !force &&
    cached.checkedAtMs &&
    nowMs - cached.checkedAtMs < CHECK_INTERVAL_MS &&
    cached.localVersion === local.version &&
    cached.localSha === local.headSha &&
    cached.status !== 'error'
  ) {
    const targetKey = cached.remoteTag || cached.remoteSha || '';
    return {
      ...cached,
      isDirty: local.isDirty,
      dirtyFiles: local.dirtyFiles,
      branch: local.branch,
      dismissed: Boolean(targetKey && dismissedKey === targetKey),
    };
  }

  const base = {
    status: 'up_to_date',
    hasUpdate: false,
    channel: 'release',
    installMode: local.installMode,
    repoSlug: local.repoSlug,
    branch: local.branch,
    localVersion: local.version,
    localSha: local.headSha,
    localShortSha: local.shortSha,
    remoteVersion: null,
    remoteTag: null,
    remoteSha: null,
    remoteShortSha: null,
    releaseTitle: '',
    releaseNotes: '',
    releaseUrl: `https://github.com/${local.repoSlug}`,
    tarballUrl: '',
    isDirty: local.isDirty,
    dirtyFiles: local.dirtyFiles,
    checkedAtMs: nowMs,
    dismissedKey,
    dismissed: false,
    error: '',
  };

  try {
    // Priority 1: Official GitHub Releases (semver tag)
    const relRes = await fetchJsonWithTimeout(
      `https://api.github.com/repos/${local.repoSlug}/releases/latest`,
      fetchImpl
    );

    if (relRes.ok && relRes.json?.tag_name) {
      const rel = relRes.json;
      const remoteTag = String(rel.tag_name).trim();
      const remoteVersion = remoteTag.replace(/^v/i, '');
      const hasUpdate = compareSemver(remoteVersion, local.version) > 0;
      const out = {
        ...base,
        status: hasUpdate ? 'update_available' : 'up_to_date',
        hasUpdate,
        channel: 'release',
        remoteVersion,
        remoteTag,
        releaseTitle: String(rel.name || remoteTag),
        releaseNotes: summarizeReleaseBody(rel.body),
        releaseUrl: String(rel.html_url || base.releaseUrl),
        tarballUrl: String(rel.tarball_url || ''),
        dismissed: Boolean(hasUpdate && dismissedKey === remoteTag),
      };
      saveUpdaterState(out, stateFile);
      return out;
    }

    // Priority 2: Branch HEAD fallback (when no GitHub Releases are published yet)
    if (relRes.status === 404 || !relRes.ok) {
      let remoteSha = '';
      let commitSubject = '';
      let remoteVersion = null;

      if (local.installMode === 'git') {
        const lsOut = await runGit(['ls-remote', 'origin', `refs/heads/${local.branch}`], pluginRoot, 12000);
        const firstLine = lsOut.split(/\r?\n/)[0] || '';
        remoteSha = firstLine.split(/\s+/)[0] || '';
      }

      if (!remoteSha) {
        const commitRes = await fetchJsonWithTimeout(
          `https://api.github.com/repos/${local.repoSlug}/commits/${encodeURIComponent(local.branch)}`,
          fetchImpl
        );
        if (commitRes.ok && commitRes.json?.sha) {
          remoteSha = String(commitRes.json.sha).trim();
          commitSubject = String(commitRes.json.commit?.message || '').split(/\r?\n/)[0] || '';
        } else if (!relRes.ok && relRes.status !== 404) {
          throw new Error(`GitHub API HTTP ${relRes.status}`);
        }
      }

      let hasUpdate = false;
      if (remoteSha) {
        if (local.installMode === 'git' && local.headSha) {
          if (remoteSha !== local.headSha) {
            // If remoteSha is already an ancestor of local HEAD, local is ahead (e.g. author unpushed commits)
            let remoteIsAncestor = false;
            try {
              await runGit(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], pluginRoot, 5000);
              remoteIsAncestor = true;
            } catch {
              remoteIsAncestor = false;
            }
            hasUpdate = !remoteIsAncestor;
          }
        } else {
          const manifestRes = await fetchJsonWithTimeout(
            `https://raw.githubusercontent.com/${local.repoSlug}/${encodeURIComponent(local.branch)}/plugin.json`,
            fetchImpl
          );
          if (manifestRes.ok && manifestRes.json?.version) {
            remoteVersion = String(manifestRes.json.version).trim();
            hasUpdate = compareSemver(remoteVersion, local.version) > 0;
          } else if (cached.installedArchiveSha) {
            hasUpdate = remoteSha !== cached.installedArchiveSha;
          }
        }
      }

      if (hasUpdate && !commitSubject && remoteSha) {
        try {
          const cRes = await fetchJsonWithTimeout(
            `https://api.github.com/repos/${local.repoSlug}/commits/${remoteSha}`,
            fetchImpl,
            5000
          );
          if (cRes.ok && cRes.json?.commit?.message) {
            commitSubject = String(cRes.json.commit.message).split(/\r?\n/)[0] || '';
          }
        } catch {}
      }

      const out = {
        ...base,
        status: hasUpdate ? 'update_available' : 'up_to_date',
        hasUpdate,
        channel: 'branch',
        remoteVersion,
        remoteSha: remoteSha || null,
        remoteShortSha: remoteSha ? remoteSha.slice(0, 7) : null,
        releaseTitle: commitSubject || (remoteSha ? `${local.branch}@${remoteSha.slice(0, 7)}` : ''),
        releaseNotes: commitSubject,
        releaseUrl: remoteSha
          ? `https://github.com/${local.repoSlug}/commit/${remoteSha}`
          : base.releaseUrl,
        tarballUrl: `https://codeload.github.com/${local.repoSlug}/tar.gz/refs/heads/${encodeURIComponent(local.branch)}`,
        dismissed: Boolean(hasUpdate && remoteSha && dismissedKey === remoteSha),
      };
      saveUpdaterState(out, stateFile);
      return out;
    }
  } catch (err) {
    const out = {
      ...base,
      status: 'error',
      error: String(err?.message || err),
    };
    return out;
  }

  return base;
}
