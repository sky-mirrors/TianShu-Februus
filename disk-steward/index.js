// 天枢插件入口（TPI 1.0）。
// 宿主在 import 入口之前注入 globalThis.__tianshuTPI，入口必须 default（或 plugin）导出
// defineTianshuPlugin({ id, activate }) 的结果——工具由 activate(host) 返回，宿主再包成
// 工具面形状。只导出 `tools` 会被判 rejected_handshake：插件中心显示得出来、工具面永远为空。
import { pluginStatePaths } from './core/paths.mjs'
import { createTools } from './tools/index.mjs'

export { createTools }

const sdk = globalThis.__tianshuTPI
if (!sdk) {
  throw new Error('disk-steward: 只能在 TPI 1.0 宿主内加载（globalThis.__tianshuTPI 未注入）')
}

/**
 * 运行期状态的位置由宿主决定，不落在插件安装目录里。
 * 安装目录是可替换的发行包（更新/卸载整个换掉），而 run 落盘、台账和隔离区必须比它活得久；
 * 且桌面端的安装目录在用户 AppData 之下，写进去等于把用户数据混进程序目录。
 * 宿主未提供 storage.dataDir() 时直接失败，不猜一个位置。
 * @param {{ cwd?: string, storage?: { dataDir?: () => string } }} host
 */
export function pluginState(host) {
  const dataDir = host?.storage?.dataDir?.()
  if (!dataDir) throw new Error('disk-steward: 宿主未提供 storage.dataDir()，无法确定台账与隔离区位置')
  return { ...pluginStatePaths(dataDir), projectRoot: host.cwd }
}

export default sdk.defineTianshuPlugin({
  id: 'disk-steward',
  // activate 的返回契约为 { tools }；工具对象字段名（inputSchema / execute({args}) /
  // concurrencySafe / requiresApproval / timeoutMs）由宿主 wrapTpiTool 直接消费。
  activate: (host) => {
    // 「人批准过」的证据只从宿主的会话记录读（host.transcripts），不信任 approval 参数本身：
    // 参数是模型能填的字符串，会话记录里 user 角色的消息才是用户真的说过。
    // 宿主没提供 transcripts → 返回 null → 执行类工具 fail-closed（EXEC_APPROVAL_UNVERIFIABLE）。
    const approvalEvidence = () => {
      if (typeof host.transcripts?.read !== 'function' || !host.sessionId) return null
      try {
        return host.transcripts.read(host.sessionId)
      } catch {
        return null
      }
    }
    return { tools: createTools({ ...pluginState(host), approvalEvidence }) }
  },
})
