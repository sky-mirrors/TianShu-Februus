// 勾选状态机 + 帧渲染：纯函数，按键只改选择集，不动磁盘。
import { fmtBytes } from '../core/probe.mjs'
import { renderConfirm } from './confirm.mjs'

const FILTERS = ['all', 'selectable', 'protected', 'blocked']
const GRADE_LABEL = { green: 'green ', yellow: 'yellow', orange: 'orange', brown: 'brown ', blue: 'blue  ' }
const isProtected = (i) => i.grade === 'brown'
const blockedNote = (i) => i.blocked === 'active' ? ' · 跳过(10 分钟内有写入)'
  : i.blocked === 'precondition' ? ' · 跳过(前置条件未满足)'
  : i.blocked ? ` · 跳过(${i.blocked})` : ''

// 可勾选 = 非保护 + 未被挡 + 执行器是"会动文件"的那两种。
// compact（仅压实，不动文件）不得进清理选择集——把它 stage 走等于直接破坏活数据库。
export const STAGEABLE = new Set(['stage', 'migrate'])
export const isSelectable = (i) =>
  i.grade !== 'brown' && !i.blocked && STAGEABLE.has(i.executor)

export function createSession(run, opts = {}) {
  return {
    run,
    cursor: opts.cursor ?? 0,
    selected: new Set(opts.selected ?? []),
    filter: 'all',
    showDetail: false,
    refused: null,
    confirmPending: false,
    message: null,
  }
}

export function visibleItems(s) {
  const items = s.run.items ?? []
  if (s.filter === 'selectable') return items.filter(isSelectable)
  if (s.filter === 'protected') return items.filter((i) => i.grade === 'brown')
  if (s.filter === 'blocked') return items.filter((i) => Boolean(i.blocked))
  return items
}

export function handleKey(s, key) {
  const items = visibleItems(s)
  const cur = items[Math.min(s.cursor, Math.max(items.length - 1, 0))]
  const next = { ...s, selected: new Set(s.selected), refused: null, message: null }
  const none = { type: 'none' }

  switch (key) {
    case 'j':
    case 'down':
      next.cursor = Math.min(s.cursor + 1, Math.max(items.length - 1, 0))
      break
    case 'k':
    case 'up':
      next.cursor = Math.max(s.cursor - 1, 0)
      break
    case ' ': {
      if (!cur) break
      if (!isSelectable(cur)) {
        next.refused = cur.grade === 'brown' ? 'protected' : 'blocked'
        next.message =
          cur.grade === 'brown'
            ? '受保护项不可勾选'
            : STAGEABLE.has(cur.executor)
              ? '该项正被写入，已跳过'
              : `该项执行器是 ${cur.executor}，不进清理集（请走对应操作）`
        break
      }
      if (next.selected.has(cur.id)) next.selected.delete(cur.id)
      else next.selected.add(cur.id)
      break
    }
    case 'a':
      for (const i of items) if (isSelectable(i)) next.selected.add(i.id)
      break
    case 'f':
      next.filter = FILTERS[(FILTERS.indexOf(s.filter) + 1) % FILTERS.length]
      next.cursor = 0
      break
    case 'd':
      next.showDetail = !s.showDetail
      break
    case 'c':
      next.selected = new Set()
      break
    case 'p':
      return { state: next, action: { type: 'plan', itemIds: [...next.selected] } }
    case 'x':
      // 执行前必须先过确认页：x 只进入确认态，绝不直接动手
      if (!next.selected.size) return { state: { ...next, message: '未勾选任何项' }, action: { type: 'none' } }
      next.confirmPending = true
      return { state: next, action: { type: 'confirm', itemIds: [...next.selected] } }
    case 'y':
      if (!s.confirmPending) return { state: next, action: none }
      next.confirmPending = false
      return { state: next, action: { type: 'stage', itemIds: [...next.selected] } }
    case 'n':
      if (!s.confirmPending) return { state: next, action: none }
      next.confirmPending = false
      return { state: next, action: { type: 'cancel' } }
    case 'u':
      return { state: next, action: { type: 'undo' } }
    case 'q':
      return { state: next, action: { type: 'quit' } }
    default:
      return { state: next, action: none }
  }
  return { state: next, action: none }
}

export function renderFrame(s) {
  const items = visibleItems(s)
  if (s.confirmPending) {
    const chosen = (s.run.items ?? []).filter((i) => s.selected.has(i.id))
    const c = renderConfirm(s.run, chosen)
    return [...c.lines, '', 'y 确认删除 · n 取消']
  }
  const chosen = (s.run.items ?? []).filter((i) => s.selected.has(i.id))
  const willFree = chosen.reduce((n, i) => n + (i.bytes ?? 0), 0)
  const lines = [
    `清理清单 · 共 ${(s.run.items ?? []).length} 项 / 已勾 ${chosen.length} 项（${fmtBytes(willFree)}）/ 过滤 ${s.filter}`,
  ]

  items.forEach((item, idx) => {
    const brown = !isSelectable(item)
    const mark = brown ? '-' : s.selected.has(item.id) ? 'x' : ' '
    const caret = idx === s.cursor ? '▸' : ' '
    const note = isProtected(item)
      ? ' · 不可勾选(受保护)'
      : item.blocked
        ? blockedNote(item)
        : !STAGEABLE.has(item.executor)
          ? ` · 仅可${item.executor === 'compact' ? '压实' : '迁移'}(不进清理集)`
          : ''
    lines.push(
      `  ${caret} [${mark}] ${fmtBytes(item.bytes).padStart(9)}  ${GRADE_LABEL[item.grade] ?? item.grade}  ${item.title}  ${item.path}${note}`,
    )
  })

  if (s.showDetail) {
    const cur = items[s.cursor]
    lines.push('', '—— 详情 ——')
    if (!cur) lines.push('（无选中项）')
    else {
      const e = cur.explain ?? {}
      lines.push(`是什么 ${e.what ?? '—'}`)
      lines.push(`为什么 ${e.why ?? '—'}`)
      lines.push(`重建   ${e.rebuild ?? '无需重建'}   副作用 ${e.sideEffect ?? '无'}`)
      lines.push(`撤销   ${e.undo ?? '—'}`)
      if (cur.samples?.length) lines.push(`样本   ${cur.samples.join('、')}`)
    }
  }

  if (s.message) lines.push('', `! ${s.message}`)
  lines.push('', 'j/k 移动 · space 勾选 · a 全选 · c 清空 · f 过滤 · d 详情 · p 预览计划 · x 执行(stage) · u 撤销 · q 退出')
  return lines
}
