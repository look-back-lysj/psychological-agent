const RULES = [
  { key: 'safety_first', hits: ['不想活', '去死', '自杀', '自伤', '自残', '割腕', '跳楼', '结束生命', '轻生', '活不下去', '上吊', '烧炭'], score: 100 },
  { key: 'safety_first', hits: ['活着没意思', '活着太累', '不想醒', '撑不住', '太痛苦', '没有意义', '想要解脱', '消失就好了'], score: 40 },
  { key: 'low_pressure', hits: ['不想说', '算了', '没什么', '别问了', '不想聊', '先这样', '我不想讲'], score: 20 },
  { key: 'empathy', hits: ['难受', '难过', '委屈', '崩溃', '累', '自责', '没用', '失败', '焦虑', '压力大', '心烦', '考砸', '失眠', '害怕'], score: 18 },
  { key: 'clarify', hits: ['说不清', '也不确定', '不知道为什么', '莫名其妙', '乱糟糟', '一团糟', '模糊'], score: 14 },
  { key: 'problem_solving', hits: ['怎么办', '怎么调整', '有什么办法', '你帮我', '教我', '能帮我', '你能不能帮我想'], score: 16 }
];

function chooseStrategy(text, inputSafety) {
  if (inputSafety && (inputSafety.riskLevel === 'high_direct' || inputSafety.riskLevel === 'watch')) {
    return { key: 'safety_first', reason: '检测到可能涉及安全关注的表达，优先转入安全支持模式。' };
  }

  const normalized = String(text || '').toLowerCase();
  const scored = new Map();

  for (const rule of RULES) {
    const hit = rule.hits.some(h => normalized.includes(h));
    if (hit) {
      scored.set(rule.key, (scored.get(rule.key) || 0) + rule.score);
    }
  }

  if (scored.size === 0) {
    return { key: 'low_pressure', reason: '当前表达较短或信息不足，先采用低压力陪伴方式，避免追问过多。' };
  }

  const [bestKey, bestScore] = [...scored.entries()].sort((a, b) => b[1] - a[1])[0];
  const reasonMap = {
    safety_first: '存在明显安全信号。',
    low_pressure: '用户更可能暂时不想展开。',
    empathy: '用户表现出明显的负面情绪或压力。',
    clarify: '表达比较模糊，适合先温和澄清。',
    problem_solving: '用户明确在寻求办法或建议。'
  };

  return { key: bestKey, score: bestScore, reason: reasonMap[bestKey] || '匹配到最接近的沟通策略。' };
}

module.exports = { chooseStrategy };
