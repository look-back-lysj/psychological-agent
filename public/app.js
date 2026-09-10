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
    welcome: $('welcome'),
    suggestions: $('suggestions'),
    scrollBottom: $('scroll-bottom'),
    form: $('chat-form'),
    input: $('message'),
    sendBtn: $('send-btn'),
    toasts: $('toasts'),
    scrim: $('scrim'),

    // 顶栏与入口
    modelWarn: $('model-warn'),
    debugToggle: $('debug-toggle'),
    openSettingsTop: $('open-settings-top'),
    openSettings: $('open-settings'),
    openMemory: $('open-memory'),

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
    }
    return msg;
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

  function loadState() {
    let loaded = [];
    try {
      const raw = localStorage.getItem(LS_KEYS.sessions);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) loaded = parsed.map(sanitizeSession).filter(Boolean);
    } catch (e) { loaded = []; }
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
            return o;
          }),
      }));
      localStorage.setItem(LS_KEYS.sessions, JSON.stringify(payload));
      localStorage.setItem(LS_KEYS.activeId, activeId || '');
    } catch (e) { /* 存储不可用时静默忽略，不影响对话 */ }
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
      if (msg.waitingText) content.textContent = msg.waitingText;
      else content.innerHTML = DOTS_HTML;
      bubble.appendChild(content);
      box.appendChild(bubble);
      return;
    }

    const parts = (!msg.streaming && Array.isArray(msg.parts) && msg.parts.length > 1) ? msg.parts : null;
    const list = parts || [msg.content || ''];
    let delay = 0;
    list.forEach((part, index) => {
      const bubble = makeBubble(renderMarkdown(part));
      if (msg.streaming) {
        const content = bubble.querySelector('.msg__content');
        const caret = makeEl('span', 'caret');
        caret.setAttribute('aria-hidden', 'true');
        if (content) content.appendChild(caret);
      }
      if (parts) {
        // 分气泡依次出现：每条间隔 350–800ms，带轻微上浮动画
        if (index > 0) delay += stableGap(msg.ts, index);
        bubble.classList.add('is-seq');
        bubble.style.animationDelay = Math.round(delay) + 'ms';
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

    const foot = makeEl('div', 'msg__foot');
    const meta = makeEl('span', 'msg__meta');
    foot.appendChild(meta);
    foot.appendChild(makeActionButton('copy', '复制回复', 'i-copy'));
    foot.appendChild(makeActionButton('retry', '重新生成', 'i-retry'));

    body.appendChild(bubbles);
    body.appendChild(note);
    body.appendChild(dbg);
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
    renderMeta(article.querySelector('.msg__meta'), msg);

    const actions = article.querySelectorAll('.msg__action');
    for (let i = 0; i < actions.length; i += 1) actions[i].disabled = !!msg.streaming;
  }


  function buildMessageEl(msg, index) {
    if (msg.role === 'user') return buildUserMessage(msg);
    if (msg.role === 'assistant') return buildAssistantMessage(msg, index);
    return buildSystemMessage(msg);
  }

  function renderMessages() {
    if (!el.messages) return;
    const session = getSession(activeId);
    el.messages.textContent = '';
    if (!session) return;
    session.messages.forEach((msg, index) => {
      el.messages.appendChild(buildMessageEl(msg, index));
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

  function renderSessionList() {
    if (!el.sessionList) return;
    const list = sortedSessions();
    el.sessionList.textContent = '';
    list.forEach((s) => el.sessionList.appendChild(buildSessionItem(s)));
    // “没有其它会话时”显示空状态提示
    if (el.sessionsEmpty) setHidden(el.sessionsEmpty, list.length > 1);
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
    setHidden(el.scrollBottom, stickBottom);
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
      }
      assistant.blocked = !!data.blocked;
      assistant.done = true;
    }
  }

  // 手动解析 text/event-stream；返回是否收到 done
  async function streamChat(text, sessionId, assistant, signal) {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ message: text, sessionId: sessionId }),
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
  async function fetchNonStream(text, sessionId, signal) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: sessionId }),
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

  async function fallbackReply(text, session, assistant, signal) {
    const data = await fetchNonStream(text, session.id, signal);
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
    }
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

  async function startGeneration(text, session, assistant) {
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

      const finished = await streamChat(text, session.id, assistant, controller.signal);
      if (!finished && !controller.signal.aborted) {
        // 流提前结束却没有 done：按“流中断”处理，降级到非流式
        try {
          await fallbackReply(text, session, assistant, controller.signal);
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
          await fallbackReply(text, session, assistant, controller.signal);
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
    autosize();
    syncComposer();

    renderMessages();
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
    msg.parts = null;
    msg.stopped = false;
    msg.blocked = false;
    msg.error = false;
    msg.done = false;
    msg.streaming = true;
    msg.ts = now();
    session.updatedAt = now();

    renderMessages();
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

    startGeneration(userText, session, msg);
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
  }

  /* ============================================================
   * 十四、侧边栏 / 主题 / 弹窗 / 复制
   * ============================================================ */

  function openSidebar() {
    if (el.app) el.app.classList.add('is-sidebar-open');
    setHidden(el.scrim, false);
  }

  function closeSidebar() {
    if (el.app) el.app.classList.remove('is-sidebar-open');
    setHidden(el.scrim, true);
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
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(LS_KEYS.theme, next); } catch (e) { /* 忽略 */ }
  }

  function openAbout() {
    if (!el.aboutModal || typeof el.aboutModal.showModal !== 'function') return;
    try { el.aboutModal.showModal(); } catch (e) { /* 忽略 */ }
  }

  function closeAbout() {
    if (!el.aboutModal) return;
    try { if (el.aboutModal.open) el.aboutModal.close(); } catch (e) { /* 忽略 */ }
  }

  async function copyMessage(text) {
    const value = String(text || '');
    if (!value) { toast('这条回复还是空的', 'error'); return; }
    let ok = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(value); ok = true; } catch (e) { ok = false; }
    }
    if (!ok) ok = legacyCopy(value);
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
    if (el.statusPill) {
      el.statusPill.dataset.state = state;
      el.statusPill.textContent = statusText;
    }
    if (el.modelDot) el.modelDot.dataset.state = state;
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
      } else {
        setHealth('error', '模型未配置', '模型：未配置');
        setHidden(el.modelWarn, false);
        // 首次进入且用户没有主动跳过时，引导配置
        if (!isSetupDismissed() && !isWizardOpen() && !activeDrawer) openWizard(1);
      }
      return data;
    } catch (e) {
      healthConfigured = null;
      setHealth('error', '连接失败', '模型：无法连接');
      return null;
    }
  }

  async function checkHealth() {
    await refreshHealth(false);
  }

  /* ============================================================
   * 十六、事件绑定
   * ============================================================ */

  function bindEvents() {
    // 侧边栏
    if (el.sidebarOpen) el.sidebarOpen.addEventListener('click', openSidebar);
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
    }

    // 输入区
    if (el.form) el.form.addEventListener('submit', function (e) { e.preventDefault(); submitMessage(); });
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
        if (btn.dataset.action === 'copy') copyMessage(msg.content);
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

    // 设置 / 记忆入口
    if (el.openSettings) el.openSettings.addEventListener('click', function () { openDrawer('settings'); });
    if (el.openSettingsTop) el.openSettingsTop.addEventListener('click', function () { openDrawer('settings'); });
    if (el.openMemory) el.openMemory.addEventListener('click', function () { openDrawer('memory'); });
    if (el.settingsClose) el.settingsClose.addEventListener('click', closeDrawer);
    if (el.memoryClose) el.memoryClose.addEventListener('click', closeDrawer);
    if (el.drawerScrim) el.drawerScrim.addEventListener('click', closeDrawer);

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
      el.confirmModal.addEventListener('close', function () {
        if (confirmResolve) settleConfirm(false);
      });
    }

    // Esc：按层级关闭（弹窗的 Esc 由 <dialog> 原生处理）
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // 按层级关闭：向导 → 抽屉 → 侧边栏（<dialog> 的 Esc 由原生处理）
      if (isWizardOpen()) { closeWizard(true); return; }
      if (activeDrawer) { closeDrawer(); return; }
      if (isSidebarOpen()) closeSidebar();
    });

    // 尺寸变化：重算输入框高度与滚动状态
    window.addEventListener('resize', function () {
      autosize();
      stickBottom = isNearBottom();
      updateScrollButton();
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
      try { el.confirmModal.showModal(); } catch (e) { settleConfirm(false); }
    });
  }

  function settleConfirm(value) {
    const resolve = confirmResolve;
    confirmResolve = null;
    try { if (el.confirmModal && el.confirmModal.open) el.confirmModal.close(); } catch (e) { /* 忽略 */ }
    if (resolve) resolve(!!value);
  }

  function openDrawer(name) {
    closeSidebar();
    activeDrawer = name;
    setHidden(el.drawerScrim, false);
    setHidden(el.settingsDrawer, name !== 'settings');
    setHidden(el.memoryDrawer, name !== 'memory');
    if (name === 'settings') loadConfig();
    else if (name === 'memory') loadMemory();
    const panel = name === 'settings' ? el.settingsDrawer : (name === 'memory' ? el.memoryDrawer : null);
    if (panel) {
      window.setTimeout(function () {
        const focusable = panel.querySelector('input, select, textarea, button');
        if (focusable) { try { focusable.focus(); } catch (e) { /* 忽略 */ } }
      }, 80);
    }
  }

  function closeDrawer() {
    activeDrawer = '';
    setHidden(el.drawerScrim, true);
    setHidden(el.settingsDrawer, true);
    setHidden(el.memoryDrawer, true);
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
    setHidden(el.wizard, false);
    showWizardStep(step || 1);
    window.setTimeout(function () {
      if (wizardStep === 3 && el.wizardKey) { try { el.wizardKey.focus(); } catch (e) { /* 忽略 */ } }
    }, 80);
  }

  function closeWizard(dismissed) {
    if (!el.wizard) return;
    setHidden(el.wizard, true);
    if (dismissed) {
      try { localStorage.setItem(LS_KEYS.setup, 'dismissed'); } catch (e) { /* 忽略 */ }
    }
    if (healthConfigured === false) setHidden(el.modelWarn, false);
    focusInput();
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

  function buildMemoryItem(item) {
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

  function renderMemoryList(items, meta) {
    const list = Array.isArray(items) ? items : [];
    if (el.memoryList) {
      el.memoryList.textContent = '';
      list.forEach((item) => {
        if (!item || !item.id) return;
        el.memoryList.appendChild(buildMemoryItem(item));
      });
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
   * 二十一、初始化
   * ============================================================ */

  function init() {
    el.messages.setAttribute('aria-live', 'polite'); // 无障碍：消息区播报

    initTheme();
    loadState();
    ensureActive();
    bindEvents();

    // 新增组件：默认值与上次偏好
    setDebug(readDebugPref(), false);
    fillModelSelect(el.wizardModel, MODEL_OPTIONS[0].value);
    fillModelSelect(el.settingModel, MODEL_OPTIONS[0].value);
    fillCategorySelect(el.memoryAddCategory, 'other');
    updateTemperatureLabel();
    if (el.wizardBaseUrl) el.wizardBaseUrl.value = 'https://api.deepseek.com';

    closeSidebar();
    closeDrawer();
    stickBottom = true;
    renderAll();
    autosize();
    syncComposer();
    updateScrollButton();

    loadConfig(true);
    checkHealth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
