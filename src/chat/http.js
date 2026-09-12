/**
 * 模块：chat/http —— SSE 写出与 HTTP 层辅助
 * 层级：chat L4（编排）
 * 职责：把流式响应头刷出、SSE 事件序列化写出、错误事件与「安全文案分段下发」等纯 HTTP 细节
 *      收敛到一处，供 chat/index.js 的两个路由处理器使用。
 * 依赖：无内部依赖（只用 res 对象的方法）；错误文案由调用方传入 friendlyMessage 的结果
 * 被依赖：chat/index.js
 * 改动风险：🔴 高 —— 改完要跑 node tests/run.js（期望 42/42 + 9/9）+ 启动冒烟
 * 契约：SSE 事件名（meta / delta / replace / error / done）与事件 data 的 JSON 形状不得改，
 *      前端 public/app.js 直接按这些事件名解析。
 * 不要做什么：
 *   1) 不要在这里新增任何「边收边发」的转发路径 —— 本模块只负责「已通过检查的文本」分段下发；
 *   2) 不要去掉 res.flushHeaders()（去掉会让首字节被缓冲，表现为首字延迟变长）。
 */

const NL = String.fromCharCode(10);

/**
 * 刷出 SSE 响应头。必须在写任何事件之前调用：不调用 flushHeaders() 时首字节可能被缓冲，
 * 前端迟迟收不到任何数据，表现为「首字延迟」变长。
 */
function startSSE(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
}

/**
 * 建一个 SSE 写出器，绑定到具体的 res 与 AbortController。
 *
 * @param {import('http').ServerResponse} res
 * @param {AbortController} controller 客户端断开时用它中止上游模型请求
 * @returns {{ send:Function, finish:Function, streamText:Function, state:object, onClose:Function }}
 */
function createWriter(res, controller) {
  const state = { finished: false, clientGone: false };

  const send = (event, data) => {
    if (state.finished || state.clientGone || res.writableEnded) return false;
    try {
      res.write('event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL);
      return true;
    } catch (e) {
      state.clientGone = true;
      controller.abort();
      return false;
    }
  };

  const finish = (data) => {
    if (!state.finished && !state.clientGone) send('done', data);
    state.finished = true;
    if (!res.writableEnded) { try { res.end(); } catch (e) { /* 忽略 */ } }
  };

  // 只监听 res 的 close：Node 16+ 中 req 的 close 会在请求体读完时就触发
  const onClose = () => {
    if (state.finished || res.writableEnded) return;
    state.clientGone = true;
    controller.abort();
  };

  // 安全文案 / 已校验文本的分段下发（长文本用更大分片）
  const streamText = async (text) => {
    const base = Math.max(2, Math.ceil(String(text).length / 120));
    let i = 0;
    while (i < text.length) {
      const size = base + Math.floor(Math.random() * 3);
      if (!send('delta', { text: text.slice(i, i + size) })) return false;
      i += size;
      await new Promise(r => setTimeout(r, 10 + Math.random() * 8));
    }
    return true;
  };

  return { send, finish, streamText, state, onClose };
}

module.exports = { NL, startSSE, createWriter };
