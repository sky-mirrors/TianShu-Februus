// 系统域：白名单目标 + 禁区硬闸门；默认 executor 置空（只读）。
// 立场：只有调用方显式传 execEnabled: true 才给 stage 能力；即便开启，保护项与前置条件未满足的项仍不可执行。
import { join } from 'node:path'
import { buildRun, resolveVars, computeTotals, expandGlobFiles } from '../core/run.mjs'
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
    // 用户级缓存与转储：实测这台机器上合计约 1.3 GB，都是可重建的派生数据。
    // C:\Windows\* 下的 Installer/Logs/Prefetch 不在此列——它们会被 guard 的
    // WINDOWS_DIR 硬禁区拦在 items 之外，加规则只会得到永不生效的死规则。
    {
      id: 'sys.pip-cache',
      title: 'pip 包缓存（%LOCALAPPDATA%\\pip\\Cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/pip/Cache' },
      grade: 'green',
      reason: 'pip 下载的 wheel 缓存；只在重新安装依赖时需要重新下载',
      rebuild: '重新安装依赖时自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.crash-dumps',
      title: '崩溃转储（%LOCALAPPDATA%\\CrashDumps）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/CrashDumps' },
      grade: 'green',
      reason: '应用崩溃时生成的内存转储，仅在排查那次崩溃时需要',
      rebuild: '不可重建（历史崩溃记录）',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.explorer-thumbs',
      title: '缩略图缓存（%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Windows/Explorer' },
      grade: 'green',
      reason: '资源管理器的缩略图与图标缓存，删后浏览文件时自动重建',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.d3d-cache',
      title: 'DirectX 着色器缓存（D3DSCache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/D3DSCache' },
      grade: 'green',
      reason: '显卡着色器编译缓存，删后首次运行会重新编译（略慢一次）',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.pnpm-store',
      title: 'pnpm 存储（%LOCALAPPDATA%\\pnpm）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/pnpm' },
      grade: 'green',
      reason: 'pnpm 内容寻址包存储；删后重新安装依赖需重新下载',
      rebuild: '重新安装依赖时重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.npm-cache',
      title: 'npm 缓存（%LOCALAPPDATA%\\npm-cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/npm-cache' },
      // yellow 而不是 green：删后所有依赖要重新下载，离线时直接失败。
      // 建议层会把它判成「谨慎：可清但有前提」，且清理仍需用户逐项点名。
      grade: 'yellow',
      reason: 'npm 内容寻址缓存（本机实测数 GB）；删后所有依赖需重新下载，离线时会失败',
      rebuild: '重新安装依赖时重建',
      executor: { type: 'stage' },
    },
    // 第二批：用户主目录下的包管理器缓存 + 浏览器站点缓存 + 模型资产。
    // 前八条都是可重建的派生数据；Ollama 模型与 UWP 应用数据是用户资产，判 brown 永不删。
    {
      id: 'sys.cargo-registry',
      title: 'Cargo 注册表缓存（~/.cargo/registry）',
      match: { kind: 'prefix', path: '{{USERPROFILE}}/.cargo/registry' },
      grade: 'yellow',
      reason: 'Rust 依赖源码与索引缓存，删后需重新下载',
      rebuild: '重新构建时按需下载',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.maven-repo',
      title: 'Maven 本地仓库（~/.m2/repository）',
      match: { kind: 'prefix', path: '{{USERPROFILE}}/.m2/repository' },
      grade: 'yellow',
      reason: 'Java 依赖构件缓存，删后需重新下载',
      rebuild: '重新构建时按需下载',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.nuget-packages',
      title: 'NuGet 包缓存（~/.nuget/packages）',
      match: { kind: 'prefix', path: '{{USERPROFILE}}/.nuget/packages' },
      grade: 'yellow',
      reason: '.NET 包缓存，删后需重新下载',
      rebuild: '重新构建时按需下载',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.user-cache',
      title: '用户 .cache（~/.cache）',
      match: { kind: 'prefix', path: '{{USERPROFILE}}/.cache' },
      grade: 'yellow',
      reason: '各类命令行工具的缓存目录，内容按工具混放，删前建议先看一眼里面有什么',
      rebuild: '由各工具自行重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-sw-cache',
      title: 'Edge Service Worker 缓存',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/Default/Service Worker' },
      // 与其余 Edge 规则一致：浏览器开着时动它的站点缓存会损坏/profile 损坏
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      grade: 'green',
      reason: '站点离线资源缓存，删后访问时重新拉取',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-indexeddb',
      title: 'Edge IndexedDB（Default/IndexedDB）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/Default/IndexedDB' },
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      grade: 'green',
      reason: '站点本地数据库缓存；删后部分站点会丢离线数据并需重新登录',
      rebuild: '自动重建（可能丢离线数据）',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.inet-cache',
      title: 'IE/系统网络缓存（INetCache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Windows/INetCache' },
      grade: 'green',
      reason: '系统级网络临时缓存，可自动重建',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.web-cache',
      title: 'WebCache（系统浏览器缓存库）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Windows/WebCache' },
      grade: 'green',
      reason: '系统 Web 缓存数据库，可自动重建',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.uwp-packages',
      title: 'UWP 应用数据（%LOCALAPPDATA%\\Packages）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Packages' },
      grade: 'brown',
      reason: 'UWP 应用的数据、账号与设置，删了应用需要重新初始化',
    },
    {
      id: 'sys.ollama-models',
      title: 'Ollama 模型（~/.ollama/models）',
      match: { kind: 'prefix', path: '{{USERPROFILE}}/.ollama/models' },
      grade: 'brown',
      reason: '已下载的大模型权重，删了要重新下载数 GB；属用户资产，不清理',
    },
    // 第三批：实测本机存在的应用缓存。判绿色只针对纯缓存子目录——
    // 父目录（网易云整目录 / Edge 用户数据 / JetBrains 整个）都含用户资产，绝不能整删。
    {
      id: 'sys.netease-cache',
      title: '网易云音乐缓存（CloudMusic\\Cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Netease/CloudMusic/Cache' },
      grade: 'green',
      reason: '在线试听缓存（本机实测十余 GB）；歌曲文件在 Library 目录，不在此范围内',
      rebuild: '播放时自动重新缓存',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.jetbrains-caches',
      title: 'JetBrains 索引缓存（JetBrains\\*\\caches）',
      match: { kind: 'glob', path: '{{LOCALAPPDATA}}/JetBrains/*/caches' },
      grade: 'yellow',
      reason: 'IDE 的索引与缓存，删后首次打开项目需重建索引（耗时较长）；配置与插件不在此目录',
      rebuild: '首次打开项目时重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-component-cache',
      title: 'Edge 组件解包缓存（component_crx_cache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/component_crx_cache' },
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      grade: 'green',
      reason: '已安装扩展的组件解包缓存，可重新解包',
      rebuild: '自动重建',
      executor: { type: 'stage' },
    },
    {
      id: 'sys.edge-gr-cache',
      title: 'Edge 着色器缓存（GrShaderCache）',
      match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/Microsoft/Edge/User Data/GrShaderCache' },
      precondition: { kind: 'processNotRunning', name: 'msedge' },
      grade: 'green',
      reason: 'GPU 着色器缓存，删后首次渲染会重新编译',
      rebuild: '自动重建',
      executor: { type: 'stage' },
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
    // 用户主目录：~/.cargo、~/.m2、~/.nuget、~/.cache、~/.ollama 都挂在它下面
    USERPROFILE: env.USERPROFILE ?? '',
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
    // glob 规则（如 JetBrains/*/caches）要先展开成具体目录：
    // buildRun 是「路径存在就测量」，带 `*` 的路径永远 exists=false，不展开即静默失效。
    if (r.match.kind === 'glob') {
      for (const hit of await expandGlobFiles(resolved)) {
        if (isDenied(hit)) {
          denied.push({ path: hit, reason: denyReason(hit) })
          continue
        }
        rules.push({ ...r, match: { kind: 'prefix', path: hit } })
      }
      continue
    }
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
