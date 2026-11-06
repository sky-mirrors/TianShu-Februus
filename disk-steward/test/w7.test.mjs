// W7：报告渲染（纯函数）。清理前列全 + 逐项解释，落成可归档的 Markdown。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { renderReport } = await import('../render/report.mjs')

const item = (over = {}) => ({
  id: over.id ?? 'i1',
  title: over.title ?? '示例缓存',
  path: over.path ?? '/x/cache',
  bytes: over.bytes ?? 2048,
  fileCount: 3,
  topExt: [{ ext: '.txt', files: 2, bytes: 4096 }],
  samples: ['a.txt'],
  grade: over.grade ?? 'green',
  blocked: over.blocked ?? null,
  blockedReason: over.blockedReason ?? null,
  executor: over.executor ?? 'stage',
  explain: { what: '两个文本文件', why: '可重建', rebuild: '自动重建', sideEffect: null, undo: '可撤销' },
  ...over,
})

const run = {
  runId: 'r-rep',
  domain: 'tianshu',
  createdAt: 1791372812870,
  items: [
    item({ id: 'a', title: '缓存A', path: '/x/cache', bytes: 4096 }),
    item({ id: 'b', title: '在写项', path: '/x/hot', bytes: 100, blocked: 'active', blockedReason: '10 分钟内有写入（可能仍在使用）' }),
    item({ id: 'c', title: '主库', path: '/x/db', bytes: 8192, grade: 'brown', executor: null }),
  ],
  unmatched: [{ path: '/x/unknown', grade: 'brown', executor: null }],
  denied: [{ path: 'C:/Windows/WinSxS', reason: 'WINDOWS_DIR: Windows 系统目录' }],
  totals: { items: 3, bytes: 12388, selectable: 1, selectableBytes: 4096, blocked: 1, protected: 1 },
}

test('报告覆盖全部条目（不是 top20），每条带路径与解释', () => {
  const md = renderReport(run)
  for (const i of run.items) {
    assert.ok(md.includes(i.path), `缺路径 ${i.path}`)
    assert.ok(md.includes(i.title), `缺标题 ${i.title}`)
  }
  // 三条解释字段都要出现
  assert.ok(md.includes('可重建'))
  assert.ok(md.includes('可撤销'))
})

test('被挡项要写出原因，不能只说"跳过"', () => {
  const md = renderReport(run)
  assert.ok(md.includes('10 分钟内有写入'), '被挡原因是给用户看的，必须出现')
})

test('保护项明确标为不可勾选，未收录路径单列一节', () => {
  const md = renderReport(run)
  assert.match(md, /受保护|不可勾选/)
  assert.ok(md.includes('/x/unknown'), '未收录路径要列出来（按保护处理）')
})

test('禁区拦截单独列出（系统域）', () => {
  const md = renderReport(run)
  assert.ok(md.includes('C:/Windows/WinSxS'))
  assert.ok(md.includes('WINDOWS_DIR'))
})

test('空 run 也要出报告并明确写"无可清理项"，不产空文件', () => {
  const empty = { runId: 'r-empty', domain: 'tianshu', items: [], unmatched: [], denied: [], totals: { items: 0, bytes: 0, selectable: 0, selectableBytes: 0, blocked: 0, protected: 0 } }
  const md = renderReport(empty)
  assert.match(md, /无可清理项|0 项/)
  assert.ok(md.length > 100, '不能是空内容')
})

test('报告不泄漏 undefined/null 字面量（字段缺失不能污染给人看的文档）', () => {
  const md = renderReport(run)
  assert.ok(!md.includes('undefined'), '出现了 undefined')
  assert.ok(!md.includes('null'), '出现了 null')
  assert.ok(!md.includes('NaN'))
})
