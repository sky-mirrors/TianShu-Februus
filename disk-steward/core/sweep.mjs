// 整盘 sweep：只算顶层体积回答不了「C 盘里哪些是垃圾」。
// 这里把盘内目录按深度递归枚举，逐个过规则库：命中规则给分级与建议，
// 未命中的**不当作垃圾**（advice=keep、grade=null），并单独列进 unmatched 让人能补规则。
// 禁区先挡后测；预算用尽标 truncated，不假装扫完了。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { measure } from './probe.mjs'
import { isDenied, denyReason } from './guard.mjs'
import { matchRule } from './run.mjs'
import { advise } from './advice.mjs'

/**
 * @param {{ root: string, depth?: number, rules?: any[], vars?: Record<string, any>,
 *   minBytes?: number, topLimit?: number, budgetMs?: number,
 *   readdirFn?: typeof readdir, measureFn?: typeof measure,
 *   isDeniedFn?: (p: string) => boolean, denyReasonFn?: (p: string) => string,
 *   clock?: () => number }} opts
 */
export async function sweepDrive({
  root,
  depth = 2,
  rules = [],
  vars = {},
  minBytes = 1024 * 1024,
  topLimit = 60,
  budgetMs = 120000,
  readdirFn = readdir,
  measureFn = measure,
  isDeniedFn = isDenied,
  denyReasonFn = denyReason,
  clock = Date.now,
}) {
  const deadline = clock() + budgetMs
  const denied = []
  const candidates = []
  const unmatched = []
  let truncated = false
  let scanned = 0

  const walk = async (dir, level) => {
    if (level > depth) return
    if (clock() > deadline) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdirFn(dir, { withFileTypes: true })
    } catch {
      return // 无权限/消失的目录：跳过，不虚报成 0 字节候选
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (isDeniedFn(path)) {
        denied.push({ path, reason: denyReasonFn(path) })
        continue
      }
      if (clock() > deadline) {
        truncated = true
        return
      }
      scanned += 1
      // 先判规则再测体积：整盘递归测体积太贵（实测 45s 只测完 C 盘 9 个顶层目录）。
      // 未收录的目录没有依据判它是垃圾，只交出路径供补规则，不当垃圾也不白花时间去量。
      const rule = rules.find((r) => matchRule(path, r, vars))
      if (!rule) {
        unmatched.push(path)
        await walk(path, level + 1)
        continue
      }
      let bytes = 0
      try {
        const m = await measureFn(path, { deadline })
        bytes = m?.bytes ?? 0
        if (m?.partial === true) truncated = true
      } catch {
        bytes = 0
      }
      if (bytes >= minBytes) {
        const item = {
          path,
          title: rule.title ?? entry.name,
          bytes,
          grade: rule.grade,
          blocked: null,
          executor: rule.executor ? rule.executor.type : null,
          ruleId: rule.id,
          explain: rule.explain ?? { why: rule.reason },
        }
        item.advice = advise(item)
        candidates.push(item)
      }
      await walk(path, level + 1)
    }
  }

  await walk(root, 1)
  candidates.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  return {
    root,
    depth,
    candidates: candidates.slice(0, topLimit),
    candidatesTotal: candidates.length,
    unmatched,
    denied,
    truncated,
    scanned,
  }
}
