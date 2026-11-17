(function () {
  const STORAGE_KEY = 'agy_telemetry_lang';

  function detectSystemLang() {
    try {
      const langs = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language || ''];
      const primary = String(langs[0] || '').toLowerCase();
      if (primary.startsWith('zh')) return 'zh';
      if (primary) return 'en';
    } catch {}
    return 'zh';
  }

  let currentLang = (() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch {}
    return detectSystemLang();
  })();

  const DICT = {
    zh: {
      appTitle: '并行任务监控台',
      ready: '前台就绪',
      activeInference: (n) => `⚡ ${n} 活跃推理`,
      codexRunningBadge: (n) => `🟢 ${n} Codex 执行中`,
      codexSessionsBadge: (n) => `🟢 ${n} Codex 会话`,
      bgRunningBadge: (n) => `⚙️ ${n} 后台任务运行中`,
      tabRecent: '最近活跃',
      tabRecentTip: '展示进行中任务及今日未归档的近期对话，进行中的默认置顶',
      tabCodex: '🟢 Codex',
      tabAll: '全部',
      btnSig: '签名头',
      btnRefresh: '刷新',
      btnLangLabel: 'EN',
      btnLangTip: 'Switch UI language to English',
      kpiRuntime: '运行态',
      kpiRuntimeBracket: '(前台 / 后台)',
      kpiTasksActiveCodex: (r, c, b) => `${r} 活跃 (${c} Codex) / ${b} 后台`,
      kpiTasksFgBg: (r, b) => `${r} 前台 / ${b} 后台`,
      kpiTasksSubCodex: (c) => `含 ${c} 个 Codex 任务正在实时推进`,
      kpiTasksSubBg: (b) => `含 ${b} 个正在执行的后台任务`,
      kpiTasksSubTotal: (tot, c) => `共追踪 ${tot} 个会话 (含 ${c} 个 Codex)`,
      kpiSpeed: '实时速度',
      kpiSpeedSubLive: (tps) => `实时并发合流 ${tps} tok/s`,
      kpiSpeedSubAvg: '近期平均流式吐字',
      kpiCtxTitle: '最高上下文大小',
      kpiCtxSub: (w) => `来源对话: ${w}`,
      quota5hTitle: '5小时配额',
      quota7dTitle: '周窗口配额',
      quotaLoading: '正在读取配额池...',
      quotaResetSoon: '即将刷新',
      quotaResetLeft: (cd) => `剩 ${cd}`,
      quotaResetUnknown: '刷新时间: --',
      scanning: '正在扫描活跃任务与后台进程...',
      emptyRecentTitle: '当前暂无进行中任务或今日未归档对话',
      emptyRecentSub: '可切换至「全部」或「Codex」查看更早的历史会话记录',
      emptyCodexBtn: (n) => `🟢 查看 Codex 任务 (${n})`,
      emptyAllBtn: (n) => `查看全部近期会话 (${n}) →`,
      turnCur: '本轮',
      turnLast: '末轮',
      detailsBtn: (n) => `详情 (${n}) ▾`,
      collapseBtn: '收起 ▴',
      jumpAgy: '跳转 ↗',
      jumpCodex: 'Codex ↗',
      jumpAgyTip: '在 Antigravity 中切换到此对话',
      jumpCodexTip: '在 Codex Desktop 客户端中直接打开此会话',
      stopBgMulti: (n) => `停止后台 (${n})`,
      stopBgSingle: (id) => `停止 ${id}`,
      bgDaemon: '🌐 常驻服务',
      bgCmd: '⚙️ 后台命令',
      bgLogOpen: '收起日志',
      bgLogClosed: '📄 日志',
      bgCmdCopy: '📋 命令',
      bgStop: '🛑 停止',
      bgLatestOut: '↳ 最新输出:',
      bgRefreshLog: '↻ 刷新日志',
      streamLabel: '流式',
      e2eLabel: 'E2E',
      avgShort: '均',
      peakShort: '峰',
      cacheLabel: '缓存',
      totalShort: '累计',
      ctxLabel: '上下文大小',
      ctxShort: '上下文',
      tokLabel: 'Token',
      tokIn: '入',
      tokCache: '缓',
      tokOut: '出',
      tokShare: '占',
      quotaLabel: '配额',
      quotaWeek: '周',
      quotaSyncing: '同步中…',
      quotaEmpty: '5h -- · 周 --',
      quotaRecordedTip: '本轮任务期间实测配额消耗',
      quotaConcurrentTip: '同配额池多任务并发，按 Token 权重近似分摊 (~)',
      quotaWaitTip: '已纳入实时配额监控，等待上游配额数值刷新',
      quotaNoneTip: '未记录到此轮运行期间的配额快照（历史轮次或插件未监听期间）',
      sigTip: (hex, sid) => `Thinking 签名协议前缀: 0x${hex} · Session: ${sid}`,
      speedTip: '当前/末轮任务流式吐字速度 vs 会话全局平均',
      cacheTip: '当前/末轮任务缓存命中率与实际读取大小(k) vs 会话全局平均',
      bgPillCount: (n) => `⚙️ ${n} 后台`,
      detailLoading: (title) => `正在加载「${title}」的轮次任务与诊断详情...`,
      detailTitle: (tag) => `${tag}任务 & 会话详情`,
      cfgModel: '配置',
      respModel: '返回',
      execModel: '执行器',
      poolLabel: '所属池',
      sessionTotal: '会话累计',
      kpiTurnSpeed: (tag) => `${tag}流式速度`,
      kpiTurnCache: (tag) => `${tag}缓存命中`,
      kpiTurnE2e: (tag) => `${tag}端到端 E2E`,
      kpiTurnTokDur: (tag) => `${tag}Token / 耗时`,
      sessionAvgPrefix: '会话均',
      outPrefix: '输出',
      durPrefix: '耗时',
      diagHeader: '🛡 路由与诊断',
      diagHealthy: '✓ 无异常重试',
      diagNoSig: '无签名头',
      diagProvider: '通道',
      diagMatch: '路由一致',
      diagMismatch: '路由偏离',
      diagCot: '思占比',
      diagLastStep: '末步',
      diagRetry: '重试',
      doneBgPrefix: '已完成后台',
      historyTitle: '📜 历史任务列表（按轮次保存 · 点击单轮可展开 LLM 调用）',
      historyCount: (n, tok) => `共 ${n} 轮 · 累计 ${tok} tok`,
      historyEmpty: '暂无轮次任务记录',
      statusRunning: '进行中',
      statusDone: '✓ 完成',
      statusAborted: '已中止',
      stepsUnit: (n) => `${n}步`,
      cacheRatioLabel: '缓存比例',
      subStepEmpty: '本轮暂无底层 LLM 调用记录',
      thModel: '模型',
      thSpeed: '流式',
      thCache: '缓存',
      thTtft: 'TTFT/流',
      thOut: '输出(思/答)',
      thDiag: '诊断',
      buffered: '缓冲',
      bufferedTip: (sec) => `缓冲刷出 (${sec}s)`,
      agoJust: '刚刚',
      turnTitleFallback: (n) => `轮次 #${n}`,
      turnSparkNoSpeedTip: (n, tok, cache) => `轮次 #${n} | 总Token: ${tok} | 缓存: ${cache}%`,
      turnSparkTip: (n, tps, cache, tok) => `轮次 #${n} | 流式: ${tps} tok/s | 缓存: ${cache}% | 总Token: ${tok}`,
      turnCacheTip: (hit, cacheK, share) => `本轮提示词缓存命中率 ${hit}% · 缓存读取 ${cacheK} · 占本轮总Token ${share}%`,
      turnCtxTip: '本轮末步上下文大小 / 上限',
      turnTokTip: (inTok, cacheK, share, hit, outTok, thinkTok, respTok) =>
        `未命中输入 ${inTok} + 缓存读取 ${cacheK} (占总Token ${share}%, 命中率 ${hit}%) + 输出 ${outTok} (思${thinkTok}/答${respTok})`,
      stepMismatch: '路由偏离',
      stepRateLimit: (n) => `限流${n}x`,
      stepNetRetry: (n) => `重连${n}x`,
      stepHighLat: '高延迟',
      stepLowCot: '少思',
      stepCacheShock: '破缓',
      codexDoneSummary: (turn, steps, cmds, files) => `✅ 第 ${turn} 轮已完成 · ${steps} 步 (${cmds} 命令 / ${files} 改文件)`,
      codexSynergyDone: (m) => `✅ Codex 协同已完成 (${m})`,
      codexSynergyRun: (m) => `🟢 Codex 协同运行中 (${m})`,
      codexProgressRun: '🟢 Codex 实时工作进度',
      codexProgressDone: '✅ Codex 回合已完成',
      codexTurnBadge: (turn, isRun, steps, cmds, files) => `第 ${turn} 轮 · ${isRun ? '已执行' : '共执行'} ${steps} 步 (${cmds} 命令 / ${files} 改文件)`,
      codexTraceBtn: (n) => `📜 过程 (${n})`,
      codexTraceFullBtn: (n) => `📜 过程明细 (${n})`,
      codexTraceHide: '收起过程 ▴',
      codexCommentRun: '💬 最新进展:',
      codexCommentDone: '💬 完成总结:',
      fpAlertTitle: (n) => `⚠️ 检测到 ${n} 个模型 Thinking 签名协议头变化（同系共用，仅提示协议/密钥切换）`,
      fpAckAll: '✓ 确认变更并更新基线',
      fpAckDone: '已确认',
      fpDrawerTitle: '🔑 本地 Thinking 签名协议头档案 (同系共用，仅监测签名版本/格式变化)',
      fpClose: '收起',
      fpEmpty: '暂未采集到 Thinking 签名记录',
      fpChanged: '⚠️ 已变更',
      fpMatched: '✓ 基线一致',
      stateMap: {
        IDLE: '空闲就绪',
        THINKING: '推理思考中',
        TOOL_RUNNING: '工具执行中',
        RUNNING: '模型生成中',
        BG_RUNNING: '后台任务中',
      },
      diagMap: {
        HEALTHY: '✓ 正常',
        FP_CHANGED: '🔑 签名头变化',
        DEGRADE: '🚨 路由不一致',
        THROTTLE: '⚠️ 限流重试',
        CACHE_SHOCK: '⚠️ 缓存击穿',
        COT_LOW: '⚠️ 思考偏低',
        SLOW_TPS: '吐字偏慢',
        QUEUE: '首字高延迟',
        NET_RETRY: '网络重连',
        THROTTLE_HIST: '历史限流',
        NET_HIST: '历史重连',
      },
    },
    en: {
      appTitle: 'Fleet Telemetry HUD',
      ready: 'Ready',
      activeInference: (n) => `⚡ ${n} Active`,
      codexRunningBadge: (n) => `🟢 ${n} Codex Running`,
      codexSessionsBadge: (n) => `🟢 ${n} Codex`,
      bgRunningBadge: (n) => `⚙️ ${n} BG Running`,
      tabRecent: 'Recent',
      tabRecentTip: 'Shows in-progress tasks & today\'s unarchived conversations (running pinned first)',
      tabCodex: '🟢 Codex',
      tabAll: 'All',
      btnSig: 'Sig Keys',
      btnRefresh: 'Refresh',
      btnLangLabel: '中文',
      btnLangTip: '切换界面语言为简体中文',
      kpiRuntime: 'Runtime',
      kpiRuntimeBracket: '(FG / BG)',
      kpiTasksActiveCodex: (r, c, b) => `${r} Active (${c} Codex) / ${b} BG`,
      kpiTasksFgBg: (r, b) => `${r} FG / ${b} BG`,
      kpiTasksSubCodex: (c) => `${c} Codex task(s) actively executing`,
      kpiTasksSubBg: (b) => `${b} background task(s) running`,
      kpiTasksSubTotal: (tot, c) => `Tracking ${tot} sessions (${c} Codex)`,
      kpiSpeed: 'Gen Speed',
      kpiSpeedSubLive: (tps) => `Live aggregate ${tps} tok/s`,
      kpiSpeedSubAvg: 'Recent avg streaming TPS',
      kpiCtxTitle: 'Peak Context Size',
      kpiCtxSub: (w) => `Source: ${w}`,
      quota5hTitle: '5-Hour Quota',
      quota7dTitle: 'Weekly Quota',
      quotaLoading: 'Loading quota pools...',
      quotaResetSoon: 'Resetting',
      quotaResetLeft: (cd) => `${cd} left`,
      quotaResetUnknown: 'Reset: --',
      scanning: 'Scanning active tasks and background processes...',
      emptyRecentTitle: 'No in-progress tasks or unarchived conversations today',
      emptyRecentSub: 'Switch to "All" or "Codex" to inspect earlier sessions',
      emptyCodexBtn: (n) => `🟢 View Codex Tasks (${n})`,
      emptyAllBtn: (n) => `View All Recent Sessions (${n}) →`,
      turnCur: 'Turn',
      turnLast: 'Last',
      detailsBtn: (n) => `Details (${n}) ▾`,
      collapseBtn: 'Hide ▴',
      jumpAgy: 'Open ↗',
      jumpCodex: 'Codex ↗',
      jumpAgyTip: 'Switch to this conversation in Antigravity',
      jumpCodexTip: 'Open this thread in Codex Desktop',
      stopBgMulti: (n) => `Stop BG (${n})`,
      stopBgSingle: (id) => `Stop ${id}`,
      bgDaemon: '🌐 Daemon',
      bgCmd: '⚙️ BG Cmd',
      bgLogOpen: 'Hide Logs',
      bgLogClosed: '📄 Logs',
      bgCmdCopy: '📋 Cmd',
      bgStop: '🛑 Stop',
      bgLatestOut: '↳ Output:',
      bgRefreshLog: '↻ Refresh',
      streamLabel: 'Stream',
      e2eLabel: 'E2E',
      avgShort: 'Avg',
      peakShort: 'Peak',
      cacheLabel: 'Cache',
      totalShort: 'Total',
      ctxLabel: 'Context',
      ctxShort: 'Ctx',
      tokLabel: 'Tokens',
      tokIn: 'In',
      tokCache: 'Cache',
      tokOut: 'Out',
      tokShare: 'share',
      quotaLabel: 'Quota',
      quotaWeek: '7d',
      quotaSyncing: 'Syncing…',
      quotaEmpty: '5h -- · 7d --',
      quotaRecordedTip: 'Measured quota drop during this turn',
      quotaConcurrentTip: 'Concurrent pool activity; apportioned by token delta (~)',
      quotaWaitTip: 'Tracking live snapshots; waiting for upstream quota update',
      quotaNoneTip: 'No quota snapshot captured for this historical turn',
      sigTip: (hex, sid) => `Thinking sig prefix: 0x${hex} · Session: ${sid}`,
      speedTip: 'Current/last turn streaming TPS vs session avg',
      cacheTip: 'Current/last turn cache hit rate & size (k) vs session avg',
      bgPillCount: (n) => `⚙️ ${n} BG`,
      detailLoading: (title) => `Loading turn history & diagnostics for "${title}"...`,
      detailTitle: (tag) => `${tag} & Session Details`,
      cfgModel: 'Config',
      respModel: 'Resp',
      execModel: 'Exec',
      poolLabel: 'Pool',
      sessionTotal: 'Session Total',
      kpiTurnSpeed: (tag) => `${tag} Stream TPS`,
      kpiTurnCache: (tag) => `${tag} Cache Hit`,
      kpiTurnE2e: (tag) => `${tag} E2E TPS`,
      kpiTurnTokDur: (tag) => `${tag} Tokens / Dur`,
      sessionAvgPrefix: 'Avg',
      outPrefix: 'Out',
      durPrefix: 'Dur',
      diagHeader: '🛡 Routing & Diagnostics',
      diagHealthy: '✓ Healthy',
      diagNoSig: 'No sig',
      diagProvider: 'Provider',
      diagMatch: 'Matched',
      diagMismatch: 'Mismatch',
      diagCot: 'CoT',
      diagLastStep: 'Step',
      diagRetry: 'Retries',
      doneBgPrefix: 'Finished BG',
      historyTitle: '📜 Turn Task History (Persisted per turn · Click to expand LLM calls)',
      historyCount: (n, tok) => `${n} turns · Total ${tok} tok`,
      historyEmpty: 'No turn records yet',
      statusRunning: 'Running',
      statusDone: '✓ Done',
      statusAborted: 'Aborted',
      stepsUnit: (n) => `${n} steps`,
      cacheRatioLabel: 'Cache Hit',
      subStepEmpty: 'No LLM invocations recorded for this turn yet',
      thModel: 'Model',
      thSpeed: 'TPS',
      thCache: 'Cache',
      thTtft: 'TTFT/Gen',
      thOut: 'Out(CoT/Ans)',
      thDiag: 'Diag',
      buffered: 'Buf',
      bufferedTip: (sec) => `Buffered flush (${sec}s)`,
      agoJust: 'Just now',
      turnTitleFallback: (n) => `Turn #${n}`,
      turnSparkNoSpeedTip: (n, tok, cache) => `Turn #${n} | Tokens: ${tok} | Cache: ${cache}%`,
      turnSparkTip: (n, tps, cache, tok) => `Turn #${n} | Stream: ${tps} tok/s | Cache: ${cache}% | Tokens: ${tok}`,
      turnCacheTip: (hit, cacheK, share) => `Turn prompt cache hit ${hit}% · Read ${cacheK} · ${share}% of turn tokens`,
      turnCtxTip: 'Last step context size / limit in this turn',
      turnTokTip: (inTok, cacheK, share, hit, outTok, thinkTok, respTok) =>
        `Uncached in ${inTok} + Cache read ${cacheK} (${share}% of turn, ${hit}% hit) + Out ${outTok} (CoT ${thinkTok}/Ans ${respTok})`,
      stepMismatch: 'Mismatch',
      stepRateLimit: (n) => `429×${n}`,
      stepNetRetry: (n) => `Retry×${n}`,
      stepHighLat: 'HighTTFT',
      stepLowCot: 'LowCoT',
      stepCacheShock: 'CacheMiss',
      codexDoneSummary: (turn, steps, cmds, files) => `✅ Turn ${turn} Done · ${steps} steps (${cmds} cmds / ${files} files)`,
      codexSynergyDone: (m) => `✅ Codex Synergy Done (${m})`,
      codexSynergyRun: (m) => `🟢 Codex Synergy Active (${m})`,
      codexProgressRun: '🟢 Codex Live Progress',
      codexProgressDone: '✅ Codex Turn Completed',
      codexTurnBadge: (turn, isRun, steps, cmds, files) => `Turn ${turn} · ${steps} steps (${cmds} cmds / ${files} files)`,
      codexTraceBtn: (n) => `📜 Trace (${n})`,
      codexTraceFullBtn: (n) => `📜 Timeline (${n})`,
      codexTraceHide: 'Hide Trace ▴',
      codexCommentRun: '💬 Latest:',
      codexCommentDone: '💬 Summary:',
      fpAlertTitle: (n) => `⚠️ ${n} model Thinking signature header change(s) detected`,
      fpAckAll: '✓ Ack & Update Baseline',
      fpAckDone: 'Acked',
      fpDrawerTitle: '🔑 Thinking Signature Protocol Headers (Shared per family)',
      fpClose: 'Hide',
      fpEmpty: 'No Thinking signature headers captured yet',
      fpChanged: '⚠️ Changed',
      fpMatched: '✓ Baseline OK',
      stateMap: {
        IDLE: 'Idle',
        THINKING: 'Thinking',
        TOOL_RUNNING: 'Tool Running',
        RUNNING: 'Generating',
        BG_RUNNING: 'BG Running',
      },
      diagMap: {
        HEALTHY: '✓ OK',
        FP_CHANGED: '🔑 Sig Changed',
        DEGRADE: '🚨 Route Mismatch',
        THROTTLE: '⚠️ Throttled',
        CACHE_SHOCK: '⚠️ Cache Shock',
        COT_LOW: '⚠️ Low CoT',
        SLOW_TPS: 'Slow TPS',
        QUEUE: 'High TTFT',
        NET_RETRY: 'Net Retry',
        THROTTLE_HIST: 'Past 429',
        NET_HIST: 'Past EOF',
      },
    },
  };

  window.getHudLang = () => currentLang;
  window.tHud = (key, ...args) => {
    const val = DICT[currentLang]?.[key] ?? DICT.zh[key];
    return typeof val === 'function' ? val(...args) : (val ?? key);
  };
  window.trStateLabel = (stateCode, fallbackLabel, runningBgCount) => {
    if (currentLang === 'zh') return fallbackLabel || DICT.zh.stateMap[stateCode] || stateCode;
    if (stateCode === 'BG_RUNNING' && runningBgCount > 1) return `BG (${runningBgCount})`;
    return DICT.en.stateMap[stateCode] || fallbackLabel || stateCode;
  };
  window.trDiagLabel = (diag) => {
    if (!diag) return window.tHud('diagMap').HEALTHY;
    if (currentLang === 'zh') return diag.label || DICT.zh.diagMap.HEALTHY;
    return DICT.en.diagMap[diag.code] || diag.label || DICT.en.diagMap.HEALTHY;
  };

  window.applyStaticI18n = function () {
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set('hudTitleText', window.tHud('appTitle'));
    set('filterRunLabel', window.tHud('tabRecent'));
    const filterRunBtn = document.getElementById('filterRunBtn');
    if (filterRunBtn) filterRunBtn.title = window.tHud('tabRecentTip');
    set('filterCodexLabel', window.tHud('tabCodex'));
    set('filterAllLabel', window.tHud('tabAll'));
    set('fpLedgerBtnLabelBase', window.tHud('btnSig'));
    set('refreshBtnLabel', window.tHud('btnRefresh'));
    set('langToggleLabel', window.tHud('btnLangLabel'));
    const langBtn = document.getElementById('langToggleBtn');
    if (langBtn) langBtn.title = window.tHud('btnLangTip');
    set('kpiRuntimeLabel', window.tHud('kpiRuntime'));
    set('kpiRuntimeSubBracket', window.tHud('kpiRuntimeBracket'));
    set('kpiSpeedLabel', window.tHud('kpiSpeed'));
    set('kpiMaxCtxLabel', window.tHud('kpiCtxTitle'));
    set('quota5hLabel', window.tHud('quota5hTitle'));
    set('quota7dLabel', window.tHud('quota7dTitle'));
  };

  window.toggleHudLang = function () {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    try {
      localStorage.setItem(STORAGE_KEY, currentLang);
    } catch {}
    window.applyStaticI18n();
    if (window.lastPayload) {
      if (typeof window.renderFingerprintLedger === 'function') window.renderFingerprintLedger(window.lastPayload);
      if (typeof window.renderFleet === 'function') window.renderFleet(window.lastPayload);
    }
  };
})();
