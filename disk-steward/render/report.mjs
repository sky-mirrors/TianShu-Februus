// 报告渲染：纯函数。把 run 变成一份可归档的 Markdown，不读盘、不写盘。
// 纪律：字段缺失一律显示 '—'，绝不把 undefined/null 泄漏进给人看的文档。
import { fmtBytes } from '../core/probe.mjs'
import { isStageable } from '../core/plan.mjs'
import { advise } from '../core/advice.mjs'

const dash = (v) => {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'number' && Number.isNaN(v)) return '—'
  return String(v)
}

const stamp = (ms) => {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 域归属：规则 id 前缀就是域（sys.* 系统域，ts.* 宿主域）。清单必须标域，
// 否则用户分不清“删的是天枢自己的数据”还是“删的是操作系统的缓存”。
const domainOf = (i) => (String(i?.ruleId ?? i?.id ?? '').startsWith('sys.') ? 'system' : 'tianshu')

function itemBlock(i, idx) {
  const e = i.explain ?? {}
  const advice = advise(i)
  const lines = [
    `### ${idx}. ${dash(i.title)} · ${fmtBytes(i.bytes)}`,
    '',
    `- id：\`${dash(i.id)}\``,
    `- 域：${domainOf(i)}`,
    `- 路径：\`${dash(i.path)}\``,
    `- 分级：${dash(i.grade)}${i.blocked ? `（被挡：${dash(i.blocked)}）` : ''}`,
    `- 建议：${advice.label} — ${dash(advice.reason)}`,
    `- 是什么：${dash(e.what)}`,
    `- 为什么：${dash(e.why)}`,
    `- 重建：${dash(e.rebuild)}`,
    `- 副作用：${dash(e.sideEffect)}`,
    `- 撤销：${dash(e.undo)}`,
  ]
  if (i.blockedReason) lines.push(`- 被挡原因：${dash(i.blockedReason)}`)
  if (i.samples?.length) lines.push(`- 样本：${i.samples.map(dash).join('、')}`)
  if (i.topExt?.length) {
    lines.push(`- 构成：${i.topExt.map((x) => `${x.ext} ${fmtBytes(x.bytes)}`).join('、')}`)
  }
  lines.push('')
  return lines
}

export function renderReport(run = {}) {
  const items = run.items ?? []
  const unmatched = run.unmatched ?? []
  const denied = run.denied ?? []
  // 分桶必须穷尽：每一项必须落入可勾选 / 被挡 / 受保护 / 可见但不可执行 四个之一。
  // 少最后一桶时，yellow + executor=null 的项（Edge 缓存 793 MiB）在报告里静默消失。
  const selectable = items.filter(isStageable)
  const blocked = items.filter((i) => i.blocked)
  const parked = items.filter((i) => !i.blocked && i.grade === 'brown')
  const notExecutable = items.filter((i) => !i.blocked && i.grade !== 'brown' && !isStageable(i))
  const willFree = selectable.reduce((s, i) => s + (i.bytes ?? 0), 0)
  const totalBytes = items.reduce((s, i) => s + (i.bytes ?? 0), 0)
  const idleBytes = notExecutable.reduce((s, i) => s + (i.bytes ?? 0), 0)
  const sumOf = (rows) => rows.reduce((s, i) => s + (i.bytes ?? 0), 0)
  const selSys = selectable.filter((i) => domainOf(i) === 'system')
  const selTs = selectable.filter((i) => domainOf(i) === 'tianshu')

  const out = [
    `# 磁盘清理报告 · ${dash(run.runId)}`,
    '',
    `- 生成时间：${stamp(run.createdAt)}`,
    `- 扫描域：${dash(run.domain)}`,
    `- 口径：扫描阶段只读；本报告不含任何删除动作，执行需另行逐项确认。`,
    '',
    '## 汇总',
    '',
    '| 项 | 数量 | 体积 |',
    '| --- | --- | --- |',
    `| 全部条目 | ${items.length} | ${fmtBytes(totalBytes)} |`,
    `| 可勾选（本次可释放） | ${selectable.length} | ${fmtBytes(willFree)} |`,
    `| 　其中系统域（OS 缓存/临时目录） | ${selSys.length} | ${fmtBytes(sumOf(selSys))} |`,
    `| 　其中宿主域（~/.rivet 与项目 .rivet） | ${selTs.length} | ${fmtBytes(sumOf(selTs))} |`,
    `| 被挡住（活跃/前置条件） | ${blocked.length} | — |`,
    `| 受保护（不可勾选） | ${parked.length} | — |`,
    `| 可见但不可执行 | ${notExecutable.length} | ${fmtBytes(idleBytes)} |`,
    `| 未收录路径（按保护处理） | ${unmatched.length} | — |`,
    `| 禁区拦截 | ${denied.length} | — |`,
    '',
  ]

  out.push('## 可勾选', '')
  if (selectable.length === 0) out.push('无可清理项（0 项）：本次扫描没有发现可安全勾选的条目。', '')
  else {
    selectable
      .slice()
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      .forEach((i, n) => out.push(...itemBlock(i, n + 1)))
  }

  if (blocked.length) {
    out.push('## 被挡住', '', '这些项本轮不会清理，原因逐条列出。', '')
    blocked.forEach((i, n) => out.push(...itemBlock(i, n + 1)))
  }

  if (notExecutable.length) {
    out.push(
      '## 可见但不可执行',
      '',
      '分级不是受保护，但当前没有可用的执行分支（数据库 WAL 只能 checkpoint、部分规则没有 stage 分支等）；单列在这里，不让它们在报告里消失。',
      '',
    )
    notExecutable
      .slice()
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      .forEach((i, n) => out.push(...itemBlock(i, n + 1)))
  }

  if (parked.length) {
    out.push('## 受保护（不可勾选）', '')
    for (const i of parked) {
      out.push(`- [${domainOf(i)}] ${dash(i.title)} · ${fmtBytes(i.bytes)} · \`${dash(i.path)}\` — ${dash(i.explain?.why)}`)
    }
    out.push('')
  }

  if (unmatched.length) {
    out.push('## 未收录路径（按保护处理）', '', '规则库未覆盖，因此一律不清理；需要纳管时补规则。', '')
    for (const u of unmatched) out.push(`- \`${dash(u.path)}\``)
    out.push('')
  }

  if (denied.length) {
    out.push('## 禁区拦截', '', '这些路径命中硬禁区，连扫描都不进入。', '')
    for (const d of denied) out.push(`- \`${dash(d.path)}\` — ${dash(d.reason)}`)
    out.push('')
  }

  out.push('---', '', `报告由 disk-steward 生成，依据 \`.runs/${dash(run.runId)}.json\`；同一份 run 可复算。`, '')
  return out.join('\n')
}

// 两次扫描的对比报告：把"到底涨了没有"写成一段可读文字。
/** @param {any} d @param {{ prevRunId?: string, nextRunId?: string }} [opts] */
export function renderDiff(d, { prevRunId, nextRunId } = {}) {
  const dashv = (v) => (v === undefined || v === null || v === '' ? '—' : String(v))
  const sign = d.totalDelta > 0 ? '+' : d.totalDelta < 0 ? '−' : '±'
  const out = [
    '## 两次扫描对比',
    '',
    `- A：${dashv(prevRunId)}　B：${dashv(nextRunId)}`,
    `- 总量：${fmtBytes(d.totalPrev)} → ${fmtBytes(d.totalNext)}（${sign}${fmtBytes(Math.abs(d.totalDelta))}）`,
    `- 分项：新增 ${d.added.length} · 消失 ${d.removed.length} · 变大 ${d.grew.length} · 变小 ${d.shrank.length} · 未变 ${d.unchanged}`,
    '',
  ]
  const section = (title, rows, fmt) => {
    out.push(`### ${title}`, '')
    if (!rows.length) out.push('无', '')
    else {
      for (const r of rows) out.push(`- ${fmt(r)}`)
      out.push('')
    }
  }
  section('变大', d.grew, (r) => `\`${dashv(r.path)}\` ${fmtBytes(r.before)} → ${fmtBytes(r.after)}（+${fmtBytes(r.delta)}）`)
  section('变小', d.shrank, (r) => `\`${dashv(r.path)}\` ${fmtBytes(r.before)} → ${fmtBytes(r.after)}（−${fmtBytes(Math.abs(r.delta))}）`)
  section('新增', d.added, (r) => `\`${dashv(r.path)}\` ${fmtBytes(r.bytes)}`)
  section('消失', d.removed, (r) => `\`${dashv(r.path)}\` ${fmtBytes(r.bytes)}`)
  return out.join('\n')
}
