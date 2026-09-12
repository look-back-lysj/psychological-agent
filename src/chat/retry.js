/**
 * 模块：chat/retry —— 「重新生成」去重
 * 层级：chat L4（编排）
 * 职责：处理前端「重新生成」把同一条用户消息再发一次时，避免在会话里追加重复的用户轮次、
 *      并如实返回实际行为（deduped / user_reused / fallback_normal）供 agent 标注。
 * 依赖：sessions（../infra/sessions）、core/utils（../core/utils）
 * 被依赖：chat/pipeline.js
 * 改动风险：🔴 高 —— 改完要跑 node tests/run.js（期望 42/42 + 9/9）+ 启动冒烟
 * 契约：dedupeRetryTurns(sessionId, message) 的返回结构
 *      { ok:boolean, status:'deduped'|'user_reused'|'fallback_normal', removedAssistants:number } 不得改。
 * 不要做什么：
 *   1) 不要为了「重试更彻底」去删除用户消息或其后更多轮次 —— 只允许移除「紧随其后的助手回复」；
 *   2) 不要在这里做任何模型调用或输出安全检查（本函数只碰会话存储）。
 */

const { ensureSession } = require('../infra/sessions');
const { normalizeText } = require('../core/utils');

/**
 * 「重新生成」去重（只允许改 chat.js：本函数只读使用 sessions 的现有导出）。
 *
 * 前端点「重新生成」会把同一条消息再发一次；若不处理，addTurn(user) 会追加一条
 * 重复的用户消息，多轮上下文被污染。这里在会话内定位「这条用户消息 + 紧随其后的
 * 助手回复」，删掉助手回复并保留用户消息，返回实际行为供 agent.retry_dedup 标注。
 *
 * 防御性约束（宁可少做，也不破坏会话）：
 *   - 找不到对应消息 → 按普通请求处理（返回 ok=false，调用方会正常 addTurn）；
 *   - 命中的用户消息后面还有更多轮次（说明用户在重试很久之前的一条）→ 不动会话，
 *     按普通请求处理，避免误删后续对话；
 *   - 任何异常 → 按普通请求处理，绝不报错。
 *
 * @returns {{ ok: boolean, status: string, removedAssistants: number }}
 */
function dedupeRetryTurns(sessionId, message) {
  try {
    const s = ensureSession(sessionId);
    if (!s || !Array.isArray(s.turns) || !s.turns.length) {
      return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
    }
    const key = normalizeText(message);
    if (!key) return { ok: false, status: 'fallback_normal', removedAssistants: 0 };

    // 从末尾往前找最近一条内容相同的用户消息
    let idx = -1;
    for (let i = s.turns.length - 1; i >= 0; i -= 1) {
      const t = s.turns[i];
      if (t && t.role === 'user' && normalizeText(t.text) === key) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, status: 'fallback_normal', removedAssistants: 0 };

    const tail = s.turns.slice(idx + 1);
    const onlyAssistantTail = tail.length <= 1 && tail.every(t => t && t.role === 'assistant');
    if (!onlyAssistantTail) {
      // 重试的是更早的一轮：不动会话，退回普通请求
      return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
    }

    // 命中末尾这一轮：保留用户消息，移除其后已存在的助手回复
    s.turns = s.turns.slice(0, idx + 1);
    s.updatedAt = Date.now();
    const removedAssistants = tail.length;
    return {
      ok: true,
      status: removedAssistants > 0 ? 'deduped' : 'user_reused',
      removedAssistants
    };
  } catch (e) {
    return { ok: false, status: 'fallback_normal', removedAssistants: 0 };
  }
}

module.exports = { dedupeRetryTurns };
