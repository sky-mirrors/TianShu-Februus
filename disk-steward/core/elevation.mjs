// 提权判定与提权命令构造。原则：**只判定、只构造，绝不自动执行**。
// 本机实测（2026-11-04 本次会话）：net session 成功、C:\Windows\Temp 可写 → elevated=true。
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const PS_ESCAPE = (s) => String(s).replace(/'/g, "''")

// net session 需要管理员权限，失败即未提权（这是 Windows 上最轻的判定）
/** @param {{ run?: (args: string[]) => any }} [opts] */
export async function isElevated({ run } = {}) {
  const runner = run ?? ((args) => spawnSync('net', args, { encoding: 'utf8', timeout: 5000, windowsHide: true }))
  try {
    const r = runner(['session'])
    if (r.error) return { elevated: false, reason: `无法确认提权状态（${r.error}），按未提权处理` }
    return r.status === 0 ? { elevated: true, reason: 'net session 成功' } : { elevated: false, reason: 'net session 被拒（未提权）' }
  } catch (e) {
    return { elevated: false, reason: `无法确认提权状态（${e.code ?? e.message}），按未提权处理` }
  }
}

// 系统目录可写性：**故意绕过清理侧的禁区闸门**——这里测的是"这台机器上我能不能写系统目录"，
// 不用于任何清理判定（清理判定仍走 occupancy.probeWritable，那里禁区一律拒绝）。
/** @param {string} [dir] @param {{ fs?: any }} [opts] */
export async function systemDirWritable(dir = `${process.env.WINDIR ?? 'C:\\Windows'}\\Temp`, { fs = fsp } = {}) {
  const probe = join(dir, `.ds-elev-${randomBytes(4).toString('hex')}`)
  try {
    await fs.writeFile(probe, 'probe', { flag: 'wx' })
  } catch (e) {
    return { writable: false, code: e.code ?? 'UNKNOWN' }
  }
  try {
    await fs.unlink(probe)
  } catch {
    return { writable: true, code: 'WRITABLE_BUT_PROBE_LEFT' }
  }
  return { writable: true, code: 'WRITABLE' }
}

// 只构造命令，不执行。真正执行必须由人显式触发（本插件不自动提权）。
export function planElevation(payload, { exe = 'powershell.exe' } = {}) {
  const command =
    `Start-Process -FilePath '${exe}' -ArgumentList '-NoProfile','-Command','${PS_ESCAPE(payload)}' -Verb RunAs -Wait`
  return { command, payload, executed: false, note: '需要用户在 UAC 对话框上确认；本插件不会自动执行它' }
}
