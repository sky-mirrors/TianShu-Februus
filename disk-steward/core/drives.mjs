// 盘符枚举：只对 A–Z 逐个做只读 statfs（实测本机 26 个盘符合计 2ms，不存在的盘符 1ms 内 ENOENT）。
// 不调用 wmic/PowerShell，不创建任何文件——枚举本身不产生副作用。
import { statfs } from 'node:fs/promises'

export const DRIVE_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

/** 规范化成 Node 在 Windows 上能接受的根路径：'C' / 'c:' / 'C:\\' → 'C:\\' */
export function driveRoot(letter) {
  return `${String(letter).replace(/[:\\/]/g, '').toUpperCase()}:\\`
}

/**
 * 枚举当前设备上存在的盘。
 * 盘的存在性判据是 statfs 成功——不存在的盘符直接跳过，不列空盘、不猜。
 * @param {{probe?: typeof statfs, letters?: string[]}} [opts]
 * @returns {Promise<Array<{letter: string, root: string, totalBytes: number, freeBytes: number, usedBytes: number}>>}
 */
export async function listDrives({ probe = statfs, letters = DRIVE_LETTERS } = {}) {
  const out = []
  for (const L of letters) {
    const root = driveRoot(L)
    let st
    try {
      st = await probe(root)
    } catch {
      continue
    }
    const totalBytes = Number(st.bsize) * Number(st.blocks)
    const freeBytes = Number(st.bsize) * Number(st.bavail)
    out.push({ letter: root.slice(0, 2), root, totalBytes, freeBytes, usedBytes: totalBytes - freeBytes })
  }
  return out
}
