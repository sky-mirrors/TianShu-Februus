// 全部盘扫描：盘级容量 + 每盘顶层条目。summary 只 readdir 顶层（秒级）；
// deep 对顶层项逐个 measure() 得出占用排序，受总预算约束——超预算的项标为未测，不静默少报。
// 禁区（回收站/系统卷信息等）在这里同样先挡后测：不进清单、只登记 denied。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { listDrives } from '../core/drives.mjs'
import { measure } from '../core/probe.mjs'
import { isDenied, denyReason } from '../core/guard.mjs'

/**
 * @param {{drives?: any[], deep?: boolean, topLimit?: number, budgetMs?: number,
 *   list?: () => Promise<any[]>, readdirFn?: typeof readdir, measureFn?: typeof measure,
 *   clock?: () => number}} [opts]
 */
export async function scanDrives({
  drives,
  deep = false,
  topLimit = 20,
  budgetMs = 15000,
  list = listDrives,
  readdirFn = readdir,
  measureFn = measure,
  clock = Date.now,
} = {}) {
  const all = drives ?? (await list())
  // 预算按盘平摊：否则第一个盘会吃光全部预算，后面的盘一条都测不到（实测 C 先把 15s 用完、D 全为空）
  const perDriveBudget = Math.max(1, Math.floor(budgetMs / Math.max(1, all.length)))
  const denied = []
  const out = []
  let truncated = false

  for (const d of all) {
    const deadline = clock() + perDriveBudget
    let entries = []
    let readError = null
    try {
      entries = await readdirFn(d.root, { withFileTypes: true })
    } catch (e) {
      // 盘存在但读不了（空光驱 / 未挂载 / 无权限）：如实报告，不当作空盘
      readError = e.code ?? String(e)
    }

    let dirCount = 0
    let fileCount = 0
    const top = []
    for (const e of entries) {
      const path = join(d.root, e.name)
      if (isDenied(path)) {
        denied.push({ path, reason: denyReason(path) })
        continue
      }
      const isDir = e.isDirectory()
      if (isDir) dirCount += 1
      else fileCount += 1
      let bytes = null
      let partial = false
      if (deep) {
        if (e.isSymbolicLink()) {
          // junction/符号链接：measure 只跳过"链接指向的内容"，不跳链接本身。
          // 顶层必须先挡，否则 C:\Documents and Settings 会把整个 C:\Users 重复算一遍（实测 139 GB 虚高）。
        } else if (clock() > deadline) {
          truncated = true
        } else {
          try {
            const m = await measureFn(path, { deadline })
            bytes = m.bytes
            partial = m.partial === true
            if (partial) truncated = true
          } catch {
            bytes = null
          }
        }
      }
      top.push({ name: e.name, path, kind: isDir ? 'dir' : 'file', bytes, measured: bytes !== null && !partial, partial })
    }
    if (deep) top.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))

    out.push({
      ...d,
      dirCount,
      fileCount,
      readError,
      topTotal: top.length,
      unmeasured: top.filter((t) => !t.measured).length,
      top: top.slice(0, topLimit),
    })
  }

  return { deep, drives: out, denied, truncated }
}
