// 删除确认页：把"要删什么、干什么用、多大、能不能撤销"摊开，并用一句明确的 y/N 问用户。
// 纯函数：只产出文本与问句，绝不执行任何动作。
import { fmtBytes } from '../core/probe.mjs'

const dash = (v) => (v === undefined || v === null || v === '' ? '—' : String(v))

export function renderConfirm(run, items) {
  const list = items ?? []
  if (!list.length) {
    return {
      lines: ['## 没有可删除项', '', '本次勾选里没有被判定为可执行的条目，不做任何操作。'],
      question: null,
      summary: '0 项',
    }
  }

  const total = list.reduce((s, i) => s + (i.bytes ?? 0), 0)
  const undoable = list.filter((i) => i.executor === 'stage').length
  const lines = [
    '## 即将删除以下内容——请逐条确认',
    '',
  ]

  list.forEach((i, n) => {
    const e = i.explain ?? {}
    lines.push(`### ${n + 1}. ${dash(i.title)} —— ${fmtBytes(i.bytes)}`)
    lines.push(`- 位置：\`${dash(i.path)}\``)
    lines.push(`- 这是什么：${dash(e.what)}`)
    lines.push(`- 为什么可以删：${dash(e.why)}`)
    lines.push(`- 删掉之后：${dash(e.rebuild)}`)
    lines.push(`- 副作用：${dash(e.sideEffect)}`)
    lines.push(`- 能否撤回：${dash(e.undo)}`)
    if (i.blocked) lines.push(`- 状态：被挡住（${dash(i.blockedReason ?? i.blocked)}），本次不会执行`)
    lines.push('')
  })

  lines.push('---', '')
  const summary = `合计 ${list.length} 项 / ${fmtBytes(total)}；其中 ${undoable} 项为"移入隔离区"（可撤销）`
  lines.push(summary)
  const question = `是否删除以上 ${list.length} 项（共 ${fmtBytes(total)}）？[y/N]`
  lines.push('', question)
  return { lines, question, summary }
}
