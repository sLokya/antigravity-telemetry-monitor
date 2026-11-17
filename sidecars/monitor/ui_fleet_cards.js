(function () {
  const PILL_CLS = 'metric-pill inline-flex flex-wrap items-center gap-1 px-2 py-0.5 rounded-md text-[11px] leading-4 mono';

  function sp() {
    return window.getHudLang() === 'en' ? ' ' : '';
  }

  function formatCardQuotaPill(t) {
    const turnTag = tHud(t.isCurrentRunning ? 'turnCur' : 'turnLast');
    const titlePrefix = `${turnTag}${sp()}${tHud('quotaLabel')}`;
    const q = t.currentTurn?.quotaUsage;
    if (!q) {
      return `
        <span class="${PILL_CLS} whitespace-nowrap"
              title="${escapeHtml(tHud('quotaNoneTip'))}">
          <span class="text-[var(--muted-foreground)]">🔋 ${escapeHtml(titlePrefix)}</span>
          <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('quotaEmpty'))}</span>
        </span>
      `;
    }
    const u5 = q.fiveHourUsedPct ?? 0;
    const uw = q.weeklyUsedPct ?? 0;
    const approx = q.isApproxConcurrent ? '~' : '';
    if (u5 === 0 && uw === 0) {
      const valueStr = t.currentTurn?.isRunning
        ? tHud('quotaSyncing')
        : `5h <0.01% · ${tHud('quotaWeek')} <0.01%`;
      return `
        <span class="${PILL_CLS} whitespace-nowrap"
              title="${escapeHtml(tHud('quotaWaitTip'))}">
          <span class="text-[var(--muted-foreground)]">🔋 ${escapeHtml(titlePrefix)}</span>
          <span class="text-sky-600 dark:text-sky-400 font-semibold">${escapeHtml(valueStr)}</span>
        </span>
      `;
    }
    const valCls = q.isApproxConcurrent
      ? 'text-amber-600 dark:text-amber-300 font-bold'
      : 'text-sky-600 dark:text-sky-300 font-bold';
    return `
      <span class="${PILL_CLS} whitespace-nowrap"
            title="${escapeHtml(q.isApproxConcurrent ? tHud('quotaConcurrentTip') : tHud('quotaRecordedTip'))}">
        <span class="text-[var(--muted-foreground)]">🔋 ${escapeHtml(titlePrefix)}</span>
        <span class="${valCls}">5h ${approx}-${u5}% · ${tHud('quotaWeek')} ${approx}-${uw}%</span>
      </span>
    `;
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

  function renderTurnMetricPillsHtml(t, isCodex) {
    const cleanTier = String(t.modelLabel || '').replace(/^Orchestrator\s*/i, '').replace(/^\((.+)\)$/, '$1').trim();
    const showTier = String(t.exactModelId || '').includes('orchestrator') && cleanTier;
    const metaTip = `${tHud('cfgModel')}: ${t.modelLabel} (${t.requestedModelId || t.exactModelId}) | ${tHud('respModel')}: ${t.responseModel}${t.execModelId ? ` | ${tHud('execModel')}: ${t.execModelId}` : ''} | ${tHud('diagProvider')}: ${t.apiProvider}`;

    const turnTag = tHud(t.isCurrentRunning ? 'turnCur' : 'turnLast');
    const avgLbl = `${tHud('avgShort')}${sp()}`;
    const totLbl = `${tHud('totalShort')}${sp()}`;
    const hasTurnSteps = (t.currentTurn?.stepCount ?? 1) > 0;
    const avgTpsStr = t.avgStreamingTps > 0 ? t.avgStreamingTps : '--';
    const avgCacheStr = t.avgCacheHitRate !== undefined ? `${t.avgCacheHitRate}%` : '--%';

    const speedHtml = hasTurnSteps && t.streamingTps > 0
      ? `<span class="text-[var(--muted-foreground)]">${escapeHtml(turnTag)}</span> <strong class="text-emerald-600 dark:text-emerald-400">${t.streamingTps}</strong> <span class="text-[var(--muted-foreground)]">tok/s (${escapeHtml(avgLbl)}${avgTpsStr})</span>`
      : hasTurnSteps && t.effectiveTps > 0
        ? `<span class="text-[var(--muted-foreground)]">${escapeHtml(turnTag)} E2E</span> <strong class="text-indigo-600 dark:text-indigo-400">${t.effectiveTps}</strong> <span class="text-[var(--muted-foreground)]">(${escapeHtml(avgLbl)}${avgTpsStr})</span>`
        : `<span class="text-[var(--muted-foreground)]">${escapeHtml(turnTag)} -- tok/s (${escapeHtml(avgLbl)}${avgTpsStr})</span>`;

    const curCacheTok = t.currentTurn?.cacheReadTokens ?? t.cacheReadTokens ?? 0;
    const totalCacheTok = t.totalCacheReadTokens ?? curCacheTok;
    const cacheTitle = `${tHud('cacheLabel')}${sp()}${turnTag}`;
    const cacheHtml = hasTurnSteps
      ? `<span class="text-[var(--muted-foreground)]">${escapeHtml(cacheTitle)}</span> <strong class="text-amber-600 dark:text-amber-400">${t.cacheHitRate}%</strong> <span class="text-amber-700/85 dark:text-amber-300/85 font-medium">(${fmtCacheK(curCacheTok)})</span> <span class="text-[var(--muted-foreground)]">(${escapeHtml(avgLbl)}${avgCacheStr} · ${escapeHtml(totLbl)}${fmtCacheK(totalCacheTok)})</span>`
      : `<span class="text-[var(--muted-foreground)]">${escapeHtml(cacheTitle)} --% (${escapeHtml(avgLbl)}${avgCacheStr} · ${escapeHtml(totLbl)}${fmtCacheK(totalCacheTok)})</span>`;

    const curTok = t.currentTurn?.totalTokens ?? t.totalAllTokens ?? 0;
    const curInTok = t.currentTurn?.inputTokens ?? 0;
    const curOutTok = t.currentTurn?.outputTokens ?? t.outputTokens ?? 0;
    const totalTok = t.totalAllTokens ?? curTok;
    const inTag = `${tHud('tokIn')}${sp()}`;
    const cacheTag = `${tHud('tokCache')}${sp()}`;
    const outTag = `${tHud('tokOut')}${sp()}`;
    const tokTitle = `${turnTag}${sp()}${tHud('tokLabel')}`;
    const tokTip = `${tokTitle}: ${fmtNum(curTok)} (${inTag}${fmtNum(curInTok)} / ${cacheTag}${fmtCacheK(curCacheTok)} / ${outTag}${fmtNum(curOutTok)}) | ${tHud('sessionTotal')}: ${fmtNum(totalTok)}`;

    const ctxBarColor = getCtxColor(t.contextPct);
    const ctxTextClass = getCtxTextColor(t.contextPct);

    return `
      <div class="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 mono">
        <span class="${PILL_CLS} ${isCodex ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'} font-bold max-w-full break-all" title="${escapeHtml(metaTip)}">
          <span>✦ ${escapeHtml(t.exactModelId || t.responseModel)}${showTier ? ` (${escapeHtml(cleanTier)})` : ''}</span>
          ${t.execModelId ? `<span class="font-normal opacity-80">→${escapeHtml(tHud('execModel'))}:${escapeHtml(t.execModelId)}</span>` : t.responseModel && t.responseModel !== '--' && t.responseModel !== t.exactModelId ? `<span class="font-normal opacity-75">(${escapeHtml(t.responseModel)})</span>` : ''}
        </span>
        ${t.sigKeyHex ? `
          <span class="${PILL_CLS} ${t.fpStatus === 'CHANGED' ? 'text-amber-500 font-bold border-amber-500/40' : 'text-[var(--muted-foreground)]'} whitespace-nowrap"
                title="${escapeHtml(tHud('sigTip', t.sigKeyHex, t.sessionID || '--'))}">
            🔑 ${t.sigKeyHex.slice(0, 6)}
          </span>
        ` : ''}
        <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tHud('speedTip'))}">${speedHtml}</span>
        <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tHud('cacheTip'))}">${cacheHtml}</span>
        <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tHud('turnCtxTip'))}">
          <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('ctxLabel'))}</span>
          <strong class="${ctxTextClass}">${fmtNum(t.contextUsed || 0)}/${fmtNum(t.maxContext || 0)}</strong>
          <span class="text-[var(--muted-foreground)]">(${t.contextPct}%)</span>
          <span class="w-10 bg-[var(--card)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)] shrink-0 inline-block">
            <span class="block ${ctxBarColor} h-full transition-all duration-300" style="width: ${Math.min(100, t.contextPct)}%"></span>
          </span>
        </span>
        <span class="${PILL_CLS}" title="${escapeHtml(tokTip)}">
          <span class="text-[var(--muted-foreground)]">📊 ${escapeHtml(tokTitle)}</span>
          <strong class="text-indigo-600 dark:text-indigo-400">${fmtNum(curTok)}</strong>
          <span class="text-[var(--muted-foreground)]">(${escapeHtml(inTag)}${fmtNum(curInTok)}/${escapeHtml(cacheTag)}${fmtCacheK(curCacheTok)}/${escapeHtml(outTag)}${fmtNum(curOutTok)})${totalTok > curTok ? ` · ${escapeHtml(totLbl)}${fmtNum(totalTok)}` : ''}</span>
        </span>
        ${formatCardQuotaPill(t)}
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
    return Boolean(t.isRunning || (t.runningBgCount || 0) > 0 || t.linkedCodex?.isRunning);
  }

  function sortFleetInProgressFirst(list) {
    return [...list].sort((a, b) => {
      const aRun = isTaskInProgress(a) ? 1 : 0;
      const bRun = isTaskInProgress(b) ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      if ((a.runningBgCount || 0) !== (b.runningBgCount || 0)) {
        return (b.runningBgCount || 0) - (a.runningBgCount || 0);
      }
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });
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
        (t) => isTaskInProgress(t) || (!t.isArchived && isTodayLocal(t.mtimeMs) && !t.isSubagent)
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
    const maxUsed = ov.maxContextUsed || 0;
    const maxLim = ov.maxContextLimit || 0;
    document.getElementById('kpiMaxCtx').textContent = maxLim > 0
      ? `${fmtNum(maxUsed)} / ${fmtNum(maxLim)} (${maxPct}%)`
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
    const filtered = mode === 'active' ? activeTasksList : mode === 'codex' ? codexTasksList : sortFleetInProgressFirst(tasks);
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

    container.innerHTML = filtered.map((t) => {
      const isCodex = t.engine === 'CODEX';
      const runningBgList = (t.backgroundTasks || []).filter((b) => b.isRunning);
      const nonDaemonBgList = runningBgList.filter((b) => !b.isDaemon);
      const hasRunningBg = runningBgList.length > 0;
      const hasActiveNonDaemonBg = nonDaemonBgList.length > 0;
      const st = getStateStyle(t.stateCode, hasActiveNonDaemonBg || Boolean(t.linkedCodex?.isRunning));
      const isSelected = window.selectedConvId === t.conversationId;
      const activeRing = isSelected ? 'ring-2 ring-sky-500/60' : '';
      const localizedState = trStateLabel(t.stateCode, t.stateLabel, t.runningBgCount);

      const runningStepIndicesJson = JSON.stringify(nonDaemonBgList.map((b) => b.stepIndex));
      const headerBgStopBtn = hasActiveNonDaemonBg ? `
        <button onclick="killBgTask(event, '${t.conversationId}', ${runningStepIndicesJson})"
                class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md border border-rose-500/40 bg-rose-500/12 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-semibold transition inline-flex items-center gap-1 whitespace-nowrap">
          <span>🛑</span>
          <span>${escapeHtml(nonDaemonBgList.length > 1 ? tHud('stopBgMulti', nonDaemonBgList.length) : tHud('stopBgSingle', nonDaemonBgList[0].taskId))}</span>
        </button>
      ` : '';

      const runningBgTrayHtml = renderBgTrayHtml(t, runningBgList);
      const codexTrayHtml = isCodex
        ? renderCodexProgressTray(t.conversationId, t.codexProgress, false, null)
        : t.linkedCodex
          ? renderCodexProgressTray(`linked:${t.conversationId}`, t.linkedCodex.progress, true, t.linkedCodex)
          : '';

      const diag = getDiagTagStyle(t.diagTag);
      const engineBadgeHtml = isCodex
        ? `<span class="text-[11px] leading-4 mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/35 shrink-0 whitespace-nowrap">🟢 Codex</span>`
        : '';

      const inlineDetailHtml = isSelected && typeof window.renderInlineDetailHtml === 'function'
        ? window.renderInlineDetailHtml(t, data)
        : '';

      return `
        <div class="space-y-0">
          <div onclick="selectTaskForDrilldown('${t.conversationId}')"
               class="task-card ${st.cardClass} ${activeRing} rounded-xl p-2.5 cursor-pointer relative overflow-hidden">
            <div class="absolute left-0 top-0 bottom-0 w-1 ${isCodex ? 'bg-emerald-500' : st.accentBar}"></div>
            <div class="pl-1.5 space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <span class="w-2 h-2 rounded-full ${st.dot} shrink-0"></span>
                  ${engineBadgeHtml}
                  <span class="text-xs sm:text-sm font-bold truncate text-[var(--foreground)]" title="${escapeHtml(t.title)}">
                    ${escapeHtml(t.title)}
                  </span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <span class="text-[11px] mono text-[var(--muted-foreground)] hidden sm:inline whitespace-nowrap">${fmtAgo(t.mtimeMs)}</span>
                  <span class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md metric-pill text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-medium whitespace-nowrap">
                    ${escapeHtml(isSelected ? tHud('collapseBtn') : tHud('detailsBtn', t.totalTurnsCount || 0))}
                  </span>
                  <button onclick="jumpToConversation(event, '${t.conversationId}')"
                          title="${escapeHtml(isCodex ? tHud('jumpCodexTip') : tHud('jumpAgyTip'))}"
                          class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md border ${isCodex ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25' : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20'} font-semibold transition whitespace-nowrap">
                    ${escapeHtml(isCodex ? tHud('jumpCodex') : tHud('jumpAgy'))}
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 mono">
                <span class="font-bold px-2 py-0.5 rounded-md border ${st.badge} shrink-0 whitespace-nowrap">${escapeHtml(localizedState)}</span>
                <span class="px-2 py-0.5 rounded-md border ${diag.cls} shrink-0 whitespace-nowrap" title="${escapeHtml(diag.detail)}">
                  ${escapeHtml(diag.label)}
                </span>
                ${t.isRunning && hasRunningBg ? `
                  <span class="${PILL_CLS} font-semibold text-violet-600 dark:text-violet-300 shrink-0 whitespace-nowrap">
                    ${escapeHtml(tHud('bgPillCount', t.runningBgCount))}
                  </span>
                ` : ''}
                <span class="${PILL_CLS} text-[var(--muted-foreground)] font-medium shrink-0 whitespace-nowrap">
                  ${escapeHtml(t.workspaceLabel)}
                </span>
                <span class="text-[11px] mono text-[var(--muted-foreground)] sm:hidden whitespace-nowrap">${fmtAgo(t.mtimeMs)}</span>
                ${t.isSubagent ? `
                  <span class="${PILL_CLS} font-semibold text-purple-600 dark:text-purple-400 shrink-0 whitespace-nowrap">Sub</span>
                ` : ''}
                ${headerBgStopBtn}
              </div>

              ${renderTurnMetricPillsHtml(t, isCodex)}
              ${runningBgTrayHtml}
              ${codexTrayHtml}
            </div>
          </div>
          ${inlineDetailHtml}
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-scroll-id]').forEach((el) => {
      const id = el.getAttribute('data-scroll-id');
      if (savedScrollTops.has(id)) {
        el.scrollTop = savedScrollTops.get(id);
      }
    });
  };
})();
