// W0/W1 验收测试：先写红灯，再实现。
// 对应架构设计 §14.5 的 T2/T3 与 §6.1 的三条硬规则、§14.4 的活跃项护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { validateRule, RULE_ERRORS } = await import('../core/rules.mjs')
const { buildRun } = await import('../core/run.mjs')
const { renderTable } = await import('../render/table.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-test-'))
  return root
}

const baseRule = {
  id: 'test.cache',
  domain: 'tianshu',
  detect: { kind: 'exists', path: '{{root}}/cache' },
  match: { kind: 'prefix', path: '{{root}}/cache' },
  grade: 'green',
  reason: 'HTTP 抓取缓存，可重建',
  executor: { type: 'stage' },
}

// T2 + §6.1 硬规则：解释字段缺任一 → 拒绝生成 run（而不是产出残缺面板）
test('T2: 规则缺 reason 时 RULE_EXPLAIN_INCOMPLETE，不生成残缺 run', async () => {
  const root = sandbox()
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'a.txt'), 'x'.repeat(1024))
  const bad = { ...baseRule, reason: '' }
  await assert.rejects(
    buildRun({ rules: [bad], vars: { root }, now: Date.now() }),
    (e) => e.code === RULE_ERRORS.EXPLAIN_INCOMPLETE,
  )
})

// §6.1 硬规则 2：brown（保护）不允许带 executor
test('保护级规则带 executor 时规则库校验必须失败', () => {
  const bad = { ...baseRule, grade: 'brown', executor: { type: 'stage' } }
  assert.throws(() => validateRule(bad), (e) => e.code === RULE_ERRORS.BROWN_HAS_EXECUTOR)
})

// §6.1 硬规则 3：detect 未命中 → 不产生 item（也不出现在报告里）
test('detect 未命中时该规则不产出任何 item', async () => {
  const root = sandbox()
  const run = await buildRun({ rules: [baseRule], vars: { root }, now: Date.now() })
  assert.equal(run.items.length, 0)
})

// I2：无匹配路径一律保护，且不可执行
test('未命中任何规则的路径落 brown 且没有 executor', async () => {
  const root = sandbox()
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'a.txt'), 'x'.repeat(512))
  const run = await buildRun({ rules: [{ ...baseRule, match: { kind: 'prefix', path: '{{root}}/nothing-here' } }], vars: { root }, now: Date.now() })
  const stray = run.unmatched.find((u) => u.path.endsWith('cache'))
  assert.ok(stray, '未匹配路径应出现在 unmatched 里')
  assert.equal(stray.grade, 'brown')
  assert.equal(stray.executor, null)
})

// §14.4 护栏：活跃项（10 分钟内被写入）在执行前转 blocked，且条目仍可见
test('活跃目录被判为 blocked=active 且不可执行为 stage', async () => {
  const root = sandbox()
  const cache = join(root, 'cache')
  mkdirSync(cache, { recursive: true })
  const f = join(cache, 'hot.txt')
  writeFileSync(f, 'x'.repeat(2048))
  const now = Date.now()
  utimesSync(f, new Date(now - 1000), new Date(now - 1000)) // 1 秒前写过
  const run = await buildRun({ rules: [baseRule], vars: { root }, now, mtimeGuardMs: 10 * 60 * 1000 })
  assert.equal(run.items.length, 1)
  assert.equal(run.items[0].blocked, 'active')
  assert.equal(run.selectable, 0)
})

// §14.5 T1 + T3：渲染出的行数 == 全量条目数 + 表头；brown 行标 disabled
test('renderTable 全量渲染且保护项标记为不可勾选', () => {
  const run = {
    runId: 'r-test',
    domain: 'tianshu',
    items: [
      { id: 'a', title: '缓存 A', path: '/x/a', bytes: 2048, grade: 'green', blocked: null, explain: { what: 'a', why: 'b', undo: 'c' } },
      { id: 'b', title: '记忆库 B', path: '/x/b', bytes: 4096, grade: 'brown', blocked: null, explain: { what: 'a', why: 'b', undo: 'none' } },
    ],
    unmatched: [],
    totals: { bytes: 6144, selectable: 1, blocked: 0, protected: 1 },
  }
  const lines = renderTable(run, { cursor: 0, selected: new Set() })
  const body = lines.filter((l) => l.startsWith('  '))
  assert.equal(body.length, run.items.length, '全量条目都要列出')
  assert.ok(lines.some((l) => l.includes('brown') && l.includes('不可勾选')))
})
