// 建议层：分级（green/yellow/blue/brown）不是给人看的结论。
// 用户要的是「这个删还是不删、不删的话它到底是什么」，所以这里把分级 + 可执行性 + 拦截状态
// 收敛成三档可读结论，并且非 clean 必须附理由。
// 纯函数：只读 item，不读盘不写盘，报告与工具摘要共用同一判据（与 isStageable 同源）。
import { isStageable } from './plan.mjs'

export const ADVICE = { CLEAN: 'clean', CAUTION: 'caution', KEEP: 'keep' }
export const ADVICE_LABELS = {
  [ADVICE.CLEAN]: '建议清理',
  [ADVICE.CAUTION]: '谨慎：可清但有前提',
  [ADVICE.KEEP]: '不建议删除',
}

const say = (v) => (v === undefined || v === null || v === '' ? '未说明' : String(v))

/**
 * @param {any} item
 * @returns {{ verdict: string, label: string, reason: string }}
 */
export function advise(item = {}) {
  const e = item.explain ?? {}
  const what = say(e.what)
  const why = say(e.why)
  const verdict = (v, reason) => ({ verdict: v, label: ADVICE_LABELS[v], reason })

  // 被挡：现在不能动，但挡住它的是运行状态（可能关掉某个程序就能清），属「谨慎」而非「不该删」
  if (item.blocked) {
    return verdict(ADVICE.CAUTION, `${what}｜当前被挡（${item.blocked}）：${why}`)
  }
  // 受保护：删了会丢数据，明确不建议
  if (item.grade === 'brown') {
    return verdict(ADVICE.KEEP, `${what}｜受保护（brown），不该删：${why}`)
  }
  // 没有执行分支：内容可能无害，但工具不支持安全地执行
  if (!isStageable(item)) {
    return verdict(ADVICE.KEEP, `${what}｜没有可用的执行分支（executor=${say(item.executor)}）：${why}`)
  }
  // 只有 green 才给「建议清理」；yellow/blue 意味着有代价（重建成本、需压实等）
  if (item.grade === 'green') {
    return verdict(ADVICE.CLEAN, `${what}｜${why}`)
  }
  return verdict(ADVICE.CAUTION, `${what}｜分级 ${say(item.grade)}：${why}`)
}

/**
 * 把一次 run 分成三桶，供摘要与报告共用。
 * @param {any[]} items
 */
export function bucketAdvice(items = []) {
  const buckets = { clean: [], caution: [], keep: [] }
  for (const item of items) {
    const a = advise(item)
    buckets[a.verdict].push({ item, ...a })
  }
  return buckets
}
