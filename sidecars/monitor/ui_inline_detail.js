(function () {
  const expandedTurnIds = new Set();

  window.toggleTurnStepsExpand = function (event, turnId) {
    event.stopPropagation();
    if (expandedTurnIds.has(turnId)) {
      expandedTurnIds.delete(turnId);
    } else {
      expandedTurnIds.add(turnId);
    }
    if (window.lastPayload && typeof window.renderFleet === 'function') {
      window.renderFleet(window.lastPayload);
    }
  };

  window.closeInlineDetail = function (event) {
    event.stopPropagation();
    window.selectedConvId = null;
    if (window.lastPayload && typeof window.renderFleet === 'function') {
      window.renderFleet(window.lastPayload);
    }
  };

  function renderPoolQuotaRows(quotaGroups, selModel, latest) {
    const pools = [];
    const g5 = quotaGroups?.gemini?.fiveHour || (selModel.quotaRemainingFraction != null
      ? { remainingFraction: latest?.quotaRemainingFraction ?? selModel.quotaRemainingFraction, resetTime: latest?.quotaResetTime ?? selModel.quotaResetTime }
      : null);
    const gw = quotaGroups?.gemini?.weekly || (selModel.quotaWeeklyRemainingFraction != null
      ? { remainingFraction: latest?.quotaWeeklyRemainingFraction ?? selModel.quotaWeeklyRemainingFraction, resetTime: latest?.quotaWeeklyResetTime ?? selModel.quotaWeeklyResetTime }
      : null);
    if (g5 || gw) pools.push({ key: 'gemini', fiveHour: g5, weekly: gw });
    if (quotaGroups?.['3p']) pools.push({ key: '3p', ...quotaGroups['3p'] });
    if (quotaGroups?.codex) pools.push({ key: 'codex', ...quotaGroups.codex });

    if (pools.length === 0) return '';
    return `
      <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] px-2.5 py-2 space-y-1.5">
        <div class="text-[10px] font-semibold text-[var(--muted-foreground)]">${escapeHtml(tHud('poolQuotasTitle'))}</div>
        <div class="space-y-1 text-[11px] mono tabular-nums">
          ${pools.map((p) => {
            const meta = HudMetrics.poolMeta(p.key);
            const f5 = p.fiveHour?.remainingFraction;
            const fw = p.weekly?.remainingFraction;
            const p5 = f5 !== null && f5 !== undefined ? `${(f5 * 100).toFixed(1)}%` : '--%';
            const pw = fw !== null && fw !== undefined ? `${(fw * 100).toFixed(1)}%` : '--%';
            return `
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-semibold ${meta.textCls}">${meta.icon} ${escapeHtml(meta.label)}</span>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                  <span>5h <strong class="text-[var(--foreground)]">${p5}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(p.fiveHour?.resetTime))}</span></span>
                  <span class="text-[var(--muted-foreground)]">|</span>
                  <span>${escapeHtml(tHud('quotaWeek'))} <strong class="text-[var(--foreground)]">${pw}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(p.weekly?.resetTime))}</span></span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderSessionFallback(sum, task, turns) {
    if (sum?.sessionTotals) return sum.sessionTotals;
    if (task?.sessionTotals) return task.sessionTotals;
    let inT = 0;
    let cacheT = 0;
    let outT = 0;
    let totT = 0;
    for (const tr of turns) {
      inT += tr.inputTokens || 0;
      cacheT += tr.cacheReadTokens || 0;
      outT += tr.outputTokens || 0;
      totT += tr.totalTokens || 0;
    }
    const prompt = inT + cacheT;
    return {
      inputTokens: inT,
      cacheReadTokens: cacheT,
      outputTokens: outT,
      totalTokens: totT || sum?.totalAllTokens || task?.totalAllTokens || 0,
      cacheHitRate: prompt > 0 ? +((cacheT / prompt) * 100).toFixed(1) : (sum?.avgCacheHitRate ?? 0),
      byModel: [],
      quotaUsage: null,
      turnsCount: turns.length,
    };
  }

  window.renderInlineDetailHtml = function (task, data) {
    const isSynced = data && data.activeConversationId === task.conversationId;
    if (!isSynced) {
      return `
        <div onclick="event.stopPropagation()" class="mt-1.5 rounded-xl border border-sky-500/35 bg-[var(--background)]/80 p-3 text-xs text-[var(--muted-foreground)] flex items-center justify-between">
          <span>${escapeHtml(tHud('detailLoading', task.title))}</span>
          <button onclick="closeInlineDetail(event)" class="px-2 py-0.5 rounded border border-[var(--hud-border)] hover:text-[var(--foreground)] whitespace-nowrap">✕ ${escapeHtml(tHud('fpClose'))}</button>
        </div>
      `;
    }

    const latest = data.latest;
    const selModel = data.selectedModel || {};
    const sum = data.summary || {};
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const curTurn = turns.length > 0 ? turns[turns.length - 1] : (sum.currentTurn || task.currentTurn || null);
    const curAgg = curTurn?.aggregate || HudMetrics.turnTotalsFallback(curTurn);
    const sessTotals = renderSessionFallback(sum, task, turns);
    const isCurRunning = Boolean(sum.isCurrentRunning ?? task.isCurrentRunning ?? curTurn?.isRunning);
    const turnTag = tHud(isCurRunning ? 'turnCur' : 'turnLast');
    const hasCurSteps = (curAgg.stepCount || curTurn?.stepCount || 0) > 0;

    const curStreamTps = hasCurSteps && curTurn?.streamingTps > 0 ? curTurn.streamingTps : '--';
    const curEffTps = hasCurSteps && curTurn?.effectiveTps > 0 ? curTurn.effectiveTps : '--';
    const avgStreamTps = sum.avgStreamingTps > 0 ? sum.avgStreamingTps : '--';
    const peakStreamTps = sum.peakStreamingTps > 0 ? sum.peakStreamingTps : '--';
    const curDurStr = curTurn?.totalSec > 0 ? fmtElapsed(curTurn.totalSec) : '--';

    const ctxUsed = latest?.contextUsed ?? task.contextUsed ?? 0;
    const ctxMax = latest?.maxContext ?? task.maxContext ?? 256000;
    const ctxPct = ctxMax > 0 ? +((ctxUsed / ctxMax) * 100).toFixed(1) : (task.contextPct || 0);

    const healthLevel = sum.healthLevel || 'OK';
    const healthBadges = sum.healthBadges || [];
    const localizedBadges = healthBadges.map((b) => trDiagLabel({ code: b.type, label: b.label }));
    let diagBadgeText = tHud('diagHealthy');
    let diagBadgeCls = 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/25';
    if (healthLevel === 'ALERT') {
      diagBadgeText = `🚨 ${localizedBadges.join(' · ')}`;
      diagBadgeCls = 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/35';
    } else if (healthLevel === 'WARN') {
      diagBadgeText = `⚠️ ${localizedBadges.join(' · ')}`;
      diagBadgeCls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/35';
    } else if (localizedBadges.length > 0) {
      diagBadgeText = localizedBadges.join(' · ');
      diagBadgeCls = 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25';
    }

    const doneBgList = (task.backgroundTasks || []).filter((b) => !b.isRunning);
    const curStatusBadge = isCurRunning
      ? `<span class="text-[10px] mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-bold">${escapeHtml(tHud('statusRunning'))}</span>`
      : `<span class="text-[10px] mono px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">${escapeHtml(tHud('statusDone'))}</span>`;

    return `
      <div onclick="event.stopPropagation()" class="mt-1.5 rounded-xl border border-sky-500/35 bg-[var(--hud-subtle)] p-2.5 space-y-2.5 shadow-sm">
        <!-- Header Bar -->
        <div class="flex items-center justify-between gap-2 pb-1.5 border-b border-[var(--hud-border)]">
          <div class="flex items-center gap-2 min-w-0 flex-1 text-xs">
            <span class="font-bold text-sky-600 dark:text-sky-400 shrink-0">${escapeHtml(tHud('detailTitle', turnTag))}</span>
            <span class="text-[11px] text-[var(--muted-foreground)] truncate" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
          </div>
          <button onclick="closeInlineDetail(event)" class="text-[11px] mono px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] hover:border-rose-500/40 hover:text-rose-500 font-semibold shrink-0 transition">
            ${escapeHtml(tHud('collapseBtn'))}
          </button>
        </div>

        <!-- 1. Current/Last Turn Task Panel -->
        <div class="rounded-xl border border-sky-500/25 bg-[var(--card)] p-2.5 space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-bold text-[var(--foreground)]">${escapeHtml(tHud('panelTurnTitle', turnTag))}</span>
                ${curTurn ? `<span class="text-[10px] mono text-[var(--muted-foreground)]">#${curTurn.turnNumber}</span>` : ''}
                ${curStatusBadge}
                <span class="text-[10px] mono text-[var(--muted-foreground)]">${escapeHtml(tHud('durPrefix'))} ${curDurStr}</span>
              </div>
              <div class="text-xs font-medium text-[var(--foreground)] truncate" title="${escapeHtml(curTurn?.promptPreview || data.liveDetail || '')}">
                ${escapeHtml(curTurn?.promptPreview || data.liveDetail || '--')}
              </div>
              ${data.liveDetail && curTurn?.promptPreview ? `
                <div class="text-[10px] text-[var(--muted-foreground)] truncate">${escapeHtml(data.liveDetail)}</div>
              ` : ''}
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mono tabular-nums">
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowTokens'))}</div>
              <div class="text-sm font-extrabold text-indigo-600 dark:text-indigo-400">${HudMetrics.fmtCompactTok(curAgg.totalTokens)}</div>
              <div class="text-[10px] text-[var(--muted-foreground)] truncate">${HudMetrics.fmtCompactTok(curAgg.inputTokens)}/${HudMetrics.fmtCompactTok(curAgg.cacheReadTokens)}/${HudMetrics.fmtCompactTok(curAgg.outputTokens)}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowCacheHit'))}</div>
              <div class="text-sm font-extrabold text-amber-600 dark:text-amber-400">${curAgg.cacheHitRate ?? 0}%</div>
              <div class="text-[10px] text-[var(--muted-foreground)]">${HudMetrics.fmtCompactTok(curAgg.cacheReadTokens)}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowSpeed'))}</div>
              <div class="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">${curStreamTps} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok/s</span></div>
              <div class="text-[10px] text-[var(--muted-foreground)]">E2E ${curEffTps}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2 space-y-0.5">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowQuota'))}</div>
              <div>${HudMetrics.renderQuotaChips(curAgg.quotaUsage, { isRunning: isCurRunning })}</div>
            </div>
          </div>

          ${curAgg.byModel?.length > 0 ? `
            <div class="space-y-1.5">
              ${HudMetrics.renderModelBreakdown(curAgg.byModel, { title: tHud('modelsThisTurn') })}
              ${HudMetrics.renderModelTable(curAgg.byModel)}
            </div>
          ` : ''}

          ${HudTurnList.renderSubagentContribs(curTurn?.subagentTurns || [])}
        </div>

        <!-- 2. Session Details Panel -->
        <div class="rounded-xl border border-[var(--hud-border)] bg-[var(--card)] p-2.5 space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-bold text-[var(--foreground)]">${escapeHtml(tHud('panelSessionTitle'))}</span>
            <span class="text-[10px] mono px-1.5 py-0.5 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)] text-[var(--muted-foreground)]">
              ${escapeHtml(tHud('turnsCountBadge', sessTotals.turnsCount || turns.length))}
            </span>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mono tabular-nums">
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('sessionTotal'))}</div>
              <div class="text-sm font-extrabold text-[var(--foreground)]">${HudMetrics.fmtCompactTok(sessTotals.totalTokens)}</div>
              <div class="text-[10px] text-[var(--muted-foreground)] truncate">${HudMetrics.fmtCompactTok(sessTotals.inputTokens)}/${HudMetrics.fmtCompactTok(sessTotals.cacheReadTokens)}/${HudMetrics.fmtCompactTok(sessTotals.outputTokens)}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowCacheHit'))}</div>
              <div class="text-sm font-extrabold text-amber-600 dark:text-amber-400">${sessTotals.cacheHitRate ?? 0}%</div>
              <div class="text-[10px] text-[var(--muted-foreground)]">${HudMetrics.fmtCompactTok(sessTotals.cacheReadTokens)}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowSpeed'))}</div>
              <div class="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">${avgStreamTps} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok/s</span></div>
              <div class="text-[10px] text-[var(--muted-foreground)]">${escapeHtml(tHud('peakShort'))} ${peakStreamTps}</div>
            </div>
            <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2 space-y-0.5">
              <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowQuota'))}</div>
              <div>${HudMetrics.renderQuotaChips(sessTotals.quotaUsage, { isRunning: task.isRunning })}</div>
            </div>
          </div>

          ${sessTotals.byModel?.length > 0 ? HudMetrics.renderModelBreakdown(sessTotals.byModel, { title: tHud('modelsSession') }) : ''}

          <div class="rounded-lg px-2.5 py-1.5 border border-[var(--hud-border)] bg-[var(--hud-subtle)] space-y-1">
            <div class="flex items-center justify-between text-[11px] mono tabular-nums">
              <span class="text-[var(--muted-foreground)] font-sans">${escapeHtml(tHud('ctxLabel'))}</span>
              <span class="${getCtxTextColor(ctxPct)} font-semibold">${fmtNum(ctxUsed)} / ${fmtNum(ctxMax)} (${ctxPct}%)</span>
            </div>
            <div class="w-full bg-[var(--background)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)]">
              <div class="${getCtxColor(ctxPct)} h-full transition-all duration-300" style="width: ${Math.min(100, ctxPct)}%"></div>
            </div>
          </div>

          ${renderPoolQuotaRows(data.quotaGroups || {}, selModel, latest)}

          <!-- Compact Diagnostics Grid -->
          <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] p-2 space-y-1.5 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-1.5">
              <div class="flex items-center gap-1.5">
                <span class="font-bold text-[11px]">${escapeHtml(tHud('diagHeader'))}</span>
                <span class="text-[10px] mono font-semibold px-1.5 py-0.5 rounded border ${diagBadgeCls}">${escapeHtml(diagBadgeText)}</span>
              </div>
              <span class="text-[10px] mono text-[var(--muted-foreground)]">
                ${sum.sigKeyHex ? `🔑 0x${sum.sigKeyHex}` : escapeHtml(tHud('diagNoSig'))} · ${(latest?.sessionID || '--').slice(0, 10)}
              </span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mono text-[10px]">
              <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
                ${escapeHtml(tHud('diagProvider'))}: ${escapeHtml(latest?.apiProvider || '--')} · ${latest?.isRouteMismatch ? `<span class="text-rose-500 font-bold">${escapeHtml(tHud('diagMismatch'))}</span>` : `<span class="text-emerald-600 dark:text-emerald-400">${escapeHtml(tHud('diagMatch'))}</span>`}
              </div>
              <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
                ${escapeHtml(tHud('diagCot'))}: ${latest?.thinkingRatioPct ?? 0}% (${escapeHtml(tHud('avgShort'))} ${sum.avgThinkingRatioPct ?? 0}%)
              </div>
              <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate col-span-2 sm:col-span-1">
                ${escapeHtml(tHud('diagRetry'))}: ${latest?.retries || 0} / ${escapeHtml(tHud('totalShort'))} ${sum.totalRetries || 0}
              </div>
            </div>
          </div>

          ${doneBgList.length > 0 ? `
            <div class="space-y-1">
              ${doneBgList.map((bg) => `
                <div class="rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] px-2 py-1 flex items-center justify-between gap-2 text-[11px]">
                  <span class="truncate"><span class="mono font-semibold text-[var(--muted-foreground)]">${escapeHtml(tHud('doneBgPrefix'))} ${bg.taskId}:</span> ${escapeHtml(bg.toolSummary || bg.commandLine)}</span>
                  <span class="mono text-[var(--muted-foreground)] shrink-0">${fmtElapsed(bg.elapsedSec)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- 3. Historical Turns -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--muted-foreground)]">
            <span class="font-bold text-[var(--foreground)]">${escapeHtml(tHud('panelHistoryTitle'))}</span>
            <span class="mono text-[11px] whitespace-nowrap">${escapeHtml(tHud('historyCount', turns.length, fmtNum(sessTotals.totalTokens || 0)))}</span>
          </div>
          ${HudTurnList.renderSparkline(turns)}
          ${HudTurnList.renderTurnList(task, turns, expandedTurnIds)}
        </div>
      </div>
    `;
  };
})();
