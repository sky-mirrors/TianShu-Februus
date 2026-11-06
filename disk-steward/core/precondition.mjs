// precondition：机器可检查的执行前置。fail-closed —— 不认识的一律不通过。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export const defaultPs = {
  async list() {
    if (process.platform !== 'win32') return []
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (r.status !== 0 || !r.stdout) return []
    return r.stdout
      .split(/\r?\n/)
      .map((l) => (l.split('","')[0] ?? '').replace(/^"/, '').trim())
      .filter(Boolean)
  },
}

const norm = (s) => String(s).toLowerCase().replace(/\.exe$/, '')

export async function checkPrecondition(spec, { ps = defaultPs, fs = { exists: existsSync }, services = defaultServices } = {}) {
  if (!spec || !spec.kind) return { ok: false, code: 'PRECONDITION_UNKNOWN', reason: '缺 kind' }

  if (spec.kind === 'processNotRunning') {
    const list = (await ps.list()).map(norm)
    if (list.includes(norm(spec.name))) {
      return { ok: false, code: 'PRECONDITION_FAILED', reason: `进程 ${spec.name} 正在运行，先关掉再清` }
    }
    return { ok: true }
  }

  if (spec.kind === 'serviceStopped') {
    // 有 info 就用 info（能拿到启动类型与依赖链），否则退回只查状态
    const info = typeof services.info === 'function'
      ? await services.info(spec.name)
      : { state: await services.state(spec.name), startType: 'UNKNOWN', dependents: [] }
    const st = info.state
    if (st === 'stopped') {
      const warnings = []
      if (info.startType === 'AUTO_START') warnings.push(`服务 ${spec.name} 为自动启动，停止后可能被系统拉起`)
      return { ok: true, warnings }
    }
    if (st === 'running') {
      const dep = info.dependents?.length ? `，另有 ${info.dependents.length} 个从属服务（先停它们）` : ''
      return { ok: false, code: 'PRECONDITION_FAILED', reason: `服务 ${spec.name} 正在运行${dep}，先停掉再清` }
    }
    return { ok: false, code: 'PRECONDITION_UNKNOWN', reason: `服务 ${spec.name} 状态未知（不猜）` }
  }

  if (spec.kind === 'fileExists') {
    if (!fs.exists(spec.path)) {
      return { ok: false, code: 'PRECONDITION_FAILED', reason: `缺少前置文件 ${spec.path}` }
    }
    return { ok: true }
  }

  return { ok: false, code: 'PRECONDITION_UNKNOWN', reason: `未知 precondition: ${spec.kind}` }
}

export async function checkPreconditions(specs, deps) {
  for (const s of specs ?? []) {
    const r = await checkPrecondition(s, deps)
    if (!r.ok) return r
  }
  return { ok: true }
}

// 服务状态查询：sc.exe query 是 cmd 内建工具，免提权可查状态
export const defaultServices = {
  async state(name) {
    if (process.platform !== 'win32') return 'unknown'
    const r = spawnSync('sc.exe', ['query', String(name)], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (r.status !== 0 || !r.stdout) return 'unknown'
    if (/\bRUNNING\b/i.test(r.stdout)) return 'running'
    if (/\bSTOPPED\b/i.test(r.stdout)) return 'stopped'
    return 'unknown'
  },
}

// 服务详情：状态 + 启动类型 + 从属服务。sc.exe 全部免提权。
defaultServices.info = async function info(name) {
  if (process.platform !== 'win32') return { state: 'unknown', startType: 'UNKNOWN', dependents: [] }
  const run = (args) => spawnSync('sc.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true })
  const q = run(['query', String(name)])
  let state = 'unknown'
  if (q.status === 0 && q.stdout) {
    if (q.stdout.includes('RUNNING')) state = 'running'
    else if (q.stdout.includes('STOPPED')) state = 'stopped'
  }
  const qc = run(['qc', String(name)])
  const startType = /START_TYPE\s*:\s*\d+\s+([A-Z_]+)/i.exec(qc.stdout || '')?.[1]?.toUpperCase() ?? 'UNKNOWN'
  const ed = run(['enumdepend', String(name)])
  const dependents = [...String(ed.stdout || '').matchAll(/SERVICE_NAME:\s*(\S+)/g)].map((m) => m[1])
  return { state, startType, dependents }
}
