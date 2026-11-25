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

  function isSubagentTrayOpen(root) {
    const runCount = root?.subagentRunningCount || 0;
    const override = trayToggleState.get(root?.conversationId);
    return override !== undefined ? override : runCount > 0;
  }

  function describeSubagentKind(child) {
    const t = String(child?.subagentType || '').toLowerCase();
    const role = String(child?.role || '');
    if (t === 'browser' || /visual|browser/i.test(role)) return { icon: '🌐', label: '浏览器子代理' };
    if (/^swarm/i.test(role)) return { icon: '🐝', label: '蜂群子代理' };
    return { icon: '🤖', label: '子代理' };
  }

  window.renderSubagentInlineBtn = function (root) {
    const subs = Array.isArray(root?.subagents) ? root.subagents : [];
    if (subs.length === 0) return '';
    const runCount = root.subagentRunningCount || 0;
    const isOpen = isSubagentTrayOpen(root);
    const sumTok = subs.reduce((acc, s) => acc + (s.totals?.totalTokens || 0), 0);
    const allBrowser = subs.every((s) => describeSubagentKind(s).icon === '🌐');
    const allSwarm = subs.every((s) => describeSubagentKind(s).icon === '🐝');
    const prefix = allBrowser ? '🌐 浏览器子代理' : allSwarm ? '🐝 蜂群子代理' : '🤖 子代理';
    const cls = runCount > 0
      ? 'text-sky-600 dark:text-sky-400 font-semibold'
      : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]';
    return `
      <button type="button" onclick="toggleSubagentTray(event, '${escapeHtml(root.conversationId)}')"
              class="inline-flex items-center gap-1 text-[11px] mono ${cls} whitespace-nowrap">
        <span>${prefix} ${subs.length}${runCount > 0 ? `(${runCount}运行)` : ''} · ${HudMetrics.fmtCompactTok(sumTok)}</span>
        <span class="text-[10px] opacity-75">${isOpen ? '▴' : '▾'}</span>
      </button>
    `;
  };

  window.renderSubagentTray = function (root) {
    const subs = Array.isArray(root?.subagents) ? root.subagents : [];
    if (subs.length === 0 || !isSubagentTrayOpen(root)) return '';

    return `
      <div class="pt-1.5 border-t border-[var(--hud-hairline)] space-y-1" onclick="event.stopPropagation()">
        ${subs.map((child) => {
          const isSelected = window.selectedConvId === child.conversationId;
          const dotCls = child.isRunning ? 'bg-sky-500 pulse-live' : 'bg-emerald-500';
          const kind = describeSubagentKind(child);
          const displayLabel = child.role || child.title || child.conversationId.slice(0, 8);
          const turnTag = tHud('subagentTurnBadge', child.attachedTurnNumbers);
          const modelShort = HudMetrics.fmtModelShort(child.exactModelId || child.modelLabel || '--');
          const rowCls = isSelected
            ? 'border-sky-500/60 bg-sky-500/10'
            : 'border-[var(--hud-hairline)] bg-[var(--hud-subtle)] hover:border-sky-500/35';

          return `
            <div onclick="selectTaskForDrilldown('${escapeHtml(child.conversationId)}'); event.stopPropagation();"
                 class="rounded-md border ${rowCls} px-2 py-1 cursor-pointer flex items-center justify-between gap-2 text-[11px] leading-4">
              <div class="flex items-center gap-1.5 min-w-0 flex-1">
                <span class="w-1.5 h-1.5 rounded-full ${dotCls} shrink-0"></span>
                <span class="text-[10px] text-[var(--muted-foreground)] shrink-0">${kind.icon} ${kind.label}</span>
                <span class="font-medium text-[var(--foreground)] truncate" title="${escapeHtml(`${child.role ? `[${child.role}] ` : ''}${child.title}`)}">
                  ${escapeHtml(displayLabel)}
                </span>
                ${turnTag ? `<span class="text-[10px] mono text-sky-600 dark:text-sky-400 shrink-0">${escapeHtml(turnTag)}</span>` : ''}
              </div>
              <div class="flex items-center gap-1.5 shrink-0 mono text-[10px]">
                <span class="text-[var(--muted-foreground)] truncate max-w-[105px]" title="${escapeHtml(child.exactModelId || child.modelLabel)}">${escapeHtml(modelShort)}</span>
                <span class="font-bold text-indigo-600 dark:text-indigo-400">${HudMetrics.fmtCompactTok(child.totals?.totalTokens || 0)}</span>
                ${child.totals?.quotaUsage ? HudMetrics.renderCompactQuotaInline(child.totals.quotaUsage, { isRunning: child.isRunning }) : ''}
                <button type="button" onclick="jumpToConversation(event, '${escapeHtml(child.conversationId)}')"
                        title="${escapeHtml(tHud('jumpAgyTip'))}"
                        class="text-sky-600 dark:text-sky-400 hover:underline px-0.5">↗</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  };
})();
