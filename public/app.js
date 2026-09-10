/*!
 * 心屿 · 大学生情绪陪伴助手 —— 前端交互逻辑（public/app.js）
 *
 * 纯原生 JavaScript（ES2020+），无任何第三方依赖 / CDN 引入。
 * 职责：
 *   1) 浏览器本地多会话（localStorage）
 *   2) POST /api/chat/stream 的 SSE 手动解析（fetch + ReadableStream，EventSource 不支持 POST）
 *   3) 流中断时自动降级到非流式 POST /api/chat
 *   4) 安全的轻量 Markdown 渲染（先整体转义，再套用白名单子集）
 *   5) 侧边栏 / 主题 / 关于弹窗 / 建议问题 / 滚动 / Toast / 健康检查
 *
 * 设计约束：所有网络与解析异常都必须被捕获；任何失败都不能让界面卡在“正在回复…”。
 */
(function () {
  'use strict';

  /* ============================================================
   * 一、常量与文案
   * ============================================================ */

  const LS_KEYS = {
    sessions: 'psych.sessions.v1',
    activeId: 'psych.activeId',
    theme: 'psych.theme',
    debug: 'psych.debug.v1',
    setup: 'psych.setup.v1',
  };

  const DEFAULT_TITLE = '新的对话';
  const TITLE_MAX = 16;

  // 策略 / 风险英文 key -> 中文标签（未知则原样显示）
  const STRATEGY_LABELS = {
    S0_crisis: '危机安全',
    S1_listen: '陪伴性倾听',
    S2_empathy: '共情反映',
    S3_clarify: '澄清提问',
    S4_normalize: '正常化与轻量科普',
    S5_action: '协作式小行动',
    S6_referral: '资源转介',
    // 旧版 key 兼容
    low_pressure: '低压力陪伴',
    empathy: '共情',
    clarify: '温和澄清',
    problem_solving: '一起想办法',
    safety_first: '安全优先',
    error_fallback: '备用回复',
  };
  const RISK_LABELS = {
    L0: '常规',
    L1: '关注',
    L2: '需留意',
    L3: '高风险',
    // 旧版 key 兼容
    normal: '正常',
    watch: '关注',
    elevated: '留意',
    high_direct: '高风险',
    unknown: '未知',
  };

  // 设置面板里的模型选项（与后端白名单一致的常用两项）
  const MODEL_OPTIONS = [
    { value: 'deepseek-flash', label: 'deepseek-flash（推荐，便宜快）' },
    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更稳，稍贵）' },
  ];

  // 记忆分类兜底（接口返回 categories 时优先用接口的）
  const MEMORY_CATEGORIES = [
    ['profile', '基本情况'], ['stressor', '压力来源'], ['preference', '偏好'],
    ['relationship', '人际关系'], ['goal', '目标'], ['state', '近期状态'], ['other', '其它'],
  ];

  // 自检失败码 -> 中文说明（接口 message 优先）
  const ERROR_CODE_TEXT = {
    no_key: '还没有填写 API Key',
    model_auth: 'API Key 无效或已失效',
    model_balance: '账户余额不足，请先充值',
    model_rate_limit: '请求太频繁，稍后再试',
    model_timeout: '模型响应超时',
    model_network: '网络连接不太顺畅',
  };

  // 拟人化节奏（毫秒）
  const THINK_MIN_MS = 500;
  const THINK_MAX_MS = 1200;
  const FIRST_TOKEN_MS = 900;
  const PART_GAP_MIN = 350;
  const PART_GAP_MAX = 800;
  const PART_LIMIT = 60; // 每个气泡的大致字数上限

  const LOCAL_FALLBACK = '我现在这边有点没接上，但你的话我已经听到了。可以点“重试”再试一次；如果想继续，也可以先慢慢说说现在最想聊的那件事。';
  const ERROR_FALLBACK = '这条回复没有顺利说完，你可以点“重试”再来一次。我还在。';
  const ABORT_TEXT = '（已停止生成，可点“重试”继续）';
  const COPY_OK_TEXT = '已复制这条回复';
  const COPY_FAIL_TEXT = '复制失败，请手动选中文字复制';
  const FALLBACK_TOAST = '连接不太顺畅，已改用备用方式回复';
  const NET_FAIL_TOAST = '网络似乎断开了，稍后再试试';
  const GENERATING_TOAST = '上一条还在回复中，请稍候';
  const ERROR_TOAST = '生成回复时出了点小状况，我先在这儿陪你';
  const WAIT_TEXT = '正在想怎么接你的话…';
  const NET_TIMEOUT_TOAST = '连接超时了，稍后再试试';
  const CONFIG_SAVED_TOAST = '设置已保存';
  const MEMORY_SAVED_TOAST = '已添加一条记忆';
  const STORAGE_FAIL_TOAST = '本机记录保存失败，聊天仍可继续';
  const STORAGE_CORRUPT_TOAST = '本机记录已损坏，已重置';
  const CORRUPT_KEY_PREFIX = 'psych.sessions.corrupt.';
  const USED_MEMORY_SHOW = 2;  // 「用到了」最多展示 2 条，其余折叠为「等 N 条」
  const SR_LIVE_MAX = 200;     // 读屏播报截断长度

  // 情感连续性（GET /api/comeback）与免 Key 演示模式（GET/POST /api/demo）
  const COMEBACK_TIMEOUT_MS = 3000;
  const COMEBACK_CACHE_MS = 5000;
  const DEMO_TIMEOUT_MS = 3000;
  const DEFAULT_HERO_TITLE = '你好，我在这里';
  const DEFAULT_HERO_SUB = '不用急着说什么。想聊的时候，我在。';
  const DEFAULT_STARTERS_LABEL = '可以这样开始';
  const DEMO_ENTRY_OFF_TEXT = '没有 API Key？先用演示模式感受一下';
  const DEMO_ENTRY_ON_TEXT = '演示模式已开启（不会发送到模型）';
  const DEMO_ON_TOAST = '已进入演示模式';
  const DEMO_OFF_TOAST = '已退出演示模式';
  const DEMO_FAIL_TOAST = '演示模式暂时不可用，稍后再试';

  // 接口不可用 / suggestions 为空时回落的 4 条静态建议（保持 button.suggestion + data-prompt 契约）
  const STATIC_SUGGESTIONS = [
    { prompt: '最近考试压力很大，晚上一直失眠', label: '最近考试压力很大，晚上一直失眠' },
    { prompt: '我也不知道为什么，最近就是乱糟糟的', label: '说不清原因，就是乱糟糟的' },
    { prompt: '算了，没什么，不想说了', label: '算了，没什么' },
    { prompt: '我该怎么调整自己的状态？', label: '想问问怎么调整状态' },
  ];

  const SCROLL_THRESHOLD = 96; // px：距底部多近算“在底部附近”
  const DOTS_HTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NUL = '\u0000';

  // Markdown 行内规则（全局正则，配合 String.replace 使用是安全的）
  const RE_INLINE_CODE = /`([^`\n]+)`/g;
  const RE_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
  const RE_BOLD = /\*\*([^*\n]+)\*\*/g;
  const RE_ITALIC = /(^|[^*])\*([^*\n]+)\*(?!\*)/g;
  const RE_RESTORE_LINK = /\u0000L(\d+)\u0000/g;
  const RE_RESTORE_CODE = /\u0000K(\d+)\u0000/g;

  /* ============================================================
   * 二、DOM 引用
   * ============================================================ */

  const $ = (id) => document.getElementById(id);

  const el = {
    app: $('app'),
    sidebar: $('sidebar'),
    sidebarOpen: $('sidebar-open'),
    sidebarClose: $('sidebar-close'),
    newChat: $('new-chat'),
    sessionList: $('session-list'),
    sessionsEmpty: $('sessions-empty'),
    themeToggle: $('theme-toggle'),
    themeIconUse: document.querySelector('#theme-icon use'),
    themeText: $('theme-text'),
    openAbout: $('open-about'),
    aboutModal: $('about-modal'),
    aboutClose: $('about-close'),
    modelDot: $('model-dot'),
    modelPill: $('model-pill'),
    chatTitle: $('chat-title'),
    statusPill: $('status-pill'),
    chat: $('chat'),
    messages: $('messages'),
    srLive: $('sr-live'),
    welcome: $('welcome'),
    suggestions: $('suggestions'),
    heroTitle: $('hero-title'),
    heroSub: $('hero-sub'),
    recall: $('recall'),
    recallList: $('recall-list'),
    startersLabel: $('starters-label'),
    demoEntry: $('demo-entry'),
    demoEntryText: $('demo-entry-text'),
    scrollBottom: $('scroll-bottom'),
    form: $('chat-form'),
    input: $('message'),
    sendBtn: $('send-btn'),
    toasts: $('toasts'),
    scrim: $('scrim'),

    // 桌面外壳（Tauri 无边框窗口）
    titlebar: $('titlebar'),
    titlebarMin: $('titlebar-min'),
    titlebarMax: $('titlebar-max'),
    titlebarClose: $('titlebar-close'),

    // 顶栏与入口
    modelWarn: $('model-warn'),
    debugToggle: $('debug-toggle'),
    openSettingsTop: $('open-settings-top'),
    openSettings: $('open-settings'),
    openMemory: $('open-memory'),
    openShortcuts: $('open-shortcuts'),

    // 首次启动向导
    wizard: $('wizard'),
    wizardBackdrop: $('wizard-backdrop'),
    wizardDots: $('wizard-dots'),
    wizardBack: $('wizard-back'),
    wizardNext: $('wizard-next'),
    wizardSkip: $('wizard-skip'),
    wizardKey: $('wizard-key'),
    wizardKeyEye: $('wizard-key-eye'),
    wizardModel: $('wizard-model'),
    wizardBaseUrl: $('wizard-baseurl'),
    wizardResult: $('wizard-result'),

    // 设置抽屉
    drawerScrim: $('drawer-scrim'),
    settingsDrawer: $('settings-drawer'),
    settingsClose: $('settings-close'),
    settingModel: $('setting-model'),
    settingTemperature: $('setting-temperature'),
    settingTemperatureValue: $('setting-temperature-value'),
    settingMaxTokens: $('setting-maxtokens'),
    settingThinking: $('setting-thinking'),
    settingKeyMasked: $('setting-key-masked'),
    settingKeyChange: $('setting-key-change'),
    settingKeyClear: $('setting-key-clear'),
    settingKeyRow: $('setting-key-row'),
    settingKeyInput: $('setting-key-input'),
    settingKeyEye: $('setting-key-eye'),
    settingDebug: $('setting-debug'),
    settingsTest: $('settings-test'),
    settingsSave: $('settings-save'),
    settingsResult: $('settings-result'),
    openWizardAgain: $('open-wizard-again'),

    // 记忆抽屉
    memoryDrawer: $('memory-drawer'),
    memoryClose: $('memory-close'),
    memoryEnabled: $('memory-enabled'),
    memoryAddText: $('memory-add-text'),
    memoryAddCategory: $('memory-add-category'),
    memoryAddBtn: $('memory-add-btn'),
    memoryList: $('memory-list'),
    memoryEmpty: $('memory-empty'),
    memoryCount: $('memory-count'),
    memoryUpdated: $('memory-updated'),
    memoryClear: $('memory-clear'),
    memoryFootNote: $('memory-foot-note'),

    // 键盘快捷键帮助
    shortcutsModal: $('shortcuts-modal'),
    shortcutsClose: $('shortcuts-close'),

    // 二次确认弹窗
    confirmModal: $('confirm-modal'),
    confirmTitle: $('confirm-title'),
    confirmMessage: $('confirm-message'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel'),
    confirmClose: $('confirm-close'),
  };

  // DOM 契约缺失时直接退出，避免整页报错
  if (!el.messages || !el.form || !el.input || !el.sendBtn) return;

  // 桌面外壳（Tauri）标记尽早挂上，避免首帧布局跳动；浏览器里不做任何事
  if (window.__TAURI__) document.documentElement.classList.add('is-tauri');

  /* ============================================================
   * 三、运行时状态
   * ============================================================ */

  let sessions = [];           // 全部本地会话
  let activeId = '';           // 当前会话 id
  let generating = false;      // 是否正在生成回复
  let activeController = null; // 当前流式请求的 AbortController
  let pending = null;          // 正在流式更新的助手消息 { session, msg, index, el }
  let rafId = 0;               // 流式渲染的 requestAnimationFrame 句柄
  let stickBottom = true;      // 是否自动吸附到底部
  let composing = false;       // 输入法组合中
  let debugOn = false;         // 调试面板：显示策略路由证据
  let wizardStep = 1;          // 向导当前步骤
  let activeDrawer = '';       // 当前打开的抽屉 id（'' / 'settings' / 'memory'）
  let healthConfigured = null; // 最近一次健康检查的 configured 结果
  let configCache = null;      // 最近一次 GET /api/config 的 data
  let memoryCategories = MEMORY_CATEGORIES.slice(); // 分类表（接口优先）
  let memoryEnabledCache = true; // 记忆开关的最近状态
  let confirmResolve = null;   // 确认弹窗的 Promise resolve
  let themeAnimTimer = 0;      // 主题平滑过渡的收尾计时器
  let scrollBtnVisible = false;// 「回到最新」当前是否可见（避免滚动时反复改 DOM）
  let lastRippleAt = 0;        // 发送键最近一次涟漪反馈的时间戳

  // 情感连续性 / 演示模式
  let comebackCache = null;    // 最近一次成功的 /api/comeback 数据
  let comebackAt = 0;          // 上面数据的获取时间，用于短间隔缓存
  let comebackInFlight = null; // 进行中的 comeback 请求（避免并发重复）
  let demoCapable = false;     // /api/demo 是否可用（接口存在或 comeback 声明可用）
  let demoEnabled = false;     // 演示模式当前是否开启
  let demoBusy = false;        // 演示模式切换 / 自动关闭进行中
  let storageWarned = false;   // 本机写入失败是否已提示（同一次会话只提示一次）
  let drawerReturnFocus = null;    // 关闭抽屉后归还焦点的元素
  let sidebarReturnFocus = null;   // 关闭侧边栏后归还焦点的元素
  let shortcutsReturnFocus = null; // 关闭快捷键帮助后归还焦点的元素
  let demoApplied = null;      // 上次同步「用到了」显隐时的演示模式状态

  /* ============================================================
   * 四、通用工具
   * ============================================================ */

  function now() {
    return Date.now();
  }

  function uid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return 's_' + window.crypto.randomUUID();
      }
    } catch (e) { /* 忽略，走兜底 */ }
    return 's_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncateTitle(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return DEFAULT_TITLE;
    const chars = Array.from(clean);
    return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : chars.join('');
  }

  function strategyLabel(key) {
    if (!key) return '';
    return STRATEGY_LABELS[key] || String(key);
  }

  function riskLabel(key) {
    if (!key) return '';
    return RISK_LABELS[key] || String(key);
  }

  function formatTime(ts) {
    const d = new Date(Number(ts) || now());
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function svgIcon(iconId) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + iconId);
    svg.appendChild(use);
    return svg;
  }

  // 切换 hidden；样式表已有 [hidden]{display:none!important}，这里再兜底一次
  function setHidden(node, hidden) {
    if (!node) return;
    node.hidden = !!hidden;
    node.style.display = hidden ? 'none' : '';
  }

  /* ============================================================
   * 三之二、无障碍：隐藏容器的焦点隔离（inert + 老浏览器降级）
   * ------------------------------------------------------------
   * 支持 inert 时优先用 inert；不支持时降级为 aria-hidden="true"
   * 并把容器内可聚焦元素临时改为 tabindex="-1"（关闭时还原）。
   * ============================================================ */

  const supportsInert = (function () {
    try { return 'inert' in HTMLElement.prototype; } catch (e) { return false; }
  })();

  const tabindexBackup = new WeakMap(); // 元素 -> 原始 tabindex（降级方案用）
  const hiddenLayers = new Set();       // 当前被标记为「不可见」的容器

  const TABBABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';

  function isVisibleNode(node) {
    if (!node || node.hidden || node.disabled) return false;
    try { if (node.closest('[hidden]')) return false; } catch (e) { /* 忽略 */ }
    return true;
  }

  // 容器内当前可 Tab 到的元素（按 DOM 顺序）
  function collectFocusable(root) {
    const out = [];
    if (!root) return out;
    let nodes = [];
    try { nodes = root.querySelectorAll(TABBABLE_SELECTOR); } catch (e) { return out; }
    for (let i = 0; i < nodes.length; i += 1) {
      if (isVisibleNode(nodes[i])) out.push(nodes[i]);
    }
    return out;
  }

  // 降级方案：把容器内可聚焦元素改成 tabindex="-1"，首次进入时记录原值
  function applyTabindexFallback(node) {
    if (!node) return;
    let nodes = [];
    try { nodes = node.querySelectorAll(FOCUSABLE_SELECTOR); } catch (e) { return; }
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (!tabindexBackup.has(n)) tabindexBackup.set(n, n.getAttribute('tabindex'));
      n.setAttribute('tabindex', '-1');
    }
  }

  function restoreTabindexFallback(node) {
    if (!node) return;
    let nodes = [];
    try { nodes = node.querySelectorAll('[tabindex]'); } catch (e) { return; }
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (!tabindexBackup.has(n)) continue;
      const prev = tabindexBackup.get(n);
      tabindexBackup.delete(n);
      if (prev == null) n.removeAttribute('tabindex');
      else n.setAttribute('tabindex', prev);
    }
  }

  // 容器「不可见 / 可见」的唯一入口：inert + aria-hidden（+ 降级）
  function setLayerHidden(node, hidden) {
    if (!node) return;
    if (hidden) {
      if (supportsInert) { try { node.inert = true; } catch (e) { /* 忽略 */ } }
      node.setAttribute('aria-hidden', 'true');
      hiddenLayers.add(node);
      if (!supportsInert) applyTabindexFallback(node);
      return;
    }
    if (supportsInert) { try { node.inert = false; } catch (e) { /* 忽略 */ } }
    node.removeAttribute('aria-hidden');
    hiddenLayers.delete(node);
    if (!supportsInert) restoreTabindexFallback(node);
  }

  // 容器内容在隐藏状态下被重建时，重新补一次降级（inert 无需处理）
  function refreshLayerHidden(node) {
    if (!node || !hiddenLayers.has(node) || supportsInert) return;
    applyTabindexFallback(node);
  }

  // 焦点归还：目标不存在/已移除时回落到备用触发按钮
  function returnFocusTo(target, fallback) {
    let node = (target && target !== document.body && target.isConnected !== false) ? target : null;
    if (!node && fallback && fallback.isConnected !== false) node = fallback;
    if (!node || typeof node.focus !== 'function') return;
    try { node.focus(); } catch (e) { /* 忽略 */ }
  }

  // 焦点陷阱：在打开的抽屉 / 移动端侧边栏内循环 Tab
  function activeTrapLayer() {
    if (isShortcutsOpen()) return null; // <dialog> 自行管理焦点
    if (activeDrawer === 'settings') return el.settingsDrawer;
    if (activeDrawer === 'memory') return el.memoryDrawer;
    if (isSidebarOpen()) return el.sidebar;
    return null;
  }

  function handleLayerTab(e) {
    if (e.key !== 'Tab') return;
    const layer = activeTrapLayer();
    if (!layer || layer.hidden) return;
    const items = collectFocusable(layer);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = !!(active && layer.contains(active));
    if (e.shiftKey) {
      if (!inside || active === first) { e.preventDefault(); try { last.focus(); } catch (err) { /* 忽略 */ } }
      return;
    }
    if (!inside || active === last) { e.preventDefault(); try { first.focus(); } catch (err) { /* 忽略 */ } }
  }

  function setExpanded(node, on) {
    if (node) node.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function isNarrowViewport() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches); }
    catch (e) { return true; }
  }

  // 侧边栏：窄屏下隐藏时需要隔离焦点；宽屏常驻可见，保持可交互
  function syncSidebarHidden() {
    if (!el.sidebar) return;
    const sidebarVisible = isNarrowViewport() ? isSidebarOpen() : true;
    setLayerHidden(el.sidebar, !sidebarVisible);
  }

  // 触发按钮的 aria-expanded 同步
  function syncLayerAria() {
    const sidebarExpanded = isSidebarOpen() || !isNarrowViewport();
    setExpanded(el.sidebarOpen, sidebarExpanded);
    setExpanded(el.openMemory, activeDrawer === 'memory');
    setExpanded(el.openSettings, activeDrawer === 'settings');
    setExpanded(el.openSettingsTop, activeDrawer === 'settings');
    setExpanded(el.openShortcuts, isShortcutsOpen());
  }

  function sleep(ms) {
    return new Promise((resolve) => { window.setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  // 取 350–800ms 之间、对同一条消息稳定的间隔（避免重渲染时跳动）
  function stableGap(seed, index) {
    const n = Math.abs(Number(seed) || 0) + index * 173;
    return PART_GAP_MIN + (n % (PART_GAP_MAX - PART_GAP_MIN));
  }

  /* ============================================================
   * 四之二、动效工具（统一入口，方便一键降级为“无动效”）
   * ============================================================ */

  // 是否处于「减少动效」偏好；每次实时读取，系统设置中途改变也能生效
  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function nextFrame(fn) {
    try { window.requestAnimationFrame(fn); }
    catch (e) { window.setTimeout(fn, 16); }
  }

  // 浮层（抽屉 / 向导 / 遮罩）的开合：关闭时先播退场动画，再挂 hidden
  const layerTimers = new WeakMap();  // 节点 -> 退场计时器
  const layerCleanup = new WeakMap(); // 节点 -> 动画期收尾计时器

  function layerDelay(ms) {
    return reducedMotion() ? 0 : Math.max(0, Number(ms) || 0);
  }

  function markAnimating(node, ms) {
    if (!node) return;
    const prev = layerCleanup.get(node);
    if (prev) window.clearTimeout(prev);
    // will-change 只在动画期间存在，动画结束立刻摘掉
    node.classList.add('is-animating');
    const timer = window.setTimeout(function () {
      layerCleanup.delete(node);
      node.classList.remove('is-animating');
    }, reducedMotion() ? 0 : Math.max(120, Number(ms) || 240));
    layerCleanup.set(node, timer);
  }

  function showLayer(node, openClass, duration) {
    if (!node) return;
    const pending = layerTimers.get(node);
    if (pending) { window.clearTimeout(pending); layerTimers.delete(node); }
    node.classList.remove('is-closing');
    setHidden(node, false);
    markAnimating(node, duration || 260);
    // 先以闭合态渲染一帧，再加 is-open，过渡才有起点
    nextFrame(function () {
      if (node.hidden || node.classList.contains('is-closing')) return;
      node.classList.add(openClass || 'is-open');
    });
  }

  function hideLayer(node, duration, onDone) {
    if (!node || node.hidden) {
      if (node) node.classList.remove('is-open', 'is-closing');
      if (typeof onDone === 'function') onDone();
      return;
    }
    if (node.classList.contains('is-closing')) return; // 已在退场中，避免重复
    const wait = layerDelay(duration || 200);
    node.classList.remove('is-open');
    node.classList.add('is-closing');
    markAnimating(node, wait + 80);
    const timer = window.setTimeout(function () {
      layerTimers.delete(node);
      node.classList.remove('is-closing', 'is-animating');
      setHidden(node, true);
      if (typeof onDone === 'function') onDone();
    }, wait);
    layerTimers.set(node, timer);
  }

  // 原生 <dialog> 没有退场时机，这里手动延后 close()
  function openDialog(dialog) {
    if (!dialog || typeof dialog.showModal !== 'function') return false;
    const pending = layerTimers.get(dialog);
    if (pending) { window.clearTimeout(pending); layerTimers.delete(dialog); }
    dialog.classList.remove('is-closing', 'is-open');
    try {
      if (!dialog.open) dialog.showModal();
    } catch (e) {
      return false;
    }
    nextFrame(function () { dialog.classList.add('is-open'); });
    return true;
  }

  function closeDialog(dialog, duration) {
    if (!dialog) return;
    if (!dialog.open) { dialog.classList.remove('is-open', 'is-closing'); return; }
    if (dialog.classList.contains('is-closing')) return;
    dialog.classList.remove('is-open');
    dialog.classList.add('is-closing');
    const timer = window.setTimeout(function () {
      layerTimers.delete(dialog);
      dialog.classList.remove('is-closing');
      try { if (dialog.open) dialog.close(); } catch (e) { /* 忽略 */ }
    }, layerDelay(duration || 190));
    layerTimers.set(dialog, timer);
  }

  // 发送键：按下缩放 + 涟漪（只用 transform / opacity，不触发布局）
  function ripple(btn) {
    if (!btn || reducedMotion()) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 2.1;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.left = (rect.width / 2 - size / 2) + 'px';
    dot.style.top = (rect.height / 2 - size / 2) + 'px';
    btn.appendChild(dot);
    window.setTimeout(function () { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 620);
  }

  function pressFeedback(btn) {
    if (!btn || btn.disabled || reducedMotion()) return;
    lastRippleAt = now();
    ripple(btn);
    btn.classList.add('is-pressing');
    window.setTimeout(function () { btn.classList.remove('is-pressing'); }, 160);
  }

  // 键盘 / 表单提交路径的反馈：按钮快速回弹一下
  function sendPulse() {
    const btn = el.sendBtn;
    if (!btn || reducedMotion()) return;
    if (now() - lastRippleAt < 400) return; // 刚点过按钮就不再叠加
    btn.classList.remove('is-pulse');
    void btn.offsetWidth; // 重启动画
    btn.classList.add('is-pulse');
    window.setTimeout(function () { btn.classList.remove('is-pulse'); }, 300);
    ripple(btn);
  }

  // 复制成功：图标短暂变成 ✓ + 「已复制」文字
  function markCopied(btn) {
    if (!btn) return;
    const use = btn.querySelector('use');
    const prevLabel = btn.getAttribute('aria-label') || '复制回复';
    const prevHref = use ? use.getAttribute('href') : '';
    if (btn.__copiedTimer) window.clearTimeout(btn.__copiedTimer);
    btn.classList.add('is-done');
    btn.setAttribute('aria-label', '已复制');
    if (use) use.setAttribute('href', '#i-check');
    btn.__copiedTimer = window.setTimeout(function () {
      btn.__copiedTimer = 0;
      btn.classList.remove('is-done');
      if (!btn.isConnected) return; // 列表已重渲染，旧节点无需复原
      btn.setAttribute('aria-label', prevLabel);
      if (use && prevHref) use.setAttribute('href', prevHref);
    }, 1400);
  }

  function makeApiError(message, status) {
    const err = new Error(message || '请求失败');
    err.userMessage = message || '请求失败';
    err.status = status || 0;
    return err;
  }

  // 统一的后端请求：始终 try/catch，失败抛中文错误；非 2xx 或 ok!==true 一律视为失败
  async function apiRequest(path, options) {
    const opts = options || {};
    const init = { method: opts.method || 'GET', headers: {}, cache: 'no-store' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw makeApiError('网络似乎断开了，请检查网络后重试', 0);
    }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok || !json || json.ok !== true) {
      const detail = json && (json.error || (json.data && json.data.message));
      throw makeApiError(detail || ('请求失败（HTTP ' + res.status + '）'), res.status);
    }
    return json.data === undefined ? json : json.data;
  }

  function toastError(err, fallback) {
    const msg = (err && (err.userMessage || err.message)) || fallback || '操作没有成功，请稍后再试';
    toast(msg, 'error');
  }

  // 面板内的结果行
  function setResult(node, state, text) {
    if (!node) return;
    if (!text) { setHidden(node, true); node.textContent = ''; node.removeAttribute('data-state'); return; }
    node.textContent = text;
    if (state) node.setAttribute('data-state', state);
    else node.removeAttribute('data-state');
    setHidden(node, false);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = true;
      if (busyText) button.textContent = busyText;
    } else {
      button.disabled = false;
      if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; }
    }
  }

  // 密码框的显示 / 隐藏
  function togglePassword(input, button) {
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (button) button.textContent = show ? '隐藏' : '显示';
  }

  /* ============================================================
   * 五、安全 Markdown 渲染（自实现，无外部库）
   *
   * 约定：输入永远是“原始纯文本”。renderMarkdown 内部先整体转义 HTML，
   * 再套用轻量子集；对同一条原始文本可重复调用、结果稳定（流式重渲染安全）。
   * ============================================================ */

  // 行内：`代码`、[文字](http/https)、**粗体**、*斜体*
  function renderInline(escaped) {
    // 1) 先抽出行内代码，避免代码里的 [x](y) 被当成链接
    const codes = [];
    let text = escaped.replace(RE_INLINE_CODE, function (m, code) {
      codes.push(code);
      return NUL + 'K' + (codes.length - 1) + NUL;
    });

    // 2) 抽出合法链接（仅 http/https），URL 不再参与后续强调规则，避免被破坏
    const links = [];
    text = text.replace(RE_LINK, function (m, label, url) {
      const plainUrl = url.replace(/&amp;/g, '&');
      if (!/^https?:\/\/[^\s]+$/i.test(plainUrl)) return m; // 其它协议按纯文本
      const labelHtml = label
        .replace(RE_BOLD, '<strong>$1</strong>')
        .replace(RE_ITALIC, '$1<em>$2</em>');
      links.push('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + labelHtml + '</a>');
      return NUL + 'L' + (links.length - 1) + NUL;
    });

    // 3) 粗体 / 斜体
    text = text.replace(RE_BOLD, '<strong>$1</strong>');
    text = text.replace(RE_ITALIC, '$1<em>$2</em>');

    // 4) 还原链接与行内代码
    text = text.replace(RE_RESTORE_LINK, function (m, i) { return links[Number(i)] || ''; });
    text = text.replace(RE_RESTORE_CODE, function (m, i) { return '<code>' + (codes[Number(i)] || '') + '</code>'; });
    return text;
  }

  function isBlockStart(line) {
    return /^\s*```/.test(line) ||
      /^(#{1,3})\s+/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line);
  }

  function renderMarkdown(raw) {
    const source = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    if (!source) return '';
    const lines = source.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 空行
      if (line.trim() === '') { i += 1; continue; }

      // 代码块 ```lang ... ```
      const fence = line.match(/^\s*```(\S*)\s*$/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1; // 跳过结束围栏
        const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
        out.push('<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 标题 # ~ ###
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + renderInline(escapeHtml(heading[2].trim())) + '</h' + level + '>');
        i += 1;
        continue;
      }

      // 引用 >（可连续多行）
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + renderInline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br />') + '</blockquote>');
        continue;
      }

      // 无序列表 - / * / +
      if (/^\s*[-*+]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i += 1;
        }
        out.push('<ul>' + buf.map((t) => '<li>' + renderInline(escapeHtml(t)) + '</li>').join('') + '</ul>');
        continue;
      }

      // 有序列表 1. / 1)
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i += 1;
        }
        out.push('<ol>' + buf.map((t) => '<li>' + renderInline(escapeHtml(t)) + '</li>').join('') + '</ol>');
        continue;
      }

      // 段落（段内单换行 -> <br />）
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '' || isBlockStart(l)) break;
        buf.push(l);
        i += 1;
      }
      if (buf.length === 0) { buf.push(line); i += 1; } // 安全兜底，杜绝死循环
      out.push('<p>' + renderInline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br />') + '</p>');
    }

    return out.join('');
  }

  /* ============================================================
   * 六、本地多会话（localStorage）
   * ============================================================ */

  function sanitizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const role = (raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system') ? raw.role : 'system';
    const msg = {
      role: role,
      content: typeof raw.content === 'string' ? raw.content : String(raw.content == null ? '' : raw.content),
      ts: Number(raw.ts) || now(),
    };
    if (role === 'assistant') {
      if (raw.strategy) msg.strategy = String(raw.strategy);
      if (raw.strategyLabel) msg.strategyLabel = String(raw.strategyLabel);
      if (raw.riskLevel) msg.riskLevel = String(raw.riskLevel);
      if (raw.blocked) msg.blocked = true;
      if (raw.error) msg.error = true;
      if (raw.stopped) msg.stopped = true;
      if (Array.isArray(raw.parts)) {
        const parts = raw.parts.map((p) => String(p == null ? '' : p)).filter((p) => p.trim() !== '');
        if (parts.length) msg.parts = parts.slice(0, 3);
      }
      const route = sanitizeRoute(raw.route);
      if (route) msg.route = route;
      if (raw.memory && typeof raw.memory === 'object' && raw.memory.action) {
        msg.memory = {
          action: String(raw.memory.action),
          item: raw.memory.item == null ? '' : String(raw.memory.item),
        };
      }
      // 本轮实际用到的记忆原文（历史消息同样保留，刷新后仍可回看）
      const used = normalizeMemoriesUsed(raw.memoriesUsed);
      if (used.length) msg.memoriesUsed = used;
    }
    return msg;
  }

  // 归一化后端 done.memoriesUsed：只接受非空字符串（兼容 snake_case 与对象项）
  function normalizeMemoriesUsed(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length && out.length < 8; i += 1) {
      const item = raw[i];
      let text = '';
      if (typeof item === 'string') text = item;
      else if (item && typeof item === 'object') text = String(item.text || item.content || item.label || '');
      text = text.replace(/\s+/g, ' ').trim();
      if (text) out.push(text.slice(0, 200));
    }
    return out;
  }

  // 只保留已知字段的基本类型，避免把任意结构写进 localStorage
  function sanitizeRoute(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = ['risk_level', 'strategy', 'strategy_label', 'confidence', 'reason',
      'next_hint', 'ask_count', 'emotion_temperature', 'turn', 'strategy_streak'];
    const out = {};
    keys.forEach((k) => {
      const v = raw[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  function sanitizeSession(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    const messages = Array.isArray(raw.messages)
      ? raw.messages.map(sanitizeMessage).filter(Boolean)
      : [];
    return {
      id: String(raw.id),
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : DEFAULT_TITLE,
      createdAt: Number(raw.createdAt) || now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now(),
      messages: messages,
    };
  }

  // 尽力而为地把损坏的原值留档，方便事后找回（写不进去就忽略）
  function backupCorruptState(raw) {
    try {
      localStorage.setItem(CORRUPT_KEY_PREFIX + Date.now(), String(raw).slice(0, 200000));
    } catch (e) { /* 忽略：配额/隐私模式下留档失败不影响降级 */ }
  }

  function toastOnce(flag, message, type) {
    if (flag.value) return;
    flag.value = true;
    try { toast(message, type); } catch (e) { /* 忽略 */ }
  }

  const corruptFlag = { value: false };

  function loadState() {
    let loaded = [];
    let raw = null;
    try { raw = localStorage.getItem(LS_KEYS.sessions); } catch (e) { raw = null; }
    if (raw) {
      let parsed = null;
      let broken = false;
      try { parsed = JSON.parse(raw); } catch (e) { broken = true; }
      if (!broken && parsed != null && !Array.isArray(parsed)) broken = true;
      if (broken) {
        backupCorruptState(raw);            // 先留档，再降级为空状态
        loaded = [];
        toastOnce(corruptFlag, STORAGE_CORRUPT_TOAST, 'error');
      } else if (Array.isArray(parsed)) {
        loaded = parsed.map(sanitizeSession).filter(Boolean);
      }
    }
    sessions = loaded;

    let act = '';
    try { act = localStorage.getItem(LS_KEYS.activeId) || ''; } catch (e) { act = ''; }
    if (!act || !sessions.some((s) => s.id === act)) {
      act = sessions.length ? sessions[0].id : '';
    }
    activeId = act;
  }

  function saveState() {
    try {
      // 不落盘“空白的流式占位”，避免刷新后永久停在“正在回复…”
      const payload = sessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: s.messages
          .filter((m) => !(m.role === 'assistant' && m.streaming && !m.content))
          .map((m) => {
            const o = { role: m.role, content: m.content, ts: m.ts };
            if (m.strategy) o.strategy = m.strategy;
            if (m.strategyLabel) o.strategyLabel = m.strategyLabel;
            if (m.riskLevel) o.riskLevel = m.riskLevel;
            if (m.blocked) o.blocked = true;
            if (m.error) o.error = true;
            if (m.stopped) o.stopped = true;
            if (m.parts && m.parts.length) o.parts = m.parts.slice(0, 3);
            if (m.route) o.route = m.route;
            if (m.memory) o.memory = m.memory;
            if (m.memoriesUsed && m.memoriesUsed.length) o.memoriesUsed = m.memoriesUsed.slice(0, 8);
            return o;
          }),
      }));
      localStorage.setItem(LS_KEYS.sessions, JSON.stringify(payload));
      localStorage.setItem(LS_KEYS.activeId, activeId || '');
    } catch (e) {
      // 配额超限 / 隐私模式：降级为「只在内存里继续」，并只提示一次
      if (!storageWarned) {
        storageWarned = true;
        try { toast(STORAGE_FAIL_TOAST, 'error'); } catch (err) { /* 忽略 */ }
      }
    }
  }

  function getSession(id) {
    return sessions.find((s) => s.id === id) || null;
  }

  function createSession() {
    return {
      id: uid(),
      title: DEFAULT_TITLE,
      createdAt: now(),
      updatedAt: now(),
      messages: [],
    };
  }

  // 保证一定存在可用会话
  function ensureActive() {
    let s = getSession(activeId);
    if (s) return s;
    s = createSession();
    sessions.unshift(s);
    activeId = s.id;
    saveState();
    return s;
  }

  function sortedSessions() {
    return sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /* ============================================================
   * 七、渲染：消息、会话列表、标题、空状态
   * ============================================================ */

  function makeActionButton(action, label, iconId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg__action';
    btn.dataset.action = action;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.appendChild(svgIcon(iconId));
    return btn;
  }

  // 生成 meta 文本：共情反映 · 风险 关注（策略/风险值用 <em> 高亮，视觉保持克制）
  function renderMeta(metaEl, msg) {
    if (!metaEl) return;
    metaEl.textContent = '';
    const strategy = msg.strategyLabel || strategyLabel(msg.strategy);
    let hasText = false;

    if (strategy) {
      metaEl.appendChild(makeEl('em', null, strategy));
      hasText = true;
    }
    if (msg.riskLevel) {
      if (hasText) metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(document.createTextNode('风险 '));
      metaEl.appendChild(makeEl('em', null, riskLabel(msg.riskLevel)));
      hasText = true;
    }
    if (msg.blocked) {
      if (hasText) metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(document.createTextNode('已安全处理'));
      hasText = true;
    }
    if (msg.stopped) {
      if (hasText) metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(document.createTextNode('已停止'));
    }
  }

  function buildUserMessage(msg) {
    const article = makeEl('article', 'msg msg--user');
    const body = makeEl('div', 'msg__body');
    const bubble = makeEl('div', 'msg__bubble');
    const content = makeEl('div', 'msg__content', msg.content || '');
    bubble.appendChild(content);
    body.appendChild(bubble);
    article.appendChild(body);
    return article;
  }

  function buildSystemMessage(msg) {
    const article = makeEl('article', 'msg msg--system');
    const body = makeEl('div', 'msg__body');
    const bubble = makeEl('div', 'msg__bubble');
    const content = makeEl('div', 'msg__content', msg.content || '');
    bubble.appendChild(content);
    body.appendChild(bubble);
    article.appendChild(body);
    return article;
  }

  function makeBubble(html) {
    const bubble = makeEl('div', 'msg__bubble');
    const content = makeEl('div', 'msg__content');
    // 全站唯一写 innerHTML 的位置：renderMarkdown 已对内容整体转义
    content.innerHTML = html;
    bubble.appendChild(content);
    return bubble;
  }

  /**
   * 把一条回复按语义拆成 1–3 个气泡：
   * - 先按换行、再按句末标点切分，每段不超过约 60 字；
   * - 错误 / 停止 / 安全处理 / 含代码块的回复不拆，避免破坏呈现。
   */
  function splitReply(raw, msg) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return [];
    if (msg && (msg.stopped || msg.error || msg.blocked)) return [text];
    if (text.length <= PART_LIMIT) return [text];
    if (text.indexOf('```') !== -1) return [text];

    const units = [];
    text.split(String.fromCharCode(10)).forEach((line) => {
      const clean = line.trim();
      if (!clean) return;
      const matched = clean.match(/[^。！？!?…；;]+[。！？!?…；;]*/g);
      (matched && matched.length ? matched : [clean]).forEach((piece) => {
        const seg = piece.trim();
        if (seg) units.push(seg);
      });
    });
    if (units.length <= 1) return [text];

    const parts = [];
    let buf = '';
    let i = 0;
    // 最多切两刀，剩下的全部归到第三段，保证 1–3 个气泡
    while (i < units.length && parts.length < 2) {
      const unit = units[i];
      if (!buf) buf = unit;
      else if (buf.length + unit.length <= PART_LIMIT) buf += unit;
      else { parts.push(buf); buf = unit; }
      i += 1;
    }
    buf += units.slice(i).join('');
    if (buf) parts.push(buf);

    const out = parts.filter((p) => p && p.trim());
    return out.length > 1 ? out.slice(0, 3) : [text];
  }

  function renderBubbles(box, msg) {
    if (!box) return;
    box.textContent = '';

    // 打字中：占位气泡（三个点，或首字兜底文案）
    if (!msg.content && msg.streaming) {
      const bubble = makeEl('div', 'msg__bubble');
      const content = makeEl('div', 'msg__content');
      if (msg.waitingText) {
        content.textContent = msg.waitingText;
        bubble.classList.add('is-waiting-hint'); // 文案切换时轻微淡入
      } else {
        content.innerHTML = DOTS_HTML;
      }
      bubble.setAttribute('aria-label', msg.waitingText || '心屿正在输入');
      bubble.appendChild(content);
      box.appendChild(bubble);
      return;
    }

    const parts = (!msg.streaming && Array.isArray(msg.parts) && msg.parts.length > 1) ? msg.parts : null;
    const list = parts || [msg.content || ''];
    const animate = !reducedMotion(); // 减少动效时直接出现，不排队
    let delay = 0;
    list.forEach((part, index) => {
      const bubble = makeBubble(renderMarkdown(part));
      if (msg.streaming) {
        const content = bubble.querySelector('.msg__content');
        const caret = makeEl('span', 'caret');
        caret.setAttribute('aria-hidden', 'true');
        if (content) content.appendChild(caret);
      }
      if (parts && animate) {
        // 分气泡依次出现：沿用 350–800ms 的拟人节奏，再叠加一点 stagger
        if (index > 0) delay += stableGap(msg.ts, index);
        bubble.classList.add('is-seq');
        bubble.style.animationDelay = Math.round(delay + index * 30) + 'ms';
      }
      box.appendChild(bubble);
    });
  }

  // 记忆提示：done.memory.action 为 remember / forget 时显示一条轻提示
  function renderNote(noteEl, msg) {
    if (!noteEl) return;
    const mem = msg.memory;
    if (!mem || !mem.action) {
      noteEl.textContent = '';
      setHidden(noteEl, true);
      return;
    }
    if (mem.action === 'remember') {
      noteEl.textContent = mem.item ? ('已记住：' + mem.item) : '已记住这条内容';
    } else if (mem.action === 'forget') {
      noteEl.textContent = '已忘记相关内容';
    } else {
      noteEl.textContent = '';
      setHidden(noteEl, true);
      return;
    }
    setHidden(noteEl, false);
  }

  // 调试面板摘要：风险 L1 · 策略 S2_empathy · 置信度 0.95 · 情绪温度 4 · 追问 0 · 第 3 轮
  function buildRouteSummary(route) {
    if (!route) return '';
    const bits = [];
    if (route.risk_level) bits.push('风险 ' + route.risk_level);
    if (route.strategy) bits.push('策略 ' + route.strategy);
    if (typeof route.confidence === 'number') bits.push('置信度 ' + route.confidence.toFixed(2));
    if (route.emotion_temperature != null) bits.push('情绪温度 ' + route.emotion_temperature);
    if (route.ask_count != null) bits.push('追问 ' + route.ask_count);
    if (route.turn != null) bits.push('第 ' + route.turn + ' 轮');
    return bits.join(' · ');
  }

  function renderDebug(dbgEl, msg) {
    if (!dbgEl) return;
    if (!debugOn || !msg.route) {
      setHidden(dbgEl, true);
      return;
    }
    const summary = dbgEl.querySelector('summary');
    const pre = dbgEl.querySelector('.dbg__json');
    if (summary) summary.textContent = buildRouteSummary(msg.route);
    if (pre) {
      let text = '';
      try { text = JSON.stringify(msg.route, null, 2); } catch (e) { text = ''; }
      pre.textContent = text;
    }
    setHidden(dbgEl, false);
  }

  // 「用到了：…」——最多 2 条，其余折叠为「等 N 条」；hover / 聚焦看完整原文
  function renderUsed(usedEl, msg) {
    if (!usedEl) return;
    const list = (msg && Array.isArray(msg.memoriesUsed)) ? msg.memoriesUsed : [];
    // 演示模式的回复没有真实记忆；流式过程中先不出现，等 done 后一次成型
    if (!list.length || demoEnabled || (msg && msg.streaming)) {
      usedEl.textContent = '';
      usedEl.dataset.sig = '';
      setHidden(usedEl, true);
      return;
    }
    const sig = list.join('\u0001');
    if (usedEl.dataset.sig === sig) { // 幂等：重复渲染不重复插入
      setHidden(usedEl, false);
      return;
    }
    usedEl.dataset.sig = sig;
    usedEl.textContent = '';
    usedEl.appendChild(makeEl('span', 'msg__used-label', '用到了：'));
    list.slice(0, USED_MEMORY_SHOW).forEach(function (text, i) {
      if (i > 0) usedEl.appendChild(makeEl('span', 'msg__used-sep', '、'));
      const item = makeEl('span', 'msg__used-item', clipText(text, 18));
      item.title = text;                                     // 轻量 tooltip：完整原文
      item.setAttribute('aria-label', '用到的记忆：' + text);
      item.setAttribute('tabindex', '0');                    // 键盘聚焦也能看到
      usedEl.appendChild(item);
    });
    if (list.length > USED_MEMORY_SHOW) {
      usedEl.appendChild(makeEl('span', 'msg__used-more', ' 等 ' + list.length + ' 条'));
    }
    // 有折叠时，整行 hover 也能看到全部原文
    if (list.length > USED_MEMORY_SHOW) usedEl.title = list.join('；');
    else usedEl.removeAttribute('title');
    setHidden(usedEl, false);
  }

  // 演示模式切换后同步「用到了」的显隐（不重建整段消息，避免滚动跳动）
  function refreshUsedRows() {
    if (!el.messages) return;
    const session = getSession(activeId);
    if (!session) return;
    const nodes = el.messages.querySelectorAll('.msg--assistant');
    for (let i = 0; i < nodes.length; i += 1) {
      const index = Number(nodes[i].dataset.index);
      if (!Number.isInteger(index)) continue;
      const msg = session.messages[index];
      if (msg) renderUsed(nodes[i].querySelector('.msg__used'), msg);
    }
  }

  function buildAssistantMessage(msg, index) {
    const article = makeEl('article', 'msg msg--assistant');
    article.dataset.index = String(index);

    const avatar = makeEl('div', 'msg__avatar', '屿');
    avatar.setAttribute('aria-hidden', 'true');

    const body = makeEl('div', 'msg__body');
    const bubbles = makeEl('div', 'msg__bubbles');
    const note = makeEl('div', 'msg__note');
    setHidden(note, true);

    const dbg = makeEl('details', 'dbg');
    dbg.appendChild(makeEl('summary', null, ''));
    dbg.appendChild(makeEl('pre', 'dbg__json', ''));
    setHidden(dbg, true);

    const used = makeEl('div', 'msg__used');
    setHidden(used, true);

    const foot = makeEl('div', 'msg__foot');
    const meta = makeEl('span', 'msg__meta');
    foot.appendChild(meta);
    foot.appendChild(makeActionButton('copy', '复制回复', 'i-copy'));
    foot.appendChild(makeActionButton('retry', '重新生成', 'i-retry'));

    body.appendChild(bubbles);
    body.appendChild(note);
    body.appendChild(dbg);
    body.appendChild(used);
    body.appendChild(foot);
    article.appendChild(avatar);
    article.appendChild(body);

    renderAssistantBody(article, msg);
    return article;
  }

  // 渲染/更新助手气泡内容（流式过程中会被反复调用）
  function renderAssistantBody(article, msg) {
    if (!article) return;
    article.classList.toggle('msg--error', !!msg.error);
    article.classList.toggle('msg--blocked', !!msg.blocked);
    article.classList.toggle('msg--typing', !msg.content && !!msg.streaming);

    const sig = msg.streaming
      ? 's|' + (msg.content || '') + '|' + (msg.waitingText || '')
      : 'f|' + (Array.isArray(msg.parts) ? msg.parts.join(String.fromCharCode(1)) : (msg.content || '')) +
        '|' + (msg.error ? 'e' : '') + '|' + (msg.blocked ? 'b' : '') + '|' + (msg.stopped ? 's' : '');
    if (article.dataset.sig !== sig) {
      article.dataset.sig = sig;
      try {
        renderBubbles(article.querySelector('.msg__bubbles'), msg);
      } catch (e) { /* 渲染异常不影响主流程 */ }
    }

    renderNote(article.querySelector('.msg__note'), msg);
    renderDebug(article.querySelector('.dbg'), msg);
    renderUsed(article.querySelector('.msg__used'), msg);
    renderMeta(article.querySelector('.msg__meta'), msg);

    const actions = article.querySelectorAll('.msg__action');
    for (let i = 0; i < actions.length; i += 1) actions[i].disabled = !!msg.streaming;
  }


  function buildMessageEl(msg, index) {
    if (msg.role === 'user') return buildUserMessage(msg);
    if (msg.role === 'assistant') return buildAssistantMessage(msg, index);
    return buildSystemMessage(msg);
  }

  /**
   * 渲染整段消息。
   * animateFrom：从该下标开始的消息带「上浮 + 淡入 + 轻微缩放」入场动画，
   * 其余（历史消息、会话切换）保持静态，避免整列表重播造成闪烁。
   */
  function renderMessages(animateFrom) {
    if (!el.messages) return;
    const session = getSession(activeId);
    el.messages.textContent = '';
    if (!session) return;
    const from = Number.isInteger(animateFrom) ? animateFrom : -1;
    const animate = from >= 0 && !reducedMotion();
    session.messages.forEach((msg, index) => {
      const node = buildMessageEl(msg, index);
      if (animate && index >= from) {
        node.classList.add('is-enter');
        const step = index - from;
        if (step > 0) node.style.animationDelay = Math.round(step * 70) + 'ms';
      }
      el.messages.appendChild(node);
    });
    // 若正在流式更新，重新绑定被重建的 DOM 引用
    if (pending && pending.session === session) {
      const live = el.messages.querySelector('.msg--assistant[data-index="' + pending.index + '"]');
      if (live) pending.el = live;
    }
  }

  function buildSessionItem(session) {
    const li = makeEl('li', 'session-item');
    if (session.id === activeId) li.classList.add('is-active');
    li.dataset.id = session.id;

    const main = makeEl('button', 'session-item__main');
    main.type = 'button';
    main.dataset.action = 'open';
    main.setAttribute('aria-label', '打开对话：' + (session.title || DEFAULT_TITLE));
    main.title = session.title || DEFAULT_TITLE;
    main.appendChild(makeEl('span', 'session-item__title', session.title || DEFAULT_TITLE));

    const del = makeEl('button', 'session-item__del');
    del.type = 'button';
    del.dataset.action = 'delete';
    del.setAttribute('aria-label', '删除对话：' + (session.title || DEFAULT_TITLE));
    del.title = '删除对话';
    del.appendChild(svgIcon('i-trash'));

    li.appendChild(main);
    li.appendChild(del);
    return li;
  }

  // 上一次渲染的会话 id 列表：用来判断哪些是「新增」，从而只给新条目播入场动画
  let renderedSessionIds = null;

  function renderSessionList() {
    if (!el.sessionList) return;
    const list = sortedSessions();
    const prevIds = renderedSessionIds;
    const isFirst = !prevIds;
    el.sessionList.textContent = '';
    list.forEach((s) => {
      const li = buildSessionItem(s);
      if (!isFirst && prevIds.indexOf(s.id) === -1 && !reducedMotion()) {
        li.classList.add('is-entering'); // 新增：高度 + 透明度过渡，避免列表跳变
      }
      el.sessionList.appendChild(li);
    });
    renderedSessionIds = list.map((s) => s.id);
    refreshLayerHidden(el.sidebar); // 老浏览器降级时补 tabindex="-1"
    // “没有其它会话时”显示空状态提示
    if (el.sessionsEmpty) setHidden(el.sessionsEmpty, list.length > 1);
  }

  // 按 id 找到会话列表里的 <li>（用于删除时的退场动画）
  function sessionListItem(id) {
    if (!el.sessionList) return null;
    const items = el.sessionList.children;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].dataset.id === id) return items[i];
    }
    return null;
  }

  function updateTitle(session) {
    if (el.chatTitle) el.chatTitle.textContent = (session && session.title) || DEFAULT_TITLE;
  }

  function updateWelcome(session) {
    setHidden(el.welcome, !!(session && session.messages.length));
  }

  function renderAll() {
    const session = ensureActive();
    updateTitle(session);
    renderMessages();
    renderSessionList();
    updateWelcome(session);
  }

  /* ============================================================
   * 八、滚动 / 输入框 / Toast
   * ============================================================ */

  function scrollables() {
    return [el.messages, el.chat].filter(Boolean);
  }

  function scrollToBottom(smooth) {
    scrollables().forEach((node) => {
      if (smooth) {
        try { node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }); }
        catch (e) { node.scrollTop = node.scrollHeight; }
        return;
      }
      // 立即到底：临时关闭 scroll-behavior，避免流式更新时被平滑滚动拖住
      const prev = node.style.scrollBehavior;
      node.style.scrollBehavior = 'auto';
      node.scrollTop = node.scrollHeight;
      node.style.scrollBehavior = prev;
    });
  }

  function isNearBottom() {
    const nodes = [el.messages, el.chat];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) continue;
      const oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
        return node.scrollHeight - node.scrollTop - node.clientHeight <= SCROLL_THRESHOLD;
      }
    }
    return true;
  }

  function updateScrollButton() {
    const btn = el.scrollBottom;
    if (!btn) return;
    const shouldShow = !stickBottom;
    if (shouldShow === scrollBtnVisible) return; // 滚动过程中不反复改 DOM
    scrollBtnVisible = shouldShow;
    if (shouldShow) {
      setHidden(btn, false);
      nextFrame(function () { btn.classList.add('is-visible'); }); // 浮起 + 淡入
      return;
    }
    btn.classList.remove('is-visible');
    window.setTimeout(function () {
      if (!scrollBtnVisible) setHidden(btn, true); // 退场动画结束后再移出布局
    }, layerDelay(180));
  }

  function handleScroll() {
    stickBottom = isNearBottom();
    updateScrollButton();
  }

  function autosize() {
    if (!el.input) return;
    el.input.style.height = 'auto';
    let max = parseFloat(getComputedStyle(el.input).maxHeight);
    if (!max || Number.isNaN(max) || max <= 0) max = 180;
    const next = Math.min(el.input.scrollHeight, max);
    el.input.style.height = next + 'px';
    el.input.style.overflowY = el.input.scrollHeight > max ? 'auto' : 'hidden';
  }

  function toast(message, type) {
    if (!el.toasts) return;
    const node = makeEl('div', 'toast' + (type ? ' toast--' + type : ''), message || '');
    node.setAttribute('role', 'status');
    el.toasts.appendChild(node);
    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
    }, 3000);
  }

  // 读屏播报：只在「一条回复完成」时写一次，且截断到 200 字，
  // 避免流式重渲染让 aria-live 反复朗读整段对话。
  function announceMessage(text) {
    if (!el.srLive) return;
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const chars = Array.from(clean);
    const clipped = chars.length > SR_LIVE_MAX ? chars.slice(0, SR_LIVE_MAX).join('') + '…' : clean;
    // 先清空再写入，保证内容相同时也会重新播报
    el.srLive.textContent = '';
    window.setTimeout(function () {
      if (el.srLive) el.srLive.textContent = clipped;
    }, 30);
  }

  /* ============================================================
   * 九、SSE 解析（按空行分块，块内逐行解析）
   * ============================================================ */

  // 从缓冲区中切出“完整的事件块”，返回 { blocks, rest }
  function drainBlocks(buffer) {
    const blocks = [];
    const sep = /\r?\n\r?\n/;
    let rest = buffer;
    let m = sep.exec(rest);
    while (m) {
      blocks.push(rest.slice(0, m.index));
      rest = rest.slice(m.index + m[0].length);
      m = sep.exec(rest);
    }
    return { blocks: blocks, rest: rest };
  }

  // 把单个块拆成若干事件（兼容 event/data 之间无空行、甚至事件之间无空行的写法）
  function splitEvents(block) {
    const lines = block.split(/\r?\n/);
    const groups = [];
    let current = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^event\s*:/.test(line)) {
        if (current) groups.push(current);
        current = [line];
      } else if (/^(data|id|retry)\s*:/.test(line)) {
        if (!current) current = [];
        current.push(line);
      } else if (line.charAt(0) === ':') {
        // SSE 注释行，忽略
      } else if (line.trim() !== '' && current) {
        current.push(line);
      }
    }
    if (current) groups.push(current);
    return groups.map(parseEventLines);
  }

  function parseEventLines(lines) {
    let event = 'message';
    const dataLines = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = String(lines[i]).replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim();
      let value = line.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1); // SSE：冒号后可选一个空格
      if (field === 'event') event = value.trim();
      else if (field === 'data') dataLines.push(value);
    }
    const raw = dataLines.join('\n');
    let data = null;
    if (raw.trim()) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    }
    return { event: event, data: data };
  }

  /* ============================================================
   * 十、流式渲染调度
   * ============================================================ */

  function scheduleAssistantRender() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      try {
        if (pending && pending.el) renderAssistantBody(pending.el, pending.msg);
        if (stickBottom) scrollToBottom(false);
      } catch (e) { /* 渲染异常不影响主流程 */ }
    });
  }

  function flushAssistantRender() {
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    if (pending && pending.el) renderAssistantBody(pending.el, pending.msg);
  }

  /* ============================================================
   * 十一、网络：流式请求 + 非流式降级 + 健康检查
   * ============================================================ */

  // 处理单个 SSE 事件；返回后由调用方决定是否继续读流
  function applyStreamEvent(ev, assistant) {
    if (!ev) return;
    const data = ev.data || {};

    if (ev.event === 'meta') {
      if (data.sessionId) assistant.serverSessionId = String(data.sessionId);
      if (data.strategy) assistant.strategy = String(data.strategy);
      if (data.strategyLabel) assistant.strategyLabel = String(data.strategyLabel);
      if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
      const metaRoute = sanitizeRoute(data.route);
      if (metaRoute) assistant.route = metaRoute;
      scheduleAssistantRender();
      return;
    }

    if (ev.event === 'delta') {
      const piece = typeof data.text === 'string' ? data.text : '';
      if (piece) {
        assistant.gotDelta = true;
        if (assistant.waitingText) assistant.waitingText = '';
        assistant.content += piece;
        scheduleAssistantRender();
      }
      return;
    }

    if (ev.event === 'replace') {
      // 安全拦截：整体替换，不回放此前增量
      if (typeof data.reply === 'string' && data.reply) assistant.content = data.reply;
      assistant.blocked = data.blocked !== false;
      if (data.reason) assistant.blockReason = String(data.reason);
      scheduleAssistantRender();
      return;
    }

    if (ev.event === 'error') {
      // 后端可能随后仍补一个 done，因此这里只提示 + 占位，不结束流程
      assistant.error = true;
      toast(ERROR_TOAST, 'error');
      if (!assistant.content) assistant.content = ERROR_FALLBACK;
      scheduleAssistantRender();
      return;
    }

    if (ev.event === 'done') {
      if (typeof data.reply === 'string' && data.reply) {
        assistant.content = data.reply;
        assistant.error = false;
      }
      if (data.strategy) assistant.strategy = String(data.strategy);
      if (data.strategyLabel) assistant.strategyLabel = String(data.strategyLabel);
      if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
      if (data.sessionId) assistant.serverSessionId = String(data.sessionId);
      const doneRoute = sanitizeRoute(data.route);
      if (doneRoute) assistant.route = doneRoute;
      if (data.memory && data.memory.action) {
        assistant.memory = {
          action: String(data.memory.action),
          item: data.memory.item == null ? '' : String(data.memory.item),
        };
        applyMemoryFeedback(assistant.memory); // 即时同步「我记得」列表
      }
      // 本轮实际用到的记忆：字段缺失 / 为空时不显示（后端未升级也能正常用）
      const doneUsed = normalizeMemoriesUsed(
        data.memoriesUsed !== undefined ? data.memoriesUsed : data.memories_used
      );
      if (doneUsed.length) assistant.memoriesUsed = doneUsed;
      assistant.blocked = !!data.blocked;
      assistant.done = true;
    }
  }

  // 手动解析 text/event-stream；返回是否收到 done
  async function streamChat(text, sessionId, assistant, signal, isRetry) {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ message: text, sessionId: sessionId, retry: isRetry === true }),
      signal: signal,
    });
    if (!res.ok) throw new Error('stream_http_' + res.status);
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('stream_no_body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const consume = (block) => {
      if (!block || !block.trim()) return;
      const events = splitEvents(block);
      for (let i = 0; i < events.length; i += 1) applyStreamEvent(events[i], assistant);
    };

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        if (chunk.done) break;

        const drained = drainBlocks(buffer);
        buffer = drained.rest;
        for (let i = 0; i < drained.blocks.length; i += 1) consume(drained.blocks[i]);

        if (assistant.done) {
          try { await reader.cancel(); } catch (e) { /* 忽略 */ }
          return true;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } finally {
      try { reader.releaseLock(); } catch (e) { /* 忽略 */ }
    }

    return assistant.done === true;
  }

  // 非流式降级
  async function fetchNonStream(text, sessionId, signal, isRetry) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: sessionId, retry: isRetry === true }),
      signal: signal,
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const json = await res.json();
    if (!json || json.ok !== true || !json.data) throw new Error('bad_payload');
    return json.data;
  }

  function adoptBackendSession(session, backendId) {
    if (!backendId || backendId === session.id) return;
    const dup = sessions.find((s) => s !== session && s.id === backendId);
    if (dup) return; // 极小概率的 id 冲突：保持本地 id 更安全
    const oldId = session.id;
    session.id = backendId;
    if (activeId === oldId) activeId = backendId;
    saveState();
  }

  function degradeLocally(assistant, message) {
    assistant.content = assistant.content || LOCAL_FALLBACK;
    assistant.error = true;
    toast(message || NET_FAIL_TOAST, 'error');
  }

  async function fallbackReply(text, session, assistant, signal, isRetry) {
    const data = await fetchNonStream(text, session.id, signal, isRetry);
    if (data.sessionId) adoptBackendSession(session, String(data.sessionId));
    assistant.content = typeof data.reply === 'string' ? data.reply : '';
    if (data.strategy) assistant.strategy = String(data.strategy);
    if (data.strategyLabel) assistant.strategyLabel = String(data.strategyLabel);
    if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
    const route = sanitizeRoute(data.route);
    if (route) assistant.route = route;
    if (data.memory && data.memory.action) {
      assistant.memory = {
        action: String(data.memory.action),
        item: data.memory.item == null ? '' : String(data.memory.item),
      };
      applyMemoryFeedback(assistant.memory); // 即时同步「我记得」列表
    }
    const fallbackUsed = normalizeMemoriesUsed(
      data.memoriesUsed !== undefined ? data.memoriesUsed : data.memories_used
    );
    if (fallbackUsed.length) assistant.memoriesUsed = fallbackUsed;
    assistant.blocked = !!data.blocked;
    assistant.error = false;
    assistant.done = true;
    if (!assistant.content) {
      assistant.content = LOCAL_FALLBACK;
      assistant.error = true;
    }
  }

  /* ============================================================
   * 十二、对话流程
   * ============================================================ */

  function syncComposer() {
    const hasText = !!(el.input && el.input.value.trim());
    if (el.sendBtn) {
      if (generating) {
        // 生成中：发送键切换为「停止生成」，点击可中止本次流式请求
        el.sendBtn.disabled = false;
        el.sendBtn.classList.add('is-stop');
        el.sendBtn.setAttribute('aria-label', '停止生成');
      } else {
        el.sendBtn.disabled = !hasText;
        el.sendBtn.classList.remove('is-stop');
        el.sendBtn.setAttribute('aria-label', '发送消息');
      }
      const use = el.sendBtn.querySelector('use');
      if (use) use.setAttribute('href', generating ? '#i-stop' : '#i-send');
    }
    if (el.input) el.input.setAttribute('aria-busy', generating ? 'true' : 'false');
  }

  function focusInput() {
    try { el.input.focus(); } catch (e) { /* 忽略 */ }
  }

  function finalizeTurn(session, assistant) {
    assistant.streaming = false;
    assistant.waitingText = '';
    if (!assistant.content) {
      assistant.content = LOCAL_FALLBACK;
      assistant.error = true;
    }
    // 收尾时再计算分气泡，避免流式过程中反复拆分
    if (!Array.isArray(assistant.parts) || !assistant.parts.length) {
      try { assistant.parts = splitReply(assistant.content, assistant); }
      catch (e) { assistant.parts = [assistant.content]; }
    }
    if (assistant.serverSessionId) adoptBackendSession(session, assistant.serverSessionId);
    session.updatedAt = now();

    if (pending && pending.msg === assistant && pending.el && pending.el.isConnected) {
      try { flushAssistantRender(); } catch (e) { /* 渲染失败也不能阻塞收尾 */ }
    }
    pending = null;

    // 无障碍：整条回复完成后再播报一次，流式过程不打扰读屏
    try { announceMessage(assistant.content); } catch (e) { /* 播报失败不影响主流程 */ }

    saveState();
    try {
      renderSessionList();
      if (activeId === session.id) {
        updateTitle(session);
        updateWelcome(session);
        if (stickBottom) scrollToBottom(false);
      }
    } catch (e) { /* 收尾渲染异常忽略 */ }
  }

  async function startGeneration(text, session, assistant, isRetry) {
    generating = true;
    syncComposer();

    const controller = new AbortController();
    activeController = controller;
    let aborted = false;
    let waitTimer = 0;

    try {
      // 拟人化：先让「正在输入…」停留 500–1200ms，再真正发起请求（期间可点停止）
      assistant.gotDelta = false;
      assistant.waitingText = '';
      await sleep(randomBetween(THINK_MIN_MS, THINK_MAX_MS));
      if (controller.signal.aborted) { aborted = true; return; }

      // 首字兜底：900ms 内没有第一个 delta，就把占位文案换成更自然的一句
      waitTimer = window.setTimeout(function () {
        if (assistant.done || assistant.gotDelta || !assistant.streaming) return;
        assistant.waitingText = WAIT_TEXT;
        // 直接渲染一次：后台标签页里 rAF 可能被节流，兜底文案不能等下一帧
        try {
          flushAssistantRender();
          if (stickBottom) scrollToBottom(false);
        } catch (e) { /* 渲染异常不影响请求 */ }
      }, FIRST_TOKEN_MS);

      const finished = await streamChat(text, session.id, assistant, controller.signal, isRetry);
      if (!finished && !controller.signal.aborted) {
        // 流提前结束却没有 done：按“流中断”处理，降级到非流式
        try {
          await fallbackReply(text, session, assistant, controller.signal, isRetry);
          toast(FALLBACK_TOAST, 'success');
        } catch (e) {
          degradeLocally(assistant, NET_FAIL_TOAST);
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        aborted = true;
      } else {
        // 网络异常 / !res.ok / 解析异常 -> 自动降级
        try {
          await fallbackReply(text, session, assistant, controller.signal, isRetry);
          toast(FALLBACK_TOAST, 'success');
        } catch (e) {
          degradeLocally(assistant, NET_FAIL_TOAST);
        }
      }
    } finally {
      if (waitTimer) window.clearTimeout(waitTimer);
      // 中止可能表现为“抛 AbortError”“流提前结束”两种，统一以 signal 判定
      const stopped = aborted || controller.signal.aborted;
      if (stopped) {
        // 保留已生成的部分内容，并标注为“已停止”
        assistant.content = assistant.content ? (assistant.content + ' ' + ABORT_TEXT) : ABORT_TEXT;
        assistant.stopped = true;
      }
      try { finalizeTurn(session, assistant); } catch (e) { /* 保证绝不卡在“正在回复…” */ }
      generating = false;
      if (activeController === controller) activeController = null;
      try { syncComposer(); autosize(); } catch (e) { /* 忽略 */ }
    }
  }

  function submitMessage() {
    // 生成中再点发送键 = 停止生成（必须在空文本判断之前：此时输入框已被清空）
    if (generating) { abortActiveStream(); return; }

    const text = (el.input.value || '').trim();
    if (!text) return;

    const session = ensureActive();

    // 用户消息
    session.messages.push({ role: 'user', content: text, ts: now() });
    if (!session.title || session.title === DEFAULT_TITLE) {
      session.title = truncateTitle(text);
    }

    // 助手占位（流式期间复用，结束时再落盘）
    const assistant = {
      role: 'assistant', content: '', strategy: '', riskLevel: '',
      blocked: false, streaming: true, ts: now(),
    };
    session.messages.push(assistant);
    session.updatedAt = now();

    el.input.value = '';
    // 发送后输入框高度平滑回落（只在回落这一下挂 transition，打字时不做布局动画）
    if (!reducedMotion()) {
      el.input.classList.add('is-collapsing');
      window.setTimeout(function () { el.input.classList.remove('is-collapsing'); }, 240);
    }
    autosize();
    syncComposer();
    sendPulse();

    renderMessages(session.messages.length - 2); // 本轮的用户消息 + 助手占位依次入场
    renderSessionList();
    updateTitle(session);
    updateWelcome(session);
    stickBottom = true;
    updateScrollButton();
    scrollToBottom(true);
    saveState();

    const index = session.messages.length - 1;
    pending = {
      session: session,
      msg: assistant,
      index: index,
      el: el.messages.querySelector('.msg--assistant[data-index="' + index + '"]'),
    };

    startGeneration(text, session, assistant);
  }

  function abortActiveStream() {
    if (activeController) {
      try { activeController.abort(); } catch (e) { /* 忽略 */ }
    }
  }

  function retryMessage(index) {
    if (generating) { toast(GENERATING_TOAST); return; }
    const session = ensureActive();
    const msg = session.messages[index];
    if (!msg || msg.role !== 'assistant') return;

    // 找到该回复对应的上一条用户消息
    let userText = '';
    for (let i = index - 1; i >= 0; i -= 1) {
      if (session.messages[i].role === 'user') { userText = session.messages[i].content; break; }
    }
    if (!userText) { toast('找不到对应的提问，无法重试', 'error'); return; }

    msg.content = '';
    msg.strategy = '';
    msg.strategyLabel = '';
    msg.riskLevel = '';
    msg.route = null;
    msg.memory = null;
    msg.memoriesUsed = null;
    msg.parts = null;
    msg.stopped = false;
    msg.blocked = false;
    msg.error = false;
    msg.done = false;
    msg.streaming = true;
    msg.ts = now();
    session.updatedAt = now();

    renderMessages(index); // 重试时该条回复重新入场
    stickBottom = true;
    updateScrollButton();
    scrollToBottom(false);
    saveState();

    pending = {
      session: session,
      msg: msg,
      index: index,
      el: el.messages.querySelector('.msg--assistant[data-index="' + index + '"]'),
    };

    startGeneration(userText, session, msg, true);
  }

  /* ============================================================
   * 十三、会话操作
   * ============================================================ */

  function switchSession(id) {
    const session = getSession(id);
    if (!session) return;
    if (session.id !== activeId) {
      abortActiveStream();
      activeId = session.id;
      saveState();
      renderAll();
      stickBottom = true;
      updateScrollButton();
      scrollToBottom(false);
    }
    closeSidebar();
    focusInput();
  }

  function startNewChat() {
    loadComeback(false); // 每次开新对话都重拉一次（短间隔走缓存，避免频繁请求）
    const current = getSession(activeId);
    if (current && current.messages.length === 0) {
      renderAll();
      closeSidebar();
      focusInput();
      return;
    }
    abortActiveStream();
    const session = createSession();
    sessions.unshift(session);
    activeId = session.id;
    saveState();
    renderAll();
    stickBottom = true;
    updateScrollButton();
    scrollToBottom(false);
    closeSidebar();
    focusInput();
  }

  function deleteSession(id) {
    const session = getSession(id);
    if (!session) return;
    const wasActive = id === activeId;
    if (wasActive) abortActiveStream();

    const remove = function () {
      sessions = sessions.filter((s) => s.id !== id);
      if (wasActive) {
        activeId = '';
        saveState();
        ensureActive();
        renderAll();
      } else {
        saveState();
        renderSessionList();
      }
      toast('已删除这个对话', 'success');
      closeSidebar();
    };

    // 先播「高度 + 透明度」退场动画，再真正移除，避免列表瞬间跳变
    const li = sessionListItem(id);
    if (li && !reducedMotion()) {
      li.classList.add('is-leaving');
      window.setTimeout(remove, 200);
    } else {
      remove();
    }
  }

  /* ============================================================
   * 十四、侧边栏 / 主题 / 弹窗 / 复制
   * ============================================================ */

  function openSidebar(trigger) {
    if (el.app) el.app.classList.add('is-sidebar-open');
    sidebarReturnFocus = trigger || (document.activeElement !== document.body ? document.activeElement : null);
    setHidden(el.scrim, false);
    syncSidebarHidden();  // 可见 -> 解除 inert
    syncLayerAria();
    window.setTimeout(function () {
      if (!isSidebarOpen()) return;
      const items = collectFocusable(el.sidebar);
      if (items.length) { try { items[0].focus(); } catch (e) { /* 忽略 */ } }
    }, 60);
  }

  function closeSidebar() {
    const wasOpen = isSidebarOpen();
    if (el.app) el.app.classList.remove('is-sidebar-open');
    setHidden(el.scrim, true);
    syncSidebarHidden();  // 隐藏 -> 加 inert（宽屏常驻时自动跳过）
    syncLayerAria();
    if (wasOpen) {
      returnFocusTo(sidebarReturnFocus, el.sidebarOpen);
      sidebarReturnFocus = null;
    }
  }

  function isSidebarOpen() {
    return !!(el.app && el.app.classList.contains('is-sidebar-open'));
  }

  function applyTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', value);
    if (el.themeIconUse) el.themeIconUse.setAttribute('href', value === 'dark' ? '#i-sun' : '#i-moon');
    if (el.themeText) el.themeText.textContent = value === 'dark' ? '浅色模式' : '深色模式';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'dark' ? '#0f172a' : '#5b8def');
  }

  function initTheme() {
    let saved = '';
    try { saved = localStorage.getItem(LS_KEYS.theme) || ''; } catch (e) { saved = ''; }
    let theme = (saved === 'dark' || saved === 'light') ? saved : '';
    if (!theme) {
      const prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      theme = prefersDark ? 'dark' : 'light';
    }
    applyTheme(theme);
  }

  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    // 平滑过渡：切换期间给根节点挂类，240ms 后摘掉（不改动其它组件自身的 transition）
    if (!reducedMotion()) {
      if (themeAnimTimer) window.clearTimeout(themeAnimTimer);
      root.classList.add('is-theme-anim');
      themeAnimTimer = window.setTimeout(function () {
        themeAnimTimer = 0;
        root.classList.remove('is-theme-anim');
      }, 280);
    }
    applyTheme(next);
    try { localStorage.setItem(LS_KEYS.theme, next); } catch (e) { /* 忽略 */ }
  }

  function openAbout() {
    if (!el.aboutModal || typeof el.aboutModal.showModal !== 'function') return;
    try { openDialog(el.aboutModal); } catch (e) { /* 忽略 */ }
  }

  function closeAbout() {
    if (!el.aboutModal) return;
    try { closeDialog(el.aboutModal); } catch (e) { /* 忽略 */ }
  }

  async function copyMessage(text, btn) {
    const value = String(text || '');
    if (!value) { toast('这条回复还是空的', 'error'); return; }
    let ok = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(value); ok = true; } catch (e) { ok = false; }
    }
    if (!ok) ok = legacyCopy(value);
    if (ok) markCopied(btn); // 按钮短暂变成「✓ 已复制」
    toast(ok ? COPY_OK_TEXT : COPY_FAIL_TEXT, ok ? 'success' : 'error');
  }

  function legacyCopy(value) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  /* ============================================================
   * 十五、健康检查
   * ============================================================ */

  function setHealth(state, statusText, modelText) {
    // 演示模式开启时，状态胶囊固定显示「演示模式」（复用 ok 状态，不改样式假设）
    if (el.statusPill) {
      el.statusPill.dataset.state = demoEnabled ? 'ok' : state;
      el.statusPill.textContent = demoEnabled ? '演示模式' : statusText;
    }
    if (el.modelDot) el.modelDot.dataset.state = demoEnabled ? 'ok' : state;
    if (el.modelPill) el.modelPill.textContent = modelText;
  }

  // 健康检查：同时维护「未配置模型」提示与首次启动向导
  async function refreshHealth(silent) {
    if (!silent) setHealth('loading', '连接中…', '模型检测中…');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw makeApiError('http_' + res.status, res.status);
      const data = await res.json();
      if (!data || data.ok !== true) throw makeApiError('bad_payload', 0);
      const model = typeof data.model === 'string' ? data.model.trim() : '';
      const configured = !!data.configured;
      healthConfigured = configured;
      if (configured) {
        setHealth('ok', '已连接', '模型：' + (model || '已配置'));
        setHidden(el.modelWarn, true);
        maybeAutoDisableDemo(); // 用户后来补了 Key：自动退出演示模式
      } else {
        setHealth('error', '模型未配置', '模型：未配置');
        setHidden(el.modelWarn, !!demoEnabled);
        // 首次进入且用户没有主动跳过时，引导配置；演示模式开启时不再强制打断
        if (!isSetupDismissed() && !isWizardOpen() && !activeDrawer && !demoEnabled) openWizard(1);
      }
      syncDemoUI();
      return data;
    } catch (e) {
      healthConfigured = null;
      setHealth('error', '连接失败', '模型：无法连接');
      syncDemoUI();
      return null;
    }
  }

  async function checkHealth() {
    await refreshHealth(false);
  }

  /* ============================================================
   * 十五·补、情感连续性（comeback）与免 Key 演示模式
   * ------------------------------------------------------------
   * 这两块都是「锦上添花」：接口缺失 / 超时 / 返回异常时一律静默降级到
   * 静态欢迎文案，绝不抛错、不白屏，也不影响聊天主流程。
   * ============================================================ */

  const FETCH_TIMEOUT_MS = 3000;

  // 带超时的 JSON 请求：网络失败 / 超时 / 非 2xx / ok !== true 一律返回 null
  async function fetchDataWithTimeout(path, options, timeoutMs) {
    const opts = options || {};
    const init = { method: opts.method || 'GET', headers: {}, cache: 'no-store' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(function () {
      try { controller.abort(); } catch (e) { /* 忽略 */ }
    }, timeoutMs || FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(path, Object.assign({}, init, { signal: controller.signal }));
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (!res.ok || !json || json.ok !== true) return null;
      return json.data === undefined ? json : json.data;
    } catch (e) {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function clipText(value, max) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
  }

  // 按中英文句末标点断句（问候语最多 1—2 句：第一句进标题，第二句进副标题）
  function splitSentences(text) {
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const matched = clean.match(/[^。！？!?…]+[。！？!?…]*/g);
    return (matched || [clean]).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // health 与 config 谁先回来都行：都拿不到时返回 null（未知）
  function isConfiguredState() {
    if (healthConfigured === true || healthConfigured === false) return healthConfigured;
    if (configCache && typeof configCache.configured === 'boolean') return configCache.configured;
    return null;
  }

  function normalizeSuggestion(item) {
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? { label: text, prompt: text } : null;
    }
    if (item && typeof item === 'object') {
      const prompt = String(item.prompt || item.text || item.question || item.content || '').trim();
      if (!prompt) return null;
      const label = String(item.label || item.title || '').trim() || prompt;
      return { label: label, prompt: prompt };
    }
    return null;
  }

  // 用建议替换 #suggestions 内容；为空 / 非法时回落到内置 4 条静态建议
  function renderSuggestions(items) {
    if (!el.suggestions) return;
    const list = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      const norm = normalizeSuggestion(item);
      if (norm && list.length < 4) list.push(norm);
    });
    const finalList = list.length ? list : STATIC_SUGGESTIONS.slice();
    el.suggestions.textContent = '';
    finalList.forEach(function (item) {
      const btn = makeEl('button', 'suggestion', clipText(item.label, 60) || item.prompt);
      btn.type = 'button';
      btn.dataset.prompt = item.prompt; // 现有发送逻辑依赖 data-prompt，契约不可改
      if (item.label !== item.prompt) btn.setAttribute('aria-label', item.prompt);
      el.suggestions.appendChild(btn);
    });
  }

  function recallText(value) {
    if (typeof value === 'string') return clipText(value, 16);
    if (value && typeof value === 'object') {
      return clipText(value.text || value.content || value.label, 16);
    }
    return '';
  }

  // 渲染 0—3 条「我记得」；为空时保持 #recall 隐藏
  function renderRecallChips(items) {
    if (!el.recallList || !el.recall) return;
    const list = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      const text = recallText(item);
      if (text && list.length < 3) list.push(text);
    });
    el.recallList.textContent = '';
    list.forEach(function (text) {
      el.recallList.appendChild(makeEl('li', 'recall__chip', text));
    });
    setHidden(el.recall, list.length === 0);
  }

  // 欢迎区是否当前可见（会话为空时 updateWelcome 才会显示它）
  function isWelcomeVisible() {
    return !!(el.welcome && !el.welcome.hidden);
  }

  // SSE done / 非流式回包里的 memory 反馈：即时同步「我记得」列表
  function applyMemoryFeedback(mem) {
    if (!mem || !mem.action || !el.recallList) return;
    if (mem.action === 'remember') {
      if (!isWelcomeVisible()) return; // 欢迎区不可见时跳过，等下次 comeback 重建
      const text = recallText(mem.item);
      if (!text) return;
      el.recallList.insertBefore(makeEl('li', 'recall__chip', text), el.recallList.firstChild);
      while (el.recallList.children.length > 3) el.recallList.removeChild(el.recallList.lastChild);
      setHidden(el.recall, false);
      return;
    }
    if (mem.action === 'forget') {
      const key = String(mem.item == null ? '' : mem.item).trim();
      if (!key) return;
      const chips = el.recallList.querySelectorAll('.recall__chip');
      for (let i = chips.length - 1; i >= 0; i -= 1) {
        if (chips[i].textContent.indexOf(key) !== -1) chips[i].parentNode.removeChild(chips[i]);
      }
      if (!el.recallList.children.length) setHidden(el.recall, true);
    }
  }

  // 把一次成功的 comeback 数据写进欢迎区；任何字段缺失都单独兜底
  function applyComeback(data) {
    if (!data || typeof data !== 'object') return;
    const sentences = splitSentences(data.greeting);
    if (el.heroTitle) {
      if (sentences.length) el.heroTitle.textContent = clipText(sentences[0], 48);
      else if (!el.heroTitle.textContent) el.heroTitle.textContent = DEFAULT_HERO_TITLE;
    }
    if (el.heroSub) {
      if (sentences.length > 1) el.heroSub.textContent = clipText(sentences[1], 80);
      else if (!el.heroSub.textContent) el.heroSub.textContent = DEFAULT_HERO_SUB;
    }
    renderRecallChips(data.memoryHighlights);
    renderSuggestions(data.suggestions);
    if (el.startersLabel) {
      if (data.timeOfDay === 'lateNight') el.startersLabel.textContent = '也可以这样开始';
      else if (data.timeOfDay === 'evening') el.startersLabel.textContent = '晚上也可以这样开始';
      else el.startersLabel.textContent = DEFAULT_STARTERS_LABEL;
    }
    if (data.demoAvailable === true) {
      demoCapable = true;
      syncDemoUI();
    }
  }

  // force=true 时忽略缓存（演示模式切换后需要新问候）
  async function loadComeback(force) {
    if (!force && comebackCache && comebackAt && (now() - comebackAt) < COMEBACK_CACHE_MS) {
      applyComeback(comebackCache); // 短间隔内复用缓存，避免频繁请求
      return comebackCache;
    }
    if (comebackInFlight) return comebackInFlight;
    comebackInFlight = (async function () {
      const data = await fetchDataWithTimeout('/api/comeback', { method: 'GET' }, COMEBACK_TIMEOUT_MS);
      if (data && typeof data === 'object') {
        comebackCache = data;
        comebackAt = now();
        applyComeback(data);
      }
      return data || null;
    })();
    try {
      return await comebackInFlight;
    } finally {
      comebackInFlight = null;
    }
  }

  // ── 演示模式 ────────────────────────────────────────────────

  function applyDemoPill() {
    if (el.statusPill && demoEnabled) {
      el.statusPill.dataset.state = 'ok';
      el.statusPill.textContent = '演示模式';
    }
  }

  function syncDemoUI() {
    // 演示模式没有真实记忆：状态变化时同步隐藏 / 恢复「用到了」提示
    if (demoApplied !== demoEnabled) {
      demoApplied = demoEnabled;
      try { refreshUsedRows(); } catch (e) { /* 忽略 */ }
    }
    if (el.demoEntryText) {
      el.demoEntryText.textContent = demoEnabled ? DEMO_ENTRY_ON_TEXT : DEMO_ENTRY_OFF_TEXT;
    }
    const configured = isConfiguredState();
    // 只在「确认未配置 Key」或「演示模式已开启」时露出入口
    const visible = demoCapable && (configured === false || demoEnabled);
    setHidden(el.demoEntry, !visible);
    if (demoEnabled) {
      setHidden(el.modelWarn, true);
      applyDemoPill();
    }
    return visible;
  }

  async function loadDemo() {
    const data = await fetchDataWithTimeout('/api/demo', { method: 'GET' }, DEMO_TIMEOUT_MS);
    if (data && typeof data === 'object') {
      demoCapable = true;
      demoEnabled = data.enabled === true;
    }
    syncDemoUI();
    return data || null;
  }

  async function toggleDemoFromEntry() {
    if (demoBusy || !el.demoEntry) return;
    demoBusy = true;
    el.demoEntry.disabled = true;
    const next = !demoEnabled;
    try {
      const data = await fetchDataWithTimeout('/api/demo', { method: 'POST', body: { enabled: next } }, DEMO_TIMEOUT_MS);
      if (!data || typeof data !== 'object') { toast(DEMO_FAIL_TOAST, 'error'); return; }
      demoCapable = true;
      demoEnabled = data.enabled === true;
      if (demoEnabled) {
        if (isWizardOpen()) closeWizard(true); // 关闭向导，让用户直接开始
        toast(DEMO_ON_TOAST, 'success');
      } else {
        toast(DEMO_OFF_TOAST);
      }
      syncDemoUI();
      await loadComeback(true);   // 重新拉「回来」问候与建议
      if (!demoEnabled) checkHealth(); // 退出后刷新连接状态
      focusInput();
    } catch (e) {
      toast(DEMO_FAIL_TOAST, 'error');
    } finally {
      demoBusy = false;
      if (el.demoEntry) el.demoEntry.disabled = false;
    }
  }

  // 关闭演示模式后，用已知的 health 状态恢复状态胶囊（避免残留「演示模式」）
  function reapplyHealthStatus() {
    if (healthConfigured === true) {
      setHealth('ok', '已连接', (el.modelPill && el.modelPill.textContent) || '模型：已配置');
    } else if (healthConfigured === false) {
      setHealth('error', '模型未配置', '模型：未配置');
      setHidden(el.modelWarn, false);
      if (!isSetupDismissed() && !isWizardOpen() && !activeDrawer) openWizard(1);
    } else {
      checkHealth(); // 状态未知时重新探测一次
    }
  }

  // 用户后来填了 Key 并保存成功：自动关闭演示模式（失败也以本地状态为准，静默处理）
  async function maybeAutoDisableDemo() {
    if (!demoEnabled || demoBusy) return;
    demoBusy = true;
    try {
      await fetchDataWithTimeout('/api/demo', { method: 'POST', body: { enabled: false } }, DEMO_TIMEOUT_MS);
    } catch (e) { /* 忽略：本地状态照样关闭 */ }
    demoEnabled = false;
    demoBusy = false;
    syncDemoUI();
    reapplyHealthStatus();
  }

  /* ============================================================
   * 十六、事件绑定
   * ============================================================ */

  // 当前焦点是否在会吃掉按键的输入控件里
  function isEditableTarget(node) {
    const target = node || document.activeElement;
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!target.isContentEditable;
  }

  function bindEvents() {
    // 侧边栏（传入触发按钮，关闭时焦点归还给它）
    if (el.sidebarOpen) el.sidebarOpen.addEventListener('click', function () { openSidebar(el.sidebarOpen); });
    if (el.sidebarClose) el.sidebarClose.addEventListener('click', closeSidebar);
    if (el.scrim) el.scrim.addEventListener('click', closeSidebar);

    // 会话列表（事件委托：切换 / 删除）
    if (el.sessionList) {
      el.sessionList.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const li = btn.closest('.session-item');
        const id = li && li.dataset.id;
        if (!id) return;
        if (btn.dataset.action === 'open') switchSession(id);
        else if (btn.dataset.action === 'delete') deleteSession(id);
      });
    }

    // 新对话
    if (el.newChat) el.newChat.addEventListener('click', startNewChat);

    // 免 Key 演示模式入口
    if (el.demoEntry) el.demoEntry.addEventListener('click', toggleDemoFromEntry);

    // 主题
    if (el.themeToggle) el.themeToggle.addEventListener('click', toggleTheme);

    // 关于弹窗
    if (el.openAbout) el.openAbout.addEventListener('click', openAbout);
    if (el.aboutClose) el.aboutClose.addEventListener('click', closeAbout);
    if (el.aboutModal) {
      el.aboutModal.addEventListener('click', function (e) {
        // 点击 ::backdrop 时，事件目标就是 dialog 本身
        if (e.target === el.aboutModal) closeAbout();
      });
      // Esc：拦下原生立即关闭，改走带退场动画的关闭
      el.aboutModal.addEventListener('cancel', function (e) {
        e.preventDefault();
        closeAbout();
      });
    }

    // 输入区
    if (el.form) el.form.addEventListener('submit', function (e) { e.preventDefault(); submitMessage(); });
    // 发送键：按压缩放 + 涟漪（pointerdown 比 click 更跟手；禁用态不会触发）
    if (el.sendBtn) {
      el.sendBtn.addEventListener('pointerdown', function () { pressFeedback(el.sendBtn); });
      el.sendBtn.addEventListener('pointerleave', function () { el.sendBtn.classList.remove('is-pressing'); });
      el.sendBtn.addEventListener('pointercancel', function () { el.sendBtn.classList.remove('is-pressing'); });
    }
    if (el.input) {
      el.input.addEventListener('input', function () { autosize(); syncComposer(); });
      el.input.addEventListener('compositionstart', function () { composing = true; });
      el.input.addEventListener('compositionend', function () { composing = false; });
      el.input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;                  // Shift+Enter 换行
        if (composing || e.isComposing || e.keyCode === 229) return;   // 输入法组合中不发送
        e.preventDefault();
        submitMessage();
      });
    }

    // 建议问题
    if (el.suggestions) {
      el.suggestions.addEventListener('click', function (e) {
        const btn = e.target.closest('button.suggestion[data-prompt]');
        if (!btn) return;
        if (generating) { toast(GENERATING_TOAST); return; }
        el.input.value = btn.dataset.prompt || btn.textContent || '';
        autosize();
        syncComposer();
        submitMessage();
      });
    }

    // 消息操作（复制 / 重试）
    if (el.messages) {
      el.messages.addEventListener('click', function (e) {
        const btn = e.target.closest('button.msg__action');
        if (!btn) return;
        const article = btn.closest('.msg--assistant');
        if (!article) return;
        const index = Number(article.dataset.index);
        if (!Number.isInteger(index)) return;
        const session = getSession(activeId);
        const msg = session && session.messages[index];
        if (!msg || msg.role !== 'assistant') return;
        if (btn.dataset.action === 'copy') copyMessage(msg.content, btn);
        else if (btn.dataset.action === 'retry') retryMessage(index);
      });
    }

    // 滚动
    scrollables().forEach((node) => node.addEventListener('scroll', handleScroll, { passive: true }));
    if (el.scrollBottom) {
      el.scrollBottom.addEventListener('click', function () {
        stickBottom = true;
        updateScrollButton();
        scrollToBottom(true);
      });
    }

    // 调试开关（状态存 localStorage）
    if (el.debugToggle) {
      el.debugToggle.addEventListener('click', function () {
        setDebug(!debugOn, true);
        toast(debugOn ? '调试面板已开启' : '调试面板已关闭');
      });
    }

    // 顶栏「未配置模型」提示 -> 再次打开向导
    if (el.modelWarn) el.modelWarn.addEventListener('click', function () { openWizard(1); });

    // 设置 / 记忆入口（传入触发按钮，关闭时焦点归还给它）
    if (el.openSettings) el.openSettings.addEventListener('click', function () { openDrawer('settings', el.openSettings); });
    if (el.openSettingsTop) el.openSettingsTop.addEventListener('click', function () { openDrawer('settings', el.openSettingsTop); });
    if (el.openMemory) el.openMemory.addEventListener('click', function () { openDrawer('memory', el.openMemory); });
    if (el.settingsClose) el.settingsClose.addEventListener('click', closeDrawer);
    if (el.memoryClose) el.memoryClose.addEventListener('click', closeDrawer);
    if (el.drawerScrim) el.drawerScrim.addEventListener('click', closeDrawer);

    // 键盘快捷键帮助：入口按钮 / 关闭按钮 / 点遮罩 / Esc
    if (el.openShortcuts) {
      el.openShortcuts.addEventListener('click', function () { openShortcuts(el.openShortcuts); });
    }
    if (el.shortcutsClose) el.shortcutsClose.addEventListener('click', closeShortcuts);
    if (el.shortcutsModal) {
      el.shortcutsModal.addEventListener('click', function (e) {
        if (e.target === el.shortcutsModal) closeShortcuts(); // 点 ::backdrop
      });
      el.shortcutsModal.addEventListener('cancel', function (e) {
        e.preventDefault(); // 拦下原生立即关闭，走带退场动画的关闭
        closeShortcuts();
      });
    }

    // 向导：上一步 / 下一步 / 暂不配置 / 点遮罩关闭
    if (el.wizardBack) el.wizardBack.addEventListener('click', function () { showWizardStep(wizardStep - 1); });
    if (el.wizardNext) el.wizardNext.addEventListener('click', wizardNext);
    if (el.wizardSkip) el.wizardSkip.addEventListener('click', function () { closeWizard(true); });
    if (el.wizardBackdrop) el.wizardBackdrop.addEventListener('click', function () { closeWizard(true); });
    if (el.wizardKeyEye) {
      el.wizardKeyEye.addEventListener('click', function () { togglePassword(el.wizardKey, el.wizardKeyEye); });
    }

    // 设置面板
    if (el.settingTemperature) el.settingTemperature.addEventListener('input', updateTemperatureLabel);
    if (el.settingKeyChange) {
      el.settingKeyChange.addEventListener('click', function () {
        const willShow = !!(el.settingKeyRow && el.settingKeyRow.hidden);
        setHidden(el.settingKeyRow, !willShow);
        if (willShow && el.settingKeyInput) {
          try { el.settingKeyInput.focus(); } catch (e) { /* 忽略 */ }
        }
      });
    }
    if (el.settingKeyEye) {
      el.settingKeyEye.addEventListener('click', function () { togglePassword(el.settingKeyInput, el.settingKeyEye); });
    }
    if (el.settingKeyClear) el.settingKeyClear.addEventListener('click', clearApiKey);
    if (el.settingsSave) el.settingsSave.addEventListener('click', function () { saveSettings(false); });
    if (el.settingsTest) el.settingsTest.addEventListener('click', testFromSettings);
    if (el.settingDebug) {
      el.settingDebug.addEventListener('change', function () { setDebug(!!el.settingDebug.checked, true); });
    }
    // 设置面板里也能随时重新打开向导
    if (el.openWizardAgain) {
      el.openWizardAgain.addEventListener('click', function () { closeDrawer(); openWizard(1); });
    }

    // 记忆面板
    if (el.memoryEnabled) el.memoryEnabled.addEventListener('change', toggleMemoryEnabled);
    if (el.memoryAddBtn) el.memoryAddBtn.addEventListener('click', addMemory);
    if (el.memoryAddText) {
      el.memoryAddText.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addMemory(); }
      });
    }
    if (el.memoryClear) el.memoryClear.addEventListener('click', clearMemories);
    if (el.memoryList) {
      el.memoryList.addEventListener('click', function (e) {
        const li = e.target.closest('.mem-item');
        if (!li || li.dataset.editing === 'true') return;
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const id = li.dataset.id;
        if (!id) return;
        if (btn.dataset.act === 'pin') patchMemory(id, { pinned: li.dataset.pinned !== 'true' }, '已更新置顶状态');
        else if (btn.dataset.act === 'edit') startMemoryEdit(li);
        else if (btn.dataset.act === 'del') deleteMemory(id);
      });
    }

    // 二次确认弹窗（dialog 的 Esc 也会走到 close 事件）
    if (el.confirmOk) el.confirmOk.addEventListener('click', function () { settleConfirm(true); });
    if (el.confirmCancel) el.confirmCancel.addEventListener('click', function () { settleConfirm(false); });
    if (el.confirmClose) el.confirmClose.addEventListener('click', function () { settleConfirm(false); });
    if (el.confirmModal) {
      el.confirmModal.addEventListener('click', function (e) {
        if (e.target === el.confirmModal) settleConfirm(false);
      });
      el.confirmModal.addEventListener('cancel', function (e) {
        e.preventDefault(); // 同上：Esc 也走退场动画
        settleConfirm(false);
      });
      el.confirmModal.addEventListener('close', function () {
        if (confirmResolve) settleConfirm(false);
      });
    }

    // 桌面外壳（Tauri）窗口按钮
    bindTitlebar();

    // 抽屉 / 移动端侧边栏内循环 Tab（焦点陷阱）
    document.addEventListener('keydown', handleLayerTab);

    // 全局快捷键：? 帮助、Ctrl/Cmd+K 新对话、Esc 按层级关闭
    document.addEventListener('keydown', function (e) {
      const key = e.key;
      // Ctrl/Cmd+K：新建对话
      if (!e.altKey && (e.ctrlKey || e.metaKey) && (key === 'k' || key === 'K')) {
        e.preventDefault();
        if (isShortcutsOpen()) closeShortcuts();
        startNewChat();
        return;
      }
      // ?：显示快捷键帮助（输入框 / 文本域 / 可编辑区域内不抢键）
      if (key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target) || isShortcutsOpen()) return;
        e.preventDefault();
        openShortcuts(document.activeElement);
        return;
      }
      if (key !== 'Escape') return;
      // 按层级关闭：快捷键帮助 → 向导 → 抽屉 → 侧边栏（<dialog> 的 Esc 由原生处理）
      if (isShortcutsOpen()) { closeShortcuts(); return; }
      if (isWizardOpen()) { closeWizard(true); return; }
      if (activeDrawer) { closeDrawer(); return; }
      if (isSidebarOpen()) closeSidebar();
    });

    // 尺寸变化：重算输入框高度与滚动状态，并同步侧边栏的可见性/无障碍状态
    window.addEventListener('resize', function () {
      autosize();
      stickBottom = isNearBottom();
      updateScrollButton();
      syncSidebarHidden();
      syncLayerAria();
    });

    // 回到前台时刷新连接状态
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkHealth();
    });
  }

  /* ============================================================
   * 十七、浮层基础：二次确认 / 抽屉 / 调试开关
   * ============================================================ */

  // 页面内二次确认（不阻塞渲染，也避免原生 confirm 在无头环境卡住）
  function openConfirm(options) {
    const opt = options || {};
    return new Promise((resolve) => {
      if (!el.confirmModal || typeof el.confirmModal.showModal !== 'function') {
        let agreed = false;
        try { agreed = window.confirm(opt.message || '确认执行这个操作？'); } catch (e) { agreed = false; }
        resolve(agreed);
        return;
      }
      confirmResolve = resolve;
      if (el.confirmTitle) el.confirmTitle.textContent = opt.title || '确认操作';
      if (el.confirmMessage) el.confirmMessage.textContent = opt.message || '';
      if (el.confirmOk) {
        el.confirmOk.textContent = opt.confirmText || '确定';
        el.confirmOk.classList.toggle('btn--danger', opt.danger !== false);
      }
      if (!openDialog(el.confirmModal)) settleConfirm(false);
    });
  }

  function settleConfirm(value) {
    const resolve = confirmResolve;
    confirmResolve = null;
    // 先给出结果，再播退场动画（Promise 不会因为动画延迟）
    closeDialog(el.confirmModal);
    if (resolve) resolve(!!value);
  }

  function openDrawer(name, trigger) {
    closeSidebar();
    activeDrawer = name;
    drawerReturnFocus = trigger || (document.activeElement !== document.body ? document.activeElement : null);
    const panel = name === 'settings' ? el.settingsDrawer : (name === 'memory' ? el.memoryDrawer : null);
    const other = name === 'settings' ? el.memoryDrawer : el.settingsDrawer;
    hideLayer(other, 160);                       // 两个抽屉互斥：另一个播退场
    setLayerHidden(other, true);                 // 隐藏中的抽屉不可聚焦
    setLayerHidden(panel, false);                // 目标抽屉可见 -> 解除 inert
    showLayer(el.drawerScrim, 'is-open', 220);   // 遮罩淡入（关闭时同样有淡出）
    showLayer(panel, 'is-open', 280);            // 滑入 + 缩放 + 淡入
    syncLayerAria();
    if (name === 'settings') loadConfig();
    else if (name === 'memory') loadMemory();
    if (panel) {
      window.setTimeout(function () {
        if (panel.hidden || activeDrawer !== name) return;
        const items = collectFocusable(panel);
        if (items.length) { try { items[0].focus(); } catch (e) { /* 忽略 */ } }
      }, 80);
    }
  }

  function closeDrawer() {
    const name = activeDrawer;
    activeDrawer = '';
    const target = drawerReturnFocus;
    drawerReturnFocus = null;
    hideLayer(el.settingsDrawer, 200);
    hideLayer(el.memoryDrawer, 200);
    hideLayer(el.drawerScrim, 200);
    setLayerHidden(el.settingsDrawer, true);  // 关闭后立即移出无障碍树与 Tab 序列
    setLayerHidden(el.memoryDrawer, true);
    syncLayerAria();
    if (name) {
      const fallback = name === 'memory' ? el.openMemory : (el.openSettingsTop || el.openSettings);
      returnFocusTo(target, fallback);
    }
  }

  /* ---- 键盘快捷键帮助（复用 <dialog class="modal"> 体系） ---- */

  function isShortcutsOpen() {
    return !!(el.shortcutsModal && el.shortcutsModal.open);
  }

  function openShortcuts(trigger) {
    if (!el.shortcutsModal || typeof el.shortcutsModal.showModal !== 'function') return false;
    if (isShortcutsOpen()) { setExpanded(el.openShortcuts, true); return true; }
    shortcutsReturnFocus = trigger || (document.activeElement !== document.body ? document.activeElement : null);
    if (!openDialog(el.shortcutsModal)) { // <dialog> 不可用时静默降级
      shortcutsReturnFocus = null;
      return false;
    }
    syncLayerAria();
    return true;
  }

  function closeShortcuts() {
    if (!el.shortcutsModal) return;
    const target = shortcutsReturnFocus;
    shortcutsReturnFocus = null;
    closeDialog(el.shortcutsModal, 190);
    syncLayerAria();
    // <dialog> close() 之后焦点会回到打开前的元素，这里再兜一次
    window.setTimeout(function () { returnFocusTo(target, null); }, layerDelay(220));
  }

  function isWizardOpen() {
    return !!(el.wizard && !el.wizard.hidden);
  }

  function readDebugPref() {
    try { return localStorage.getItem(LS_KEYS.debug) === '1'; } catch (e) { return false; }
  }

  function setDebug(on, persist) {
    debugOn = !!on;
    if (persist !== false) {
      try { localStorage.setItem(LS_KEYS.debug, debugOn ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    if (el.debugToggle) {
      el.debugToggle.classList.toggle('is-on', debugOn);
      el.debugToggle.setAttribute('aria-pressed', debugOn ? 'true' : 'false');
      el.debugToggle.title = debugOn ? '调试面板已开启（点击关闭）' : '调试面板（显示策略路由）';
    }
    if (el.settingDebug) el.settingDebug.checked = debugOn;
    try { renderMessages(); } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
   * 十八、首次启动向导（未配置 API Key 时全屏出现，可随时重开）
   * ============================================================ */

  function isSetupDismissed() {
    try { return localStorage.getItem(LS_KEYS.setup) === 'dismissed'; } catch (e) { return false; }
  }

  function clearSetupDismissed() {
    try { localStorage.removeItem(LS_KEYS.setup); } catch (e) { /* 忽略 */ }
  }

  function showWizardStep(step) {
    wizardStep = Math.min(3, Math.max(1, Number(step) || 1));
    if (el.wizard) {
      const steps = el.wizard.querySelectorAll('.wizard__step');
      for (let i = 0; i < steps.length; i += 1) {
        steps[i].classList.toggle('is-active', Number(steps[i].dataset.step) === wizardStep);
      }
    }
    if (el.wizardDots) {
      const dots = el.wizardDots.querySelectorAll('i');
      for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('is-active', i === wizardStep - 1);
    }
    if (el.wizardBack) setHidden(el.wizardBack, wizardStep === 1);
    if (el.wizardNext) {
      el.wizardNext.disabled = false;
      el.wizardNext.textContent = wizardStep === 1 ? '开始设置' : (wizardStep === 2 ? '我拿到 Key 了' : '测试并保存');
    }
    setResult(el.wizardResult, '', '');
  }

  function openWizard(step) {
    if (!el.wizard) return;
    showWizardStep(step || 1);
    showLayer(el.wizard, 'is-open', 300); // 卡片滑入 + 缩放 + 淡入
    window.setTimeout(function () {
      if (el.wizard.hidden) return;
      if (wizardStep === 3 && el.wizardKey) { try { el.wizardKey.focus(); } catch (e) { /* 忽略 */ } }
    }, 80);
  }

  function closeWizard(dismissed) {
    if (!el.wizard) return;
    if (dismissed) {
      try { localStorage.setItem(LS_KEYS.setup, 'dismissed'); } catch (e) { /* 忽略 */ }
    }
    // 先播退场动画，动画结束后再隐藏并归还焦点
    hideLayer(el.wizard, 220, function () {
      if (healthConfigured === false) setHidden(el.modelWarn, false);
      focusInput();
    });
  }

  async function submitWizardConfig() {
    const key = el.wizardKey ? el.wizardKey.value.trim() : '';
    if (!key) {
      setResult(el.wizardResult, 'error', '请先把 API Key 粘贴到上面的输入框。');
      if (el.wizardKey) { try { el.wizardKey.focus(); } catch (e) { /* 忽略 */ } }
      return;
    }
    const model = (el.wizardModel && el.wizardModel.value) || MODEL_OPTIONS[0].value;
    const baseUrl = el.wizardBaseUrl ? el.wizardBaseUrl.value.trim() : '';
    const patch = { apiKey: key, model: model };
    if (baseUrl) patch.baseUrl = baseUrl;

    if (el.wizardNext) { el.wizardNext.disabled = true; el.wizardNext.textContent = '正在测试…'; }
    setResult(el.wizardResult, 'loading', '正在保存配置并尝试连接模型…');
    let success = false;
    try {
      await apiRequest('/api/config', { method: 'POST', body: patch });
      const result = await apiRequest('/api/config/test', { method: 'POST' });
      if (result && result.ok) {
        success = true;
        setResult(el.wizardResult, 'ok',
          '连接成功（延迟 ' + (result.latencyMs || 0) + ' ms）' + (result.model ? ' · ' + result.model : ''));
        clearSetupDismissed();
        configCache = null;
        healthConfigured = true;
        setHealth('ok', '已连接', '模型：' + (result.model || model));
        setHidden(el.modelWarn, true);
        maybeAutoDisableDemo(); // 补上 Key 后自动退出演示模式
        if (el.wizardKey) el.wizardKey.value = '';
        window.setTimeout(function () {
          closeWizard(false);
          toast('连接成功，可以开始聊了', 'success');
        }, 750);
      } else {
        const code = result && result.code;
        const msg = (result && result.message) || ERROR_CODE_TEXT[code] || '连接失败，请检查 Key 后再试一次';
        setResult(el.wizardResult, 'error', String(msg || '').replace(/[。.]+$/, '') + '。可以修改后重试。');
      }
    } catch (e) {
      setResult(el.wizardResult, 'error', String((e && e.userMessage) || '保存失败，请稍后再试').replace(/[。.]+$/, '') + '。可以修改后重试。');
    } finally {
      if (!success && el.wizardNext) { el.wizardNext.disabled = false; el.wizardNext.textContent = '测试并保存'; }
    }
  }

  function wizardNext() {
    if (wizardStep < 3) { showWizardStep(wizardStep + 1); return; }
    submitWizardConfig();
  }

  /* ============================================================
   * 十九、设置面板（模型 / 温度 / max_tokens / Key / 测试连接 / 调试）
   * ============================================================ */

  function fillModelSelect(select, current) {
    if (!select) return;
    select.textContent = '';
    const options = MODEL_OPTIONS.slice();
    if (current && !options.some((o) => o.value === current)) {
      options.unshift({ value: current, label: current + '（当前使用）' });
    }
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    });
    select.value = current || MODEL_OPTIONS[0].value;
  }

  function updateTemperatureLabel() {
    if (!el.settingTemperatureValue || !el.settingTemperature) return;
    const value = Number(el.settingTemperature.value);
    el.settingTemperatureValue.textContent = Number.isFinite(value) ? value.toFixed(1) : '0.8';
  }

  function applyConfigToForm(cfg) {
    const conf = cfg || {};
    fillModelSelect(el.settingModel, conf.model || MODEL_OPTIONS[0].value);
    if (el.settingTemperature) {
      const temp = typeof conf.temperature === 'number' ? conf.temperature : 0.8;
      el.settingTemperature.value = String(temp);
    }
    updateTemperatureLabel();
    if (el.settingMaxTokens) el.settingMaxTokens.value = String(conf.maxTokens || 512);
    if (el.settingThinking) el.settingThinking.checked = conf.thinking === 'enabled';
    if (el.settingKeyMasked) el.settingKeyMasked.textContent = conf.configured ? (conf.keyMasked || '已配置') : '未配置';
    if (el.settingKeyRow) setHidden(el.settingKeyRow, true);
    if (el.settingKeyInput) el.settingKeyInput.value = '';
  }

  async function loadConfig(silent) {
    try {
      const data = await apiRequest('/api/config');
      configCache = data || {};
      applyConfigToForm(configCache);
    } catch (e) {
      applyConfigToForm(configCache || {});
      if (!silent) toastError(e, '读取设置失败，先显示上一次的配置');
    }
    syncDemoUI(); // configured 状态可能变化，同步演示模式入口
  }

  function collectSettingsPatch() {
    const patch = {
      model: (el.settingModel && el.settingModel.value) || MODEL_OPTIONS[0].value,
      temperature: el.settingTemperature ? Number(el.settingTemperature.value) : 0.8,
      maxTokens: el.settingMaxTokens ? Number(el.settingMaxTokens.value) : 512,
      thinking: el.settingThinking && el.settingThinking.checked ? 'enabled' : 'disabled',
    };
    const newKey = el.settingKeyInput ? el.settingKeyInput.value.trim() : '';
    if (newKey) patch.apiKey = newKey;
    return patch;
  }

  function validateSettings(patch) {
    if (!Number.isFinite(patch.temperature) || patch.temperature < 0 || patch.temperature > 2) {
      return '温度需要在 0–2 之间。';
    }
    if (!Number.isInteger(patch.maxTokens) || patch.maxTokens < 64 || patch.maxTokens > 8192) {
      return 'max_tokens 需要是 64–8192 之间的整数。';
    }
    return '';
  }

  async function saveSettings(silent) {
    const patch = collectSettingsPatch();
    const invalid = validateSettings(patch);
    if (invalid) {
      setResult(el.settingsResult, 'error', invalid);
      return false;
    }
    setBusy(el.settingsSave, true, '保存中…');
    try {
      const data = await apiRequest('/api/config', { method: 'POST', body: patch });
      configCache = data || {};
      applyConfigToForm(configCache);
      clearSetupDismissed();
      setResult(el.settingsResult, 'ok', '设置已保存。');
      if (!silent) toast(CONFIG_SAVED_TOAST, 'success');
      await refreshHealth();
      maybeAutoDisableDemo(); // 兜底：即使健康检查失败也自动退出演示模式
      return true;
    } catch (e) {
      setResult(el.settingsResult, 'error', (e && e.userMessage) || '保存失败，请稍后再试。');
      if (!silent) toastError(e, '保存失败，请稍后再试');
      return false;
    } finally {
      setBusy(el.settingsSave, false);
    }
  }

  async function testConnection(button, resultNode) {
    setBusy(button, true, '测试中…');
    setResult(resultNode, 'loading', '正在连接模型…');
    try {
      const data = await apiRequest('/api/config/test', { method: 'POST' });
      if (data && data.ok) {
        setResult(resultNode, 'ok', '连接成功（延迟 ' + (data.latencyMs || 0) + ' ms）' +
          (data.model ? ' · ' + data.model : '') +
          (data.sample ? ' · 回复示例：' + data.sample : ''));
        await refreshHealth();
      } else {
        const code = data && data.code;
        const msg = (data && data.message) || ERROR_CODE_TEXT[code] || '连接失败';
        setResult(resultNode, 'error', msg + '，可以修改设置后重试。');
      }
    } catch (e) {
      setResult(resultNode, 'error', (e && e.userMessage) || '测试失败，请稍后再试。');
    } finally {
      setBusy(button, false);
    }
  }

  async function testFromSettings() {
    // 先把当前改动保存下来，否则测的还是旧配置
    const saved = await saveSettings(true);
    if (!saved) return;
    await testConnection(el.settingsTest, el.settingsResult);
  }

  async function clearApiKey() {
    const agreed = await openConfirm({
      title: '清除 API Key',
      message: '清除后需要重新填写 Key 才能继续对话。确定清除吗？',
      confirmText: '清除',
      danger: true,
    });
    if (!agreed) return;
    try {
      const data = await apiRequest('/api/config/key', { method: 'DELETE' });
      configCache = data || {};
      applyConfigToForm(configCache);
      healthConfigured = false;
      setHealth('error', '模型未配置', '模型：未配置');
      setHidden(el.modelWarn, false);
      setResult(el.settingsResult, '', '');
      syncDemoUI(); // 清除 Key 后演示模式入口重新露出
      toast('已清除 API Key', 'success');
    } catch (e) {
      toastError(e, '清除失败，请稍后再试');
    }
  }

  /* ============================================================
   * 二十、长期记忆面板（开关 / 查看 / 编辑 / 置顶 / 删除 / 清空）
   * ============================================================ */

  function categoryLabel(key) {
    const all = memoryCategories.concat(MEMORY_CATEGORIES);
    for (let i = 0; i < all.length; i += 1) {
      if (all[i][0] === key) return all[i][1];
    }
    return key || '其它';
  }

  function fillCategorySelect(select, selected) {
    if (!select) return;
    const current = selected || select.value || 'other';
    select.textContent = '';
    memoryCategories.forEach((pair) => {
      const opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      select.appendChild(opt);
    });
    if (memoryCategories.some((pair) => pair[0] === current)) select.value = current;
    else select.value = memoryCategories.length ? memoryCategories[0][0] : 'other';
  }

  function makeIconAction(act, label, iconId) {
    const btn = makeEl('button', 'icon-btn');
    btn.type = 'button';
    btn.dataset.act = act;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(svgIcon(iconId));
    return btn;
  }

  function buildMemoryItem(item, usedKeys) {
    const li = makeEl('li', 'mem-item');
    li.dataset.id = item.id;
    li.dataset.pinned = item.pinned ? 'true' : 'false';

    const main = makeEl('div', 'mem-item__main');
    const text = makeEl('p', 'mem-item__text', item.text || '');
    main.appendChild(text);
    const meta = makeEl('div', 'mem-item__meta');
    const cat = makeEl('span', 'mem-tag', categoryLabel(item.category));
    cat.dataset.key = item.category || 'other';
    meta.appendChild(cat);
    meta.appendChild(makeEl('span', 'mem-tag mem-tag--src', item.source === 'manual' ? '手动添加' : '自动记住'));
    if (item.pinned) meta.appendChild(makeEl('span', 'mem-tag mem-tag--pin', '已置顶'));
    if (usedKeys && usedKeys.has(memoryKey(item.text))) {
      meta.appendChild(makeEl('span', 'mem-tag mem-tag--recent', '最近用过'));
    }
    main.appendChild(meta);
    li.appendChild(main);

    const actions = makeEl('div', 'mem-item__actions');
    const pin = makeIconAction('pin', item.pinned ? '取消置顶' : '置顶', 'i-star');
    if (item.pinned) pin.classList.add('is-on');
    actions.appendChild(pin);
    actions.appendChild(makeIconAction('edit', '编辑', 'i-edit'));
    actions.appendChild(makeIconAction('del', '删除', 'i-trash'));
    li.appendChild(actions);

    return li;
  }

  // 归一化记忆原文，用于「本条被用过」的匹配
  function memoryKey(text) {
    return String(text == null ? '' : text).replace(/\s+/g, '').trim();
  }

  // 当前会话里最近一条带 memoriesUsed 的回复，就是「本轮被用过」的记忆
  function recentlyUsedKeys() {
    const keys = new Set();
    const session = getSession(activeId);
    if (!session) return keys;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const msg = session.messages[i];
      if (msg && msg.role === 'assistant' && Array.isArray(msg.memoriesUsed) && msg.memoriesUsed.length) {
        msg.memoriesUsed.forEach(function (text) {
          const key = memoryKey(text);
          if (key) keys.add(key);
        });
        break;
      }
    }
    return keys;
  }

  function renderMemoryList(items, meta) {
    const list = Array.isArray(items) ? items : [];
    if (el.memoryList) {
      const usedKeys = recentlyUsedKeys();
      el.memoryList.textContent = '';
      list.forEach((item) => {
        if (!item || !item.id) return;
        el.memoryList.appendChild(buildMemoryItem(item, usedKeys));
      });
      refreshLayerHidden(el.memoryList); // 老浏览器降级时补 tabindex="-1"
    }
    if (el.memoryCount) {
      el.memoryCount.textContent = String(typeof (meta && meta.count) === 'number' ? meta.count : list.length);
    }
    if (el.memoryUpdated) {
      const ts = Number((meta && meta.updatedAt) || 0);
      el.memoryUpdated.textContent = ts ? ('最近更新 ' + formatTime(ts)) : '';
    }
    if (el.memoryEmpty) {
      el.memoryEmpty.textContent = '还没有记住任何内容。聊到对陪伴有用的稳定事实时，心屿会试着记下来，你也可以在上面手动添加。';
      setHidden(el.memoryEmpty, list.length > 0);
    }
    if (el.memoryFootNote) {
      el.memoryFootNote.textContent = memoryEnabledCache ? '' : '记忆已关闭，不会再记住新内容';
    }
  }

  async function loadMemory() {
    try {
      const data = await apiRequest('/api/memory');
      memoryEnabledCache = data.enabled !== false;
      if (data.categories && typeof data.categories === 'object' && !Array.isArray(data.categories)) {
        const pairs = Object.keys(data.categories).map((k) => [k, String(data.categories[k])]);
        if (pairs.length) memoryCategories = pairs;
      }
      if (el.memoryEnabled) el.memoryEnabled.checked = memoryEnabledCache;
      fillCategorySelect(el.memoryAddCategory, el.memoryAddCategory && el.memoryAddCategory.value);
      renderMemoryList(data.items || [], data);
    } catch (e) {
      toastError(e, '读取记忆失败，稍后再试试');
      if (el.memoryEmpty) {
        el.memoryEmpty.textContent = '记忆读取失败，可以关掉面板稍后再打开。';
        setHidden(el.memoryEmpty, false);
      }
    }
  }

  async function addMemory() {
    const text = el.memoryAddText ? el.memoryAddText.value.trim() : '';
    if (!text) {
      toast('先写点什么，再点添加', 'error');
      if (el.memoryAddText) { try { el.memoryAddText.focus(); } catch (e) { /* 忽略 */ } }
      return;
    }
    const category = (el.memoryAddCategory && el.memoryAddCategory.value) || 'other';
    setBusy(el.memoryAddBtn, true, '添加中…');
    try {
      await apiRequest('/api/memory', { method: 'POST', body: { text: text, category: category } });
      if (el.memoryAddText) el.memoryAddText.value = '';
      toast(MEMORY_SAVED_TOAST, 'success');
      await loadMemory();
    } catch (e) {
      toastError(e, '添加失败，请稍后再试');
    } finally {
      setBusy(el.memoryAddBtn, false);
    }
  }

  async function patchMemory(id, patch, okText) {
    try {
      await apiRequest('/api/memory/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
      if (okText) toast(okText, 'success');
      await loadMemory();
    } catch (e) {
      toastError(e, '修改失败，请稍后再试');
    }
  }

  async function deleteMemory(id) {
    const agreed = await openConfirm({
      title: '删除这条记忆',
      message: '删除后无法恢复。确定删除这条记忆吗？',
      confirmText: '删除',
      danger: true,
    });
    if (!agreed) return;
    try {
      await apiRequest('/api/memory/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已删除这条记忆', 'success');
      await loadMemory();
    } catch (e) {
      toastError(e, '删除失败，请稍后再试');
    }
  }

  async function clearMemories() {
    const agreed = await openConfirm({
      title: '清空全部记忆',
      message: '这会删除所有已保存的记忆，且无法恢复。确定清空吗？',
      confirmText: '清空全部',
      danger: true,
    });
    if (!agreed) return;
    try {
      await apiRequest('/api/memory', { method: 'DELETE' });
      toast('已清空全部记忆', 'success');
      await loadMemory();
    } catch (e) {
      toastError(e, '清空失败，请稍后再试');
    }
  }

  async function toggleMemoryEnabled() {
    const enabled = !!(el.memoryEnabled && el.memoryEnabled.checked);
    memoryEnabledCache = enabled;
    try {
      await apiRequest('/api/memory/enabled', { method: 'POST', body: { enabled: enabled } });
      toast(enabled ? '已开启长期记忆' : '已关闭长期记忆，已有记忆仍可查看', 'success');
    } catch (e) {
      memoryEnabledCache = !enabled;
      if (el.memoryEnabled) el.memoryEnabled.checked = !enabled;
      toastError(e, '开关没有保存成功，请稍后再试');
    }
    if (el.memoryFootNote) el.memoryFootNote.textContent = enabled ? '' : '记忆已关闭，不会再记住新内容';
  }

  function startMemoryEdit(li) {
    if (!li || li.querySelector('.mem-item__edit')) return;
    const id = li.dataset.id;
    const main = li.querySelector('.mem-item__main');
    if (!main) return;
    const textEl = main.querySelector('.mem-item__text');
    const catEl = main.querySelector('.mem-tag');
    const oldText = textEl ? textEl.textContent : '';
    const oldCategory = (catEl && catEl.dataset.key) || 'other';

    const form = makeEl('div', 'mem-item__edit');
    const ta = document.createElement('textarea');
    ta.value = oldText;
    ta.maxLength = 60;
    ta.setAttribute('aria-label', '编辑记忆内容');

    const row = makeEl('div', 'mem-item__edit-row');
    const select = document.createElement('select');
    select.className = 'input';
    select.setAttribute('aria-label', '记忆分类');
    fillCategorySelect(select, oldCategory);
    const buttons = makeEl('div', 'field__row');
    const cancel = makeEl('button', 'btn btn--ghost', '取消');
    cancel.type = 'button';
    cancel.dataset.act = 'cancel';
    const save = makeEl('button', 'btn btn--primary', '保存');
    save.type = 'button';
    save.dataset.act = 'save';
    buttons.appendChild(cancel);
    buttons.appendChild(save);
    row.appendChild(select);
    row.appendChild(buttons);
    form.appendChild(ta);
    form.appendChild(row);
    main.replaceWith(form);
    li.dataset.editing = 'true';
    window.setTimeout(function () {
      try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* 忽略 */ }
    }, 30);

    // 行内编辑：保存 / 取消（一次性监听，随节点一起失效）
    form.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'cancel') { loadMemory(); return; }
      if (btn.dataset.act === 'save') {
        const next = ta.value.trim();
        if (!next) { toast('记忆内容不能为空', 'error'); return; }
        patchMemory(id, { text: next, category: select.value }, '已更新这条记忆');
      }
    });
  }

  /* ============================================================
   * 二十、桌面外壳（Tauri 无边框窗口）
   * ------------------------------------------------------------
   * 只有检测到 window.__TAURI__ 时才显示自定义标题栏；
   * 浏览器模式（评审 / 普通访问）完全保持原布局，没有任何多余元素。
   * ============================================================ */

  let tauriWindow = null;

  function tauriWindowRef() {
    const api = window.__TAURI__;
    if (!api) return null;
    try {
      if (api.window && typeof api.window.getCurrentWindow === 'function') {
        const ref = api.window.getCurrentWindow(); // Tauri v2：同步返回窗口对象
        return (ref && typeof ref.then === 'function') ? ref : Promise.resolve(ref);
      }
      if (api.window && typeof api.window.getCurrent === 'function') {
        return Promise.resolve(api.window.getCurrent()); // Tauri v1 兼容
      }
      if (api.window && api.window.Window && typeof api.window.Window.getCurrent === 'function') {
        return Promise.resolve(api.window.Window.getCurrent());
      }
    } catch (e) { /* 忽略：权限或平台差异 */ }
    return null;
  }

  function callWindow(method) {
    const win = tauriWindow;
    if (!win || typeof win[method] !== 'function') return;
    try {
      const result = win[method]();
      if (result && typeof result.catch === 'function') result.catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  // 最大化 / 还原时同步按钮图标与 aria-label
  function syncMaximizeIcon() {
    const btn = el.titlebarMax;
    if (!btn || !tauriWindow || typeof tauriWindow.isMaximized !== 'function') return;
    let result = null;
    try { result = tauriWindow.isMaximized(); } catch (e) { return; }
    Promise.resolve(result).then(function (maximized) {
      const on = !!maximized;
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', on ? '#i-restore' : '#i-max');
      const label = on ? '还原窗口' : '最大化窗口';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }).catch(function () { /* 忽略 */ });
  }

  function bindTitlebar() {
    if (el.titlebarMin) el.titlebarMin.addEventListener('click', function () { callWindow('minimize'); });
    if (el.titlebarMax) {
      el.titlebarMax.addEventListener('click', function () {
        callWindow('toggleMaximize');
        window.setTimeout(syncMaximizeIcon, 140);
      });
    }
    if (el.titlebarClose) el.titlebarClose.addEventListener('click', function () { callWindow('close'); });
    // 双击拖拽区 = 最大化 / 还原，和原生标题栏一致
    if (el.titlebar) {
      el.titlebar.addEventListener('dblclick', function (e) {
        if (e.target.closest('.titlebar__controls')) return;
        callWindow('toggleMaximize');
        window.setTimeout(syncMaximizeIcon, 140);
      });
    }
  }

  function initDesktopShell() {
    if (!window.__TAURI__) return; // 浏览器：不显示标题栏
    document.documentElement.classList.add('is-tauri');
    if (el.titlebar) setHidden(el.titlebar, false);
    const ref = tauriWindowRef();
    if (!ref) return;
    Promise.resolve(ref).then(function (win) {
      if (!win || typeof win !== 'object') return;
      tauriWindow = win;
      syncMaximizeIcon();
      try {
        if (typeof win.onResized === 'function') {
          const handle = win.onResized(function () { syncMaximizeIcon(); });
          if (handle && typeof handle.catch === 'function') handle.catch(function () { /* 忽略 */ });
        }
      } catch (e) { /* 忽略 */ }
    }).catch(function () { /* 忽略 */ });
  }

  /* ============================================================
   * 二十一、初始化
   * ============================================================ */

  function init() {
    initDesktopShell(); // 先判定是否运行在 Tauri 里，再渲染其余界面

    // 无障碍：消息列表不再整体 aria-live（流式重渲染会反复播报），
    // 改由 #sr-live 在「一条回复完成」时播报一次（见 announceMessage）。
    el.messages.removeAttribute('aria-live');
    if (el.messages.getAttribute('role') === 'log') el.messages.removeAttribute('role');
    if (!el.srLive) { // 契约缺失时兜底创建一个视觉隐藏的 live 区
      el.srLive = document.createElement('div');
      el.srLive.id = 'sr-live';
      el.srLive.className = 'sr-only';
      el.srLive.setAttribute('aria-live', 'polite');
      if (el.messages.parentNode) el.messages.parentNode.insertBefore(el.srLive, el.messages.nextSibling);
    }

    initTheme();
    loadState();
    ensureActive();
    bindEvents();
    syncSidebarHidden();  // 窄屏初始为隐藏：inert 隔离
    syncLayerAria();

    // 新增组件：默认值与上次偏好
    setDebug(readDebugPref(), false);
    fillModelSelect(el.wizardModel, MODEL_OPTIONS[0].value);
    fillModelSelect(el.settingModel, MODEL_OPTIONS[0].value);
    fillCategorySelect(el.memoryAddCategory, 'other');
    updateTemperatureLabel();
    if (el.wizardBaseUrl) el.wizardBaseUrl.value = 'https://api.deepseek.com';

    closeSidebar();
    closeDrawer();
    syncSidebarHidden();
    syncLayerAria();
    stickBottom = true;
    renderAll();
    renderSuggestions(STATIC_SUGGESTIONS); // 先给静态兜底，comeback 回来后替换
    syncDemoUI();
    autosize();
    syncComposer();
    updateScrollButton();

    loadConfig(true);
    checkHealth();
    loadComeback(); // 情感连续性：只拉一次，失败静默保持静态欢迎文案
    loadDemo();     // 免 Key 演示模式：接口可用且未配置 Key 时露出入口
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
