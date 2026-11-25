(function () {
  const CODEX_FILTER_KEY = 'agy_telemetry_show_codex';
  const optimisticDismissMap = new Map(); // convId -> { atMs, actMs }
  const pinnedOrderMap = new Map(); // convId -> fixed index locked on first sight
  let nextPinnedOrder = 0;

  window.showCodexTasks = (() => {
    try {
      return localStorage.getItem(CODEX_FILTER_KEY) === '1';
    } catch {
      return false;
    }
  })();

  function setShowCodex(next) {
    window.showCodexTasks = Boolean(next);
    try {
      localStorage.setItem(CODEX_FILTER_KEY, window.showCodexTasks ? '1' : '0');
    } catch {}
    if (!window.showCodexTasks && String(window.selectedConvId || '').startsWith('codex:')) {
      window.selectedConvId = null;
    }
    window.updateFilterButtonsUI();
    if (window.lastPayload) window.renderFleet(window.lastPayload);
  }

  window.updateFilterButtonsUI = function () {
    const filterRunBtn = document.getElementById('filterRunBtn');
    const filterAllBtn = document.getElementById('filterAllBtn');
    const filterCodexBtn = document.getElementById('filterCodexBtn');
    const mode = window.currentFilterMode === 'all' ? 'all' : 'active';
    const showCodex = Boolean(window.showCodexTasks);
    const activeCls = 'text-[11px] leading-none px-1.5 py-1 rounded bg-sky-500 text-white font-semibold whitespace-nowrap';
    const inactiveCls = 'text-[11px] leading-none px-1.5 py-1 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-medium whitespace-nowrap';
    const codexOnCls = 'hud-btn border-emerald-500 bg-emerald-600 text-white font-semibold';
    const codexOffCls = 'hud-btn';

    if (filterRunBtn) {
      filterRunBtn.className = mode === 'active' ? activeCls : inactiveCls;
      filterRunBtn.setAttribute('aria-pressed', String(mode === 'active'));
    }
    if (filterAllBtn) {
      filterAllBtn.className = mode === 'all' ? activeCls : inactiveCls;
      filterAllBtn.setAttribute('aria-pressed', String(mode === 'all'));
    }
    if (filterCodexBtn) {
      filterCodexBtn.className = showCodex ? codexOnCls : codexOffCls;
      filterCodexBtn.setAttribute('aria-pressed', String(showCodex));
    }
  };

  window.switchToAllFilter = function () {
    window.currentFilterMode = 'all';
    window.updateFilterButtonsUI();
    if (window.lastPayload) window.renderFleet(window.lastPayload);
  };

  window.enableCodexFilter = function () {
    setShowCodex(true);
  };

  document.getElementById('filterRunBtn')?.addEventListener('click', () => {
    window.currentFilterMode = 'active';
    window.updateFilterButtonsUI();
    if (window.lastPayload) window.renderFleet(window.lastPayload);
  });
  document.getElementById('filterAllBtn')?.addEventListener('click', () => {
    window.switchToAllFilter();
  });
  document.getElementById('filterCodexBtn')?.addEventListener('click', () => {
    setShowCodex(!window.showCodexTasks);
  });

  window.dismissTask = async function (event, convId) {
    event.stopPropagation();
    const list = window.lastPayload?.fleetTasks || [];
    const target = list.find((t) => t.conversationId === convId);
    optimisticDismissMap.set(convId, {
      atMs: Date.now(),
      actMs: target?.activityMtimeMs || target?.mtimeMs || 0,
    });
    if (window.selectedConvId === convId) {
      window.selectedConvId = null;
    }
    if (window.lastPayload) {
      window.renderFleet(window.lastPayload);
    }
    try {
      const res = await callActionApi({ action: 'dismiss_task', conversationId: convId });
      showToast(res.ok ? tHud('dismissToast') : res.error || 'Error', !res.ok);
      await fetchTelemetry();
    } catch (err) {
      optimisticDismissMap.delete(convId);
      showToast(String(err?.message || err), true);
    }
  };

  window.restoreTask = async function (event, convId) {
    event.stopPropagation();
    optimisticDismissMap.delete(convId);
    try {
      const res = await callActionApi({ action: 'restore_task', conversationId: convId });
      showToast(res.ok ? tHud('restoreToast') : res.error || 'Error', !res.ok);
      await fetchTelemetry();
    } catch (err) {
      showToast(String(err?.message || err), true);
    }
  };

  window.resetFamilyQuota = async function (event) {
    event.stopPropagation();
    if (window.lastPayload) {
      window.lastPayload.familyQuotaUsage = null;
      window.renderFleet(window.lastPayload);
    }
    try {
      const res = await callActionApi({ action: 'reset_family_quota' });
      showToast(res.ok ? tHud('familyQuotaResetToast') : res.error || 'Error', !res.ok);
      await fetchTelemetry();
    } catch (err) {
      showToast(String(err?.message || err), true);
    }
  };

  function isOptimisticDismissed(t) {
    const entry = optimisticDismissMap.get(t.conversationId);
    if (!entry) return false;
    const actMs = t.activityMtimeMs || t.mtimeMs || 0;
    if (t.isDismissed || isTaskInProgress(t) || actMs > entry.actMs + 1500 || Date.now() - entry.atMs > 8000) {
      optimisticDismissMap.delete(t.conversationId);
      return false;
    }
    return true;
  }

  function renderQuotaCell(textCls, barBg, bucket, extraCls = '') {
    const frac = bucket?.remainingFraction;
    const pct = frac !== null && frac !== undefined ? +(frac * 100).toFixed(1) : null;
    const resetFullStr = bucket?.resetTime ? fmtResetFull(bucket.resetTime) : tHud('quotaResetUnknown');
    let resetShort = '--';
    if (bucket?.resetTime) {
      const diffMs = new Date(bucket.resetTime).getTime() - Date.now();
      resetShort = diffMs <= 0 ? tHud('quotaResetSoon') : fmtResetCountdown(diffMs);
    }
    const barWidth = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
    const warnCls = pct !== null && pct < 20 ? 'text-rose-500 font-bold' : textCls;
    return `
      <div class="quota-cell ${extraCls}" title="${escapeHtml(resetFullStr)}">
        <div class="quota-track">
          <div class="h-full rounded-full" style="width:${barWidth}%; background:${barBg};"></div>
        </div>
        <span class="text-[10px] text-[var(--muted-foreground)] shrink-0">${escapeHtml(resetShort)}</span>
        <strong class="${warnCls} w-10 text-right shrink-0">${pct !== null ? `${pct}%` : '--'}</strong>
      </div>
    `;
  }

  function renderQuotaMatrixRow(label, textCls5h, barBg5h, textClsWk, barBgWk, pool) {
    return `
      <div class="quota-row">
        <span class="font-semibold text-[var(--foreground)] truncate">${label}</span>
        ${renderQuotaCell(textCls5h, barBg5h, pool?.fiveHour)}
        ${renderQuotaCell(textClsWk, barBgWk, pool?.weekly, 'quota-cell-wk')}
      </div>
    `;
  }

  function renderBgTrayHtml(t, runningBgList) {
    if (runningBgList.length === 0) return '';
    return `
      <div class="pt-1.5 border-t border-[var(--hud-hairline)] space-y-1">
        ${runningBgList.map((bg) => {
          const logKey = `${t.conversationId}:${bg.stepIndex}`;
          const isLogOpen = window.openBgLogs.has(logKey);
          const logContent = window.openBgLogs.get(logKey) || '';
          const encodedCmd = encodeURIComponent(bg.commandLine || bg.toolSummary || '');
          const bgTypeLabel = bg.isDaemon ? tHud('bgDaemon') : tHud('bgCmd');
          const dotCls = bg.isDaemon ? 'bg-teal-500' : 'bg-sky-500 pulse-live';
          const idCls = bg.isDaemon ? 'text-teal-600 dark:text-teal-400' : 'text-sky-600 dark:text-sky-400';

          return `
            <div class="rounded-md border border-[var(--hud-hairline)] bg-[var(--hud-subtle)] px-2 py-1.5 space-y-1" onclick="event.stopPropagation()">
              <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="w-1.5 h-1.5 rounded-full ${dotCls} shrink-0"></span>
                  <span class="font-semibold ${idCls} shrink-0">${escapeHtml(bgTypeLabel)}</span>
                  <span class="mono text-[10px] text-[var(--muted-foreground)] shrink-0">${bg.taskId}</span>
                  <span class="truncate text-[var(--foreground)] font-medium" title="${escapeHtml(bg.commandLine || bg.toolSummary)}">
                    ${escapeHtml(bg.toolSummary || bg.commandLine)}
                  </span>
                </div>
                <div class="flex items-center gap-1 shrink-0 mono text-[10px]">
                  <span class="text-[var(--muted-foreground)] whitespace-nowrap">⏱ ${fmtElapsed(bg.elapsedSec)}</span>
                  <button type="button" onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, false)"
                          class="px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-surface)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-sans whitespace-nowrap">
                    ${escapeHtml(isLogOpen ? tHud('bgLogOpen') : tHud('bgLogClosed'))}
                  </button>
                  ${bg.commandLine ? `
                    <button type="button" onclick="copyBgCmd(event, '${encodedCmd}')"
                            class="px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-surface)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-sans whitespace-nowrap">
                      ${escapeHtml(tHud('bgCmdCopy'))}
                    </button>
                  ` : ''}
                  <button type="button" onclick="killBgTask(event, '${t.conversationId}', ${bg.stepIndex})"
                          class="px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-surface)] text-[var(--muted-foreground)] hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/40 font-sans font-medium whitespace-nowrap">
                    ${escapeHtml(tHud('bgStop'))}
                  </button>
                </div>
              </div>
              ${bg.lastLogLine && !isLogOpen ? `
                <div class="text-[10px] mono text-[var(--muted-foreground)] truncate pl-3" title="${escapeHtml(bg.lastLogLine)}">
                  ${escapeHtml(tHud('bgLatestOut'))} ${escapeHtml(bg.lastLogLine)}
                </div>
              ` : ''}
              ${isLogOpen ? `
                <div class="mt-1 bg-slate-950 border border-slate-800 rounded-md p-2 space-y-1 text-slate-200">
                  <div class="flex items-center justify-between text-[10px] text-slate-400 mono">
                    <span>${bg.taskId}.log (${fmtNum(bg.logSizeBytes)} B)</span>
                    <button type="button" onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, true)"
                            class="px-1.5 py-0.5 rounded border border-slate-700 hover:text-sky-400">${escapeHtml(tHud('bgRefreshLog'))}</button>
                  </div>
                  <pre class="text-[11px] mono text-slate-200 whitespace-pre-wrap break-all max-h-36 overflow-y-auto leading-relaxed">${escapeHtml(logContent)}</pre>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function isTodayLocal(ms) {
    if (!ms) return false;
    const d = new Date(ms), now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  function isTaskInProgress(t) {
    return Boolean(t.isRunning || (t.runningBgCount || 0) > 0 || (t.subagentRunningCount || 0) > 0 || t.linkedCodex?.isRunning);
  }

  function sortFleetInProgressFirst(list) {
    return [...list].sort((a, b) => {
      const aRun = isTaskInProgress(a) ? 1 : 0, bRun = isTaskInProgress(b) ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      const aSubBg = (a.runningBgCount || 0) + (a.subagentRunningCount || 0);
      const bSubBg = (b.runningBgCount || 0) + (b.subagentRunningCount || 0);
      return aSubBg !== bSubBg ? bSubBg - aSubBg : (b.activityMtimeMs || b.mtimeMs || 0) - (a.activityMtimeMs || a.mtimeMs || 0);
    });
  }

  function syncPinnedOrder(allTasks) {
    if (!Array.isArray(allTasks) || allTasks.length === 0) return;
    const ordered = pinnedOrderMap.size === 0 ? sortFleetInProgressFirst(allTasks) : allTasks;
    for (const t of ordered) {
      if (t?.conversationId && !pinnedOrderMap.has(t.conversationId)) {
        pinnedOrderMap.set(t.conversationId, nextPinnedOrder++);
      }
    }
  }

  function sortFleetStable(list) {
    return [...list].sort((a, b) => (pinnedOrderMap.get(a.conversationId) ?? 999999) - (pinnedOrderMap.get(b.conversationId) ?? 999999));
  }

  function buildTaskCardHtml(t, data, isAllMode) {
    const isCodex = t.engine === 'CODEX';
    const runningBgList = (t.backgroundTasks || []).filter((b) => b.isRunning);
    const nonDaemonBgList = runningBgList.filter((b) => !b.isDaemon);
    const hasActiveNonDaemonBg = nonDaemonBgList.length > 0;
    const inProgress = isTaskInProgress(t);
    const st = getStateStyle(inProgress ? 'RUNNING' : 'IDLE', inProgress);

    const isRootSelected = window.selectedConvId === t.conversationId;
    const selectedChild = !isRootSelected
      ? (t.subagents || []).find((s) => s.conversationId === window.selectedConvId) || null
      : null;
    const isExpanded = isRootSelected || Boolean(selectedChild);
    const activeRing = isRootSelected ? 'ring-2 ring-sky-500/60' : selectedChild ? 'ring-2 ring-purple-500/50' : '';
    const dimCls = isAllMode && t.isDismissed ? 'opacity-60' : '';
    const localizedState = trStateLabel(t.stateCode, t.stateLabel, t.runningBgCount);
    const actMtime = t.activityMtimeMs || t.mtimeMs;

    const runningStepIndicesJson = JSON.stringify(nonDaemonBgList.map((b) => b.stepIndex));
    const headerBgStopBtn = hasActiveNonDaemonBg ? `
      <button type="button" onclick="killBgTask(event, '${t.conversationId}', ${runningStepIndicesJson})"
              class="text-[10px] leading-none mono px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-surface)] text-[var(--muted-foreground)] hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/40 font-medium inline-flex items-center gap-1 whitespace-nowrap">
        <span>■</span>
        <span>${escapeHtml(nonDaemonBgList.length > 1 ? tHud('stopBgMulti', nonDaemonBgList.length) : tHud('stopBgSingle', nonDaemonBgList[0].taskId))}</span>
      </button>
    ` : '';

    const diag = getDiagTagStyle(t.diagTag);
    const showDiagBadge = t.diagTag && t.diagTag.code && t.diagTag.code !== 'HEALTHY';
    const enginePrefixHtml = isCodex
      ? `<span class="text-[10px] mono font-bold text-emerald-600 dark:text-emerald-400 shrink-0">CX</span>`
      : '';

    const curAgg = t.currentTurn?.aggregate || HudMetrics.turnTotalsFallback(t.currentTurn);
    const sessTotals = t.sessionTotals || {
      inputTokens: 0,
      cacheReadTokens: t.totalCacheReadTokens || 0,
      outputTokens: t.totalOutputTokens || 0,
      totalTokens: t.totalAllTokens || 0,
      cacheHitRate: t.avgCacheHitRate ?? 0,
      byModel: [],
      quotaUsage: null,
    };

    const byModelDisplay = sessTotals.byModel?.length > 0
      ? sessTotals.byModel
      : curAgg.byModel?.length > 0
        ? curAgg.byModel
        : [{
            modelKey: t.exactModelId || t.modelLabel,
            modelLabel: t.modelLabel,
            exactModelId: t.exactModelId || t.responseModel || '--',
            quotaGroupKey: isCodex ? 'codex' : /claude|sonnet|opus|gpt/i.test(`${t.modelLabel} ${t.exactModelId}`) ? '3p' : 'gemini',
            stepCount: t.stepCount || 0,
            inputTokens: sessTotals.inputTokens || 0,
            cacheReadTokens: sessTotals.cacheReadTokens || t.cacheReadTokens || 0,
            outputTokens: sessTotals.outputTokens || t.outputTokens || 0,
            totalTokens: sessTotals.totalTokens || t.totalAllTokens || curAgg.totalTokens || 0,
          }];

    const detailTarget = selectedChild
      ? { ...selectedChild, backgroundTasks: [], contextUsed: 0, maxContext: 256000, contextPct: 0 }
      : t;
    const inlineDetailHtml = isExpanded && typeof window.renderInlineDetailHtml === 'function'
      ? window.renderInlineDetailHtml(detailTarget, data)
      : '';

    const subInlineBtnHtml = typeof window.renderSubagentInlineBtn === 'function' ? window.renderSubagentInlineBtn(t) : '';
    const subTrayHtml = typeof window.renderSubagentTray === 'function' ? window.renderSubagentTray(t) : '';
    const runningBgTrayHtml = renderBgTrayHtml(t, runningBgList);
    const codexTrayHtml = isCodex
      ? renderCodexProgressTray(t.conversationId, t.codexProgress, false, null)
      : t.linkedCodex
        ? renderCodexProgressTray(`linked:${t.conversationId}`, t.linkedCodex.progress, true, t.linkedCodex)
        : '';

    const stateTextCls = inProgress
      ? 'text-sky-600 dark:text-sky-400 font-semibold'
      : 'text-emerald-600 dark:text-emerald-400';

    return `
      <div class="space-y-0">
        <article onclick="selectTaskForDrilldown('${t.conversationId}')"
                 class="task-card ${st.cardClass} ${activeRing} ${dimCls} px-2.5 py-2 cursor-pointer relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-[3px] ${inProgress ? 'bg-sky-500' : 'bg-emerald-500'}"></div>
          <div class="pl-1.5 space-y-1">
            <!-- Row 1: Title + Semantic Status Meta + Compact Actions -->
            <header class="flex items-center justify-between gap-2 min-w-0">
              <div class="flex items-center gap-1.5 min-w-0 flex-1">
                <span class="w-1.5 h-1.5 rounded-full ${st.dot} shrink-0"></span>
                ${enginePrefixHtml}
                <h2 class="text-[13px] font-semibold truncate text-[var(--foreground)]" title="${escapeHtml(t.title)}">
                  ${escapeHtml(t.title)}
                </h2>
                <span class="text-[11px] ${stateTextCls} shrink-0 hidden sm:inline">${escapeHtml(localizedState)}</span>
                <span class="text-[11px] text-[var(--muted-foreground)] shrink-0 hidden sm:inline">· ${escapeHtml(t.workspaceLabel)}</span>
                ${showDiagBadge ? `<span class="text-[10px] mono px-1 rounded border ${diag.cls} shrink-0" title="${escapeHtml(diag.detail)}">${escapeHtml(diag.label)}</span>` : ''}
                ${t.fpStatus === 'CHANGED' ? `<span class="text-[10px] mono text-amber-500 font-bold shrink-0" title="${escapeHtml(tHud('sigTip', t.sigKeyHex, t.sessionID || '--'))}">🔑${escapeHtml((t.sigKeyHex || '').slice(0, 4))}</span>` : ''}
                ${headerBgStopBtn}
              </div>
              <div class="flex items-center gap-1 shrink-0 mono text-[11px]">
                <span class="text-[10px] text-[var(--muted-foreground)] mr-0.5">${fmtAgo(actMtime)}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--hud-subtle)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] whitespace-nowrap">
                  ${escapeHtml(isRootSelected ? tHud('collapseBtn') : tHud('detailsBtn', t.totalTurnsCount || 0))}
                </span>
                <button type="button" onclick="jumpToConversation(event, '${t.conversationId}')"
                        title="${escapeHtml(isCodex ? tHud('jumpCodexTip') : tHud('jumpAgyTip'))}"
                        class="px-1 py-0.5 rounded hover:bg-[var(--hud-subtle)] ${isCodex ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'} font-semibold">↗</button>
                ${isAllMode && t.isDismissed ? `
                  <button type="button" onclick="restoreTask(event, '${t.conversationId}')"
                          title="${escapeHtml(tHud('restoreBtnTip'))}"
                          class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 font-sans font-semibold">${escapeHtml(tHud('restoreBtn'))}</button>
                ` : `
                  <button type="button" onclick="dismissTask(event, '${t.conversationId}')"
                          title="${escapeHtml(tHud('dismissBtnTip'))}"
                          class="px-1 py-0.5 rounded text-[var(--muted-foreground)] hover:text-rose-500 hover:bg-rose-500/10">×</button>
                `}
              </div>
            </header>

            <!-- Mobile/narrow secondary status line (hidden on >= sm) -->
            <div class="flex sm:hidden items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
              <span class="${stateTextCls}">${escapeHtml(localizedState)}</span>
              <span>· ${escapeHtml(t.workspaceLabel)}</span>
              ${isAllMode && t.isDismissed ? `<span>· ${escapeHtml(tHud('dismissedTag'))}</span>` : ''}
            </div>

            <!-- Row 2: 4-Column Compact KPI Strip (Session Cumulative) -->
            ${HudMetrics.renderCompactKpiStrip(curAgg, sessTotals, {
              isCurrentRunning: t.isCurrentRunning,
              isRunning: Boolean(t.isRunning || (t.subagentRunningCount || 0) > 0),
              streamingTps: t.streamingTps,
              effectiveTps: t.effectiveTps,
              avgStreamingTps: t.avgStreamingTps,
              avgEffectiveTps: t.avgEffectiveTps,
            })}

            <!-- Row 3: Unified Footer (Model + Inline Subagent Trigger + Compact Context Bar) -->
            <footer class="flex items-center justify-between gap-2 min-w-0 pt-0.5">
              <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                ${HudMetrics.renderCompactModelInline(byModelDisplay)}
                ${subInlineBtnHtml ? `<span class="text-[var(--hud-border)]">·</span>${subInlineBtnHtml}` : ''}
              </div>
              <div class="flex items-center gap-1.5 shrink-0 mono tnum text-[10px]" title="${escapeHtml(tHud('turnCtxTip'))}">
                <div class="w-10 sm:w-14 bg-[var(--hud-subtle)] h-1.5 rounded-full overflow-hidden">
                  <div class="${getCtxColor(t.contextPct)} h-full" style="width:${Math.min(100, t.contextPct)}%"></div>
                </div>
                <span class="${getCtxTextColor(t.contextPct)} whitespace-nowrap">${HudMetrics.fmtCompactTok(t.contextUsed || 0)}/${HudMetrics.fmtCompactTok(t.maxContext || 0)} (${t.contextPct}%)</span>
              </div>
            </footer>

            ${subTrayHtml}
            ${runningBgTrayHtml}
            ${codexTrayHtml}
          </div>
        </article>
        ${inlineDetailHtml}
      </div>
    `;
  }

  function buildFamilyQuotaCardHtml(familyQuotaUsage) {
    if (!familyQuotaUsage || !familyQuotaUsage.active || !familyQuotaUsage.byPool) return '';
    const scopedByPool = familyQuotaUsage.byPool;
    if (Object.keys(scopedByPool).length === 0) return '';

    const hasActiveGap = Object.values(scopedByPool).some((b) => b?.confidence === 'active_gap');
    const chipsHtml = HudMetrics.renderQuotaChips({ ...familyQuotaUsage, byPool: scopedByPool }, { isRunning: false, compact: false });
    return `
      <div class="task-card rounded-xl px-2.5 py-2 relative overflow-hidden border-amber-500/40 bg-amber-500/[0.04]">
        <div class="absolute left-0 top-0 bottom-0 w-1 bg-amber-500"></div>
        <div class="pl-2 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
              <span class="text-xs font-bold truncate text-[var(--foreground)]">${escapeHtml(tHud('familyQuotaTitle'))}</span>
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              ${hasActiveGap ? `<button type="button" onclick="openQuotaCalibDrawer(event)" title="${escapeHtml(tHud('familyQuotaCalibTip'))}" class="text-[11px] leading-4 px-1 py-0.5 rounded border border-transparent hover:border-amber-500/40 hover:bg-amber-500/10 text-[var(--muted-foreground)] hover:text-amber-600 transition">⚖️</button>` : ''}
              <button type="button" onclick="resetFamilyQuota(event)" title="${escapeHtml(tHud('familyQuotaResetTip'))}" class="text-[11px] leading-4 px-1.5 py-0.5 rounded border border-transparent hover:border-rose-500/35 hover:bg-rose-500/10 text-[var(--muted-foreground)] hover:text-rose-500 transition">×</button>
            </div>
          </div>
          <div>${chipsHtml}</div>
        </div>
      </div>
    `;
  }

  window.renderFleet = function (data) {
    const ov = data.fleetOverview || {};
    const selModel = data.selectedModel || {};
    const tasks = data.fleetTasks || [];

    const mode = window.currentFilterMode === 'all' ? 'all' : 'active';
    const showCodex = Boolean(window.showCodexTasks);
    const isActiveTask = (t) =>
      isTaskInProgress(t) ||
      (!t.isArchived &&
        isTodayLocal(t.activityMtimeMs || t.mtimeMs) &&
        !t.isDismissed &&
        !isOptimisticDismissed(t));

    const runCount = ov.runningTasksCount || 0;
    const runCodexCount = ov.runningCodexCount || 0;
    const bgCount = ov.runningBgTasksCount || 0;
    syncPinnedOrder(tasks);
    const allCodexList = tasks.filter((t) => t.engine === 'CODEX');
    const activeCodexList = allCodexList.filter(isActiveTask);
    const scopedTasks = showCodex ? tasks : tasks.filter((t) => t.engine !== 'CODEX');
    const activeTasksList = sortFleetStable(scopedTasks.filter(isActiveTask));
    const allTasksList = sortFleetStable(scopedTasks);
    const codexBadgeCount = mode === 'active' ? activeCodexList.length : allCodexList.length;

    document.getElementById('filterRunCount').textContent = String(activeTasksList.length);
    const filterCodexCountEl = document.getElementById('filterCodexCount');
    if (filterCodexCountEl) {
      filterCodexCountEl.textContent = String(codexBadgeCount);
    }
    document.getElementById('filterAllCount').textContent = String(allTasksList.length);

    const fleetBadge = document.getElementById('fleetRunningBadge');
    const fleetCodexBadge = document.getElementById('fleetCodexBadge');
    const fleetBgBadge = document.getElementById('fleetBgBadge');
    const fleetDot = document.getElementById('fleetDot');

    fleetBadge.textContent = runCount > 0 ? `⚡${runCount}` : tHud('ready');
    fleetBadge.title = runCount > 0 ? tHud('activeInference', runCount) : tHud('ready');
    fleetBadge.className = runCount > 0
      ? 'text-[11px] mono font-semibold text-sky-600 dark:text-sky-400 shrink-0 whitespace-nowrap'
      : 'text-[11px] mono font-medium text-emerald-600 dark:text-emerald-400 shrink-0 whitespace-nowrap';

    if (fleetCodexBadge) {
      if (runCodexCount > 0) {
        fleetCodexBadge.textContent = `· CX⚡${runCodexCount}`;
        fleetCodexBadge.className = 'topbar-xl-only text-[11px] mono text-emerald-600 dark:text-emerald-400 font-semibold shrink-0 whitespace-nowrap';
      } else if (allCodexList.length > 0) {
        fleetCodexBadge.textContent = `· ${allCodexList.length} CX`;
        fleetCodexBadge.className = 'topbar-xl-only text-[11px] mono text-[var(--muted-foreground)] shrink-0 whitespace-nowrap';
      } else {
        fleetCodexBadge.className = 'hidden';
      }
    }

    if (bgCount > 0) {
      fleetBgBadge.textContent = `· ⚙️${bgCount}`;
      fleetBgBadge.title = tHud('bgRunningBadge', bgCount);
      fleetBgBadge.className = 'text-[11px] mono text-violet-600 dark:text-violet-400 font-semibold shrink-0 whitespace-nowrap';
    } else {
      fleetBgBadge.className = 'hidden';
    }

    fleetDot.className = (runCount > 0 || bgCount > 0 || runCodexCount > 0)
      ? 'w-2 h-2 rounded-full bg-sky-500 pulse-live shrink-0'
      : 'w-2 h-2 rounded-full bg-emerald-500 shrink-0';

    const qg = data.quotaGroups || {};
    const cq = data.codexQuota || qg.codex || null;
    const geminiPool = qg.gemini || {
      fiveHour: { remainingFraction: selModel.quotaRemainingFraction ?? null, resetTime: selModel.quotaResetTime ?? null },
      weekly: { remainingFraction: selModel.quotaWeeklyRemainingFraction ?? null, resetTime: selModel.quotaWeeklyResetTime ?? null },
    };
    const claudePool = qg['3p'] || null;

    const qMatrixEl = document.getElementById('quotaMatrixList');
    if (qMatrixEl) {
      const sky = 'text-sky-600 dark:text-sky-400', ind = 'text-indigo-600 dark:text-indigo-400';
      const pur = 'text-purple-600 dark:text-purple-400', eme = 'text-emerald-600 dark:text-emerald-400';
      const g5 = 'linear-gradient(90deg,#0ea5e9,#3b82f6)', gw = 'linear-gradient(90deg,#6366f1,#8b5cf6)';
      const p3 = 'linear-gradient(90deg,#a855f7,#ec4899)', cx = 'linear-gradient(90deg,#10b981,#059669)';
      qMatrixEl.innerHTML = [
        renderQuotaMatrixRow('✦ Gemini', sky, g5, ind, gw, geminiPool),
        renderQuotaMatrixRow('🟣 Claude', pur, p3, pur, p3, claudePool),
        renderQuotaMatrixRow('🟢 Codex', eme, cx, eme, cx, cq),
      ].join('');
    }

    const filtered = mode === 'active' ? activeTasksList : allTasksList;

    const container = document.getElementById('fleetTasksContainer');
    const savedScrollTops = new Map();
    container.querySelectorAll('[data-scroll-id]').forEach((el) => {
      savedScrollTops.set(el.getAttribute('data-scroll-id'), el.scrollTop);
    });

    const familyCardHtml = buildFamilyQuotaCardHtml(data.familyQuotaUsage);

    if (filtered.length === 0) {
      const emptyTitle = mode === 'all' ? tHud('emptyAllTitle') : tHud('emptyRecentTitle');
      container.innerHTML = `${familyCardHtml}
        <div class="kpi-tile rounded-xl p-5 text-center space-y-2">
          <div class="text-xs font-semibold text-[var(--foreground)]">${escapeHtml(emptyTitle)}</div>
          <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('emptyRecentSub'))}</div>
          <div class="flex items-center justify-center gap-2 pt-1">
            ${!showCodex && codexBadgeCount > 0 ? `
              <button onclick="enableCodexFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 font-semibold transition">
                ${escapeHtml(tHud('emptyCodexBtn', codexBadgeCount))}
              </button>
            ` : ''}
            ${mode === 'active' && allTasksList.length > 0 ? `
              <button onclick="switchToAllFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 font-medium transition">
                ${escapeHtml(tHud('emptyAllBtn', allTasksList.length))}
              </button>
            ` : ''}
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML =
      familyCardHtml + filtered.map((t) => buildTaskCardHtml(t, data, mode === 'all')).join('');

    container.querySelectorAll('[data-scroll-id]').forEach((el) => {
      const id = el.getAttribute('data-scroll-id');
      if (savedScrollTops.has(id)) {
        el.scrollTop = savedScrollTops.get(id);
      }
    });
  };
})();
