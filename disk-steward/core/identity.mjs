// 文件身份快照：用于执行前重验，堵住"扫描后被换掉"的 TOCTOU 窗口。
import { stat } from 'node:fs/promises'

/**
 * @param {string} path
 * @returns {Promise<{dev:number, ino:number, size:number, mtimeMs:number, isDir:boolean}|null>}
 */
export async function snapshot(path) {
  try {
    const s = await stat(path)
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: Math.round(s.mtimeMs), isDir: s.isDirectory() }
  } catch {
    return null
  }
}

/**
 * 身份是否一致：dev+ino 必须相同；大小与 mtime 也必须相同（防原地改写）。
 * @param {{dev:number, ino:number, size:number, mtimeMs:number}|null} a
 * @param {{dev:number, ino:number, size:number, mtimeMs:number}|null} b
 */
export function sameIdentity(a, b) {
  if (!a || !b) return false
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1
}

/**
 * 移动完成后的校验：尺寸必须一致，时间允许 1 秒误差（跨卷复制会微调 mtime）。
 * 不一致说明"检查后、动手前"目标被换掉了，调用方应回滚。
 * @param {{size:number, mtimeMs:number}|null} before
 * @param {{size:number, mtimeMs:number}|null} after
 */
export function verifyMoved(before, after) {
  if (!before || !after) return { ok: false, code: 'POSTMOVE_MISMATCH', reason: '缺快照' }
  if (before.size !== after.size) {
    return { ok: false, code: 'POSTMOVE_MISMATCH', reason: `尺寸 ${before.size} → ${after.size}` }
  }
  if (Math.abs(before.mtimeMs - after.mtimeMs) > 1000) {
    return { ok: false, code: 'POSTMOVE_MISMATCH', reason: `mtime 偏移 ${Math.abs(before.mtimeMs - after.mtimeMs)}ms` }
  }
  return { ok: true }
}
