// 兼容入口：真正的服务实现已迁至 src/server.js，这里只做转发，
// 以保证 package.json 的 "main"/"start"、pkg 打包入口与既有文档继续有效。
require('./src/server.js');
