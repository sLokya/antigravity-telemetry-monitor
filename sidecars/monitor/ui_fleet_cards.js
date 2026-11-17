(function () {
  function formatCardQuotaPill(t) {
    const turnTag = t.isCurrentRunning ? '本轮' : '末轮';
    const q = t.currentTurn?.quotaUsage;
    if (!q) {
      return `
        <span class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--background)]/70 text-[var(--muted-foreground)] whitespace-nowrap"
              title="当前/末轮任务未记录到配额快照（历史轮次或未观测期间）">
          🔋 ${turnTag}配额 5h -- · 周 --
        </span>
      `;
    }
    const u5 = q.fiveHourUsedPct ?? 0;
    const uw = q.weeklyUsedPct ?? 0;
    const approx = q.isApproxConcurrent ? '~' : '';
    if (u5 === 0 && uw === 0) {
      const label = t.currentTurn?.isRunning ? `${turnTag}配额 同步中…` : `${turnTag}配额 5h <0.01% · 周 <0.01%`;
      return `
        <span class="px-2 py-0.5 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 whitespace-nowrap"
              title="已纳入实时配额监控，等待上游配额数字刷新">
          🔋 ${label}
        </span>
      `;
    }
    return `
      <span class="px-2 py-0.5 rounded-md border ${q.isApproxConcurrent ? 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:text-amber-300' : 'border-sky-500/35 bg-sky-500/12 text-sky-600 dark:text-sky-300'} font-semibold whitespace-nowrap"
            title="${q.isApproxConcurrent ? '同配额池多任务并发，按 Token 权重近似分摊 (~)' : '本轮任务期间实测配额消耗'}">
        🔋 ${turnTag}配额 5h ${approx}-${u5}% · 周 ${approx}-${uw}%
      </span>
    `;
  }

  function renderQuotaPoolRow(label, textCls, barBg, bucket) {
    const frac = bucket?.remainingFraction;
    const pct = frac !== null && frac !== undefined ? +(frac * 100).toFixed(1) : null;
    const resetFullStr = bucket?.resetTime ? fmtResetFull(bucket.resetTime) : '刷新时间: --';
    let resetHtml = '--';
    if (bucket?.resetTime) {
      const diffMs = new Date(bucket.resetTime).getTime() - Date.now();
      if (diffMs <= 0) {
        resetHtml = '即将刷新';
      } else {
        const clock = fmtResetClock(bucket.resetTime);
        const cd = fmtResetCountdown(diffMs);
        resetHtml = `<span class="quota-clock">${escapeHtml(clock)} · </span>剩 ${escapeHtml(cd)}`;
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
          const bgTypeLabel = bg.isDaemon ? '🌐 常驻服务' : '⚙️ 后台命令';
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
                  <span class="px-1.5 py-0.2 rounded-md border ${badgeCls} text-[11px] font-medium shrink-0 whitespace-nowrap">${bgTypeLabel}</span>
                  <span class="truncate text-[var(--foreground)] font-semibold" title="${escapeHtml(bg.commandLine || bg.toolSummary)}">
                    ${escapeHtml(bg.toolSummary || bg.commandLine)}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0 mono">
                  <span class="text-emerald-600 dark:text-emerald-400 font-bold text-[11px] bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/25 whitespace-nowrap">
                    ⏱ ${fmtElapsed(bg.elapsedSec)}
                  </span>
                  <button onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, false)"
                          class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] hover:border-sky-500/40 hover:text-sky-500 transition text-[11px] font-sans font-medium whitespace-nowrap">
                    ${isLogOpen ? '收起日志' : '📄 日志'}
                  </button>
                  ${bg.commandLine ? `
                    <button onclick="copyBgCmd(event, '${encodedCmd}')"
                            class="px-2 py-0.5 rounded-md border border-[var(--hud-border)] bg-[var(--card)] hover:border-sky-500/40 hover:text-sky-500 transition text-[11px] font-sans font-medium whitespace-nowrap">
                      📋 命令
                    </button>
                  ` : ''}
                  <button onclick="killBgTask(event, '${t.conversationId}', ${bg.stepIndex})"
                          class="px-2 py-0.5 rounded-md border border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-sans font-bold transition text-[11px] whitespace-nowrap">
                    🛑 停止任务
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
                  ↳ 最新输出: ${escapeHtml(bg.lastLogLine)}
                </div>
              ` : ''}
              ${isLogOpen ? `
                <div class="mt-1 bg-slate-950 border border-slate-800 rounded-lg p-2 space-y-1 text-slate-200">
                  <div class="flex items-center justify-between text-[11px] text-slate-400 mono">
                    <span>${bg.taskId}.log (${fmtNum(bg.logSizeBytes)} B)</span>
                    <button onclick="toggleBgLog(event, '${t.conversationId}', ${bg.stepIndex}, true)"
                            class="px-2 py-0.5 rounded border border-slate-700 hover:text-sky-400">↻ 刷新日志</button>
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
    const metaTip = `配置档位: ${t.modelLabel} (${t.requestedModelId || t.exactModelId}) | 后端返回 responseModel: ${t.responseModel}${t.execModelId ? ' | 预设执行器: ' + t.execModelId : ''} | 通道: ${t.apiProvider}`;

    const turnTag = t.isCurrentRunning ? '本轮' : '末轮';
    const hasTurnSteps = (t.currentTurn?.stepCount ?? 1) > 0;
    const avgTpsStr = t.avgStreamingTps > 0 ? t.avgStreamingTps : '--';
    const avgCacheStr = t.avgCacheHitRate !== undefined ? `${t.avgCacheHitRate}%` : '--%';

    const speedHtml = hasTurnSteps && t.streamingTps > 0
      ? `${turnTag} <strong class="text-emerald-600 dark:text-emerald-400">${t.streamingTps}</strong> <span class="text-[var(--muted-foreground)] text-[11px]">tok/s (均${avgTpsStr})</span>`
      : hasTurnSteps && t.effectiveTps > 0
        ? `${turnTag} E2E <strong class="text-indigo-600 dark:text-indigo-400">${t.effectiveTps}</strong> <span class="text-[var(--muted-foreground)] text-[11px]">(均${avgTpsStr})</span>`
        : `${turnTag} <span class="text-[var(--muted-foreground)]">--</span> <span class="text-[var(--muted-foreground)] text-[11px]">tok/s (均${avgTpsStr})</span>`;

    const curCacheTok = t.currentTurn?.cacheReadTokens ?? t.cacheReadTokens ?? 0;
    const totalCacheTok = t.totalCacheReadTokens ?? curCacheTok;
    const cacheHtml = hasTurnSteps
      ? `缓存 ${turnTag} <strong class="text-amber-600 dark:text-amber-400">${t.cacheHitRate}%</strong> <span class="text-amber-700/80 dark:text-amber-300/80">(${fmtCacheK(curCacheTok)})</span> <span class="text-[var(--muted-foreground)] text-[11px]">(均${avgCacheStr} · 累计${fmtCacheK(totalCacheTok)})</span>`
      : `缓存 ${turnTag} <strong class="text-[var(--muted-foreground)]">--%</strong> <span class="text-[var(--muted-foreground)] text-[11px]">(均${avgCacheStr} · 累计${fmtCacheK(totalCacheTok)})</span>`;

    const curTok = t.currentTurn?.totalTokens ?? t.totalAllTokens ?? 0;
    const curInTok = t.currentTurn?.inputTokens ?? 0;
    const curOutTok = t.currentTurn?.outputTokens ?? t.outputTokens ?? 0;
    const totalTok = t.totalAllTokens ?? curTok;
    const tokTip = `${turnTag}总Token: ${fmtNum(curTok)} (入${fmtNum(curInTok)} / 缓${fmtCacheK(curCacheTok)} / 出${fmtNum(curOutTok)}) | 会话累计: ${fmtNum(totalTok)}`;

    const ctxBarColor = getCtxColor(t.contextPct);
    const ctxTextClass = getCtxTextColor(t.contextPct);

    return `
      <div class="flex flex-wrap items-center gap-1.5 text-xs mono">
        <span class="metric-pill inline-flex flex-wrap items-center gap-x-1 px-2 py-0.5 rounded-md ${isCodex ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'} font-bold max-w-full break-all" title="${escapeHtml(metaTip)}">
          <span>✦ ${escapeHtml(t.exactModelId || t.responseModel)}${showTier ? ` (${escapeHtml(cleanTier)})` : ''}</span>
          ${t.execModelId ? `<span class="font-normal opacity-80">→执行:${escapeHtml(t.execModelId)}</span>` : t.responseModel && t.responseModel !== '--' && t.responseModel !== t.exactModelId ? `<span class="font-normal opacity-75">(${escapeHtml(t.responseModel)})</span>` : ''}
        </span>
        ${t.sigKeyHex ? `
          <span class="metric-pill px-1.5 py-0.5 rounded-md text-[11px] ${t.fpStatus === 'CHANGED' ? 'text-amber-500 font-bold border-amber-500/40' : 'text-[var(--muted-foreground)]'}"
                title="Thinking 签名协议前缀: 0x${t.sigKeyHex} · Session: ${escapeHtml(t.sessionID || '--')}">
            🔑 ${t.sigKeyHex.slice(0, 6)}
          </span>
        ` : ''}
        <span class="metric-pill px-1.5 py-0.5 rounded-md" title="当前/末轮任务流式吐字速度 vs 会话全局平均">${speedHtml}</span>
        <span class="metric-pill px-1.5 py-0.5 rounded-md" title="当前/末轮任务缓存命中率与实际读取大小(k) vs 会话全局平均">${cacheHtml}</span>
        <div class="flex items-center gap-1.5 metric-pill px-2 py-0.5 rounded-md" title="当前对话上下文大小 / 上下文窗口上限">
          <span class="text-[11px] text-[var(--muted-foreground)]">上下文大小</span>
          <span class="${ctxTextClass} text-[11px]">${fmtNum(t.contextUsed || 0)}/${fmtNum(t.maxContext || 0)} (${t.contextPct}%)</span>
          <div class="w-10 bg-[var(--card)] h-1.5 rounded-full overflow-hidden border border-[var(--hud-border)] shrink-0">
            <div class="${ctxBarColor} h-full transition-all duration-300" style="width: ${Math.min(100, t.contextPct)}%"></div>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 text-[11px] mono pt-0.5">
        <span class="px-2 py-0.5 rounded-md border border-indigo-500/35 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-bold" title="${escapeHtml(tokTip)}">
          📊 ${turnTag}Token ${fmtNum(curTok)} <span class="font-normal opacity-80">(入${fmtNum(curInTok)}/缓${fmtCacheK(curCacheTok)}/出${fmtNum(curOutTok)})${totalTok > curTok ? ` · 累计${fmtNum(totalTok)}` : ''}</span>
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

    fleetBadge.textContent = runCount > 0 ? `⚡ ${runCount} 活跃推理` : '前台就绪';
    fleetBadge.className = runCount > 0
      ? 'text-xs mono px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-semibold whitespace-nowrap'
      : 'text-xs mono px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 font-medium whitespace-nowrap';

    if (fleetCodexBadge) {
      if (runCodexCount > 0) {
        fleetCodexBadge.textContent = `🟢 ${runCodexCount} Codex 执行中`;
        fleetCodexBadge.classList.remove('hidden');
      } else if (codexTasksList.length > 0) {
        fleetCodexBadge.textContent = `🟢 ${codexTasksList.length} Codex 会话`;
        fleetCodexBadge.classList.remove('hidden');
      } else {
        fleetCodexBadge.classList.add('hidden');
      }
    }

    if (bgCount > 0) {
      fleetBgBadge.textContent = `⚙️ ${bgCount} 后台任务运行中`;
      fleetBgBadge.classList.remove('hidden');
    } else {
      fleetBgBadge.classList.add('hidden');
    }

    fleetDot.className = (runCount > 0 || bgCount > 0 || runCodexCount > 0)
      ? 'w-2.5 h-2.5 rounded-full bg-sky-500 pulse-live shrink-0 ring-4 ring-sky-500/15'
      : 'w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0 ring-4 ring-emerald-500/15';

    document.getElementById('kpiTasks').textContent =
      runCodexCount > 0
        ? `${runCount} 活跃 (${runCodexCount} Codex) / ${bgCount} 后台`
        : `${runCount} 前台 / ${bgCount} 后台`;
    document.getElementById('kpiTasksSub').textContent =
      runCodexCount > 0
        ? `含 ${runCodexCount} 个 Codex 任务正在实时推进`
        : bgCount > 0
          ? `含 ${bgCount} 个正在执行的后台任务`
          : `共追踪 ${tasks.length} 个会话 (含 ${codexTasksList.length} 个 Codex)`;

    document.getElementById('kpiFleetTps').textContent = `${ov.fleetAvgTps || 0}`;
    document.getElementById('kpiFleetTpsSub').textContent =
      ov.fleetCombinedTps > 0 ? `实时并发合流 ${ov.fleetCombinedTps} tok/s` : '近期平均流式吐字';

    const maxPct = ov.maxContextPct || 0;
    const maxUsed = ov.maxContextUsed || 0;
    const maxLim = ov.maxContextLimit || 0;
    document.getElementById('kpiMaxCtx').textContent = maxLim > 0
      ? `${fmtNum(maxUsed)} / ${fmtNum(maxLim)} (${maxPct}%)`
      : `${maxPct}%`;
    const maxSubEl = document.getElementById('kpiMaxCtxSub');
    if (maxSubEl) {
      maxSubEl.textContent = `最高上下文对话: ${ov.maxContextTitle || '--'}`;
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
          <div class="text-xs font-semibold text-[var(--foreground)]">当前暂无进行中任务或今日未归档对话</div>
          <div class="text-[11px] text-[var(--muted-foreground)]">可切换至「全部」或「Codex」查看更早的历史会话记录</div>
          <div class="flex items-center justify-center gap-2 pt-1">
            ${codexTasksList.length > 0 ? `
              <button onclick="switchToCodexFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 font-semibold transition">
                🟢 查看 Codex 任务与工作进度 (${codexTasksList.length})
              </button>
            ` : ''}
            <button onclick="switchToAllFilter()" class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 font-medium transition">
              查看全部近期会话 (${tasks.length}) →
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

      const runningStepIndicesJson = JSON.stringify(nonDaemonBgList.map((b) => b.stepIndex));
      const headerBgStopBtn = hasActiveNonDaemonBg ? `
        <button onclick="killBgTask(event, '${t.conversationId}', ${runningStepIndicesJson})"
                class="text-xs px-2 py-0.5 rounded-md border border-rose-500/40 bg-rose-500/12 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-semibold transition flex items-center gap-1 shadow-sm whitespace-nowrap">
          <span>🛑</span>
          <span>${nonDaemonBgList.length > 1 ? `停止后台 (${nonDaemonBgList.length})` : `停止 ${nonDaemonBgList[0].taskId}`}</span>
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
        ? `<span class="text-[11px] font-extrabold px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/35 shrink-0 whitespace-nowrap">🟢 Codex</span>`
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
                  <span class="text-xs px-1.5 py-0.5 rounded-md metric-pill text-[var(--muted-foreground)] hover:text-[var(--foreground)] font-medium whitespace-nowrap">
                    ${isSelected ? '收起 ▴' : `详情 (${t.totalTurnsCount || 0}) ▾`}
                  </span>
                  <button onclick="jumpToConversation(event, '${t.conversationId}')"
                          title="${isCodex ? '在 Codex Desktop 客户端中直接打开此会话' : '在 Antigravity 中切换到此对话'}"
                          class="text-xs px-1.5 py-0.5 rounded-md border ${isCodex ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25' : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20'} font-semibold transition whitespace-nowrap">
                    ${isCodex ? 'Codex ↗' : '跳转 ↗'}
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[11px] font-bold px-1.5 py-0.5 rounded-md border ${st.badge} shrink-0 whitespace-nowrap">${t.stateLabel}</span>
                <span class="text-[11px] mono px-1.5 py-0.5 rounded-md border ${diag.cls} shrink-0 whitespace-nowrap" title="${escapeHtml(diag.detail)}">
                  ${escapeHtml(diag.label)}
                </span>
                ${t.isRunning && hasRunningBg ? `
                  <span class="text-[11px] mono font-semibold px-1.5 py-0.5 rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-500/30 shrink-0 whitespace-nowrap">
                    ⚙️ ${t.runningBgCount} 后台
                  </span>
                ` : ''}
                <span class="text-[11px] mono px-1.5 py-0.5 rounded-md metric-pill text-[var(--muted-foreground)] font-medium shrink-0 whitespace-nowrap">
                  ${escapeHtml(t.workspaceLabel)}
                </span>
                <span class="text-[11px] mono text-[var(--muted-foreground)] sm:hidden whitespace-nowrap">${fmtAgo(t.mtimeMs)}</span>
                ${t.isSubagent ? `
                  <span class="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/25 shrink-0 whitespace-nowrap">Sub</span>
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
