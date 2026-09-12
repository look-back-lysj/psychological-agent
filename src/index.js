/**
 * 模块：index —— 兼容入口（薄别名）
 * 层级：入口（src/ 顶层）
 * 职责：把 node src/index.js 转发到 src/server.js，避免两套初始化逻辑分叉。
 * 依赖：server.js
 * 被依赖：历史文档 / 旧脚本可能仍用 node src/index.js
 * 改动风险：🟢 低 —— node --check 即可
 * 契约：本文件保持 4 行以内的薄转发，不承载任何服务逻辑。
 * 不要做什么：
 *   1) 不要在这里复制一份 express 装配（两套初始化必然分叉）；
 *   2) 不要把转发目标改回根目录 main.js（真实实现在 src/server.js）。
 */
// 兼容入口：真正的服务实现在 src/server.js（根目录 main.js 也转发到它）。
// 直接运行：node src/index.js（等价于 node main.js / node src/server.js）
require('./server.js');
