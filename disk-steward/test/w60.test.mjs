// W60：外部审核清单第二波的四条入口/完整性缺陷
//  #3  runId 路径穿越（外部 JSON 可变成执行计划）
//  #7  quarantineName 非单射，同批两个不同源路径映射到同一目标
//  #9  部分扫描（预算耗尽）仍给执行资格
//  #32 合法 JSON 的坏行（null / 数字 / 错误结构）仍拖垮状态工具
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { buildRun } = await import('../core/run.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { stage } = await import('../core/executor.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')
const { quarantineStats } = await import('../core/executor.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w60-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  return { root, state, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl') }
}
const tool = (tools, name) => tools.find((t) => t.name === name)
const mkTools = (sb, extra = {}) => createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine, ...extra })

test('W60 ①：runId 越出状态目录必须被拒（#3）', async () => {
  const sb = sandbox()
  // 在 state 之外放一个自填的「扫描结论」
  const outside = join(sb.root, 'outside.json')
  writeFileSync(outside, JSON.stringify({ runId: '../outside', items: [{ id: 'x#1', path: sb.root, bytes: 1, grade: 'green', blocked: null, executor: 'stage' }], unmatched: [], denied: [], totals: {} }))
  const tools = mkTools(sb)
  const plan = await tool(tools, 'disk_plan').execute({ args: { runId: '../outside', itemIds: ['x#1'] } })
  assert.equal(plan.isError, true, `外部 JSON 不该被接收：${plan.content}`)

  const report = await tool(tools, 'disk_report').execute({ args: { runId: '../outside-report' } })
  assert.equal(report.isError, true, `越界报告路径不该被接收：${report.content}`)
  assert.equal(existsSync(join(sb.root, 'outside-report.md')), false, '不得在状态目录外写出文件')
  assert.equal(readFileSync(outside, 'utf8').length > 0, true, '夹具仍在（前置条件）')
})

test('W60 ②：同批两条不同源路径的隔离区目标必须互不相同（#7）', async () => {
  const sb = sandbox()
  const a = join(sb.root, 'source', 'a_b.txt')
  const b = join(sb.root, 'source_a', 'b.txt')
  mkdirSync(join(sb.root, 'source'), { recursive: true })
  mkdirSync(join(sb.root, 'source_a'), { recursive: true })
  writeFileSync(a, 'AAA')
  writeFileSync(b, 'BBB')
  const items = [
    { id: 'x#1', path: a, bytes: 3, grade: 'green', blocked: null, executor: 'stage' },
    { id: 'x#2', path: b, bytes: 3, grade: 'green', blocked: null, executor: 'stage' },
  ]
  const plan = { token: 'tk', issuer: 'human', confirmedBy: 'test', expiresAt: Date.now() + 60000, items, stagedBatches: new Set() }
  const r = await stage({ plan, token: 'tk', items, quarantineRoot: sb.quarantine, ledgerPath: sb.ledgerPath })
  const rows = readLedger(sb.ledgerPath).filter((x) => x.action === 'stage')
  assert.equal(rows.length, 2, `应完成 2 项，实际 ${r.staged}`)
  assert.notEqual(rows[0].to, rows[1].to, `两条目的路径不得相同：${rows[0].to}`)
  assert.equal(readFileSync(rows[0].to, 'utf8'), 'AAA', 'A 的字节必须完整保留')
  assert.equal(readFileSync(rows[1].to, 'utf8'), 'BBB', 'B 的字节必须完整保留')
})

test('W60 ③：预算耗尽的部分扫描不给执行资格（#9）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w60-partial-'))
  mkdirSync(join(dir, 'cache'), { recursive: true })
  writeFileSync(join(dir, 'cache', 'f.bin'), 'x'.repeat(1024))
  const run = await buildRun({
    rules: [{ id: 'x.cache', match: { kind: 'prefix', path: join(dir, 'cache') }, grade: 'green', reason: 't', executor: { type: 'stage' } }],
    vars: {}, collectUnmatched: false, deadline: Date.now() - 1,
  })
  const item = run.items[0]
  assert.equal(item.partial, true, '前置：确实是不完整测量')
  assert.equal(item.blocked, 'SCAN_INCOMPLETE', `不完整测量必须挡住执行，实际 blocked=${item.blocked}`)
  assert.throws(
    () => createPlan({ run, itemIds: [item.id] }),
    /REFUSED_BLOCKED/,
    '计划不得接收不完整条目',
  )
})

test('W60 ④：合法 JSON 的坏行也不得拖垮状态工具（#32）', async () => {
  const sb = sandbox()
  for (const raw of ['null', '42', '"a string"', '{"action":{}}']) writeFileSync(sb.ledgerPath, raw + '\n', { flag: 'a' })
  const rows = readLedger(sb.ledgerPath)
  assert.equal(rows.filter((r) => r.action === 'corrupt').length, 4, '4 条异常结构都应标 corrupt')
  const q = await quarantineStats({ ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })
  assert.equal(q.items, 0, '状态工具不该抛异常，也不该把坏行算进去')
})
