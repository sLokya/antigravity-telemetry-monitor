(function () {
  const POOL_STYLE = {
    gemini: {
      icon: '✦',
      textCls: 'text-sky-600 dark:text-sky-400',
      barCls: 'bg-sky-500',
      dotCls: 'bg-sky-500',
      chipCls: 'bg-sky-500/10 border-sky-500/25 text-sky-700 dark:text-sky-300',
    },
    '3p': {
      icon: '🟣',
      textCls: 'text-purple-600 dark:text-purple-400',
      barCls: 'bg-purple-500',
      dotCls: 'bg-purple-500',
      chipCls: 'bg-purple-500/10 border-purple-500/25 text-purple-700 dark:text-purple-300',
    },
    codex: {
      icon: '🟢',
      textCls: 'text-emerald-600 dark:text-emerald-400',
      barCls: 'bg-emerald-500',
      dotCls: 'bg-emerald-500',
      chipCls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300',
    },
  };

  function poolMeta(poolKey) {
    const k = POOL_STYLE[poolKey] ? poolKey : 'gemini';
    const names = typeof window.tHud === 'function' ? window.tHud('poolNames') : null;
    const label = (names && names[k]) || (k === '3p' ? 'Claude' : k === 'codex' ? 'Codex' : 'Gemini');
    return { key: k, label, ...POOL_STYLE[k] };
  }

  function fmtCompactTok(n) {
    const val = Number(n) || 0;
    if (val <= 0) return '0';
    if (val >= 1000000) return `${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
    return String(Math.round(val));
  }

  function fmtModelShort(id) {
    return String(id || '--')
      .replace(/-medium\b/i, '·med')
      .replace(/-xhigh\b/i, '·xhigh')
      .replace(/-high\b/i, '·high')
      .replace(/-low\b/i, '·low');
  }

  function extractByPoolMap(quotaUsage, fallbackPool = 'gemini') {
    if (!quotaUsage || typeof quotaUsage !== 'object') return null;
    if (quotaUsage.byPool && typeof quotaUsage.byPool === 'object') {
      return quotaUsage.byPool;
    }
    const f5 = quotaUsage.fiveHourUsedPct;
    const fw = quotaUsage.weeklyUsedPct;
    if (f5 === undefined && fw === undefined) return null;
    const pk = quotaUsage.source === 'codex_rollout' ? 'codex' : fallbackPool || 'gemini';
    return {
      [pk]: {
        fiveHourUsedPct: f5 ?? null,
        weeklyUsedPct: fw ?? null,
        weightedTokens: quotaUsage.weightedTokens || 0,
        isApproxConcurrent: Boolean(quotaUsage.isApproxConcurrent),
        isEstimated: Boolean(quotaUsage.isEstimated || quotaUsage.source === 'local_token_estimate'),
      },
    };
  }

  function renderQuotaChips(quotaUsage, opts = {}) {
    const isRunning = Boolean(opts.isRunning);
    const compact = Boolean(opts.compact);
    const byPool = extractByPoolMap(quotaUsage, opts.fallbackPool);
    const entries = byPool ? Object.entries(byPool) : [];

    if (entries.length === 0) {
      if (isRunning) {
        return `<span class="inline-flex items-center px-1.5 py-0.5 rounded border border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px] leading-tight mono font-medium" title="${escapeHtml(tHud('quotaWaitTip'))}">${escapeHtml(tHud('quotaPending'))}</span>`;
      }
      return `<span class="text-[10px] mono text-[var(--muted-foreground)]" title="${escapeHtml(tHud('quotaNoneTip'))}">${escapeHtml(tHud('quotaUnobserved'))}</span>`;
    }

    const rootEst = Boolean(quotaUsage?.isEstimated || quotaUsage?.source === 'local_token_estimate');
    const isFamilyGap = quotaUsage?.source === 'family_quota_gap';

    return `<div class="flex flex-wrap items-center gap-1">${entries
      .map(([pk, b]) => {
        const meta = poolMeta(pk);
        const u5 = b?.fiveHourUsedPct;
        const uw = b?.weeklyUsedPct;
        const isEst = Boolean(b?.isEstimated || rootEst);
        const approx = isEst || b?.isApproxConcurrent ? '~' : '';
        const wTokStr = b?.weightedTokens > 0 ? fmtCompactTok(b.weightedTokens) : '';
        const bothZero = (u5 === 0 || u5 === null || u5 === undefined) && (uw === 0 || uw === null || uw === undefined);
        const tip = isFamilyGap
          ? tHud(
              'familyQuotaChipTip',
              b?.actualDrop5hPct ?? 0,
              b?.localEst5hPct ?? 0,
              b?.actualDropWeeklyPct ?? 0,
              b?.localEstWeeklyPct ?? 0,
              b?.confidence || 'active_gap'
            )
          : isEst
            ? tHud('quotaEstimatedTip', wTokStr)
            : b?.isApproxConcurrent
              ? tHud('quotaConcurrentTip')
              : tHud('quotaRecordedTip');

        if (bothZero) {
          const text = compact
            ? `5h ${approx}${tHud('quotaBelowMin')}`
            : `5h ${approx}${tHud('quotaBelowMin')} · ${tHud('quotaWeek')} ${approx}${tHud('quotaBelowMin')}`;
          return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] leading-tight mono tabular-nums ${meta.chipCls}" title="${escapeHtml(`${meta.label}: ${tip}`)}"><span>${meta.icon}</span><span>${escapeHtml(text)}</span></span>`;
        }

        const parts = [];
        if (u5 !== null && u5 !== undefined) parts.push(`5h ${approx}-${u5}%`);
        if (uw !== null && uw !== undefined) parts.push(`${tHud('quotaWeek')} ${approx}-${uw}%`);
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] leading-tight mono font-semibold tabular-nums ${meta.chipCls}" title="${escapeHtml(`${meta.label}: ${tip}`)}"><span>${meta.icon}</span><span>${escapeHtml(parts.join(' · '))}</span></span>`;
      })
      .join('')}</div>`;
  }

  function renderModelBreakdown(byModel, opts = {}) {
    if (!Array.isArray(byModel) || byModel.length === 0) return '';
    const sumTok = byModel.reduce((acc, m) => acc + (m.totalTokens || 0), 0);
    const barSegments = byModel
      .map((m) => {
        const meta = poolMeta(m.quotaGroupKey);
        const pct = sumTok > 0 ? Math.max(2, (m.totalTokens / sumTok) * 100) : 100 / byModel.length;
        return `<div class="${meta.barCls} h-full" style="width:${pct.toFixed(1)}%" title="${escapeHtml(`${m.exactModelId || m.modelLabel}: ${fmtNum(m.totalTokens || 0)} tok`)}"></div>`;
      })
      .join('');

    const legendItems = byModel
      .map((m) => {
        const meta = poolMeta(m.quotaGroupKey);
        const sharePct = sumTok > 0 ? Math.round(((m.totalTokens || 0) / sumTok) * 100) : 0;
        const tip = `${m.modelLabel || m.exactModelId} (${m.exactModelId}) | ${meta.label} | ${tHud('thSteps')}: ${m.stepCount || 0} | ${tHud('tokIn')}:${fmtNum(m.inputTokens || 0)} / ${tHud('tokCache')}:${fmtNum(m.cacheReadTokens || 0)} / ${tHud('tokOut')}:${fmtNum(m.outputTokens || 0)}`;
        return `
          <span class="inline-flex items-center gap-1 text-[10px] leading-tight mono text-[var(--foreground)]" title="${escapeHtml(tip)}">
            <span class="w-1.5 h-1.5 rounded-full ${meta.dotCls} shrink-0"></span>
            <span class="font-semibold truncate max-w-[140px]">${escapeHtml(fmtModelShort(m.exactModelId || m.modelLabel))}</span>
            <span class="text-[var(--muted-foreground)]">${fmtCompactTok(m.totalTokens || 0)}${byModel.length > 1 && sumTok > 0 ? ` (${sharePct}%)` : ''}</span>
          </span>
        `;
      })
      .join('');

    return `
      <div class="space-y-1">
        ${opts.title ? `<div class="text-[10px] text-[var(--muted-foreground)] font-medium">${escapeHtml(opts.title)}</div>` : ''}
        <div class="w-full h-1.5 rounded-full overflow-hidden flex gap-px bg-[var(--background)] border border-[var(--hud-border)]">${barSegments}</div>
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">${legendItems}</div>
      </div>
    `;
  }

  function renderModelTable(byModel) {
    if (!Array.isArray(byModel) || byModel.length === 0) {
      return `<div class="text-[11px] text-[var(--muted-foreground)] py-1">${escapeHtml(tHud('noModelsRecorded'))}</div>`;
    }
    return `
      <div class="overflow-x-auto rounded-lg border border-[var(--hud-border)] bg-[var(--background)]/60">
        <table class="w-full text-left border-collapse text-[11px] mono tabular-nums">
          <thead class="text-[10px] text-[var(--muted-foreground)] border-b border-[var(--hud-border)] bg-[var(--hud-subtle)]">
            <tr>
              <th class="py-1 px-2 font-semibold">${escapeHtml(tHud('thModel'))}</th>
              <th class="py-1 px-2 font-semibold">${escapeHtml(tHud('thPool'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thSteps'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thIn'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thCacheRead'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thOutTotal'))}</th>
              <th class="py-1 px-2 font-semibold text-right">${escapeHtml(tHud('thTotalTok'))}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--hud-border)]">
            ${byModel
              .map((m) => {
                const meta = poolMeta(m.quotaGroupKey);
                return `
                  <tr>
                    <td class="py-1 px-2 font-semibold truncate max-w-[140px]" title="${escapeHtml(m.modelLabel || m.exactModelId)}">${escapeHtml(fmtModelShort(m.exactModelId || m.modelLabel))}</td>
                    <td class="py-1 px-2"><span class="${meta.textCls} font-semibold">${meta.icon} ${escapeHtml(meta.label)}</span></td>
                    <td class="py-1 px-2 text-right text-[var(--muted-foreground)]">${m.stepCount || 0}</td>
                    <td class="py-1 px-2 text-right">${fmtCompactTok(m.inputTokens)}</td>
                    <td class="py-1 px-2 text-right text-amber-600 dark:text-amber-400">${fmtCompactTok(m.cacheReadTokens)}</td>
                    <td class="py-1 px-2 text-right">${fmtCompactTok(m.outputTokens)}</td>
                    <td class="py-1 px-2 text-right font-bold text-indigo-600 dark:text-indigo-400">${fmtCompactTok(m.totalTokens)}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTotalsGrid(turnTotals, sessionTotals, extras = {}) {
    const tt = turnTotals || {};
    const st = sessionTotals || {};
    const turnTag = extras.turnLabel || tHud(extras.isCurrentRunning ? 'turnCur' : 'turnLast');

    const tIn = tt.inputTokens || 0;
    const tCache = tt.cacheReadTokens || 0;
    const tOut = tt.outputTokens || 0;
    const tTot = tt.totalTokens || 0;
    const tHit = tt.cacheHitRate ?? 0;

    const sIn = st.inputTokens || 0;
    const sCache = st.cacheReadTokens || 0;
    const sOut = st.outputTokens || 0;
    const sTot = st.totalTokens || 0;
    const sHit = st.cacheHitRate ?? 0;

    const curSpeedHtml =
      extras.streamingTps > 0
        ? `<span class="font-bold text-emerald-600 dark:text-emerald-400">${extras.streamingTps}</span> <span class="text-[10px] text-[var(--muted-foreground)]">tok/s</span>`
        : extras.effectiveTps > 0
          ? `<span class="text-[10px] text-[var(--muted-foreground)]">E2E</span> <span class="font-bold text-indigo-600 dark:text-indigo-400">${extras.effectiveTps}</span>`
          : `<span class="text-[var(--muted-foreground)]">--</span>`;
    const avgSpeedHtml =
      extras.avgStreamingTps > 0
        ? `<span class="text-[10px] text-[var(--muted-foreground)]">${escapeHtml(tHud('avgShort'))}</span> <span class="font-semibold text-[var(--foreground)]">${extras.avgStreamingTps}</span> <span class="text-[10px] text-[var(--muted-foreground)]">tok/s</span>`
        : `<span class="text-[var(--muted-foreground)]">--</span>`;

    const tTokTip = `${tHud('tokIn')}: ${fmtNum(tIn)} / ${tHud('tokCache')}: ${fmtNum(tCache)} / ${tHud('tokOut')}: ${fmtNum(tOut)} | ${fmtNum(tTot)}`;
    const sTokTip = `${tHud('tokIn')}: ${fmtNum(sIn)} / ${tHud('tokCache')}: ${fmtNum(sCache)} / ${tHud('tokOut')}: ${fmtNum(sOut)} | ${fmtNum(sTot)}`;

    return `
      <div class="grid grid-cols-[58px_1fr_1fr] sm:grid-cols-[68px_1fr_1fr] items-start gap-x-2.5 gap-y-1.5 text-[11px] leading-4 mono tabular-nums rounded-lg border border-[var(--hud-border)] bg-[var(--hud-subtle)] px-2.5 py-2">
        <div class="text-[10px] font-sans font-semibold text-[var(--muted-foreground)]"></div>
        <div class="text-[10px] font-sans font-bold text-sky-600 dark:text-sky-400">${escapeHtml(turnTag)}</div>
        <div class="text-[10px] font-sans font-bold text-[var(--foreground)]">${escapeHtml(tHud('gridTotal'))}</div>
        <div class="col-span-3 border-b border-[var(--hud-border)] -mt-0.5"></div>

        <div class="text-[10px] font-sans text-[var(--muted-foreground)] pt-0.5">${escapeHtml(tHud('rowTokens'))}</div>
        <div class="min-w-0" title="${escapeHtml(tTokTip)}">
          <div class="font-bold text-indigo-600 dark:text-indigo-400">${fmtCompactTok(tTot)}</div>
          <div class="text-[10px] text-[var(--muted-foreground)] truncate">${fmtCompactTok(tIn)}/${fmtCompactTok(tCache)}/${fmtCompactTok(tOut)}</div>
        </div>
        <div class="min-w-0" title="${escapeHtml(sTokTip)}">
          <div class="font-bold text-[var(--foreground)]">${fmtCompactTok(sTot)}</div>
          <div class="text-[10px] text-[var(--muted-foreground)] truncate">${fmtCompactTok(sIn)}/${fmtCompactTok(sCache)}/${fmtCompactTok(sOut)}</div>
        </div>

        <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowCacheHit'))}</div>
        <div class="min-w-0"><strong class="text-amber-600 dark:text-amber-400">${tHit}%</strong> <span class="text-[10px] text-[var(--muted-foreground)]">(${fmtCompactTok(tCache)})</span></div>
        <div class="min-w-0"><strong class="text-amber-600 dark:text-amber-400">${sHit}%</strong> <span class="text-[10px] text-[var(--muted-foreground)]">(${fmtCompactTok(sCache)})</span></div>

        <div class="text-[10px] font-sans text-[var(--muted-foreground)] pt-0.5">${escapeHtml(tHud('rowQuota'))}</div>
        <div class="min-w-0">${renderQuotaChips(tt.quotaUsage, { isRunning: extras.isCurrentRunning, compact: true })}</div>
        <div class="min-w-0">${renderQuotaChips(st.quotaUsage, { isRunning: extras.isRunning, compact: true })}</div>

        <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('rowSpeed'))}</div>
        <div class="min-w-0">${curSpeedHtml}</div>
        <div class="min-w-0">${avgSpeedHtml}</div>
      </div>
    `;
  }

  function turnTotalsFallback(tr) {
    if (!tr) return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitRate: 0, byModel: [], quotaUsage: null };
    return {
      inputTokens: tr.inputTokens || 0,
      cacheReadTokens: tr.cacheReadTokens || 0,
      outputTokens: tr.outputTokens || 0,
      totalTokens: tr.totalTokens || 0,
      cacheHitRate: tr.cacheHitRate || 0,
      byModel: Array.isArray(tr.byModel) ? tr.byModel : [],
      quotaUsage: tr.quotaUsage || null,
    };
  }

  function formatCompactQuotaPoolTip(pk, b, rootEst, scopeLabel = '') {
    const meta = poolMeta(pk);
    const u5 = b?.fiveHourUsedPct;
    const uw = b?.weeklyUsedPct;
    const approx = Boolean(b?.isEstimated || rootEst || b?.isApproxConcurrent) ? '~' : '';
    const wTokStr = b?.weightedTokens > 0 ? ` · ${fmtCompactTok(b.weightedTokens)} wTok` : '';
    const f5Text =
      u5 === null || u5 === undefined || u5 === 0
        ? `${approx}${tHud('quotaBelowMin')}`
        : `${approx}-${u5}%`;
    const fwText =
      uw === null || uw === undefined || uw === 0
        ? `${approx}${tHud('quotaBelowMin')}`
        : `${approx}-${uw}%`;
    const prefix = scopeLabel ? `${scopeLabel} · ` : '';
    return {
      meta,
      f5Text,
      tip: `${prefix}${meta.label}: 5h ${f5Text} · ${tHud('quotaWeek')} ${fwText}${wTokStr}`,
    };
  }

  function renderCompactQuotaInline(quotaUsage, opts = {}) {
    const byPool = extractByPoolMap(quotaUsage, opts.fallbackPool);
    const entries = byPool ? Object.entries(byPool) : [];
    if (entries.length === 0) {
      return opts.isRunning
        ? `<span class="text-sky-600 dark:text-sky-400" title="${escapeHtml(tHud('quotaWaitTip'))}">…</span>`
        : `<span class="text-[var(--muted-foreground)]" title="${escapeHtml(tHud('quotaNoneTip'))}">--</span>`;
    }
    const rootEst = Boolean(quotaUsage?.isEstimated || quotaUsage?.source === 'local_token_estimate');
    const scopeLabel = opts.scopeLabel || '';
    return entries
      .map(([pk, b]) => {
        const { meta, f5Text, tip } = formatCompactQuotaPoolTip(pk, b, rootEst, scopeLabel);
        return `<span class="${meta.textCls} font-semibold whitespace-nowrap" title="${escapeHtml(tip)}">${meta.icon}${escapeHtml(f5Text)}</span>`;
      })
      .join(' ');
  }

  function renderCompactKpiStrip(turnTotals, sessionTotals, extras = {}) {
    const tt = turnTotals || {};
    const st = sessionTotals || {};
    const useSession =
      (st.totalTokens || 0) > 0 ||
      Boolean(st.quotaUsage) ||
      (Array.isArray(st.byModel) && st.byModel.length > 0);
    const cum = useSession ? st : tt;

    const sIn = cum.inputTokens || 0;
    const sCache = cum.cacheReadTokens || 0;
    const sOut = cum.outputTokens || 0;
    const sTot = cum.totalTokens || 0;
    const sHit = cum.cacheHitRate ?? 0;
    const sPrompt = sIn + sCache;

    const turnTag = tHud(extras.isCurrentRunning ? 'turnCur' : 'turnLast');
    const tokTip = tHud('cardTokTip', fmtNum(sTot), fmtNum(sIn), fmtNum(sCache), fmtNum(sOut));
    const cacheTip = tHud('cardCacheTip', sHit, fmtNum(sCache), fmtNum(sPrompt));

    const avgStream = extras.avgStreamingTps || 0;
    const avgEff = extras.avgEffectiveTps || 0;
    const curStream = extras.streamingTps || 0;
    const curEff = extras.effectiveTps || 0;
    const speedMain =
      avgStream > 0
        ? `<strong class="text-emerald-600 dark:text-emerald-400">${avgStream}</strong><span class="text-[10px] text-[var(--muted-foreground)]">/s</span>`
        : avgEff > 0
          ? `<strong class="text-indigo-600 dark:text-indigo-400">${avgEff}</strong><span class="text-[10px] text-[var(--muted-foreground)]">/s</span>`
          : curStream > 0
            ? `<strong class="text-emerald-600 dark:text-emerald-400">${curStream}</strong><span class="text-[10px] text-[var(--muted-foreground)]">/s</span>`
            : curEff > 0
              ? `<strong class="text-indigo-600 dark:text-indigo-400">${curEff}</strong><span class="text-[10px] text-[var(--muted-foreground)]">/s</span>`
              : `<span class="text-[var(--muted-foreground)]">--</span>`;
    const speedTip = tHud('cardSpeedTip', avgStream || curStream, avgEff || curEff, turnTag, curStream);

    const quotaScope = tHud('sessionTotal');
    const byPool = extractByPoolMap(cum.quotaUsage);
    const rootEst = Boolean(cum.quotaUsage?.isEstimated || cum.quotaUsage?.source === 'local_token_estimate');
    const quotaCellTip = byPool && Object.keys(byPool).length > 0
      ? Object.entries(byPool)
          .map(([pk, b]) => formatCompactQuotaPoolTip(pk, b, rootEst, quotaScope).tip)
          .join(' | ')
      : extras.isRunning
        ? tHud('quotaWaitTip')
        : tHud('quotaNoneTip');

    return `
      <div class="task-kpi-strip mono tnum text-[11px] leading-tight">
        <div class="min-w-0" title="${escapeHtml(tokTip)}">
          <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('cardTokens'))}</div>
          <div class="truncate"><strong class="text-indigo-600 dark:text-indigo-400">${fmtCompactTok(sTot)}</strong></div>
        </div>
        <div class="min-w-0" title="${escapeHtml(cacheTip)}">
          <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('cardCacheHit'))}</div>
          <div class="truncate"><strong class="text-amber-600 dark:text-amber-400">${sHit}%</strong> <span class="text-[10px] text-[var(--muted-foreground)]">${fmtCompactTok(sCache)}</span></div>
        </div>
        <div class="min-w-0" title="${escapeHtml(speedTip)}">
          <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('cardSpeed'))}</div>
          <div class="truncate">${speedMain}</div>
        </div>
        <div class="min-w-0" title="${escapeHtml(quotaCellTip)}">
          <div class="text-[10px] font-sans text-[var(--muted-foreground)]">${escapeHtml(tHud('cardQuota'))}</div>
          <div class="truncate flex items-center gap-1">${renderCompactQuotaInline(cum.quotaUsage, { isRunning: extras.isRunning, scopeLabel: quotaScope })}</div>
        </div>
      </div>
    `;
  }

  function renderCompactModelInline(byModel) {
    if (!Array.isArray(byModel) || byModel.length === 0) return '';
    const primary = byModel[0];
    const meta = poolMeta(primary.quotaGroupKey);
    const sumTok = byModel.reduce((acc, m) => acc + (m.totalTokens || 0), 0);
    const tip = byModel
      .map((m) => `${m.exactModelId || m.modelLabel}: ${fmtCompactTok(m.totalTokens || 0)} (${m.stepCount || 0} steps)`)
      .join(' · ');

    const multiBar =
      byModel.length > 1
        ? `<span class="inline-flex w-8 h-1.5 rounded-full overflow-hidden gap-px bg-[var(--hud-subtle)] shrink-0">${byModel
            .map((m) => {
              const pm = poolMeta(m.quotaGroupKey);
              const pct = sumTok > 0 ? Math.max(8, (m.totalTokens / sumTok) * 100) : 100 / byModel.length;
              return `<span class="${pm.barCls} h-full" style="width:${pct.toFixed(0)}%"></span>`;
            })
            .join('')}</span>`
        : '';

    return `
      <span class="inline-flex items-center gap-1 text-[11px] mono text-[var(--muted-foreground)] min-w-0" title="${escapeHtml(tip)}">
        <span class="w-1.5 h-1.5 rounded-full ${meta.dotCls} shrink-0"></span>
        ${multiBar}
        <span class="font-medium text-[var(--foreground)] truncate max-w-[140px]">${escapeHtml(fmtModelShort(primary.exactModelId || primary.modelLabel))}</span>
        ${byModel.length > 1 ? `<span class="text-[10px] opacity-75">+${byModel.length - 1}</span>` : ''}
      </span>
    `;
  }

  window.HudMetrics = {
    poolMeta,
    fmtCompactTok,
    fmtModelShort,
    renderQuotaChips,
    renderCompactQuotaInline,
    renderCompactKpiStrip,
    renderCompactModelInline,
    renderModelBreakdown,
    renderModelTable,
    renderTotalsGrid,
    turnTotalsFallback,
  };
})();
