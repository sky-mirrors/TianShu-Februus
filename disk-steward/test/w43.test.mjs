// W43：整盘扫描结果必须能落到 run 里并进报告。
// 否则 fullDrive 的画像只活在一屏终端输出里——不能归档、不能与下次扫描对比。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { renderReport } = await import('../render/report.mjs')

const run = {
  runId: 'r-w43',
  domain: 'system',
  createdAt: 1793807474110,
  items: [],
  unmatched: [],
  denied: [],
  totals: { items: 0, bytes: 0 },
  sweep: {
    root: 'C:\\',
    depth: 3,
    scanned: 16835,
    candidatesTotal: 2,
    truncated: false,
    denied: [],
    unmatched: [],
    candidates: [
      {
        path: 'C:\\Windows\\WinSxS', title: '组件存储（WinSxS）', bytes: 8010047488, grade: 'brown',
        executor: null, ruleId: 'sys.winsxs',
        advice: { verdict: 'keep', label: '不建议删除', reason: '只能通过 DISM 清理被取代的组件版本' },
      },
      {
        path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp', title: '用户临时目录（%TEMP%）', bytes: 1175000000, grade: 'green',
        executor: null, ruleId: 'sys.user-temp',
        advice: { verdict: 'caution', label: '谨慎：可清但有前提', reason: '当前被挡（active）' },
      },
    ],
  },
}

test('W43：报告含整盘章节，且逐项给出建议与路径', () => {
  const md = renderReport(run)
  assert.match(md, /整盘扫描/, '应有整盘扫描章节')
  assert.match(md, /C:\\Windows\\WinSxS/, '应列出整盘候选路径')
  assert.match(md, /不建议删除/, '应带建议结论')
  assert.match(md, /谨慎：可清但有前提/, '应带第二档建议')
})

test('W43：整盘章节说明扫了多少目录、是否扫完', () => {
  const md = renderReport(run)
  assert.match(md, /16835/, '应报扫描目录数')
})

test('W43：没有 sweep 的 run 不出现整盘章节（不凭空造段落）', () => {
  const md = renderReport({ ...run, sweep: undefined })
  assert.ok(!/整盘扫描/.test(md), '没有整盘数据时不应出现该章节')
})
