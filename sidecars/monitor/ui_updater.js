(function () {
  let updateDrawerOpen = false;

  window.togglePluginUpdateDrawer = function (event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    updateDrawerOpen = !updateDrawerOpen;
    const drawer = document.getElementById('pluginUpdateDrawer');
    if (!drawer) return;
    if (updateDrawerOpen) {
      drawer.classList.remove('hidden');
      if (window.lastPayload) window.renderPluginUpdater(window.lastPayload);
    } else {
      drawer.classList.add('hidden');
    }
  };

  window.runPluginUpdateAction = async function (event, action) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const btn = event?.currentTarget;
    const prevText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = action === 'apply_plugin_update' ? tHud('updApplying') : tHud('updChecking');
    }
    try {
      const res = await callActionApi({ action });
      showToast(res.ok ? res.message || tHud('updDone') : res.error || 'Error', !res.ok);
      if (res.ok && res.updated && res.frontendOnly) {
        setTimeout(() => reloadWithCacheBust(), 450);
        return;
      }
      await fetchTelemetry();
    } catch (err) {
      showToast(String(err?.message || err), true);
    } finally {
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }
  };

  window.renderPluginUpdater = function (data) {
    const upd = data?.pluginUpdate || null;
    const btn = document.getElementById('pluginUpdateBtn');
    const btnLabel = document.getElementById('pluginUpdateBtnLabel');
    if (btn && btnLabel && upd) {
      const showAlert = Boolean(upd.hasUpdate && !upd.dismissed);
      const targetTag = upd.remoteTag || (upd.remoteVersion ? `v${upd.remoteVersion}` : upd.remoteShortSha || '');
      if (upd.needsReload) {
        btnLabel.textContent = tHud('updReloadShort');
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold transition flex items-center gap-1 whitespace-nowrap';
      } else if (showAlert) {
        btnLabel.textContent = targetTag ? `${tHud('updNewShort')} ${targetTag}` : tHud('updNewShort');
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-sky-500/60 bg-sky-500/15 text-sky-600 dark:text-sky-400 font-bold transition flex items-center gap-1 whitespace-nowrap';
      } else {
        btnLabel.textContent = `v${upd.localVersion || '1.0'}`;
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-[var(--hud-border)] bg-[var(--background)] text-[var(--muted-foreground)] hover:border-sky-500/50 hover:text-sky-500 font-medium mono transition flex items-center gap-1 whitespace-nowrap';
      }
      btn.setAttribute('aria-expanded', String(updateDrawerOpen));
    }

    const drawer = document.getElementById('pluginUpdateDrawer');
    if (!drawer || !updateDrawerOpen || !upd) return;

    const targetLabel = upd.remoteTag || (upd.remoteVersion ? `v${upd.remoteVersion}` : upd.remoteShortSha || '--');
    const checkedAgo = upd.checkedAtMs ? fmtAgo(upd.checkedAtMs) : '--';
    const modeLabel = upd.installMode === 'git' ? `Git (${upd.branch || 'main'})` : 'Archive';

    drawer.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hud-border)] pb-1.5">
        <div class="flex items-center gap-1.5 text-xs font-bold min-w-0">
          <span>⬆️</span>
          <span>${escapeHtml(tHud('updDrawerTitle'))}</span>
          <span class="mono text-[10px] px-1.5 py-0.2 rounded bg-[var(--card)] border border-[var(--hud-border)] text-[var(--muted-foreground)] font-medium">
            v${escapeHtml(upd.localVersion || '0.0.0')}${upd.localShortSha ? ` · ${escapeHtml(upd.localShortSha)}` : ''}
          </span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="runPluginUpdateAction(event, 'check_plugin_update')"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--card)] hover:border-sky-500/50 hover:text-sky-500 font-medium whitespace-nowrap">
            ${escapeHtml(upd.checking ? tHud('updChecking') : tHud('updCheckBtn'))}
          </button>
          <button type="button" onclick="togglePluginUpdateDrawer(event)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--hud-border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] whitespace-nowrap">
            ${escapeHtml(tHud('fpClose'))} ✕
          </button>
        </div>
      </div>

      ${upd.needsReload ? `
        <div class="rounded-lg border border-emerald-500/40 bg-emerald-500/12 px-2.5 py-2 text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
          ${escapeHtml(tHud('updNeedReloadBanner'))}
        </div>
      ` : ''}

      ${upd.status === 'error' && upd.error ? `
        <div class="rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-600 dark:text-rose-400">
          ${escapeHtml(upd.error)}
        </div>
      ` : ''}

      <div class="bg-[var(--card)] border border-[var(--hud-border)] rounded-lg px-2.5 py-2 space-y-1.5 text-[11px]">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-semibold text-[var(--foreground)]">
              ${upd.hasUpdate ? escapeHtml(tHud('updAvailLine', targetLabel)) : escapeHtml(tHud('updUpToDate'))}
            </span>
            <span class="mono text-[10px] text-[var(--muted-foreground)]">${escapeHtml(modeLabel)} · ${escapeHtml(tHud('updCheckedAt', checkedAgo))}</span>
          </div>
          ${upd.releaseUrl ? `
            <a href="${escapeHtml(upd.releaseUrl)}" target="_blank" rel="noopener noreferrer"
               class="text-[10px] text-sky-600 dark:text-sky-400 hover:underline mono whitespace-nowrap">GitHub ↗</a>
          ` : ''}
        </div>

        ${upd.hasUpdate && upd.releaseNotes ? `
          <div class="text-[11px] text-[var(--muted-foreground)] bg-[var(--hud-subtle)] border border-[var(--hud-border)] rounded px-2 py-1.5 whitespace-pre-wrap leading-relaxed">${escapeHtml(upd.releaseNotes)}</div>
        ` : ''}

        ${upd.isDirty ? `
          <div class="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
            ⚠️ ${escapeHtml(tHud('updDirtyWarn', (upd.dirtyFiles || []).length))}
          </div>
        ` : ''}

        ${upd.hasUpdate ? `
          <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button type="button" ${upd.isDirty || upd.updating ? 'disabled' : ''}
                    onclick="runPluginUpdateAction(event, 'apply_plugin_update')"
                    class="px-2.5 py-1 rounded-md ${upd.isDirty ? 'bg-[var(--hud-subtle)] text-[var(--muted-foreground)] border border-[var(--hud-border)] opacity-60 cursor-not-allowed' : 'bg-sky-600 text-white hover:bg-sky-500 shadow-sm'} font-semibold text-[11px] transition whitespace-nowrap">
              ${escapeHtml(upd.updating ? tHud('updApplying') : tHud('updApplyBtn'))}
            </button>
            ${!upd.dismissed ? `
              <button type="button" onclick="runPluginUpdateAction(event, 'dismiss_plugin_update')"
                      class="px-2 py-1 rounded-md border border-[var(--hud-border)] bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-[11px] transition whitespace-nowrap">
                ${escapeHtml(tHud('updDismissBtn'))}
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  };
})();
