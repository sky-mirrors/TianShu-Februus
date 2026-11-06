// 占用探测：只做两件安全的事——在目录里建个临时探针文件再删掉、对目标做只读打开。
// 永不重命名/移动真实文件（那正是"删错了东西"的入口）。
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isDenied, denyReason } from './guard.mjs'

const mapCode = (code) => {
  if (code === 'EBUSY' || code === 'ETXTBSY') return 'LOCKED'
  if (code === 'EACCES' || code === 'EPERM') return 'NO_PERMISSION'
  if (code === 'ENOENT') return 'ENOENT'
  if (code === 'ENOTDIR') return 'NOT_A_DIR'
  if (code === 'EROFS') return 'READ_ONLY_FS'
  return 'UNKNOWN'
}

// 目录可写性：建 -> 删。失败即说明"移不出去"，且原因要能说清。
export async function probeWritable(dir, { fs = fsp } = {}) {
  if (isDenied(dir)) return { ok: false, code: 'REFUSED_DENIED', reason: denyReason(dir) }
  const probe = join(dir, `.disk-steward-probe-${randomBytes(4).toString('hex')}`)
  try {
    await fs.writeFile(probe, 'probe', { flag: 'wx' })
  } catch (e) {
    return { ok: false, code: mapCode(e.code), reason: e.code }
  }
  try {
    await fs.unlink(probe)
  } catch (e) {
    // 删不掉也要如实报告：留下一个可见的探针文件，而不是假装干净
    return { ok: true, code: 'WRITABLE_BUT_PROBE_LEFT', reason: probe }
  }
  return { ok: true, code: 'WRITABLE' }
}

// 文件是否被独占：以**读写**方式（'r+'）打开再立即关闭（不是只读打开）。
// 用读写是为了让"占用写锁"的进程把它挡下来；这仍是启发式（Node 无法指定 Windows 共享模式），
// 失败一律当"可能被占用"，绝不据此推断"可以删"。
export async function probeLock(file, { fs = fsp } = {}) {
  if (isDenied(file)) return { ok: false, code: 'REFUSED_DENIED', reason: denyReason(file) }
  try {
    const fh = await fs.open(file, 'r+')
    await fh.close()
    return { ok: true, code: 'FREE' }
  } catch (e) {
    return { ok: false, code: mapCode(e.code), reason: e.code }
  }
}

// 给 item 附上占用结论（不改入参，返回新对象）
export async function probeItem(item, opts = {}) {
  const w = await probeWritable(item.path, opts)
  let occupancy = w.code
  if (w.code === 'NOT_A_DIR') {
    const l = await probeLock(item.path, opts)
    occupancy = l.ok ? 'FREE' : l.code
  }
  return { ...item, occupancy, occupancyReason: w.reason ?? null }
}

export async function probeItems(items, opts = {}) {
  const out = []
  for (const it of items) out.push(await probeItem(it, opts))
  return out
}
