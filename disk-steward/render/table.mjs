// TUI 渲染：纯函数（输入 run + 勾选状态，输出文本行），因此可单测（§14.5 T1/T3）。
import { fmtBytes } from '../core/probe.mjs'

const GRADE_LABEL = { green: 'green ', yellow: 'yellow', orange: 'orange', brown: 'brown ', blue: 'blue  ' }
const blockedNote = (i) => i.blocked === 'active' ? ' · 跳过(10 分钟内有写入)'
  : i.blocked === 'precondition' ? ' · 跳过(前置条件未满足)'
  : i.blocked ? ` · 跳过(${i.blocked})` : ''


export function renderTable(run, { cursor = 0, selected = new Set(), showProtected = true } = {}) {
  const lines = []
  const t = run.totals || { items: run.items.length, bytes: 0, selectable: 0, blocked: 0, protected: 0 }
  lines.push(
    `清理清单 · ${run.runId ?? 'run'} · 共 ${t.items} 项 / 可清理 ${t.selectable} 项 / 被挡住 ${t.blocked} 项 · 合计 ${fmtBytes(t.bytes)}`,
  )
  if (run.unmatched?.length) {
    lines.push(`另有 ${run.unmatched.length} 个未收录路径按保护处理（不参与勾选，可在规则库里补录）`)
  }
  run.items.forEach((item, idx) => {
    if (!showProtected && item.grade === 'brown') return
    const isBrown = item.grade === 'brown'
    const mark = isBrown ? '-' : selected.has(item.id) ? 'x' : ' '
    const caret = idx === cursor ? '▸' : ' '
    const blockNote = item.blocked ? blockedNote(item) : ''
    const guard = isBrown ? ' · 不可勾选(受保护)' : blockNote
    lines.push(
      `  ${caret} [${mark}] ${fmtBytes(item.bytes).padStart(9)}  ${GRADE_LABEL[item.grade] ?? item.grade}  ${item.title}  ${item.path}${guard}`,
    )
  })
  return lines
}

// 详情视图：把"这里面是什么"摊开给人看
export function renderDetail(item) {
  if (!item) return ['（无选中项）']
  const e = item.explain || {}
  const out = [
    `路径   ${item.path}`,
    `体积   ${fmtBytes(item.bytes)}（${item.fileCount} 个文件）`,
    `分级   ${item.grade}${item.blocked ? ` · ${item.blocked}` : ''}`,
    `是什么 ${e.what ?? '—'}`,
    `为什么 ${e.why ?? '—'}`,
    `重建   ${e.rebuild ?? '无需重建'}`,
    `副作用 ${e.sideEffect ?? '无'}`,
    `撤销   ${e.undo ?? '—'}`,
  ]
  if (item.samples?.length) out.push(`样本   ${item.samples.join('、')}`)
  return out
}
