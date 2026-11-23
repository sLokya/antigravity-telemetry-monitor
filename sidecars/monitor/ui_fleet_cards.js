(function () {
  const optimisticDismissMap = new Map(); // convId -> { atMs, actMs }

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

  function renderQuotaPoolRow(label, textCls, barBg, bucket) {
    const frac = bucket?.remainingFraction;
    const pct = frac !== null && frac !== undefined ? +(frac * 100).toFixed(1) : null;
    const resetFullStr = bucket?.resetTime ? fmtResetFull(bucket.resetTime) : tHud('quotaResetUnknown');
    let resetHtml = '--';
    if (bucket?.resetTime) {
      const diffMs = new Date(bucket.resetTime).getTime() - Date.now();
      if (diffMs <= 0) {
        resetHtml = escapeHtml(tHud('quotaResetSoon'));
      } else {
        const clock = fmtResetClock(bucket.resetTime);
        const cd = fmtResetCountdown(diffMs);
        resetHtml = `<span class="quota-clock">${escapeHtml(clock)} · </span>${escapeHtml(tHud('quotaResetLeft', cd))}`;
      }
    }
    const barWidth = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
    const warnCls = pct !== null && pct < 20 ? 'text-rose-500 font-extrabold' : textCls;
    return `
      <div class="space-y-0.5 min-w-0">
        <div class="flex items-center justify-between gap-1 text-[11px] min-w-0">
          <span class="font-semibold text-[var(--foreground)] shrink-0">${label}</span>
          <span class="text-[10px] text-[var(--muted-foreground)] truncate text-right" title="${escapeHtml(resetFullStr)}">${resetHtml}</span>
          <strong class="${warnCls} shrink-0">${pct !== null ? `${pct}%` : '--%'}</strong>
        </div>
        <div class="w-full bg-[var(--card)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)]">
          <div class="h-full rounded-full transition-all duration-500" style="width: ${barWidth}%; background: ${barBg};"></div>
        </div>
      </div>
    `;
  }

  function renderBgTrayHtml(t, runningBgList) {
    if (runningBgList.length === 0) return '';
    return `
      <div class="mt-2 pt-2 border-t border-[var(--hud-border)] space-y-1.5">
        ${runningBgList.map((bg) => {
          const logKey = `${t.conversationId}:${bg.stepIndex}`;
          const isLogOpen = window.openBgLogs.has(logKey);
          const logContent = window.openBgLogs.get(logKey) || '';
          const encodedCmd = encodeURIComponent(bg.commandLine || bg.toolSummary || '');
          const bgTypeLabel = bg.isDaemon ? tHud('bgDaemon') : tHud('bgCmd');
          const badgeCls = bg.isDaemon
            ? 'border-teal-500/30 bg-teal-500/12 text-teal-600 dark:text-teal-300'
            : 'border-violet-500/30 bg-violet-500/15 text-violet-600 dark:text-violet-300';
          const dotCls = bg.isDaemon ? 'bg-teal-500' : 'bg-violet-500 pulse-live';

          return `
            <div class="bg-task-tray rounded-xl px-2.5 py-2 space-y-1.5" onclick="event.stopPropagation()">
              <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="w-2 h-2 rounded-full ${dotCls} shrink-0"></span>
                  <span class="mono font-bold ${bg.isDaemon ? 'text-teal-600 dark:text-teal-300' : 'text-violet-600 dark:text-violet-300'} shrink-0">${bg.taskId}</span>
                  <span class="px-2 py-0.5 rounded-md border ${badgeCls} text-[11px] leading-4 font-medium shrink-0 whitespace-nowrap">${escapeHtml(bgTypeLabel)}</span>
                  <span class="truncate text-[var(--foreground)] font-semibold" title="${escapeHtml(bg.commandLine || bg.toolSummary)}">
                    ${escapeHtml(bg.toolSummary || bg.commandLine)}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0 mono">
                  <span class="text-emerald-600 dark:text-emerald-400 font-bold text-[11px] leading-4 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/25 whitespace-nowrap">
                    ⏱ ${fmtElapsed(bg.elapsedSec)}
                  </span>
                  <button onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, false)"
                          class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] hover:border-sky-500/40 hover:text-sky-500 transition text-[11px] leading-4 font-sans font-medium whitespace-nowrap">
                    ${escapeHtml(isLogOpen ? tHud('bgLogOpen') : tHud('bgLogClosed'))}
                  </button>
                  ${bg.commandLine ? `
                    <button onclick="copyBgCmd(event, '${encodedCmd}')"
                            class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] hover:border-sky-500/40 hover:text-sky-500 transition text-[11px] leading-4 font-sans font-medium whitespace-nowrap">
                      ${escapeHtml(tHud('bgCmdCopy'))}
                    </button>
                  ` : ''}
                  <button onclick="killBgTask(event, '${t.conversationId}', ${bg.stepIndex})"
                          class="px-2 py-0.5 rounded-md border border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-sans font-bold transition text-[11px] leading-4 whitespace-nowrap">
                    ${escapeHtml(tHud('bgStop'))}
                  </button>
                </div>
              </div>
              ${bg.commandLine && bg.commandLine !== bg.toolSummary ? `
                <div class="text-[11px] mono text-[var(--muted-foreground)] truncate bg-[var(--card)]/70 px-2 py-0.5 rounded border border-[var(--hud-border)]" title="${escapeHtml(bg.commandLine)}">
                  $ ${escapeHtml(bg.commandLine)}
                </div>
              ` : ''}
              ${bg.lastLogLine && !isLogOpen ? `
                <div class="text-[11px] mono text-[var(--muted-foreground)] truncate pl-1" title="${escapeHtml(bg.lastLogLine)}">
                  ${escapeHtml(tHud('bgLatestOut'))} ${escapeHtml(bg.lastLogLine)}
                </div>
              ` : ''}
              ${isLogOpen ? `
                <div class="mt-1 bg-slate-950 border border-slate-800 rounded-lg p-2 space-y-1 text-slate-200">
                  <div class="flex items-center justify-between text-[11px] text-slate-400 mono">
                    <span>${bg.taskId}.log (${fmtNum(bg.logSizeBytes)} B)</span>
                    <button onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, true)"
                            class="px-2 py-0.5 rounded border border-slate-700 hover:text-sky-400">${escapeHtml(tHud('bgRefreshLog'))}</button>
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
    const d = new Date(ms);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }

  function isTaskInProgress(t) {
    return Boolean(
      t.isRunning ||
        (t.runningBgCount || 0) > 0 ||
        (t.subagentRunningCount || 0) > 0 ||
        t.linkedCodex?.isRunning
    );
  }

  function sortFleetInProgressFirst(list) {
    return [...list].sort((a, b) => {
      const aRun = isTaskInProgress(a) ? 1 : 0;
      const bRun = isTaskInProgress(b) ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      const aSubBg = (a.runningBgCount || 0) + (a.subagentRunningCount || 0);
      const bSubBg = (b.runningBgCount || 0) + (b.subagentRunningCount || 0);
      if (aSubBg !== bSubBg) return bSubBg - aSubBg;
      return (b.activityMtimeMs || b.mtimeMs || 0) - (a.activityMtimeMs || a.mtimeMs || 0);
    });
  }

  function buildTaskCardHtml(t, data, isAllMode) {
    const isCodex = t.engine === 'CODEX';
    const runningBgList = (t.backgroundTasks || []).filter((b) => b.isRunning);
    const nonDaemonBgList = runningBgList.filter((b) => !b.isDaemon);
    const hasActiveNonDaemonBg = nonDaemonBgList.length > 0;
    const st =
      t.stateCode === 'SUB_RUNNING'
        ? getStateStyle('BG_RUNNING', true)
        : getStateStyle(t.stateCode, hasActiveNonDaemonBg || Boolean(t.linkedCodex?.isRunning));

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
      <button onclick="killBgTask(event, '${t.conversationId}', ${runningStepIndicesJson})"
              class="text-[10px] leading-4 mono px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/12 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-semibold transition inline-flex items-center gap-1 whitespace-nowrap">
        <span>🛑</span>
        <span>${escapeHtml(nonDaemonBgList.length > 1 ? tHud('stopBgMulti', nonDaemonBgList.length) : tHud('stopBgSingle', nonDaemonBgList[0].taskId))}</span>
      </button>
    ` : '';

    const diag = getDiagTagStyle(t.diagTag);
    const showDiagBadge = t.diagTag && t.diagTag.code && t.diagTag.code !== 'HEALTHY';
    const engineBadgeHtml = isCodex
      ? `<span class="text-[10px] leading-4 mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 shrink-0 whitespace-nowrap">🟢 Codex</span>`
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

    const byModelDisplay = curAgg.byModel?.length > 0
      ? curAgg.byModel
      : sessTotals.byModel?.length > 0
        ? sessTotals.byModel
        : [{
            modelKey: t.exactModelId || t.modelLabel,
            modelLabel: t.modelLabel,
            exactModelId: t.exactModelId || t.responseModel || '--',
            quotaGroupKey: isCodex ? 'codex' : /claude|sonnet|opus|gpt/i.test(`${t.modelLabel} ${t.exactModelId}`) ? '3p' : 'gemini',
            stepCount: t.stepCount || 0,
            inputTokens: 0,
            cacheReadTokens: t.cacheReadTokens || 0,
            outputTokens: t.outputTokens || 0,
            totalTokens: curAgg.totalTokens || t.totalAllTokens || 0,
          }];

    const detailTarget = selectedChild
      ? { ...selectedChild, backgroundTasks: [], contextUsed: 0, maxContext: 256000, contextPct: 0 }
      : t;
    const inlineDetailHtml = isExpanded && typeof window.renderInlineDetailHtml === 'function'
      ? window.renderInlineDetailHtml(detailTarget, data)
      : '';

    const subCount = (t.subagents || []).length;
    const subRunCount = t.subagentRunningCount || 0;
    const subTrayHtml = typeof window.renderSubagentTray === 'function' ? window.renderSubagentTray(t) : '';
    const runningBgTrayHtml = renderBgTrayHtml(t, runningBgList);
    const codexTrayHtml = isCodex
      ? renderCodexProgressTray(t.conversationId, t.codexProgress, false, null)
      : t.linkedCodex
        ? renderCodexProgressTray(`linked:${t.conversationId}`, t.linkedCodex.progress, true, t.linkedCodex)
        : '';

    return `
      <div class="space-y-0">
        <div onclick="selectTaskForDrilldown('${t.conversationId}')"
             class="task-card ${st.cardClass} ${activeRing} ${dimCls} rounded-xl p-2.5 cursor-pointer relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-1 ${isCodex ? 'bg-emerald-500' : st.accentBar}"></div>
          <div class="pl-2 space-y-2">
            <!-- Header Bar -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 min-w-0 flex-1">
                <span class="w-2 h-2 rounded-full ${st.dot} shrink-0"></span>
                ${engineBadgeHtml}
                <span class="text-xs sm:text-sm font-bold truncate text-[var(--foreground)]" title="${escapeHtml(t.title)}">
                  ${escapeHtml(t.title)}
                </span>
              </div>
              <div class="flex items-center gap-1 shrink-0 mono">
                <span class="text-[10px] text-[var(--muted-foreground)] hidden sm:inline whitespace-nowrap mr-0.5">${fmtAgo(actMtime)}</span>
                <span class="text-[10px] leading-4 px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-medium whitespace-nowrap">
                  ${escapeHtml(isRootSelected ? tHud('collapseBtn') : tHud('detailsBtn', t.totalTurnsCount || 0))}
                </span>
                <button onclick="jumpToConversation(event, '${t.conversationId}')"
                        title="${escapeHtml(isCodex ? tHud('jumpCodexTip') : tHud('jumpAgyTip'))}"
                        class="text-[11px] leading-4 px-1.5 py-0.5 rounded border border-transparent hover:border-[var(--hud-border)] hover:bg-[var(--hud-subtle)] ${isCodex ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'} font-semibold transition">↗</button>
                ${isAllMode && t.isDismissed ? `
                  <button onclick="restoreTask(event, '${t.conversationId}')"
                          title="${escapeHtml(tHud('restoreBtnTip'))}"
                          class="text-[10px] leading-4 px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 font-sans font-semibold transition">${escapeHtml(tHud('restoreBtn'))}</button>
                ` : `
                  <button onclick="dismissTask(event, '${t.conversationId}')"
                          title="${escapeHtml(tHud('dismissBtnTip'))}"
                          class="text-[11px] leading-4 px-1.5 py-0.5 rounded border border-transparent hover:border-rose-500/35 hover:bg-rose-500/10 text-[var(--muted-foreground)] hover:text-rose-500 transition">×</button>
                `}
              </div>
            </div>

            <!-- Status Strip -->
            <div class="flex flex-wrap items-center gap-1.5 text-[10px] leading-4 mono">
              <span class="font-bold px-1.5 py-0.2 rounded border ${st.badge} whitespace-nowrap">${escapeHtml(localizedState)}</span>
              <span class="px-1.5 py-0.2 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)] whitespace-nowrap">${escapeHtml(t.workspaceLabel)}</span>
              ${subCount > 0 ? `
                <span class="px-1.5 py-0.2 rounded border ${subRunCount > 0 ? 'border-purple-500/40 bg-purple-500/12 text-purple-600 dark:text-purple-300 font-bold' : 'border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)]'} whitespace-nowrap">${escapeHtml(tHud('subagentCountPill', subCount, subRunCount))}</span>
              ` : ''}
              ${showDiagBadge ? `
                <span class="px-1.5 py-0.2 rounded border ${diag.cls} whitespace-nowrap" title="${escapeHtml(diag.detail)}">${escapeHtml(diag.label)}</span>
              ` : ''}
              ${t.fpStatus === 'CHANGED' ? `
                <span class="px-1.5 py-0.2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-500 font-bold whitespace-nowrap" title="${escapeHtml(tHud('sigTip', t.sigKeyHex, t.sessionID || '--'))}">🔑 ${escapeHtml((t.sigKeyHex || '').slice(0, 6))}</span>
              ` : ''}
              ${t.isSubagent ? `
                <span class="px-1.5 py-0.2 rounded border border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold whitespace-nowrap">Sub</span>
              ` : ''}
              ${isAllMode && t.isDismissed ? `
                <span class="px-1.5 py-0.2 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)] whitespace-nowrap">${escapeHtml(tHud('dismissedTag'))}</span>
              ` : ''}
              ${headerBgStopBtn}
            </div>

            <!-- Turn vs Total Comparison Grid -->
            ${HudMetrics.renderTotalsGrid(curAgg, sessTotals, {
              isCurrentRunning: t.isCurrentRunning,
              isRunning: isTaskInProgress(t),
              streamingTps: t.streamingTps,
              effectiveTps: t.effectiveTps,
              avgStreamingTps: t.avgStreamingTps,
            })}

            <!-- Turn Model Breakdown -->
            ${HudMetrics.renderModelBreakdown(byModelDisplay, { title: tHud('modelsThisTurn') })}

            <!-- Context Progress Bar -->
            <div class="flex items-center gap-2 text-[10px] mono tabular-nums" title="${escapeHtml(tHud('turnCtxTip'))}">
              <span class="text-[var(--muted-foreground)] shrink-0">${escapeHtml(tHud('ctxShort'))}</span>
              <div class="flex-1 bg-[var(--hud-subtle)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)]">
                <div class="${getCtxColor(t.contextPct)} h-full transition-all duration-300" style="width: ${Math.min(100, t.contextPct)}%"></div>
              </div>
              <span class="${getCtxTextColor(t.contextPct)} shrink-0">${HudMetrics.fmtCompactTok(t.contextUsed || 0)}/${HudMetrics.fmtCompactTok(t.maxContext || 0)} (${t.contextPct}%)</span>
            </div>

            ${subTrayHtml}
            ${runningBgTrayHtml}
            ${codexTrayHtml}
          </div>
        </div>
        ${inlineDetailHtml}
      </div>
    `;
  }

  window.renderFleet = function (data) {
    const ov = data.fleetOverview || {};
    const selModel = data.selectedModel || {};
    const tasks = data.fleetTasks || [];

    const runCount = ov.runningTasksCount || 0;
    const runCodexCount = ov.runningCodexCount || 0;
    const bgCount = ov.runningBgTasksCount || 0;
    const codexTasksList = sortFleetInProgressFirst(tasks.filter((t) => t.engine === 'CODEX'));
    const activeTasksList = sortFleetInProgressFirst(
      tasks.filter(
        (t) =>
          isTaskInProgress(t) ||
          (!t.isArchived &&
            isTodayLocal(t.activityMtimeMs || t.mtimeMs) &&
            !t.isDismissed &&
            !isOptimisticDismissed(t))
      )
    );

    document.getElementById('filterRunCount').textContent = `(${activeTasksList.length})`;
    if (document.getElementById('filterCodexCount')) {
      document.getElementById('filterCodexCount').textContent = `(${codexTasksList.length})`;
    }
    document.getElementById('filterAllCount').textContent = `(${tasks.length})`;

    const fleetBadge = document.getElementById('fleetRunningBadge');
    const fleetCodexBadge = document.getElementById('fleetCodexBadge');
    const fleetBgBadge = document.getElementById('fleetBgBadge');
    const fleetDot = document.getElementById('fleetDot');

    fleetBadge.textContent = runCount > 0 ? tHud('activeInference', runCount) : tHud('ready');
    fleetBadge.className = runCount > 0
      ? 'text-xs mono px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-semibold whitespace-nowrap'
      : 'text-xs mono px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 font-medium whitespace-nowrap';

    if (fleetCodexBadge) {
      if (runCodexCount > 0) {
        fleetCodexBadge.textContent = tHud('codexRunningBadge', runCodexCount);
        fleetCodexBadge.classList.remove('hidden');
      } else if (codexTasksList.length > 0) {
        fleetCodexBadge.textContent = tHud('codexSessionsBadge', codexTasksList.length);
        fleetCodexBadge.classList.remove('hidden');
      } else {
        fleetCodexBadge.classList.add('hidden');
      }
    }

    if (bgCount > 0) {
      fleetBgBadge.textContent = tHud('bgRunningBadge', bgCount);
      fleetBgBadge.classList.remove('hidden');
    } else {
      fleetBgBadge.classList.add('hidden');
    }

    fleetDot.className = (runCount > 0 || bgCount > 0 || runCodexCount > 0)
      ? 'w-2.5 h-2.5 rounded-full bg-sky-500 pulse-live shrink-0 ring-4 ring-sky-500/15'
      : 'w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0 ring-4 ring-emerald-500/15';

    document.getElementById('kpiTasks').textContent =
      runCodexCount > 0
        ? tHud('kpiTasksActiveCodex', runCount, runCodexCount, bgCount)
        : tHud('kpiTasksFgBg', runCount, bgCount);
    document.getElementById('kpiTasksSub').textContent =
      runCodexCount > 0
        ? tHud('kpiTasksSubCodex', runCodexCount)
        : bgCount > 0
          ? tHud('kpiTasksSubBg', bgCount)
          : tHud('kpiTasksSubTotal', tasks.length, codexTasksList.length);

    document.getElementById('kpiFleetTps').textContent = `${ov.fleetAvgTps || 0}`;
    document.getElementById('kpiFleetTpsSub').textContent =
      ov.fleetCombinedTps > 0 ? tHud('kpiSpeedSubLive', ov.fleetCombinedTps) : tHud('kpiSpeedSubAvg');

    const maxPct = ov.maxContextPct || 0;
    document.getElementById('kpiMaxCtx').textContent = (ov.maxContextLimit || 0) > 0
      ? `${fmtNum(ov.maxContextUsed || 0)} / ${fmtNum(ov.maxContextLimit || 0)} (${maxPct}%)`
      : `${maxPct}%`;
    const maxSubEl = document.getElementById('kpiMaxCtxSub');
    if (maxSubEl) {
      maxSubEl.textContent = tHud('kpiCtxSub', ov.maxContextTitle || '--');
    }
    const maxBar = document.getElementById('kpiMaxCtxBar');
    maxBar.className = `${getCtxColor(maxPct)} h-full transition-all duration-300`;
    maxBar.style.width = `${Math.min(100, maxPct)}%`;

    const qg = data.quotaGroups || {};
    const cq = data.codexQuota || qg.codex || null;
    const geminiPool = qg.gemini || {
      fiveHour: { remainingFraction: selModel.quotaRemainingFraction ?? null, resetTime: selModel.quotaResetTime ?? null },
      weekly: { remainingFraction: selModel.quotaWeeklyRemainingFraction ?? null, resetTime: selModel.quotaWeeklyResetTime ?? null },
    };
    const claudePool = qg['3p'] || null;

    const q5hEl = document.getElementById('quota5hPoolsList');
    if (q5hEl) {
      q5hEl.innerHTML = [
        renderQuotaPoolRow('✦ Gemini', 'text-sky-600 dark:text-sky-400', 'linear-gradient(90deg, #0ea5e9, #3b82f6)', geminiPool?.fiveHour),
        renderQuotaPoolRow('🟣 Claude', 'text-purple-600 dark:text-purple-400', 'linear-gradient(90deg, #a855f7, #ec4899)', claudePool?.fiveHour),
        renderQuotaPoolRow('🟢 Codex', 'text-emerald-600 dark:text-emerald-400', 'linear-gradient(90deg, #10b981, #059669)', cq?.fiveHour),
      ].join('');
    }

    const qWkEl = document.getElementById('quotaWeeklyPoolsList');
    if (qWkEl) {
      qWkEl.innerHTML = [
        renderQuotaPoolRow('✦ Gemini', 'text-indigo-600 dark:text-indigo-400', 'linear-gradient(90deg, #6366f1, #8b5cf6)', geminiPool?.weekly),
        renderQuotaPoolRow('🟣 Claude', 'text-purple-600 dark:text-purple-400', 'linear-gradient(90deg, #a855f7, #ec4899)', claudePool?.weekly),
        renderQuotaPoolRow('🟢 Codex', 'text-emerald-600 dark:text-emerald-400', 'linear-gradient(90deg, #10b981, #059669)', cq?.weekly),
      ].join('');
    }

    const mode = window.currentFilterMode || 'active';
    const filtered = mode === 'active'
      ? activeTasksList
      : mode === 'codex'
        ? codexTasksList
        : sortFleetInProgressFirst(tasks);

    const container = document.getElementById('fleetTasksContainer');
    const savedScrollTops = new Map();
    container.querySelectorAll('[data-scroll-id]').forEach((el) => {
      savedScrollTops.set(el.getAttribute('data-scroll-id'), el.scrollTop);
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="kpi-tile rounded-xl p-5 text-center space-y-2">
          <div class="text-xs font-semibold text-[var(--foreground)]">${escapeHtml(tHud('emptyRecentTitle'))}</div>
          <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('emptyRecentSub'))}</div>
          <div class="flex items-center justify-center gap-2 pt-1">
            ${codexTasksList.length > 0 ? `
              <button onclick="switchToCodexFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 font-semibold transition">
                ${escapeHtml(tHud('emptyCodexBtn', codexTasksList.length))}
              </button>
            ` : ''}
            <button onclick="switchToAllFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 font-medium transition">
              ${escapeHtml(tHud('emptyAllBtn', tasks.length))}
            </button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map((t) => buildTaskCardHtml(t, data, mode === 'all')).join('');

    container.querySelectorAll('[data-scroll-id]').forEach((el) => {
      const id = el.getAttribute('data-scroll-id');
      if (savedScrollTops.has(id)) {
        el.scrollTop = savedScrollTops.get(id);
      }
    });
  };
})();
