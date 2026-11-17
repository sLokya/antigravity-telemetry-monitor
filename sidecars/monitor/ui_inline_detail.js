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

  function fmtClockShort(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const PILL_CLS = 'metric-pill inline-flex flex-wrap items-center gap-1 px-2 py-0.5 rounded-md text-[11px] leading-4 mono';

  function sp() {
    return window.getHudLang() === 'en' ? ' ' : '';
  }

  function fmtQuotaUsageBadges(q, isRunning) {
    if (!q) {
      return `
        <span class="${PILL_CLS} whitespace-nowrap"
              title="${escapeHtml(tHud('quotaNoneTip'))}">
          <span class="text-[var(--muted-foreground)]">🔋 ${escapeHtml(tHud('quotaLabel'))}</span>
          <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('quotaEmpty'))}</span>
        </span>
      `;
    }
    const approx = q.isApproxConcurrent ? '~' : '';
    const u5 = q.fiveHourUsedPct;
    const uw = q.weeklyUsedPct;
    const bothZero = (u5 === 0 || u5 === null) && (uw === 0 || uw === null);

    if (bothZero) {
      const label = isRunning ? tHud('quotaSyncing') : `5h <0.01% · ${tHud('quotaWeek')} <0.01%`;
      const tip = isRunning ? tHud('quotaWaitTip') : tHud('quotaRecordedTip');
      return `
        <span class="${PILL_CLS} whitespace-nowrap"
              title="${escapeHtml(tip)}">
          <span class="text-[var(--muted-foreground)]">🔋 ${escapeHtml(tHud('quotaLabel'))}</span>
          <span class="text-sky-600 dark:text-sky-400 font-semibold">${escapeHtml(label)}</span>
        </span>
      `;
    }

    const f5 = u5 !== null && u5 !== undefined ? `${approx}-${u5}%` : '--';
    const fw = uw !== null && uw !== undefined ? `${approx}-${uw}%` : '--';
    const tip = q.isApproxConcurrent ? tHud('quotaConcurrentTip') : tHud('quotaRecordedTip');
    const valCls = q.isApproxConcurrent
      ? 'text-amber-600 dark:text-amber-300 font-bold'
      : 'text-sky-600 dark:text-sky-300 font-bold';
    return `
      <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tip)}">
        <span class="text-[var(--muted-foreground)]">🔋</span>
        <span class="${valCls}">5h ${escapeHtml(f5)} · ${escapeHtml(tHud('quotaWeek'))} ${escapeHtml(fw)}</span>
      </span>
    `;
  }

  function renderTurnSubStepsHtml(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return `<div class="text-[11px] text-[var(--muted-foreground)] px-2 py-1.5">${escapeHtml(tHud('subStepEmpty'))}</div>`;
    }
    return `
      <div class="overflow-x-auto max-h-44 overflow-y-auto rounded-lg border border-[var(--hud-border)] bg-[var(--card)]">
        <table class="w-full text-left border-collapse text-[11px]">
          <thead class="bg-[var(--background)] text-[var(--muted-foreground)] sticky top-0 border-b border-[var(--hud-border)]">
            <tr>
              <th class="py-1 px-2 font-semibold">#</th>
              <th class="py-1 px-2 font-semibold">${escapeHtml(tHud('thModel'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thSpeed'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thCache'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thTtft'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thOut'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thDiag'))}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--hud-border)] mono">
            ${[...steps].reverse().map((s) => {
              const flags = [];
              if (s.isRouteMismatch) flags.push(`<span class="text-rose-500 font-bold">${escapeHtml(tHud('stepMismatch'))}</span>`);
              if (s.rateLimitRetries > 0) flags.push(`<span class="text-amber-500 font-bold">${escapeHtml(tHud('stepRateLimit', s.rateLimitRetries))}</span>`);
              else if (s.netRetries > 0) flags.push(`<span class="text-sky-500">${escapeHtml(tHud('stepNetRetry', s.netRetries))}</span>`);
              if (s.pureQueueSec >= 15 && s.ttftSec >= 20) flags.push(`<span class="text-amber-500">${escapeHtml(tHud('stepHighLat'))}</span>`);
              if (s.isCotCollapsed) flags.push(`<span class="text-rose-500">${escapeHtml(tHud('stepLowCot'))}</span>`);
              if (s.isCacheShock) flags.push(`<span class="text-amber-500">${escapeHtml(tHud('stepCacheShock'))}</span>`);
              const diagHtml = flags.length > 0 ? flags.join(' ') : '<span class="text-emerald-500/80">✓</span>';
              const speedHtml = s.isBufferedFlush || s.streamingTps <= 0
                ? `<span class="text-[var(--muted-foreground)]" title="${escapeHtml(tHud('bufferedTip', s.streamSec))}">${escapeHtml(tHud('buffered'))}(${s.effectiveTps})</span>`
                : `<span class="font-bold text-emerald-600 dark:text-emerald-400">${s.streamingTps}</span>`;
              return `
                <tr class="hover:bg-[var(--background)]/60">
                  <td class="py-1 px-2 text-[var(--muted-foreground)]">#${s.turnNumber}</td>
                  <td class="py-1 px-2 truncate max-w-[130px]" title="${escapeHtml(s.exactModelId)}">${escapeHtml(s.responseModel && s.responseModel !== 'N/A' ? s.responseModel : s.exactModelId)}</td>
                  <td class="py-1 px-2 text-right">${speedHtml}</td>
                  <td class="py-1 px-2 text-right text-amber-600 dark:text-amber-400">${s.cacheHitRate}% (${fmtCacheK(s.cacheReadTokens)})</td>
                  <td class="py-1 px-2 text-right text-[var(--muted-foreground)]">${s.ttftSec}s/${s.streamSec}s</td>
                  <td class="py-1 px-2 text-right">${s.outputTokens} <span class="text-[var(--muted-foreground)]">(${s.thinkingTokens}/${s.responseTokens})</span></td>
                  <td class="py-1 px-2 text-right">${diagHtml}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTurnSparklineHtml(turns) {
    if (!Array.isArray(turns) || turns.length < 2) return '';
    const recent = turns.slice(-14);
    const speeds = recent.filter((tr) => tr.streamingTps > 0).map((tr) => tr.streamingTps);
    const maxTps = Math.max(...speeds, 10);
    const barsHtml = recent.map((tr) => {
      if (!tr.streamingTps || tr.streamingTps <= 0) {
        return `
          <div class="flex flex-col items-center flex-1 max-w-[26px] min-w-[10px] h-full justify-end">
            <span class="text-[9px] mono text-[var(--muted-foreground)] leading-none mb-0.5">--</span>
            <div class="w-full rounded-t bg-slate-400/35" style="height: 15%"
                 title="${escapeHtml(tHud('turnSparkNoSpeedTip', tr.turnNumber, fmtNum(tr.totalTokens), tr.cacheHitRate))}"></div>
          </div>
        `;
      }
      const hPct = Math.max(15, Math.round((tr.streamingTps / maxTps) * 100));
      const barCls = tr.rateLimitRetries > 0 ? 'bg-amber-500/85' : tr.isRunning ? 'bg-sky-500/90' : 'bg-emerald-500/80';
      return `
        <div class="flex flex-col items-center flex-1 max-w-[26px] min-w-[10px] h-full justify-end">
          <span class="text-[10px] mono text-[var(--muted-foreground)] leading-none mb-0.5">${Math.round(tr.streamingTps)}</span>
          <div class="w-full rounded-t ${barCls} transition-all" style="height: ${hPct}%"
               title="${escapeHtml(tHud('turnSparkTip', tr.turnNumber, tr.streamingTps, tr.cacheHitRate, fmtNum(tr.totalTokens)))}"></div>
        </div>
      `;
    }).join('');

    return `
      <div class="h-11 flex items-end justify-start gap-1.5 pt-2 pb-0.5 px-2.5 kpi-tile rounded-xl overflow-hidden">
        ${barsHtml}
      </div>
    `;
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
    const curTurn = sum.currentTurn || task.currentTurn || null;
    const isCurRunning = Boolean(sum.isCurrentRunning ?? task.isCurrentRunning);
    const turnTag = tHud(isCurRunning ? 'turnCur' : 'turnLast');
    const hasCurSteps = (curTurn?.stepCount || 0) > 0;

    const curStreamTps = hasCurSteps && curTurn?.streamingTps > 0 ? curTurn.streamingTps : '--';
    const curEffectiveTps = hasCurSteps && curTurn?.effectiveTps > 0 ? curTurn.effectiveTps : '--';
    const curCachePct = hasCurSteps ? `${curTurn?.cacheHitRate ?? 0}%` : '--%';
    const curCacheTok = curTurn?.cacheReadTokens ?? task.cacheReadTokens ?? 0;
    const totalCacheTok = sum.totalCacheReadTokens ?? task.totalCacheReadTokens ?? curCacheTok;
    const avgStreamTps = sum.avgStreamingTps > 0 ? sum.avgStreamingTps : '--';
    const peakStreamTps = sum.peakStreamingTps > 0 ? sum.peakStreamingTps : '--';
    const avgEffTps = sum.avgEffectiveTps > 0 ? sum.avgEffectiveTps : '--';
    const peakEffTps = sum.peakEffectiveTps > 0 ? sum.peakEffectiveTps : '--';
    const avgCachePct = sum.avgCacheHitRate !== undefined ? `${sum.avgCacheHitRate}%` : '--%';

    const ctxUsed = latest?.contextUsed ?? task.contextUsed ?? 0;
    const ctxMax = latest?.maxContext ?? task.maxContext ?? 256000;
    const ctxPct = ctxMax > 0 ? +((ctxUsed / ctxMax) * 100).toFixed(1) : (task.contextPct || 0);
    const curTokensStr = curTurn ? fmtNum(curTurn.totalTokens) : '--';
    const curOutStr = curTurn ? fmtNum(curTurn.outputTokens) : '--';
    const curDurStr = curTurn?.totalSec > 0 ? fmtElapsed(curTurn.totalSec) : '--';
    const allTokensStr = fmtNum(sum.totalAllTokens ?? task.totalAllTokens ?? 0);

    const quotaFrac = latest?.quotaRemainingFraction ?? selModel.quotaRemainingFraction;
    const quotaReset = latest?.quotaResetTime ?? selModel.quotaResetTime;
    const quotaWkFrac = latest?.quotaWeeklyRemainingFraction ?? selModel.quotaWeeklyRemainingFraction;
    const quotaWkReset = latest?.quotaWeeklyResetTime ?? selModel.quotaWeeklyResetTime;

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
    const avgPfx = `${tHud('sessionAvgPrefix')}${sp()}`;
    const peakPfx = `${tHud('peakShort')}${sp()}`;
    const totPfx = `${tHud('totalShort')}${sp()}`;
    const outPfx = `${tHud('outPrefix')}${sp()}`;
    const durPfx = `${tHud('durPrefix')}${sp()}`;
    const inTag = `${tHud('tokIn')}${sp()}`;
    const cacheTag = `${tHud('tokCache')}${sp()}`;
    const outTag = `${tHud('tokOut')}${sp()}`;

    return `
      <div onclick="event.stopPropagation()" class="mt-1.5 rounded-xl border border-sky-500/40 bg-[var(--background)]/75 p-2.5 space-y-2.5 shadow-sm">
        <!-- Inline Header Bar -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hud-border)] pb-2">
          <div class="flex items-center gap-1.5 min-w-0 flex-1 text-xs">
            <span class="font-bold text-sky-600 dark:text-sky-400 shrink-0 whitespace-nowrap">${escapeHtml(tHud('detailTitle', turnTag))}</span>
            <span class="text-[var(--muted-foreground)] truncate" title="${escapeHtml(data.liveDetail || '')}">${escapeHtml(data.liveDetail || '')}</span>
          </div>
          <button onclick="closeInlineDetail(event)" class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 font-semibold shrink-0 whitespace-nowrap">
            ${escapeHtml(tHud('collapseBtn'))}
          </button>
        </div>

        <!-- Model + Pool Quota Strip -->
        <div class="kpi-tile rounded-xl p-2 space-y-1.5">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('cfgModel'))}:</span>
            <code class="mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30">${escapeHtml(latest?.exactModelId || latest?.responseModel || task.exactModelId || '--')}</code>
            <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('respModel'))}:</span>
            <code class="mono font-semibold px-1.5 py-0.5 rounded bg-[var(--card)] border border-[var(--hud-border)]">${escapeHtml(latest?.responseModel || task.responseModel || '--')}</code>
            <span class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml((latest?.modelLabel || selModel.label || '--') + (latest?.execModelId ? ` · ${tHud('execModel')}:${latest.execModelId}` : ''))}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 border-t border-[var(--hud-border)] text-[11px] mono">
            <span>${escapeHtml(tHud('poolLabel'))} 5h <strong class="text-sky-600 dark:text-sky-400">${quotaFrac !== null && quotaFrac !== undefined ? `${(quotaFrac * 100).toFixed(1)}%` : '--%'}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(quotaReset))}</span></span>
            <span class="text-[var(--muted-foreground)]">|</span>
            <span>${escapeHtml(tHud('quotaWeek'))} <strong class="text-indigo-600 dark:text-indigo-400">${quotaWkFrac !== null && quotaWkFrac !== undefined ? `${(quotaWkFrac * 100).toFixed(1)}%` : '--%'}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(quotaWkReset))}</span></span>
            <span class="text-[var(--muted-foreground)]">|</span>
            <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('sessionTotal'))} <strong class="text-[var(--foreground)]">${allTokensStr}</strong> tok</span>
          </div>
        </div>

        <!-- KPI 4-Tile Grid: Current Turn vs Session Average -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('kpiTurnSpeed', turnTag))}</div>
            <div class="text-sm font-extrabold mono text-emerald-600 dark:text-emerald-400">${curStreamTps} <span class="text-[10px] font-normal">tok/s</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">${escapeHtml(avgPfx)}${avgStreamTps} / ${escapeHtml(peakPfx)}${peakStreamTps}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('kpiTurnCache', turnTag))}</div>
            <div class="text-sm font-extrabold mono text-amber-600 dark:text-amber-400">${curCachePct} <span class="text-[10px] font-semibold">(${fmtCacheK(curCacheTok)})</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">${escapeHtml(avgPfx)}${avgCachePct} · ${escapeHtml(totPfx)}${fmtCacheK(totalCacheTok)}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('kpiTurnE2e', turnTag))}</div>
            <div class="text-sm font-extrabold mono text-indigo-600 dark:text-indigo-400">${curEffectiveTps} <span class="text-[10px] font-normal">tok/s</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">${escapeHtml(avgPfx)}${avgEffTps} / ${escapeHtml(peakPfx)}${peakEffTps}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml(tHud('kpiTurnTokDur', turnTag))}</div>
            <div class="text-sm font-extrabold mono text-indigo-600 dark:text-indigo-300">${curTokensStr} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">${escapeHtml(outPfx)}${curOutStr} · ${escapeHtml(durPfx)}${curDurStr}</div>
          </div>
        </div>

        <!-- Context Size Bar -->
        <div class="bg-[var(--card)] rounded-lg px-2.5 py-1.5 border border-[var(--hud-border)] space-y-1">
          <div class="flex items-center justify-between text-[11px] mono">
            <span class="text-[var(--muted-foreground)] font-sans">${escapeHtml(tHud('ctxLabel'))}</span>
            <span class="${getCtxTextColor(ctxPct)} font-semibold">${fmtNum(ctxUsed)} / ${fmtNum(ctxMax)} (${ctxPct}%)</span>
          </div>
          <div class="w-full bg-[var(--background)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)]">
            <div class="${getCtxColor(ctxPct)} h-full transition-all duration-300" style="width: ${Math.min(100, ctxPct)}%"></div>
          </div>
        </div>

        <!-- Compact Diagnostics Summary -->
        <div class="kpi-tile rounded-xl p-2 space-y-1.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-1.5">
            <div class="flex items-center gap-1.5">
              <span class="font-bold">${escapeHtml(tHud('diagHeader'))}</span>
              <span class="text-[11px] mono font-semibold px-2 py-0.5 rounded-md border ${diagBadgeCls} whitespace-nowrap">${escapeHtml(diagBadgeText)}</span>
            </div>
            <span class="text-[10px] mono text-[var(--muted-foreground)]">
              ${sum.sigKeyHex ? `🔑 0x${sum.sigKeyHex}` : escapeHtml(tHud('diagNoSig'))} · Session: ${escapeHtml((latest?.sessionID || '--').slice(0, 10))}
            </span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mono text-[11px]">
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
              ${escapeHtml(tHud('diagProvider'))}: ${escapeHtml(latest?.apiProvider || '--')} · ${latest?.isRouteMismatch ? `<span class="text-rose-500 font-bold">${escapeHtml(tHud('diagMismatch'))}</span>` : `<span class="text-emerald-600 dark:text-emerald-400">${escapeHtml(tHud('diagMatch'))}</span>`}
            </div>
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
              ${escapeHtml(tHud('diagCot'))}: ${escapeHtml(tHud('diagLastStep'))} ${latest?.thinkingRatioPct ?? 0}% (${escapeHtml(tHud('avgShort'))} ${sum.avgThinkingRatioPct ?? 0}%)
            </div>
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate col-span-2 sm:col-span-1">
              ${escapeHtml(tHud('diagRetry'))}: ${escapeHtml(tHud('diagLastStep'))} ${latest?.retries || 0} / ${escapeHtml(tHud('totalShort'))} ${sum.totalRetries || 0}
            </div>
          </div>
        </div>

        ${doneBgList.length > 0 ? `
          <div class="space-y-1">
            ${doneBgList.map((bg) => `
              <div class="kpi-tile rounded-lg px-2 py-1 flex items-center justify-between gap-2 text-[11px]">
                <span class="truncate"><span class="mono font-semibold text-[var(--muted-foreground)]">${escapeHtml(tHud('doneBgPrefix'))} ${bg.taskId}:</span> ${escapeHtml(bg.toolSummary || bg.commandLine)}</span>
                <span class="mono text-[var(--muted-foreground)] shrink-0">${fmtElapsed(bg.elapsedSec)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Historical Turn-Task List -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--muted-foreground)]">
            <span class="font-semibold text-[var(--foreground)]">${escapeHtml(tHud('historyTitle'))}</span>
            <span class="mono text-[11px] whitespace-nowrap">${escapeHtml(tHud('historyCount', turns.length, allTokensStr))}</span>
          </div>

          ${renderTurnSparklineHtml(turns)}

          <div data-scroll-id="turns-list-${escapeHtml(task.conversationId)}"
               class="max-h-72 overflow-y-auto space-y-1.5 pr-0.5">
            ${turns.length === 0 ? `
              <div class="text-xs text-[var(--muted-foreground)] text-center py-4 bg-[var(--card)] rounded-xl border border-[var(--hud-border)]">
                ${escapeHtml(tHud('historyEmpty'))}
              </div>
            ` : [...turns].reverse().map((tr) => {
              const isOpen = expandedTurnIds.has(tr.turnId);
              const statusBadge = tr.isRunning
                ? `<span class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-bold whitespace-nowrap shrink-0">${escapeHtml(tHud('statusRunning'))}</span>`
                : tr.status === 'ABORTED'
                  ? `<span class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md bg-rose-500/12 text-rose-500 border border-rose-500/30 whitespace-nowrap shrink-0">${escapeHtml(tHud('statusAborted'))}</span>`
                  : `<span class="text-[11px] leading-4 mono px-2 py-0.5 rounded-md bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 whitespace-nowrap shrink-0">${escapeHtml(tHud('statusDone'))}</span>`;
              const clock = fmtClockShort(tr.startedAtMs || tr.completedAtMs);
              const cacheSharePct = tr.totalTokens > 0 ? +((tr.cacheReadTokens / tr.totalTokens) * 100).toFixed(1) : 0;
              const turnCtxMax = tr.maxContext || ctxMax || 256000;
              const turnCtxPct = tr.contextUsed > 0 && turnCtxMax > 0 ? +((tr.contextUsed / turnCtxMax) * 100).toFixed(1) : 0;
              const tokenDetailTip = tHud('turnTokTip', fmtNum(tr.inputTokens), fmtCacheK(tr.cacheReadTokens), cacheSharePct, tr.cacheHitRate, fmtNum(tr.outputTokens), fmtNum(tr.thinkingTokens), fmtNum(tr.responseTokens));
              return `
                <div class="rounded-xl border ${tr.isRunning ? 'border-sky-500/45 bg-sky-500/5' : 'border-[var(--hud-border)] bg-[var(--card)]'} overflow-hidden">
                  <div onclick="toggleTurnStepsExpand(event, '${escapeHtml(tr.turnId)}')"
                       class="p-2 cursor-pointer hover:bg-[var(--background)]/50 transition space-y-1.5">
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="mono font-bold text-[var(--muted-foreground)] shrink-0 whitespace-nowrap">#${tr.turnNumber}</span>
                        ${statusBadge}
                        <span class="font-semibold text-[var(--foreground)] truncate" title="${escapeHtml(tr.promptPreview || '')}">
                          ${escapeHtml(tr.promptPreview || tHud('turnTitleFallback', tr.turnNumber))}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0 mono text-[11px] leading-4 text-[var(--muted-foreground)] whitespace-nowrap">
                        ${clock ? `<span>${clock}</span>` : ''}
                        <span class="${PILL_CLS} whitespace-nowrap">${escapeHtml(tHud('stepsUnit', tr.stepCount || 0))} ${isOpen ? '▴' : '▾'}</span>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 mono">
                      <span class="${PILL_CLS} text-[var(--foreground)] font-semibold">${escapeHtml(tr.responseModel && tr.responseModel !== 'N/A' ? tr.responseModel : tr.exactModelId)}</span>
                      <span class="${PILL_CLS} whitespace-nowrap">
                        <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('streamLabel'))}</span>
                        <strong class="text-emerald-600 dark:text-emerald-400">${tr.streamingTps > 0 ? tr.streamingTps : '--'}</strong>
                        <span class="text-[var(--muted-foreground)]">tok/s</span>
                      </span>
                      <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tHud('turnCacheTip', tr.cacheHitRate, fmtCacheK(tr.cacheReadTokens), cacheSharePct))}">
                        <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('cacheRatioLabel'))}</span>
                        <strong class="text-amber-600 dark:text-amber-400">${tr.stepCount > 0 ? `${tr.cacheHitRate}% (${fmtCacheK(tr.cacheReadTokens)})` : '--%'}</strong>
                      </span>
                      ${tr.contextUsed > 0 ? `
                        <span class="${PILL_CLS} whitespace-nowrap" title="${escapeHtml(tHud('turnCtxTip'))}">
                          <span class="text-[var(--muted-foreground)]">${escapeHtml(tHud('ctxShort'))}</span>
                          <strong class="${getCtxTextColor(turnCtxPct)}">${fmtNum(tr.contextUsed)}/${fmtNum(turnCtxMax)}</strong>
                          <span class="text-[var(--muted-foreground)]">(${turnCtxPct}%)</span>
                        </span>
                      ` : ''}
                      <span class="${PILL_CLS}" title="${escapeHtml(tokenDetailTip)}">
                        <span class="text-[var(--muted-foreground)]">📊 ${escapeHtml(totPfx)}</span>
                        <strong class="text-indigo-600 dark:text-indigo-400">${fmtNum(tr.totalTokens)} tok</strong>
                        <span class="text-[var(--muted-foreground)]">(${escapeHtml(inTag)}${fmtNum(tr.inputTokens)} / ${escapeHtml(cacheTag)}${fmtCacheK(tr.cacheReadTokens)}·${cacheSharePct}% / ${escapeHtml(outTag)}${fmtNum(tr.outputTokens)})</span>
                      </span>
                      ${fmtQuotaUsageBadges(tr.quotaUsage, tr.isRunning)}
                    </div>
                  </div>
                  ${isOpen ? `<div class="px-2 pb-2 pt-1 border-t border-[var(--hud-border)] bg-[var(--background)]/40" onclick="event.stopPropagation()">${renderTurnSubStepsHtml(tr.steps)}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  };
})();
