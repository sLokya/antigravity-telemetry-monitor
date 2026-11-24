import {
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  PLUGIN_ROOT,
  UPDATER_STATE_FILE,
  classifyChangedFiles,
  compareSemver,
  loadUpdaterState,
  readLocalPluginMeta,
  saveUpdaterState,
} from './contract.mjs';
import { checkForPluginUpdate, inspectLocalInstall } from './checker.mjs';
import { applyPluginUpdate } from './applier.mjs';

export {
  PLUGIN_ROOT,
  UPDATER_STATE_FILE,
  readLocalPluginMeta,
  compareSemver,
  classifyChangedFiles,
  inspectLocalInstall,
  checkForPluginUpdate,
  applyPluginUpdate,
};

let latestStatus = null;
let checkInFlight = null;
let applyInFlight = null;
let bgTimerStarted = false;

function buildInitialStatus() {
  const meta = readLocalPluginMeta(PLUGIN_ROOT);
  const cached = loadUpdaterState(UPDATER_STATE_FILE);
  if (cached && cached.localVersion === meta.version) {
    return {
      ...cached,
      checking: false,
      updating: false,
    };
  }
  return {
    status: 'idle',
    hasUpdate: false,
    channel: 'release',
    installMode: 'git',
    repoSlug: `${meta.owner}/${meta.repo}`,
    branch: 'main',
    localVersion: meta.version,
    localSha: '',
    localShortSha: '',
    remoteVersion: null,
    remoteTag: null,
    remoteSha: null,
    remoteShortSha: null,
    releaseTitle: '',
    releaseNotes: '',
    releaseUrl: `https://github.com/${meta.owner}/${meta.repo}`,
    isDirty: false,
    dirtyFiles: [],
    checkedAtMs: 0,
    dismissed: false,
    needsReload: false,
    checking: false,
    updating: false,
    error: '',
  };
}

export function getPluginUpdateStatus() {
  if (!latestStatus) {
    latestStatus = buildInitialStatus();
  }
  return {
    ...latestStatus,
    checking: Boolean(checkInFlight),
    updating: Boolean(applyInFlight),
  };
}

export async function runPluginUpdateCheck({ force = false } = {}) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    try {
      const prevNeedsReload = Boolean(latestStatus?.needsReload);
      const res = await checkForPluginUpdate({ force });
      latestStatus = { ...res, needsReload: prevNeedsReload };
      return latestStatus;
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

export function startBackgroundUpdateChecker() {
  if (bgTimerStarted) return;
  bgTimerStarted = true;
  setTimeout(() => {
    runPluginUpdateCheck({ force: false }).catch(() => {});
  }, INITIAL_CHECK_DELAY_MS).unref();
  setInterval(() => {
    runPluginUpdateCheck({ force: false }).catch(() => {});
  }, CHECK_INTERVAL_MS).unref();
}

export async function handleUpdaterAction(data) {
  const action = data?.action;
  if (action === 'check_plugin_update') {
    const st = await runPluginUpdateCheck({ force: true });
    if (st.status === 'error') {
      return { ok: false, error: `检查更新失败: ${st.error}`, status: st };
    }
    return {
      ok: true,
      status: st,
      message: st.hasUpdate
        ? `发现新版本 ${st.remoteTag || st.remoteShortSha || ''}`
        : `已是最新版本 (v${st.localVersion}${st.localShortSha ? ` · ${st.localShortSha}` : ''})`,
    };
  }

  if (action === 'dismiss_plugin_update') {
    const cur = getPluginUpdateStatus();
    const targetKey = cur.remoteTag || cur.remoteSha || '';
    const cached = loadUpdaterState(UPDATER_STATE_FILE);
    saveUpdaterState({ ...cached, dismissedKey: targetKey }, UPDATER_STATE_FILE);
    latestStatus = { ...cur, dismissedKey: targetKey, dismissed: true };
    return { ok: true, message: '已忽略当前版本提醒' };
  }

  if (action === 'apply_plugin_update') {
    if (applyInFlight) {
      return { ok: false, error: '更新正在进行中，请稍候' };
    }
    applyInFlight = (async () => {
      try {
        const res = await applyPluginUpdate({ latestInfo: latestStatus });
        if (res.ok && res.updated) {
          const refreshed = await checkForPluginUpdate({ force: true }).catch(() => null);
          latestStatus = {
            ...(refreshed || latestStatus || buildInitialStatus()),
            hasUpdate: false,
            status: 'up_to_date',
            needsReload: Boolean(res.needsReload),
          };
        } else {
          // Refresh dirty/status snapshot on failure
          const local = await inspectLocalInstall(PLUGIN_ROOT).catch(() => null);
          if (local && latestStatus) {
            latestStatus = { ...latestStatus, isDirty: local.isDirty, dirtyFiles: local.dirtyFiles };
          }
        }
        return res;
      } finally {
        applyInFlight = null;
      }
    })();
    return applyInFlight;
  }

  return null;
}
