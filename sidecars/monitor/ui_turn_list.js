(function () {
  function fmtClockShort(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderStepsTable(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return `<div class="text-[11px] text-[var(--muted-foreground)] px-2 py-1.5">${escapeHtml(tHud('subStepEmpty'))}</div>`;
    }
    return `
      <div class="overflow-x-auto max-h-44 overflow-y-auto rounded-lg border border-[var(--hud-border)] bg-[var(--card)]">
        <table class="w-full text-left border-collapse text-[11px] tabular-nums">
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

  function renderSparkline(turns) {
    if (!Array.isArray(turns) || turns.length < 2) return '';
    const recent = turns.slice(-14);
    const speeds = recent.filter((tr) => tr.streamingTps > 0).map((tr) => tr.streamingTps);
    const maxTps = Math.max(...speeds, 10);
    const barsHtml = recent.map((tr) => {
      const aggTok = tr.aggregate?.totalTokens ?? tr.totalTokens ?? 0;
      const aggCache = tr.aggregate?.cacheHitRate ?? tr.cacheHitRate ?? 0;
      if (!tr.streamingTps || tr.streamingTps <= 0) {
        return `
          <div class="flex flex-col items-center flex-1 max-w-[26px] min-w-[10px] h-full justify-end">
            <span class="text-[9px] mono text-[var(--muted-foreground)] leading-none mb-0.5">--</span>
            <div class="w-full rounded-t bg-slate-400/35" style="height: 15%"
                 title="${escapeHtml(tHud('turnSparkNoSpeedTip', tr.turnNumber, fmtNum(aggTok), aggCache))}"></div>
          </div>
        `;
      }
      const hPct = Math.max(15, Math.round((tr.streamingTps / maxTps) * 100));
      const barCls = tr.rateLimitRetries > 0 ? 'bg-amber-500/85' : tr.isRunning ? 'bg-sky-500/90' : 'bg-emerald-500/80';
      return `
        <div class="flex flex-col items-center flex-1 max-w-[26px] min-w-[10px] h-full justify-end">
          <span class="text-[10px] mono text-[var(--muted-foreground)] leading-none mb-0.5">${Math.round(tr.streamingTps)}</span>
          <div class="w-full rounded-t ${barCls} transition-all" style="height: ${hPct}%"
               title="${escapeHtml(tHud('turnSparkTip', tr.turnNumber, tr.streamingTps, aggCache, fmtNum(aggTok)))}"></div>
        </div>
      `;
    }).join('');

    return `
      <div class="h-11 flex items-end justify-start gap-1.5 pt-2 pb-0.5 px-2.5 kpi-tile rounded-xl overflow-hidden">
        ${barsHtml}
      </div>
    `;
  }

  function renderSubagentContribs(subTurns) {
    if (!Array.isArray(subTurns) || subTurns.length === 0) return '';
    return `
      <div class="space-y-1">
        <div class="text-[10px] font-semibold text-[var(--muted-foreground)]">${escapeHtml(tHud('subagentContribs'))} (${subTurns.length})</div>
        <div class="space-y-1">
          ${subTurns.map((st) => `
            <div onclick="selectTaskForDrilldown('${escapeHtml(st.conversationId)}'); event.stopPropagation();"
                 class="flex flex-wrap items-center justify-between gap-2 px-2 py-1 rounded-lg border border-[var(--hud-border)] bg-[var(--background)]/60 hover:border-purple-500/40 cursor-pointer text-[11px] mono">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="w-1.5 h-1.5 rounded-full ${st.isRunning ? 'bg-purple-500 pulse-live' : 'bg-emerald-500/80'} shrink-0"></span>
                <span class="font-semibold text-[var(--foreground)] truncate max-w-[140px]">${escapeHtml(st.label || st.conversationId.slice(0, 8))}</span>
                <span class="text-[10px] text-[var(--muted-foreground)]">${escapeHtml(tHud('subagentChildTurn', st.turnNumber || 1))}</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="font-bold text-indigo-600 dark:text-indigo-400">${HudMetrics.fmtCompactTok(st.totals?.totalTokens || 0)}</span>
                ${st.totals?.quotaUsage ? HudMetrics.renderQuotaChips(st.totals.quotaUsage, { isRunning: st.isRunning, compact: true }) : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderTurnList(task, turns, expandedSet) {
    if (!Array.isArray(turns) || turns.length === 0) {
      return `
        <div class="text-xs text-[var(--muted-foreground)] text-center py-4 bg-[var(--card)] rounded-xl border border-[var(--hud-border)]">
          ${escapeHtml(tHud('historyEmpty'))}
        </div>
      `;
    }

    return `
      <div data-scroll-id="turns-list-${escapeHtml(task.conversationId)}" class="max-h-72 overflow-y-auto space-y-1.5 pr-0.5">
        ${[...turns].reverse().map((tr) => {
          const isOpen = expandedSet.has(tr.turnId);
          const agg = tr.aggregate || HudMetrics.turnTotalsFallback(tr);
          const subTurns = Array.isArray(tr.subagentTurns) ? tr.subagentTurns : [];
          const subCount = agg.subagentCount || new Set(subTurns.map((x) => x.conversationId)).size;
          const clock = fmtClockShort(tr.startedAtMs || tr.completedAtMs);

          const statusBadge = tr.isRunning
            ? `<span class="text-[10px] leading-4 mono px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-bold shrink-0">${escapeHtml(tHud('statusRunning'))}</span>`
            : tr.status === 'ABORTED'
              ? `<span class="text-[10px] leading-4 mono px-1.5 py-0.2 rounded bg-rose-500/12 text-rose-500 border border-rose-500/30 shrink-0">${escapeHtml(tHud('statusAborted'))}</span>`
              : `<span class="text-[10px] leading-4 mono px-1.5 py-0.2 rounded bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 shrink-0">${escapeHtml(tHud('statusDone'))}</span>`;

          const modelDots = (agg.byModel || []).slice(0, 4).map((m) => {
            const meta = HudMetrics.poolMeta(m.quotaGroupKey);
            return `<span class="inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]" title="${escapeHtml(`${m.exactModelId}: ${fmtNum(m.totalTokens)} tok`)}"><span class="w-1.5 h-1.5 rounded-full ${meta.dotCls}"></span><span>${escapeHtml(HudMetrics.fmtModelShort(m.exactModelId || m.modelLabel))}</span></span>`;
          }).join('');

          return `
            <div class="rounded-xl border ${tr.isRunning ? 'border-sky-500/45 bg-sky-500/5' : 'border-[var(--hud-border)] bg-[var(--card)]'} overflow-hidden">
              <div onclick="toggleTurnStepsExpand(event, '${escapeHtml(tr.turnId)}')"
                   class="p-2 cursor-pointer hover:bg-[var(--background)]/50 transition space-y-1.5">
                <div class="flex items-center justify-between gap-2 text-xs">
                  <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="mono font-bold text-[var(--muted-foreground)] shrink-0">#${tr.turnNumber}</span>
                    ${statusBadge}
                    <span class="font-semibold text-[var(--foreground)] truncate" title="${escapeHtml(tr.promptPreview || '')}">
                      ${escapeHtml(tr.promptPreview || tHud('turnTitleFallback', tr.turnNumber))}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 mono text-[10px] text-[var(--muted-foreground)] whitespace-nowrap">
                    ${subCount > 0 ? `<span class="px-1.5 py-0.2 rounded bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/25 font-semibold">${escapeHtml(tHud('subagentTurnTag', subCount))}</span>` : ''}
                    ${clock ? `<span>${clock}</span>` : ''}
                    <span class="px-1.5 py-0.2 rounded border border-[var(--hud-border)] bg-[var(--hud-subtle)]">${escapeHtml(tHud('stepsUnit', agg.stepCount || tr.stepCount || 0))} ${isOpen ? '▴' : '▾'}</span>
                  </div>
                </div>

                <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] mono tabular-nums">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-bold text-indigo-600 dark:text-indigo-400" title="${escapeHtml(`${fmtNum(agg.totalTokens || 0)} tok`)}">${HudMetrics.fmtCompactTok(agg.totalTokens || 0)} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok</span></span>
                    <span class="text-amber-600 dark:text-amber-400 font-semibold">${agg.cacheHitRate ?? 0}% <span class="text-[10px] font-normal text-[var(--muted-foreground)]">(${HudMetrics.fmtCompactTok(agg.cacheReadTokens || 0)})</span></span>
                    ${tr.streamingTps > 0 ? `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">${tr.streamingTps} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok/s</span></span>` : ''}
                    ${modelDots}
                  </div>
                  <div>${HudMetrics.renderQuotaChips(agg.quotaUsage, { isRunning: tr.isRunning, compact: true })}</div>
                </div>
              </div>

              ${isOpen ? `
                <div class="border-t border-[var(--hud-border)] bg-[var(--background)]/45 p-2 space-y-2">
                  ${HudMetrics.renderModelTable(agg.byModel || [])}
                  ${renderSubagentContribs(subTurns)}
                  ${renderStepsTable(tr.steps || [])}
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  window.HudTurnList = {
    renderSparkline,
    renderTurnList,
    renderStepsTable,
    renderSubagentContribs,
  };
})();
