// 系统域：白名单目标 + 禁区硬闸门；默认 executor 置空（只读）。
// 立场：只有调用方显式传 execEnabled: true 才给 stage 能力；即便开启，保护项与前置条件未满足的项仍不可执行。
import { join } from 'node:path'
import { buildRun, resolveVars, computeTotals } from '../core/run.mjs'
import { isDenied, denyReason } from '../core/guard.mjs'
import { probeItems } from '../core/occupancy.mjs'

// 白名单：只列我们自己能解释清楚的路径，不用通配符扫系统目录
export function systemRules() {
  return [
    {
      id: 'sys.user-temp',
      title: '用户临时目录（%TEMP%）',
      match: { kind: 'prefix', path: '{{TEMP}}' },
      grade: 'green',
      reason: '用户级临时文件目录，应用崩溃/下载残留的默认去处；执行需显式开启并由人确认',
      rebuild: '需要时由应用重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.localappdata-temp',
      title: '本地临时目录（%LOCALAPPDATA%\\Temp）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Temp' },
      grade: 'green',
      reason: '与 %TEMP% 同源的用户级临时区；执行需显式开启并由人确认',
      rebuild: '需要时由应用重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.win-temp',
      title: '系统临时目录（%WINDIR%\\Temp）',
      match: { kind: 'prefix', path: '{{WINDIR}}/Temp' },
      grade: 'yellow',
      reason: '系统级临时区，清理通常需要管理员权限，且可能被服务占用；执行需显式开启并由人确认',
      rebuild: '需要时由系统重建',
      sideEffect: '误删可能影响正在运行的服务',
      needsElevation: true,
      executor: { type: 'stage' },
    },
    {
      id: 'sys.chrome-cache',
      title: 'Chrome 缓存（Default/Cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Google/Chrome/User Data/Default/Cache' },
      grade: 'yellow',
      reason: '浏览器缓存；浏览器运行时清理会失败甚至损坏，所以带进程前置条件',
      rebuild: '浏览时自动重建',
      precondition: { kind: 'processNotRunning', name: 'chrome' },
      mtimeGuard: false,
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-cache',
      title: 'Edge 缓存（Default/Cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/Default/Cache' },
      grade: 'yellow',
      reason: '浏览器 HTTP 缓存；Edge 运行时清理会失败甚至损坏，故带进程前置条件',
      rebuild: '浏览时自动重建',
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      mtimeGuard: false,
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-code-cache',
      title: 'Edge 代码缓存（Default/Code Cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/Default/Code Cache' },
      grade: 'yellow',
      reason: 'JS/WASM 编译缓存，删后可重建；同样要求 Edge 未运行',
      rebuild: '下次访问站点时重建',
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      mtimeGuard: false,
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-gpu-cache',
      title: 'Edge GPU 缓存（Default/GPUCache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/Default/GPUCache' },
      grade: 'yellow',
      reason: 'GPU 着色器缓存，可重建；要求 Edge 未运行',
      rebuild: '下次渲染时重建',
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      mtimeGuard: false,
      executor: { type: 'stage' },
    },
    {
      id: 'sys.winsxs',
      title: '组件存储（WinSxS）',
      match: { kind: 'prefix', path: '{{WINDIR}}/WinSxS' },
      grade: 'brown',
      reason: '组件存储不能直接删；只能通过 DISM 清理被取代的组件版本',
    },
    {
      id: 'sys.recycle-bin',
      title: '回收站',
      match: { kind: 'prefix', path: '{{SYSTEMDRIVE}}/$Recycle.Bin' },
      grade: 'brown',
      reason: '回收站由系统管理；本插件不接管（避免与资源管理器行为冲突）',
    },
  ]
}

export function systemVars(env = process.env) {
  return {
    domain: 'system',
    TEMP: env.TEMP ?? env.TMP ?? '',
    LOCALAPPDATA: env.LOCALAPPDATA ?? '',
    WINDIR: env.WINDIR ?? '',
    SYSTEMDRIVE: env.SYSTEMDRIVE ?? '',
    unmatchedRoots: [],
  }
}

export async function scanSystem({ env = process.env, now = Date.now(), probe = false, execEnabled = false } = {}) {
  const vars = systemVars(env)
  const denied = []
  const rules = []

  // 禁区在**测量之前**就挡掉：否则会去遍历 C:\Windows\WinSxS、C:\$Recycle.Bin 这类目录
  // （实测：挡之前单个用例跑 8.9 秒，且真的在走真实系统目录）。
  for (const r of systemRules()) {
    const vk = r.match.path.match(/\{\{(\w+)\}\}/)?.[1]
    if (vk && !vars[vk]) {
      denied.push({ path: r.match.path, reason: `变量 ${vk} 缺失，跳过（避免展开成整盘）` })
      continue
    }
    const resolved = resolveVars(r.match.path, vars)
    if (isDenied(resolved)) {
      denied.push({ path: resolved, reason: denyReason(resolved) })
      continue
    }
    rules.push(r)
  }

  const run = await buildRun({ rules, vars, now, collectUnmatched: false })
  const items = []
  for (const item of run.items) {
    // 兜底：即使规则没被拦，命中禁区也不进清单
    if (isDenied(item.path)) {
      denied.push({ path: item.path, reason: denyReason(item.path) })
      continue
    }
    items.push({
      ...item,
      // execEnabled 必须显式打开；即便如此，保护项与 precondition 未满足的项仍不可执行
      executor: execEnabled && item.grade !== 'brown' && !item.blocked ? 'stage' : null,
      executionMode: execEnabled && item.grade !== 'brown' ? 'staged' : 'readonly',
      explain: {
        ...item.explain,
        undo: execEnabled && item.grade !== 'brown'
          ? '移入隔离区（同卷 rename），可整批撤销'
          : '系统域只读：本版不提供执行（需显式开启才谈得上撤销）',
      },
    })
  }

  // 探测是**可选**的：默认不写任何东西（连临时探针文件也不建）
  const finalItems = probe ? await probeItems(items) : items

  const totals = computeTotals(finalItems)
  return {
    ...run,
    origin: 'system',
    items: finalItems,
    denied,
    probed: Boolean(probe),
    totals,
    selectable: totals.selectable,
  }
}
