import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_BRANCH,
  FETCH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  PLUGIN_ROOT,
  UPDATER_STATE_FILE,
  classifyChangedFiles,
  loadUpdaterState,
  readLocalPluginMeta,
  saveUpdaterState,
} from './contract.mjs';

const execFileAsync = promisify(execFile);

async function runCmd(bin, args, cwd, timeout = GIT_TIMEOUT_MS) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
}

async function verifyJsSyntax(files, baseDir) {
  const jsFiles = files.filter((f) => /\.(mjs|js)$/i.test(f));
  for (const rel of jsFiles) {
    const full = join(baseDir, rel);
    if (!existsSync(full)) continue;
    await runCmd(process.execPath, ['--check', full], baseDir, 10000);
  }
}

async function applyGitUpdate(pluginRoot) {
  const { stdout: porcelain } = await runCmd('git', ['status', '--porcelain'], pluginRoot, 5000);
  if (porcelain) {
    return {
      ok: false,
      code: 'DIRTY_WORKTREE',
      error: '检测到插件目录存在本地未提交改动，已中止更新以防覆盖，请先 commit 或 stash 后重试',
    };
  }

  const { stdout: rawBranch } = await runCmd(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    pluginRoot,
    5000
  );
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : DEFAULT_BRANCH;
  const { stdout: beforeSha } = await runCmd('git', ['rev-parse', 'HEAD'], pluginRoot, 5000);

  await runCmd('git', ['fetch', '--tags', 'origin', branch], pluginRoot, GIT_TIMEOUT_MS);
  try {
    await runCmd('git', ['pull', '--ff-only', 'origin', branch], pluginRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    return {
      ok: false,
      code: 'FF_ONLY_FAILED',
      error: `无法快进合并（本地分支可能已分叉），请手动 git pull：${err?.stderr || err?.message || err}`,
    };
  }

  const { stdout: afterSha } = await runCmd('git', ['rev-parse', 'HEAD'], pluginRoot, 5000);
  if (beforeSha === afterSha) {
    return {
      ok: true,
      updated: false,
      beforeSha,
      afterSha,
      changedFiles: [],
      frontendOnly: false,
      needsReload: false,
      message: '当前已是最新版本',
    };
  }

  const { stdout: diffOut } = await runCmd(
    'git',
    ['diff', '--name-only', `${beforeSha}..${afterSha}`],
    pluginRoot,
    5000
  );
  const changed = classifyChangedFiles(diffOut ? diffOut.split(/\r?\n/) : []);

  try {
    await verifyJsSyntax(changed.files, pluginRoot);
  } catch (err) {
    // Auto-rollback on broken JS syntax
    await runCmd('git', ['reset', '--hard', beforeSha], pluginRoot, 10000).catch(() => {});
    return {
      ok: false,
      code: 'SYNTAX_CHECK_FAILED',
      error: `更新后语法预检未通过，已自动回滚至 ${beforeSha.slice(0, 7)}：${err?.stderr || err?.message || err}`,
    };
  }

  const newMeta = readLocalPluginMeta(pluginRoot);
  return {
    ok: true,
    updated: true,
    beforeSha,
    afterSha,
    newVersion: newMeta.version,
    changedFiles: changed.files,
    frontendOnly: changed.frontendOnly,
    needsReload: changed.backendChanged,
    message: changed.frontendOnly
      ? `已更新至 v${newMeta.version} (${afterSha.slice(0, 7)})，仅前端变更，面板将自动刷新`
      : `已更新至 v${newMeta.version} (${afterSha.slice(0, 7)})，请在 Plugins 中开关一次 agy-telemetry 完成后端重载`,
  };
}

async function applyArchiveUpdate(pluginRoot, latestInfo, fetchImpl = fetch) {
  const meta = readLocalPluginMeta(pluginRoot);
  const slug = latestInfo?.repoSlug || `${meta.owner}/${meta.repo}`;
  const branch = latestInfo?.branch || DEFAULT_BRANCH;
  const tarballUrl =
    latestInfo?.tarballUrl ||
    `https://codeload.github.com/${slug}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;

  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-telemetry-upd-'));
  const tarFile = join(tmpDir, 'release.tar.gz');
  const extractDir = join(tmpDir, 'extract');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(FETCH_TIMEOUT_MS, 25000));
    try {
      const res = await fetchImpl(tarballUrl, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'agy-telemetry-updater' },
      });
      if (!res.ok) throw new Error(`下载更新包失败 (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(tarFile, buf);
    } finally {
      clearTimeout(timer);
    }

    await runCmd('tar', ['-xzf', tarFile, '-C', tmpDir], tmpDir, 20000);
    const entries = readdirSync(tmpDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && existsSync(join(tmpDir, d.name, 'plugin.json'))
    );
    if (entries.length === 0) {
      throw new Error('更新包内未找到 plugin.json，已中止覆盖');
    }
    const srcRoot = join(tmpDir, entries[0].name);

    // Pre-flight syntax verification on core server entry before touching live files
    const serverEntry = join(srcRoot, 'sidecars', 'monitor', 'server.mjs');
    if (existsSync(serverEntry)) {
      await runCmd(process.execPath, ['--check', serverEntry], srcRoot, 10000);
    }

    cpSync(srcRoot, pluginRoot, { recursive: true, force: true });
    const newMeta = readLocalPluginMeta(pluginRoot);
    return {
      ok: true,
      updated: true,
      newVersion: newMeta.version,
      afterSha: latestInfo?.remoteSha || '',
      changedFiles: [],
      frontendOnly: false,
      needsReload: true,
      message: `已更新至 v${newMeta.version}，请在 Plugins 中开关一次 agy-telemetry 完成重载`,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export async function applyPluginUpdate({
  pluginRoot = PLUGIN_ROOT,
  stateFile = UPDATER_STATE_FILE,
  latestInfo = null,
  nowMs = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const isGit = existsSync(join(pluginRoot, '.git'));
  try {
    const res = isGit
      ? await applyGitUpdate(pluginRoot)
      : await applyArchiveUpdate(pluginRoot, latestInfo, fetchImpl);

    if (res.ok && res.updated) {
      const prev = loadUpdaterState(stateFile);
      saveUpdaterState(
        {
          ...prev,
          status: 'up_to_date',
          hasUpdate: false,
          localVersion: res.newVersion || prev.localVersion,
          localSha: res.afterSha || prev.localSha,
          localShortSha: res.afterSha ? res.afterSha.slice(0, 7) : prev.localShortSha,
          installedArchiveSha: !isGit ? latestInfo?.remoteSha || '' : prev.installedArchiveSha,
          checkedAtMs: nowMs,
          lastAppliedAtMs: nowMs,
          needsReload: Boolean(res.needsReload),
          error: '',
        },
        stateFile
      );
    }
    return res;
  } catch (err) {
    return {
      ok: false,
      code: 'UPDATE_FAILED',
      error: String(err?.stderr || err?.message || err),
    };
  }
}
