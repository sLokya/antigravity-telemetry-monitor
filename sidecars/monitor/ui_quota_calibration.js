(function () {
  const POOL_ORDER = ['gemini', '3p', 'codex'];
  const POOL_STYLE = {
    gemini: { icon: '✦', label: 'Gemini', cls: 'text-sky-600 dark:text-sky-400' },
    '3p': { icon: '🟣', label: 'Claude', cls: 'text-purple-600 dark:text-purple-400' },
    codex: { icon: '🟢', label: 'Codex', cls: 'text-emerald-600 dark:text-emerald-400' },
  };

  let calibDrawerOpen = false;

  function fmtRateTok(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(Math.round(num));
  }

  window.toggleQuotaCalibDrawer = function (event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    calibDrawerOpen = !calibDrawerOpen;
    const drawer = document.getElementById('quotaCalibDrawer');
    if (!drawer) return;
    if (calibDrawerOpen) {
      drawer.classList.remove('hidden');
      if (window.lastPayload) window.renderQuotaCalibration(window.lastPayload);
    } else {
      drawer.classList.add('hidden');
    }
  };

  window.openQuotaCalibDrawer = function (event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    calibDrawerOpen = true;
    const drawer = document.getElementById('quotaCalibDrawer');
    if (drawer) drawer.classList.remove('hidden');
    if (window.lastPayload) window.renderQuotaCalibration(window.lastPayload);
  };

  window.runQuotaCalibAction = async function (event, action, poolKey = '') {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    try {
      const res = await callActionApi({ action, poolKey });
      showToast(res.ok ? res.message || tHud('calibActionOk') : res.error || 'Error', !res.ok);
      await fetchTelemetry();
    } catch (err) {
      showToast(String(err?.message || err), true);
    }
  };

  window.renderQuotaCalibration = function (data) {
    const cal = data?.quotaCalibration || null;
    const alerts = Array.isArray(cal?.overestimateAlerts) ? cal.overestimateAlerts : [];
    const pools = cal?.pools || {};
    const hasOverrides = Boolean(cal?.hasOverrides);

    const btn = document.getElementById('quotaCalibBtn');
    const btnLabel = document.getElementById('quotaCalibBtnLabel');
    if (btn && btnLabel) {
      if (alerts.length > 0) {
        btnLabel.textContent = `${tHud('btnCalib')} (${alerts.length})`;
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-amber-500/60 bg-amber-500/15 text-amber-600 dark:text-amber-400 font-bold transition flex items-center gap-1 whitespace-nowrap';
      } else if (hasOverrides) {
        btnLabel.textContent = tHud('btnCalibActive');
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-medium transition flex items-center gap-1 whitespace-nowrap';
      } else {
        btnLabel.textContent = tHud('btnCalib');
        btn.className =
          'text-[11px] sm:text-xs px-2 py-1 rounded-lg border border-[var(--hud-border)] bg-[var(--background)] hover:border-sky-500/50 hover:text-sky-500 font-medium transition flex items-center gap-1 whitespace-nowrap';
      }
      btn.setAttribute('aria-expanded', String(calibDrawerOpen));
    }

    const alertBanner = document.getElementById('quotaCalibAlert');
    if (alertBanner) {
      if (alerts.length > 0) {
        alertBanner.classList.remove('hidden');
        alertBanner.innerHTML = alerts
          .map((a) => {
            const meta = POOL_STYLE[a.poolKey] || { icon: '•', label: a.poolKey, cls: '' };
            return `
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 flex-wrap text-[11px]">
                  <span>⚠️</span>
                  <span class="font-bold text-amber-700 dark:text-amber-300">${escapeHtml(tHud('calibOverAlert', meta.label, a.actualDrop5hPct, a.localEst5hPct))}</span>
                  <span class="mono text-[var(--muted-foreground)]">(${fmtRateTok(a.currentWTokPer1Pct5h)} → ${fmtRateTok(a.suggestedWTokPer1Pct5h)} wTok/1%)</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button type="button" onclick="runQuotaCalibAction(event, 'apply_overestimate_fix', '${a.poolKey}')"
                          class="px-2 py-0.5 rounded-md bg-amber-600 text-white hover:bg-amber-500 font-semibold text-[11px] transition shadow-sm whitespace-nowrap">
                    ${escapeHtml(tHud('calibOverFixBtn'))}
                  </button>
                  <button type="button" onclick="openQuotaCalibDrawer(event)"
                          class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-[11px] transition whitespace-nowrap">
                    ${escapeHtml(tHud('calibDetailBtn'))}
                  </button>
                </div>
              </div>
            `;
          })
          .join('');
      } else {
        alertBanner.classList.add('hidden');
        alertBanner.innerHTML = '';
      }
    }

    const drawer = document.getElementById('quotaCalibDrawer');
    if (!drawer || !calibDrawerOpen) return;

    const minDrop = cal?.minActualDrop5hPct ?? 2;
    drawer.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hud-border)] pb-1.5">
        <div class="flex items-center gap-1.5 text-xs font-bold min-w-0">
          <span>⚖️</span>
          <span>${escapeHtml(tHud('calibDrawerTitle'))}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="runQuotaCalibAction(event, 'start_calibration_window', '')"
                  class="text-[11px] px-2 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 font-medium whitespace-nowrap">
            ${escapeHtml(tHud('calibStartAllBtn'))}
          </button>
          ${hasOverrides ? `
            <button type="button" onclick="runQuotaCalibAction(event, 'reset_quota_rates', '')"
                    class="text-[11px] px-2 py-0.5 rounded border border-rose-500/35 bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 font-medium whitespace-nowrap">
              ${escapeHtml(tHud('calibResetAllBtn'))}
            </button>
          ` : ''}
          <button type="button" onclick="toggleQuotaCalibDrawer(event)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--hud-border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] whitespace-nowrap">
            ${escapeHtml(tHud('fpClose'))} ✕
          </button>
        </div>
      </div>
      <div class="text-[11px] text-[var(--muted-foreground)] leading-relaxed">${escapeHtml(tHud('calibGuideHint', minDrop))}</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        ${POOL_ORDER.map((pk) => {
          const p = pools[pk] || {};
          const meta = POOL_STYLE[pk];
          const cur = p.currentRate || { wTokPer1Pct5h: 0, weeklyTo5hRatio: 0, isOverridden: false };
          const over = p.overestimateAlert?.active ? p.overestimateAlert : null;
          const statusBadge = over
            ? `<span class="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/35 text-[10px] font-bold">${escapeHtml(tHud('calibTagOver'))}</span>`
            : p.soloMode
              ? `<span class="px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/35 text-[10px] font-bold">${escapeHtml(tHud('calibTagSolo'))}</span>`
              : cur.isOverridden
                ? `<span class="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/35 text-[10px] font-semibold">${escapeHtml(tHud('calibTagCustom'))}</span>`
                : `<span class="px-1.5 py-0.2 rounded bg-[var(--hud-subtle)] text-[var(--muted-foreground)] border border-[var(--hud-border)] text-[10px]">${escapeHtml(tHud('calibTagDefault'))}</span>`;

          const applyBtn = p.canCalibrate
            ? `<button type="button" onclick="runQuotaCalibAction(event, 'calibrate_quota', '${pk}')"
                       class="px-2 py-0.5 rounded bg-sky-600 text-white hover:bg-sky-500 font-semibold text-[10px] transition whitespace-nowrap">
                 ${escapeHtml(tHud('calibApplyBtn'))}
               </button>`
            : over
              ? `<button type="button" onclick="runQuotaCalibAction(event, 'apply_overestimate_fix', '${pk}')"
                         class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-500 font-semibold text-[10px] transition whitespace-nowrap">
                   ${escapeHtml(tHud('calibOverFixBtn'))}
                 </button>`
              : `<button type="button" disabled title="${escapeHtml(tHud('calibNeedDropTip', minDrop))}"
                         class="px-2 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)] opacity-60 cursor-not-allowed text-[10px] whitespace-nowrap">
                   ${escapeHtml(tHud('calibApplyBtn'))}
                 </button>`;

          return `
            <div class="bg-[var(--card)] border border-[var(--hud-border)] rounded-lg p-2 space-y-1.5 text-[11px] mono">
              <div class="flex items-center justify-between gap-1">
                <strong class="${meta.cls}">${meta.icon} ${meta.label}</strong>
                ${statusBadge}
              </div>
              <div class="text-[10px] text-[var(--muted-foreground)] space-y-0.5">
                <div>${escapeHtml(tHud('calibCurRate'))}: <strong class="text-[var(--foreground)]">${fmtRateTok(cur.wTokPer1Pct5h)}</strong> /1% · ${escapeHtml(tHud('quotaWeek'))}/5h <strong class="text-[var(--foreground)]">${cur.weeklyTo5hRatio}</strong></div>
                <div>5h: ${escapeHtml(tHud('calibActualShort'))} <strong class="text-[var(--foreground)]">${p.actualDrop5hPct ?? 0}%</strong> / ${escapeHtml(tHud('calibEstShort'))} <strong>~${p.localEst5hPct ?? 0}%</strong></div>
                ${(p.actualDropWeeklyPct || 0) > 0 || (p.localEstWeeklyPct || 0) > 0 ? `
                  <div>${escapeHtml(tHud('quotaWeek'))}: ${escapeHtml(tHud('calibActualShort'))} <strong class="text-[var(--foreground)]">${p.actualDropWeeklyPct ?? 0}%</strong> / ${escapeHtml(tHud('calibEstShort'))} <strong>~${p.localEstWeeklyPct ?? 0}%</strong></div>
                ` : ''}
                ${p.proposedRate ? `
                  <div class="text-sky-600 dark:text-sky-400">→ ${fmtRateTok(p.proposedRate.wTokPer1Pct5h)} /1% (${p.proposedRate.scaleFactor}×${p.proposedRate.weeklyCalibrated ? `, ${tHud('quotaWeek')}/5h ${p.proposedRate.weeklyTo5hRatio}` : ''})</div>
                ` : ''}
              </div>
              <div class="flex flex-wrap items-center gap-1 pt-0.5 font-sans">
                <button type="button" onclick="runQuotaCalibAction(event, 'start_calibration_window', '${pk}')"
                        class="px-2 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--background)] hover:border-sky-500/50 hover:text-sky-500 text-[10px] transition whitespace-nowrap">
                  ${escapeHtml(tHud('calibStartBtn'))}
                </button>
                ${applyBtn}
                ${cur.isOverridden ? `
                  <button type="button" onclick="runQuotaCalibAction(event, 'reset_quota_rates', '${pk}')"
                          class="px-1.5 py-0.5 rounded border border-transparent hover:border-rose-500/35 hover:text-rose-500 text-[var(--muted-foreground)] text-[10px] transition whitespace-nowrap">
                    ${escapeHtml(tHud('calibResetOneBtn'))}
                  </button>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  };
})();
