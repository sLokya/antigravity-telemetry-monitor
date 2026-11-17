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

  function fmtQuotaUsageBadges(q, isRunning) {
    if (!q) {
      return `
        <span class="text-[11px] mono px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--background)]/60 text-[var(--muted-foreground)] whitespace-nowrap"
              title="无此轮运行期间的配额快照记录（历史任务或插件未监听期间）">
          配额 5h -- · 周 --
        </span>
      `;
    }
    const approx = q.isApproxConcurrent ? '~' : '';
    const u5 = q.fiveHourUsedPct;
    const uw = q.weeklyUsedPct;
    const bothZero = (u5 === 0 || u5 === null) && (uw === 0 || uw === null);

    if (bothZero) {
      const label = isRunning ? '5h/周 配额同步中…' : '5h <0.01% · 周 <0.01%';
      const tip = isRunning
        ? '已开始跟踪配额快照，上游配额池有短暂同步延迟，降幅出现后将实时更新'
        : '本轮期间上游配额池降幅小于 0.01%';
      return `
        <span class="text-[11px] mono px-2 py-0.5 rounded-md border border-sky-500/25 bg-sky-500/8 text-sky-600 dark:text-sky-400 whitespace-nowrap"
              title="${escapeHtml(tip)}">
          🔋 ${label}
        </span>
      `;
    }

    const f5 = u5 !== null && u5 !== undefined ? `${approx}-${u5}%` : '--';
    const fw = uw !== null && uw !== undefined ? `${approx}-${uw}%` : '--';
    const tip = q.source === 'codex_rollout'
      ? '基于 Codex rollout 日志 rate_limits 计算的本轮配额消耗'
      : q.isApproxConcurrent
        ? '同配额池存在多个并发任务，已按并发期间 Token 权重近似分摊（~）'
        : '基于本轮运行期间配额池实际降幅统计';
    const cls = q.isApproxConcurrent
      ? 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:text-amber-300'
      : 'border-sky-500/35 bg-sky-500/12 text-sky-600 dark:text-sky-300';
    return `
      <span class="text-[11px] mono font-semibold px-2 py-0.5 rounded-md border ${cls} whitespace-nowrap" title="${escapeHtml(tip)}">
        🔋 5h ${escapeHtml(f5)} · 周 ${escapeHtml(fw)}
      </span>
    `;
  }

  function renderTurnSubStepsHtml(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return '<div class="text-[11px] text-[var(--muted-foreground)] px-2 py-1.5">本轮暂无底层 LLM 调用记录</div>';
    }
    return `
      <div class="overflow-x-auto max-h-44 overflow-y-auto rounded-lg border border-[var(--hud-border)] bg-[var(--card)]">
        <table class="w-full text-left border-collapse text-[11px]">
          <thead class="bg-[var(--background)] text-[var(--muted-foreground)] sticky top-0 border-b border-[var(--hud-border)]">
            <tr>
              <th class="py-1 px-2 font-semibold">#</th>
              <th class="py-1 px-2 font-semibold">模型</th>
              <th class="py-1 px-2 font-semibold text-right">流式</th>
              <th class="py-1 px-2 font-semibold text-right">缓存</th>
              <th class="py-1 px-2 font-semibold text-right">TTFT/流</th>
              <th class="py-1 px-2 font-semibold text-right">输出(思/答)</th>
              <th class="py-1 px-2 font-semibold text-right">诊断</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--hud-border)] mono">
            ${[...steps].reverse().map((s) => {
              const flags = [];
              if (s.isRouteMismatch) flags.push('<span class="text-rose-500 font-bold">路由偏离</span>');
              if (s.rateLimitRetries > 0) flags.push(`<span class="text-amber-500 font-bold">限流${s.rateLimitRetries}x</span>`);
              else if (s.netRetries > 0) flags.push(`<span class="text-sky-500">重连${s.netRetries}x</span>`);
              if (s.pureQueueSec >= 15 && s.ttftSec >= 20) flags.push('<span class="text-amber-500">高延迟</span>');
              if (s.isCotCollapsed) flags.push('<span class="text-rose-500">少思</span>');
              if (s.isCacheShock) flags.push('<span class="text-amber-500">破缓</span>');
              const diagHtml = flags.length > 0 ? flags.join(' ') : '<span class="text-emerald-500/80">✓</span>';
              const speedHtml = s.isBufferedFlush || s.streamingTps <= 0
                ? `<span class="text-[var(--muted-foreground)]" title="缓冲刷出 (${s.streamSec}s)">缓冲(${s.effectiveTps})</span>`
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
                 title="轮次 #${tr.turnNumber} | 总Token: ${fmtNum(tr.totalTokens)} | 缓存: ${tr.cacheHitRate}%"></div>
          </div>
        `;
      }
      const hPct = Math.max(15, Math.round((tr.streamingTps / maxTps) * 100));
      const barCls = tr.rateLimitRetries > 0 ? 'bg-amber-500/85' : tr.isRunning ? 'bg-sky-500/90' : 'bg-emerald-500/80';
      return `
        <div class="flex flex-col items-center flex-1 max-w-[26px] min-w-[10px] h-full justify-end">
          <span class="text-[10px] mono text-[var(--muted-foreground)] leading-none mb-0.5">${Math.round(tr.streamingTps)}</span>
          <div class="w-full rounded-t ${barCls} transition-all" style="height: ${hPct}%"
               title="轮次 #${tr.turnNumber} | 流式: ${tr.streamingTps} tok/s | 缓存: ${tr.cacheHitRate}% | 总Token: ${fmtNum(tr.totalTokens)}"></div>
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
          <span>正在加载「${escapeHtml(task.title)}」的轮次任务与诊断详情...</span>
          <button onclick="closeInlineDetail(event)" class="px-2 py-0.5 rounded border border-[var(--hud-border)] hover:text-[var(--foreground)] whitespace-nowrap">✕ 收起</button>
        </div>
      `;
    }

    const latest = data.latest;
    const selModel = data.selectedModel || {};
    const sum = data.summary || {};
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const curTurn = sum.currentTurn || task.currentTurn || null;
    const isCurRunning = Boolean(sum.isCurrentRunning ?? task.isCurrentRunning);
    const turnTag = isCurRunning ? '本轮' : '末轮';
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
    let diagBadgeText = '✓ 无异常重试';
    let diagBadgeCls = 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/25';
    if (healthLevel === 'ALERT') {
      diagBadgeText = `🚨 ${healthBadges.map((b) => b.label).join(' · ')}`;
      diagBadgeCls = 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/35';
    } else if (healthLevel === 'WARN') {
      diagBadgeText = `⚠️ ${healthBadges.map((b) => b.label).join(' · ')}`;
      diagBadgeCls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/35';
    } else if (healthBadges.length > 0) {
      diagBadgeText = healthBadges.map((b) => b.label).join(' · ');
      diagBadgeCls = 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25';
    }

    const doneBgList = (task.backgroundTasks || []).filter((b) => !b.isRunning);

    return `
      <div onclick="event.stopPropagation()" class="mt-1.5 rounded-xl border border-sky-500/40 bg-[var(--background)]/75 p-2.5 space-y-2.5 shadow-sm">
        <!-- Inline Header Bar -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hud-border)] pb-2">
          <div class="flex items-center gap-1.5 min-w-0 flex-1 text-xs">
            <span class="font-bold text-sky-600 dark:text-sky-400 shrink-0 whitespace-nowrap">${turnTag}任务 &amp; 会话详情</span>
            <span class="text-[var(--muted-foreground)] truncate" title="${escapeHtml(data.liveDetail || '')}">${escapeHtml(data.liveDetail || '')}</span>
          </div>
          <button onclick="closeInlineDetail(event)" class="text-xs px-2 py-0.5 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 font-semibold shrink-0 whitespace-nowrap">
            收起 ▴
          </button>
        </div>

        <!-- Model + Pool Quota Strip -->
        <div class="kpi-tile rounded-xl p-2 space-y-1.5">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <span class="text-[var(--muted-foreground)]">配置:</span>
            <code class="mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30">${escapeHtml(latest?.exactModelId || latest?.responseModel || task.exactModelId || '--')}</code>
            <span class="text-[var(--muted-foreground)]">返回:</span>
            <code class="mono font-semibold px-1.5 py-0.5 rounded bg-[var(--card)] border border-[var(--hud-border)]">${escapeHtml(latest?.responseModel || task.responseModel || '--')}</code>
            <span class="text-[11px] text-[var(--muted-foreground)]">${escapeHtml((latest?.modelLabel || selModel.label || '--') + (latest?.execModelId ? ` · 执行器:${latest.execModelId}` : ''))}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 border-t border-[var(--hud-border)] text-[11px] mono">
            <span>所属池 5h <strong class="text-sky-600 dark:text-sky-400">${quotaFrac !== null && quotaFrac !== undefined ? `${(quotaFrac * 100).toFixed(1)}%` : '--%'}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(quotaReset))}</span></span>
            <span class="text-[var(--muted-foreground)]">|</span>
            <span>周 <strong class="text-indigo-600 dark:text-indigo-400">${quotaWkFrac !== null && quotaWkFrac !== undefined ? `${(quotaWkFrac * 100).toFixed(1)}%` : '--%'}</strong> <span class="text-[var(--muted-foreground)]">${escapeHtml(fmtResetTime(quotaWkReset))}</span></span>
            <span class="text-[var(--muted-foreground)]">|</span>
            <span class="text-[var(--muted-foreground)]">会话累计 <strong class="text-[var(--foreground)]">${allTokensStr}</strong> tok</span>
          </div>
        </div>

        <!-- KPI 4-Tile Grid: Current Turn vs Session Average -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${turnTag}流式速度</div>
            <div class="text-sm font-extrabold mono text-emerald-600 dark:text-emerald-400">${curStreamTps} <span class="text-[10px] font-normal">tok/s</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">会话均${avgStreamTps} / 峰${peakStreamTps}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${turnTag}缓存命中</div>
            <div class="text-sm font-extrabold mono text-amber-600 dark:text-amber-400">${curCachePct} <span class="text-[10px] font-semibold">(${fmtCacheK(curCacheTok)})</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">会话均${avgCachePct} · 累计${fmtCacheK(totalCacheTok)}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${turnTag}端到端 E2E</div>
            <div class="text-sm font-extrabold mono text-indigo-600 dark:text-indigo-400">${curEffectiveTps} <span class="text-[10px] font-normal">tok/s</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">会话均${avgEffTps} / 峰${peakEffTps}</div>
          </div>
          <div class="bg-[var(--card)] rounded-lg p-1.5 border border-[var(--hud-border)]">
            <div class="text-[11px] text-[var(--muted-foreground)]">${turnTag}Token / 耗时</div>
            <div class="text-sm font-extrabold mono text-indigo-600 dark:text-indigo-300">${curTokensStr} <span class="text-[10px] font-normal text-[var(--muted-foreground)]">tok</span></div>
            <div class="text-[10px] text-[var(--muted-foreground)] mono">输出${curOutStr} · 耗时${curDurStr}</div>
          </div>
        </div>

        <!-- Compact Diagnostics Summary -->
        <div class="kpi-tile rounded-xl p-2 space-y-1.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-1.5">
            <div class="flex items-center gap-1.5">
              <span class="font-bold">🛡 路由与诊断</span>
              <span class="text-[11px] mono font-semibold px-1.5 py-0.2 rounded border ${diagBadgeCls} whitespace-nowrap">${escapeHtml(diagBadgeText)}</span>
            </div>
            <span class="text-[10px] mono text-[var(--muted-foreground)]">
              ${sum.sigKeyHex ? `🔑 0x${sum.sigKeyHex}` : '无签名头'} · Session: ${escapeHtml((latest?.sessionID || '--').slice(0, 10))}
            </span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mono text-[11px]">
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
              通道: ${escapeHtml(latest?.apiProvider || '--')} · ${latest?.isRouteMismatch ? '<span class="text-rose-500 font-bold">路由偏离</span>' : '<span class="text-emerald-600 dark:text-emerald-400">路由一致</span>'}
            </div>
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate">
              思占比: 末步 ${latest?.thinkingRatioPct ?? 0}% (均 ${sum.avgThinkingRatioPct ?? 0}%)
            </div>
            <div class="bg-[var(--card)] rounded px-2 py-1 border border-[var(--hud-border)] truncate col-span-2 sm:col-span-1">
              重试: 末步 ${latest?.retries || 0} / 累计 ${sum.totalRetries || 0}
            </div>
          </div>
        </div>

        ${doneBgList.length > 0 ? `
          <div class="space-y-1">
            ${doneBgList.map((bg) => `
              <div class="kpi-tile rounded-lg px-2 py-1 flex items-center justify-between gap-2 text-[11px]">
                <span class="truncate"><span class="mono font-semibold text-[var(--muted-foreground)]">已完成后台 ${bg.taskId}:</span> ${escapeHtml(bg.toolSummary || bg.commandLine)}</span>
                <span class="mono text-[var(--muted-foreground)] shrink-0">${fmtElapsed(bg.elapsedSec)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Historical Turn-Task List -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--muted-foreground)]">
            <span class="font-semibold text-[var(--foreground)]">📜 历史任务列表（按轮次保存 · 点击单轮可展开 LLM 调用）</span>
            <span class="mono text-[11px] whitespace-nowrap">共 ${turns.length} 轮 · 累计 ${allTokensStr} tok</span>
          </div>

          ${renderTurnSparklineHtml(turns)}

          <div data-scroll-id="turns-list-${escapeHtml(task.conversationId)}"
               class="max-h-72 overflow-y-auto space-y-1.5 pr-0.5">
            ${turns.length === 0 ? `
              <div class="text-xs text-[var(--muted-foreground)] text-center py-4 bg-[var(--card)] rounded-xl border border-[var(--hud-border)]">
                暂无轮次任务记录
              </div>
            ` : [...turns].reverse().map((tr) => {
              const isOpen = expandedTurnIds.has(tr.turnId);
              const statusBadge = tr.isRunning
                ? '<span class="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-bold whitespace-nowrap shrink-0">进行中</span>'
                : tr.status === 'ABORTED'
                  ? '<span class="px-1.5 py-0.5 rounded bg-rose-500/12 text-rose-500 border border-rose-500/30 whitespace-nowrap shrink-0">已中止</span>'
                  : '<span class="px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 whitespace-nowrap shrink-0">✓ 完成</span>';
              const clock = fmtClockShort(tr.startedAtMs || tr.completedAtMs);
              const tokenDetailTip = `未命中输入 ${fmtNum(tr.inputTokens)} + 缓存读取 ${fmtNum(tr.cacheReadTokens)} + 输出 ${fmtNum(tr.outputTokens)} (思${fmtNum(tr.thinkingTokens)}/答${fmtNum(tr.responseTokens)})`;
              return `
                <div class="rounded-xl border ${tr.isRunning ? 'border-sky-500/45 bg-sky-500/5' : 'border-[var(--hud-border)] bg-[var(--card)]'} overflow-hidden">
                  <div onclick="toggleTurnStepsExpand(event, '${escapeHtml(tr.turnId)}')"
                       class="p-2 cursor-pointer hover:bg-[var(--background)]/50 transition space-y-1.5">
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="mono font-bold text-[var(--muted-foreground)] shrink-0 whitespace-nowrap">#${tr.turnNumber}</span>
                        ${statusBadge}
                        <span class="font-semibold text-[var(--foreground)] truncate" title="${escapeHtml(tr.promptPreview || '')}">
                          ${escapeHtml(tr.promptPreview || `轮次 #${tr.turnNumber}`)}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0 mono text-[11px] text-[var(--muted-foreground)] whitespace-nowrap">
                        ${clock ? `<span>${clock}</span>` : ''}
                        <span class="px-1.5 py-0.5 rounded metric-pill whitespace-nowrap">${tr.stepCount || 0}步 ${isOpen ? '▴' : '▾'}</span>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5 text-[11px] mono">
                      <span class="px-1.5 py-0.5 rounded metric-pill text-[var(--foreground)] font-semibold">${escapeHtml(tr.responseModel && tr.responseModel !== 'N/A' ? tr.responseModel : tr.exactModelId)}</span>
                      <span class="px-1.5 py-0.5 rounded metric-pill whitespace-nowrap">
                        流式 <strong class="text-emerald-600 dark:text-emerald-400">${tr.streamingTps > 0 ? tr.streamingTps : '--'}</strong> tok/s
                      </span>
                      <span class="px-1.5 py-0.5 rounded metric-pill whitespace-nowrap">
                        缓存 <strong class="text-amber-600 dark:text-amber-400">${tr.stepCount > 0 ? `${tr.cacheHitRate}% (${fmtCacheK(tr.cacheReadTokens)})` : '--%'}</strong>
                      </span>
                    </div>

                    <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] mono pt-0.5 border-t border-[var(--hud-border)]">
                      <span class="px-2 py-0.5 rounded-md border border-indigo-500/35 bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 font-bold"
                            title="${escapeHtml(tokenDetailTip)}">
                        📊 总 ${fmtNum(tr.totalTokens)} tok
                        <span class="font-normal opacity-85">(入${fmtNum(tr.inputTokens)} / 缓${fmtNum(tr.cacheReadTokens)} / 出${fmtNum(tr.outputTokens)})</span>
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
