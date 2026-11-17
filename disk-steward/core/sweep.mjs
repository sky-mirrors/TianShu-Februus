// 整盘 sweep：只算顶层体积回答不了「C 盘里哪些是垃圾」。
// 这里把盘内目录按深度递归枚举，逐个过规则库：命中规则给分级与建议，
// 未命中的**不当作垃圾**（只交出路径供补规则），并单独列进 unmatched。
// 三条纪律：
//  1) 先判规则再测体积——整盘递归测体积太贵（实测 45s 只测完 C 盘 9 个顶层目录）；
//  2) 同一规则命中父子目录时只报父一次，否则同一份数据被重复计数（回收站曾报两次）；
//  3) 禁区（C:\Windows 等）扫得到、量得准，但永不给执行器：宽的是「看得见」不是「动得了」。
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

  /**
   * @param {string} dir
   * @param {number} level
   * @param {Set<string>} claimed 祖先链上已命中的规则 id：同一规则只报最靠上的那一个
   * @param {boolean} insideDenied 祖先是否已在禁区里：子树只读，不再逐项登记
   */
  const walk = async (dir, level, claimed = new Set(), insideDenied = false) => {
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
      const visitOnly = insideDenied || isDeniedFn(path)
      if (visitOnly && !insideDenied) denied.push({ path, reason: denyReasonFn(path) })
      if (clock() > deadline) {
        truncated = true
        return
      }
      scanned += 1
      const rule = rules.find((r) => matchRule(path, r, vars))
      if (!rule) {
        // 禁区内的未收录目录不重复登记：禁区已在最上层记过，再记一遍会让 denied 膨胀且失真
        // （实测 C:\ 一次扫出 denied=209 而 scanned=261），也不进 unmatched。
        if (!visitOnly) unmatched.push(path)
        await walk(path, level + 1, claimed, visitOnly)
        continue
      }
      if (claimed.has(rule.id)) {
        // 父目录已被这条规则报过；子目录再报会把同一份数据算两遍
        await walk(path, level + 1, claimed, visitOnly)
        continue
      }
      const inner = new Set(claimed).add(rule.id)
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
          executor: visitOnly ? null : (rule.executor ? rule.executor.type : null),
          ruleId: rule.id,
          explain: rule.explain ?? { why: rule.reason },
        }
        item.advice = advise(item)
        candidates.push(item)
      }
      await walk(path, level + 1, inner, visitOnly)
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
