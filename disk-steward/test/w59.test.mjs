// W59：外部审核清单里三条入口级缺陷的回归测试
//  #2  非法 mode 落到永久删除分支
//  #37 sweepBudgetMs 非数值让 deadline 变 NaN，预算整体失效
//  #14 purge 不校验 plan.expiresAt，过期令牌仍能永久删除
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { purge } = await import('../core/executor.mjs')
const { readLedger } = await import('../core/ledger.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w59-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const data = join(root, 'cache')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'a.txt'), 'AAA')
  return { root, state, data, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl') }
}
const tool = (tools, name) => tools.find((t) => t.name === name)
const mkTools = (sb, extra = {}) => createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine, ...extra })

test('W59 ①：mode="preview" 必须被拒绝，且零副作用（#2）', async () => {
  const sb = sandbox()
  const runId = 'r-w59-mode'
  const item = { id: 'x#1', title: 't', path: sb.data, bytes: 3, grade: 'green', blocked: null, executor: 'stage' }
  writeFileSync(join(sb.state, `${runId}.json`), JSON.stringify({ runId, domain: 'system', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: 3 } }))
  const tools = mkTools(sb, { approvalEvidence: () => [{ role: 'user', content: '批准清理' }] })
  const plan = await tool(tools, 'disk_plan').execute({ args: { runId, itemIds: ['x#1'] } })
  const planId = String(plan.content).match(/plan_id=(p-[a-z0-9]+)/)?.[1]
  const token = String(plan.content).match(/令牌 (\S+)（/)?.[1]

  const stage = await tool(tools, 'disk_exec').execute({ args: { planId, token, mode: 'stage', approval: '批准清理' } })
  assert.equal(stage.isError, undefined, `stage 应先成功：${stage.content}`)
  const batchId = String(stage.content).match(/batch_id=(b-[a-z0-9]+)/)?.[1]

  const before = readLedger(sb.ledgerPath).length
  const bad = await tool(tools, 'disk_exec').execute({ args: { planId, token, mode: 'preview', batchId, approval: '批准清理' } })
  assert.equal(bad.isError, true, `非法 mode 必须报错：${bad.content}`)
  assert.match(String(bad.content), /mode|MODE/, '错误里应点名 mode')
  assert.equal(readLedger(sb.ledgerPath).length, before, '不得写任何台账行（零副作用）')
  assert.equal(existsSync(join(sb.data, 'a.txt')), false, 'stage 后源已移走（前置状态）')
  // 隔离区里那份必须还在 —— 没被永久删除
  const rows = readLedger(sb.ledgerPath).filter((r) => r.action === 'stage')
  assert.ok(rows.length >= 1 && existsSync(rows[0].to), '隔离区文件必须仍在，不能被 purge 掉')
})

test('W59 ②：sweepBudgetMs 非数值必须被拒绝，不能让 deadline 变 NaN（#37）', async () => {
  const sb = sandbox()
  const r = await tool(mkTools(sb), 'disk_scan').execute({ args: { domain: 'tianshu', sweepBudgetMs: '120s' } })
  assert.equal(r.isError, true, `非法预算应报错：${String(r.content).slice(0, 120)}`)
  assert.match(String(r.content), /预算|budget|sweepBudgetMs/i, '错误里应点名预算参数')
})

test('W59 ③：过期 plan 的 purge 必须拒绝（#14）', async () => {
  const sb = sandbox()
  const dest = join(sb.quarantine, 'b-expired', 'cache')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.txt'), 'AAA')
  writeFileSync(
    sb.ledgerPath,
    JSON.stringify({ ts: 1, batchId: 'b-expired', action: 'stage', itemId: 'x#1', from: sb.data, to: dest, bytes: 3 }) + '\n',
  )
  const plan = {
    token: 'tk', issuer: 'human', confirmedBy: 'chat:批准',
    expiresAt: 1, stagedBatches: new Set(['b-expired']), items: [],
  }
  await assert.rejects(
    () => purge({ plan, batchId: 'b-expired', token: 'tk', quarantineRoot: sb.quarantine, ledgerPath: sb.ledgerPath, now: Date.now() }),
    (e) => e.code === 'EXEC_PLAN_EXPIRED',
    '过期计划不得执行永久删除',
  )
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'AAA', '隔离区文件必须仍在')
})
