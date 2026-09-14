/**
 * 模块：pipeline/vision —— 图片侧安全筛查（为危机分级提供「只能升级」的信号）
 * 层级：pipeline L3（装配；依赖 infra/llm）
 * 职责：用一次短调用判断图片里是否**直接可见**自伤痕迹 / 危机场景，产出 imageSignals。
 * 契约：screenImage({ image }) -> { selfHarmVisible, distressVisible, source } | null
 * 改动风险：🟡 中 —— node --check + 离线 mock 探针
 * 不要做什么：
 *   1) **不许**把「模型说没事」当作降低风险等级的依据（铁律见 safety.js：只能升不能降）
 *   2) 不许抛错或阻塞主回复：任何异常/超时/解析失败一律返回 null（fail-safe）
 *   3) 不许把图片写进日志
 *
 * ⚠️ 诚实标注：视觉模型的判断不可靠（会漏判），因此本模块只负责「发现可疑就升级」，
 *    「没发现」不等于安全 —— 含图轮次的最低等级由 safety.js 的 L1 地板保证。
 */

const { callLLM } = require('../infra/llm');

const TIMEOUT_MS = Number(process.env.XINYU_IMAGE_SCREEN_TIMEOUT_MS || 8000);

const SCREEN_PROMPT = [
  '你是图像安全筛查器，只做一件事：判断图片里是否**直接可见**下列内容。',
  '1) selfHarmVisible：可见的自伤痕迹、伤口、血迹，或正在伤害自己的动作。',
  '2) distressVisible：可见的明显危机场景（大量药物、危险工具、遗书、极端消瘦等）。',
  '判定规则：看不清 / 不确定 / 图片与这些无关 → 一律填 false；不要推测文字内容，不要做心理判断。',
  '只输出一行 JSON，不要任何其它文字：{"selfHarmVisible":false,"distressVisible":false}'
].join(String.fromCharCode(10));

/** 从模型输出里抠出第一个 JSON 对象（不用正则，避免转义问题） */
function extractJson(text) {
  const s = String(text == null ? '' : text);
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

function isEnabled() {
  return String(process.env.XINYU_IMAGE_SCREEN || 'on') !== 'off';
}

/**
 * 图片安全筛查（fail-safe：任何问题都返回 null）
 * @param {{image:string}} input 图片 data URL
 * @returns {Promise<{selfHarmVisible:boolean, distressVisible:boolean, source:string}|null>}
 */
async function screenImage(input) {
  if (!isEnabled()) return null;
  const image = input && input.image;
  if (!image) return null;
  try {
    const run = callLLM(SCREEN_PROMPT, [{ role: 'user', text: '请筛查这张图片。', image: image }], { retries: 0 });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
    const r = await Promise.race([run, timeout]);
    if (!r || !r.content) return null;
    const obj = extractJson(r.content);
    if (!obj) return null;
    return {
      selfHarmVisible: obj.selfHarmVisible === true,
      distressVisible: obj.distressVisible === true,
      source: 'vision_model'
    };
  } catch (e) {
    return null;   // fail-safe：筛查失败不影响主流程（含图仍走 L1 地板）
  }
}

module.exports = { screenImage, isEnabled, extractJson, SCREEN_PROMPT };
