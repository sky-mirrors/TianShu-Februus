import { join } from 'node:path'
import { homedir } from 'node:os'

// 路径归一：Windows 上同一路径可能以 \ 或 / 出现，比较前统一成 /。
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

// 运行期状态目录的唯一推导点。插件目录是可替换的发行包（更新与卸载整目录换掉），
// 台账、run 落盘和隔离区写进去会跟着一起没；宿主给的是数据目录。
// 工具面（activate 注入 host.storage.dataDir()）与 bin/ 下的 CLI 都必须从这里取，
// 否则两处各指一个位置、看到两份台账。
// 与宿主的相对布局约定：<dataDir>/runs/ 与 <dataDir>/trash/
export function pluginStatePaths(dataDir) {
  if (!dataDir) throw new Error('pluginStatePaths: 需要 dataDir')
  const stateDir = join(dataDir, 'runs')
  return { stateDir, ledgerPath: join(stateDir, 'ledger.jsonl'), quarantineRoot: join(dataDir, 'trash') }
}

// 非宿主调用（bin/ 下的 CLI、测试）的默认位置：与真实宿主的注入点同一约定。
export function defaultHostDataDir(pluginId = 'disk-steward') {
  return join(homedir(), '.rivet', 'plugins', pluginId, 'data')
}
