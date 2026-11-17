// W46：未收录清单要带体积，否则「这 12 个路径没规则覆盖」无法判断值不值得补规则。
// 保守做法：只读 measure，不碰执行路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { renderReport } = await import('../render/report.mjs')

const run = {
  runId: 'r-w46',
  domain: 'tianshu',
  createdAt: 1793807474110,
  items: [],
  denied: [],
  totals: { items: 0, bytes: 0 },
  unmatched: [
    { path: 'C:\\.rivet\\big-unknown.log', bytes: 5 * 1024 * 1024, reason: '未收录规则 → 按保护处理' },
    { path: 'C:\\.rivet\\small.txt', bytes: 1024, reason: '未收录规则 → 按保护处理' },
  ],
}

test('W46：未收录章节逐项给体积，并按体积降序', () => {
  const md = renderReport(run)
  const section = md.split('## 未收录路径')[1] ?? ''
  assert.ok(section.length > 0, '应有未收录章节')
  const bigAt = section.indexOf('big-unknown.log')
  const smallAt = section.indexOf('small.txt')
  assert.ok(bigAt >= 0 && smallAt >= 0, '两条路径都要出现')
  assert.ok(bigAt < smallAt, '体积大的排在前面')
  assert.match(section, /5\.0 MB/, '应显示 5.0 MB')
})

test('W46：未收录章节给出合计体积，便于判断优先级', () => {
  const md = renderReport(run)
  const section = md.split('## 未收录路径')[1] ?? ''
  assert.match(section, /合计|共/, '应有合计行')
})

test('W46：没有未收录时不出现该章节（回归）', () => {
  const md = renderReport({ ...run, unmatched: [] })
  assert.ok(!/## 未收录路径/.test(md))
})
