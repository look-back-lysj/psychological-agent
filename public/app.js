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
  };

  const DEFAULT_TITLE = '新的对话';
  const TITLE_MAX = 16;

  // 策略 / 风险英文 key -> 中文标签（未知则原样显示）
  const STRATEGY_LABELS = {
    low_pressure: '低压力陪伴',
    empathy: '共情',
    clarify: '温和澄清',
    problem_solving: '一起想办法',
    safety_first: '安全优先',
    error_fallback: '备用回复',
  };
  const RISK_LABELS = {
    normal: '正常',
    watch: '关注',
    elevated: '留意',
    high_direct: '高风险',
    unknown: '未知',
  };

  const LOCAL_FALLBACK = '我现在这边有点没接上，但你的话我已经听到了。可以点“重试”再试一次；如果想继续，也可以先慢慢说说现在最想聊的那件事。';
  const ERROR_FALLBACK = '这条回复没有顺利说完，你可以点“重试”再来一次。我还在。';
  const ABORT_TEXT = '（已停止生成，可点“重试”继续）';
  const COPY_OK_TEXT = '已复制这条回复';
  const COPY_FAIL_TEXT = '复制失败，请手动选中文字复制';
  const FALLBACK_TOAST = '连接不太顺畅，已改用备用方式回复';
  const NET_FAIL_TOAST = '网络似乎断开了，稍后再试试';
  const GENERATING_TOAST = '上一条还在回复中，请稍候';
  const ERROR_TOAST = '生成回复时出了点小状况，我先在这儿陪你';

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
      if (raw.riskLevel) msg.riskLevel = String(raw.riskLevel);
      if (raw.blocked) msg.blocked = true;
      if (raw.error) msg.error = true;
    }
    return msg;
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
            if (m.riskLevel) o.riskLevel = m.riskLevel;
            if (m.blocked) o.blocked = true;
            if (m.error) o.error = true;
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

  // 生成 meta 文本：共情 · 风险 正常（策略/风险值用 <em> 高亮，兼容样式表）
  function renderMeta(metaEl, msg) {
    if (!metaEl) return;
    metaEl.textContent = '';
    let hasText = false;

    if (msg.strategy) {
      metaEl.appendChild(makeEl('em', null, strategyLabel(msg.strategy)));
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

  function buildAssistantMessage(msg, index) {
    const article = makeEl('article', 'msg msg--assistant');
    article.dataset.index = String(index);

    const avatar = makeEl('div', 'msg__avatar', '屿');
    avatar.setAttribute('aria-hidden', 'true');

    const body = makeEl('div', 'msg__body');
    const bubble = makeEl('div', 'msg__bubble');
    const content = makeEl('div', 'msg__content');
    bubble.appendChild(content);

    const foot = makeEl('div', 'msg__foot');
    const meta = makeEl('span', 'msg__meta');
    foot.appendChild(meta);
    foot.appendChild(makeActionButton('copy', '复制回复', 'i-copy'));
    foot.appendChild(makeActionButton('retry', '重新生成', 'i-retry'));

    body.appendChild(bubble);
    body.appendChild(foot);
    article.appendChild(avatar);
    article.appendChild(body);

    renderAssistantBody(article, msg);
    return article;
  }

  // 渲染/更新助手气泡内容（流式过程中会被反复调用）
  function renderAssistantBody(article, msg) {
    if (!article) return;
    const content = article.querySelector('.msg__content');
    if (!content) return;

    article.classList.toggle('msg--error', !!msg.error);
    article.classList.toggle('msg--blocked', !!msg.blocked);

    if (!msg.content && msg.streaming) {
      // 打字中：dots 指示器（静态常量，无用户数据）
      article.classList.add('msg--typing');
      content.innerHTML = DOTS_HTML;
    } else {
      article.classList.remove('msg--typing');
      // 唯一允许写入的 innerHTML：renderMarkdown 已对全部用户内容做过 HTML 转义
      content.innerHTML = renderMarkdown(msg.content || '');
      if (msg.streaming) {
        const caret = makeEl('span', 'caret');
        caret.setAttribute('aria-hidden', 'true');
        content.appendChild(caret);
      }
    }

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
      if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
      scheduleAssistantRender();
      return;
    }

    if (ev.event === 'delta') {
      const piece = typeof data.text === 'string' ? data.text : '';
      if (piece) {
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
      if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
      if (data.sessionId) assistant.serverSessionId = String(data.sessionId);
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
    if (data.riskLevel) assistant.riskLevel = String(data.riskLevel);
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
    if (!assistant.content) {
      assistant.content = LOCAL_FALLBACK;
      assistant.error = true;
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

    try {
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
    msg.riskLevel = '';
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

  async function checkHealth() {
    setHealth('loading', '连接中…', '模型检测中…');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('http_' + res.status);
      const data = await res.json();
      if (!data || data.ok !== true) throw new Error('bad_payload');
      const model = typeof data.model === 'string' ? data.model.trim() : '';
      const configured = !!model && model !== '未配置' && model.toLowerCase() !== 'unknown';
      if (configured) setHealth('ok', '已连接', '模型：' + model);
      else setHealth('error', '模型未配置', '模型：' + (model || '未配置'));
    } catch (e) {
      setHealth('error', '连接失败', '模型：无法连接');
    }
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

    // Esc 关闭侧边栏（弹窗的 Esc 由 <dialog> 原生处理）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isSidebarOpen()) closeSidebar();
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
   * 十七、初始化
   * ============================================================ */

  function init() {
    el.messages.setAttribute('aria-live', 'polite'); // 无障碍：消息区播报

    initTheme();
    loadState();
    ensureActive();
    bindEvents();

    closeSidebar();
    stickBottom = true;
    renderAll();
    autosize();
    syncComposer();
    updateScrollButton();

    checkHealth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
