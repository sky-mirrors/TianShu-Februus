// W9：工具接线集成测试——真实文件系统、真实 createTools，不用 mock。
// 目的：堵住"纯函数全绿但工具接错"这类洞（renderDiff is not defined 就是这么漏过去的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w9-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const data = join(root, 'data')
  mkdirSync(join(data, 'cache'), { recursive: true })
  writeFileSync(join(data, 'cache', 'a.txt'), 'X'.repeat(128))
  return { root, state, data, quarantine: join(root, 'trash') }
}

const mkItem = (sb, over = {}) => ({
  id: 'ts.cache#1',
  title: '测试缓存',
  path: join(sb.data, 'cache'),
  kind: 'dir',
  bytes: 128,
  fileCount: 1,
  topExt: [{ ext: '.txt', files: 1, bytes: 128 }],
  samples: ['a.txt'],
  ruleId: 'ts.cache',
  grade: 'green',
  blocked: null,
  blockedReason: null,
  executor: 'stage',
  explain: { what: '一个文本文件', why: '可重建', rebuild: '自动', sideEffect: null, undo: '可撤销' },
  decision: 'undecided',
  ...over,
})

function writeRun(stateDir, run) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, `${run.runId}.json`), JSON.stringify(run, null, 1))
  return run.runId
}

test('接线：Agent 拿到的计划不能执行（人工批准门在工具层生效）', async () => {
  const sb = sandbox()
  const t = createTools({ stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: join(sb.state, 'ledger.jsonl') })
  const item = mkItem(sb)
  const runId = writeRun(sb.state, { runId: 'r-w9a', domain: 'tianshu', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: 128 } })

  const plan = await t.find((x) => x.name === 'disk_plan').execute({ args: { runId, itemIds: [item.id] } })
  const token = /令牌 ([0-9a-f]+)/.exec(String(plan.content))?.[1]
  const planId = /plan_id=(\S+)/.exec(String(plan.content))?.[1]
  assert.ok(token && planId, `计划输出缺少令牌或 id：${plan.content}`)

  const bad = await t.find((x) => x.name === 'disk_exec').execute({ args: { planId, token: 'wrong', mode: 'stage' } })
  assert.equal(bad.isError, true, '错误令牌必须报错')
  assert.equal(existsSync(join(sb.data, 'cache')), true, '错误令牌不得移动任何文件')

  // 即使令牌正确，Agent 计划也不得执行：这是 2026-11-04 起的新契约
  const ok = await t.find((x) => x.name === 'disk_exec').execute({ args: { planId, token, mode: 'stage' } })
  assert.equal(ok.isError, true, `Agent 计划必须被拒：${ok.content}`)
  assert.match(String(ok.content), /NOT_HUMAN_APPROVED|人工/)
  assert.equal(existsSync(join(sb.data, 'cache')), true, '被拒时文件不得移动')
})

test('接线：disk_report 真的写出 md 文件，且含条目路径', async () => {
  const sb = sandbox()
  const t = createTools({ stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: join(sb.state, 'ledger.jsonl') })
  const item = mkItem(sb)
  const runId = writeRun(sb.state, { runId: 'r-w9b', domain: 'tianshu', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: 128 } })

  const r = await t.find((x) => x.name === 'disk_report').execute({ args: { runId } })
  const out = /报告已生成：(.+?)（/.exec(String(r.content))?.[1]
  assert.ok(out, `未返回报告路径：${r.content}`)
  assert.equal(existsSync(out), true, '报告文件应真实存在')
  assert.ok(readFileSync(out, 'utf8').includes(item.path), '报告应包含条目路径')
})

test('接线：disk_diff 能对比两份 run，并可选落 md', async () => {
  const sb = sandbox()
  const t = createTools({ stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: join(sb.state, 'ledger.jsonl') })
  const a = mkItem(sb, { bytes: 128 })
  const b = mkItem(sb, { bytes: 512 })
  writeRun(sb.state, { runId: 'r-w9c1', items: [a], unmatched: [], denied: [], totals: {} })
  writeRun(sb.state, { runId: 'r-w9c2', items: [b], unmatched: [], denied: [], totals: {} })

  const r = await t.find((x) => x.name === 'disk_diff').execute({ args: { runIdA: 'r-w9c1', runIdB: 'r-w9c2', write: true } })
  const txt = String(r.content)
  assert.match(txt, /变大 1 项/, `应识别为变大：${txt}`)
  const out = /报告：(.+)$/m.exec(txt)?.[1]?.trim()
  assert.ok(out && existsSync(out), '对比报告应真实存在')

  const bad = await t.find((x) => x.name === 'disk_diff').execute({ args: { runIdA: 'nope', runIdB: 'r-w9c2' } })
  assert.equal(bad.isError, true, '不存在的 run 必须报错而不是崩')
})

test('接线：不存在的 run 走 plan/report 也必须是结构化错误', async () => {
  const sb = sandbox()
  const t = createTools({ stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: join(sb.state, 'ledger.jsonl') })
  for (const [name, args] of [['disk_plan', { runId: 'nope', itemIds: ['x'] }], ['disk_report', { runId: 'nope' }]]) {
    const r = await t.find((x) => x.name === name).execute({ args })
    assert.equal(r.isError, true, `${name} 应返回结构化错误`)
    assert.match(String(r.content), /RUN_NOT_FOUND|run 不存在/)
  }
})

test('接线：stateDir/quarantineRoot 可注入，默认不落到插件目录', async () => {
  const sb = sandbox()
  const t = createTools({ stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: join(sb.state, 'ledger.jsonl') })
  const item = mkItem(sb)
  writeRun(sb.state, { runId: 'r-w9d', items: [item], unmatched: [], denied: [], totals: {} })
  const plan = await t.find((x) => x.name === 'disk_plan').execute({ args: { runId: 'r-w9d', itemIds: [item.id] } })
  const planId = /plan_id=(\S+)/.exec(String(plan.content))[1]
  const token = /令牌 ([0-9a-f]+)/.exec(String(plan.content))[1]
  const r = await t.find((x) => x.name === 'disk_exec').execute({ args: { planId, token, mode: 'stage' } })
  assert.equal(r.isError, true, 'Agent 计划应被拒')
  assert.equal(existsSync(sb.quarantine) ? readdirSync(sb.quarantine).length : 0, 0, '被拒时不得创建隔离区内容')
})
