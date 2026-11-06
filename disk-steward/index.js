// 天枢插件入口（TPI 1.0）。
// 宿主在 import 入口之前注入 globalThis.__tianshuTPI，入口必须 default（或 plugin）导出
// defineTianshuPlugin({ id, activate }) 的结果——工具由 activate(host) 返回，宿主再包成
// 工具面形状。只导出 `tools` 会被判 rejected_handshake：插件中心显示得出来、工具面永远为空。
import { createTools } from './tools/index.mjs'

export { createTools }

const sdk = globalThis.__tianshuTPI
if (!sdk) {
  throw new Error('disk-steward: 只能在 TPI 1.0 宿主内加载（globalThis.__tianshuTPI 未注入）')
}

export default sdk.defineTianshuPlugin({
  id: 'disk-steward',
  // activate 的返回契约为 { tools }；工具对象字段名（inputSchema / execute({args}) /
  // concurrencySafe / requiresApproval / timeoutMs）由宿主 wrapTpiTool 直接消费。
  activate: () => ({ tools: createTools() }),
})
