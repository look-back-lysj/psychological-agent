// 兼容入口：为避免两套初始化逻辑分叉，统一交由根目录的 main.js 启动。
// 直接运行：node src/index.js（等价于 node main.js）
// 若不希望自动打开浏览器，可设置环境变量 NO_BROWSER=1。
require('../main.js');
