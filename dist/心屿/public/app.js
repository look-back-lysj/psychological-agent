const messages = document.getElementById('messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('message');
const newChat = document.getElementById('new-chat');
let sessionId = localStorage.getItem('psych_session') || '';

function appendMessage(role, html, meta) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${role}`;
  wrapper.innerHTML = html + (meta ? `<div class="meta">${meta}</div>` : '');
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    appendMessage('system', `系统信息：当前模型 ${data.model}`);
  } catch (e) {
    appendMessage('system', '系统信息：无法连接后端，请先启动服务。');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMessage('user', escapeHtml(text));

  const loading = document.createElement('div');
  loading.className = 'typing';
  loading.textContent = '正在回复…';
  messages.appendChild(loading);
  messages.scrollTop = messages.scrollHeight;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId })
    });
    const data = await res.json();
    loading.remove();
    if (!data.ok) {
      appendMessage('system', `请求失败：${data.error || '未知错误'}`);
      return;
    }
    sessionId = data.data.sessionId;
    localStorage.setItem('psych_session', sessionId);
    appendMessage('assistant', escapeHtml(data.data.reply), `当前策略：<em>${escapeHtml(data.data.strategy)}</em>；风险等级：<em>${escapeHtml(data.data.riskLevel)}</em>`);
  } catch (err) {
    loading.remove();
    appendMessage('system', '网络异常或服务未启动，请检查后重试。');
  }
});

newChat.addEventListener('click', async () => {
  sessionId = '';
  localStorage.removeItem('psych_session');
  messages.innerHTML = '';
  appendMessage('system', '已开始新对话。');
  await fetchHealth();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

fetchHealth();
