(function () {
  const trayToggleState = new Map(); // convId -> boolean (explicit user override)

  window.toggleSubagentTray = function (event, convId) {
    event.stopPropagation();
    const cur = trayToggleState.get(convId);
    const root = (window.lastPayload?.fleetTasks || []).find((t) => t.conversationId === convId);
    const defaultOpen = (root?.subagentRunningCount || 0) > 0;
    const isOpen = cur !== undefined ? cur : defaultOpen;
    trayToggleState.set(convId, !isOpen);
    if (window.lastPayload && typeof window.renderFleet === 'function') {
      window.renderFleet(window.lastPayload);
    }
  };

  window.renderSubagentTray = function (root) {
    const subs = Array.isArray(root?.subagents) ? root.subagents : [];
    if (subs.length === 0) return '';

    const runCount = root.subagentRunningCount || 0;
    const override = trayToggleState.get(root.conversationId);
    const isOpen = override !== undefined ? override : runCount > 0;
    const sumTok = subs.reduce((acc, s) => acc + (s.totals?.totalTokens || 0), 0);
    const headerText = tHud('subagentsHeader', subs.length, runCount, HudMetrics.fmtCompactTok(sumTok));

    return `
      <div class="mt-2 pt-2 border-t border-[var(--hud-border)]/80" onclick="event.stopPropagation()">
        <button onclick="toggleSubagentTray(event, '${escapeHtml(root.conversationId)}')"
                class="w-full flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-[var(--hud-subtle)] border border-[var(--hud-border)] hover:border-purple-500/40 text-[11px] leading-4 mono transition">
          <span class="font-semibold text-[var(--foreground)] truncate">${escapeHtml(headerText)}</span>
          <span class="text-[var(--muted-foreground)] shrink-0">${isOpen ? '▴' : '▾'}</span>
        </button>

        ${isOpen ? `
          <div class="mt-1.5 space-y-1">
            ${subs.map((child) => {
              const isSelected = window.selectedConvId === child.conversationId;
              const dotCls = child.isRunning ? 'bg-purple-500 pulse-live' : 'bg-emerald-500/80';
              const displayLabel = child.role || child.title || child.conversationId.slice(0, 8);
              const turnTag = tHud('subagentTurnBadge', child.attachedTurnNumbers);
              const modelShort = HudMetrics.fmtModelShort(child.exactModelId || child.modelLabel || '--');
              const rowCls = isSelected
                ? 'border-purple-500/60 bg-purple-500/10 ring-1 ring-purple-500/40'
                : 'border-[var(--hud-border)] bg-[var(--card)] hover:border-purple-500/35';

              return `
                <div onclick="selectTaskForDrilldown('${escapeHtml(child.conversationId)}'); event.stopPropagation();"
                     class="rounded-lg border ${rowCls} px-2 py-1.5 cursor-pointer transition space-y-1">
                  <div class="flex items-center justify-between gap-2 text-[11px] leading-4">
                    <div class="flex items-center gap-1.5 min-w-0 flex-1">
                      <span class="w-1.5 h-1.5 rounded-full ${dotCls} shrink-0"></span>
                      <span class="font-semibold text-[var(--foreground)] truncate" title="${escapeHtml(`${child.role ? `[${child.role}] ` : ''}${child.title}`)}">
                        ${escapeHtml(displayLabel)}
                      </span>
                      ${child.source === 'history' ? `
                        <span class="text-[10px] mono px-1 rounded bg-[var(--hud-subtle)] text-[var(--muted-foreground)] border border-[var(--hud-border)] shrink-0">${escapeHtml(tHud('subagentSourceHist'))}</span>
                      ` : ''}
                      ${turnTag ? `
                        <span class="text-[10px] mono px-1 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/25 shrink-0">${escapeHtml(turnTag)}</span>
                      ` : ''}
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0 mono text-[10px]">
                      <span class="text-[var(--muted-foreground)] truncate max-w-[115px]" title="${escapeHtml(child.exactModelId || child.modelLabel)}">${escapeHtml(modelShort)}</span>
                      <span class="font-bold text-indigo-600 dark:text-indigo-400">${HudMetrics.fmtCompactTok(child.totals?.totalTokens || 0)}</span>
                      <button onclick="jumpToConversation(event, '${escapeHtml(child.conversationId)}')"
                              title="${escapeHtml(tHud('jumpAgyTip'))}"
                              class="px-1.5 py-0.5 rounded border border-[var(--hud-border)] hover:border-sky-500/40 hover:text-sky-500 transition">↗</button>
                    </div>
                  </div>
                  ${child.totals?.quotaUsage ? `
                    <div class="pl-3">${HudMetrics.renderQuotaChips(child.totals.quotaUsage, { isRunning: child.isRunning, compact: true })}</div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  };
})();
