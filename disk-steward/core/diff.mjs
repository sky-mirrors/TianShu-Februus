// 两次扫描的增量：按路径对齐，报告变大/变小/新增/消失。
// 纯函数，不读盘；delta 的正负号就是"涨了还是降了"。
import { fmtBytes } from './probe.mjs'

const sum = (run) => (run.items ?? []).reduce((s, i) => s + (i.bytes ?? 0), 0)

export function diffRuns(prev = {}, next = {}) {
  const p = new Map((prev.items ?? []).map((i) => [i.path, i]))
  const n = new Map((next.items ?? []).map((i) => [i.path, i]))

  const added = []
  const removed = []
  const grew = []
  const shrank = []
  let unchanged = 0

  for (const [path, ni] of n) {
    const pi = p.get(path)
    if (!pi) {
      added.push(ni)
      continue
    }
    const before = pi.bytes ?? 0
    const after = ni.bytes ?? 0
    const delta = after - before
    if (delta > 0) grew.push({ ...ni, before, after, delta })
    else if (delta < 0) shrank.push({ ...ni, before, after, delta })
    else unchanged += 1
  }

  for (const [path, pi] of p) if (!n.has(path)) removed.push(pi)

  const byAbsDelta = (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
  grew.sort(byAbsDelta)
  shrank.sort(byAbsDelta)
  added.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  removed.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))

  const totalPrev = sum(prev)
  const totalNext = sum(next)
  return { added, removed, grew, shrank, unchanged, totalPrev, totalNext, totalDelta: totalNext - totalPrev }
}

export function summarizeDiff(d) {
  const parts = []
  if (d.added.length) parts.push(`新增 ${d.added.length} 项（${fmtBytes(d.added.reduce((s, i) => s + (i.bytes ?? 0), 0))}）`)
  if (d.removed.length) parts.push(`消失 ${d.removed.length} 项（${fmtBytes(d.removed.reduce((s, i) => s + (i.bytes ?? 0), 0))}）`)
  if (d.grew.length) parts.push(`变大 ${d.grew.length} 项（+${fmtBytes(d.grew.reduce((s, i) => s + i.delta, 0))}）`)
  if (d.shrank.length) parts.push(`变小 ${d.shrank.length} 项（−${fmtBytes(Math.abs(d.shrank.reduce((s, i) => s + i.delta, 0)))}）`)
  parts.push(`未变 ${d.unchanged} 项`)
  const sign = d.totalDelta > 0 ? '+' : d.totalDelta < 0 ? '−' : '±'
  parts.push(`总量 ${fmtBytes(d.totalPrev)} → ${fmtBytes(d.totalNext)}（${sign}${fmtBytes(Math.abs(d.totalDelta))}）`)
  return parts.join(' · ')
}
