// W55：崩溃后的可见性——未决批次要出现在 disk_status，失败文案要指出下一步。
// 这两条在 W52 里只有实现、没有断言，属于「写了但没验证」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { appendLedger } = await import('../core/ledger.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w55-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  return { root, state, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl') }
}
const tool = (tools, name) => tools.find((t) => t.name === name)
const mkTools = (sb, extra = {}) => createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine, ...extra })

test('W55 ①：有未决批次时 disk_status 必须把它打出来', async () => {
  const sb = sandbox()
  appendLedger(sb.ledgerPath, {
    ts: Date.now(), batchId: 'b-pending', action: 'intent', itemId: 'x#1',
    from: join(sb.root, 'cache'), to: join(sb.quarantine, 'b-pending', 'cache'), bytes: 3, undoSupported: true,
  })
  const r = await tool(mkTools(sb), 'disk_status').execute({ args: {} })
  assert.match(String(r.content), /未决批次\s+1 批/, `disk_status 应报 1 个未决批次：\n${r.content}`)
})

test('W55 ②：没有未决批次时 disk_status 不乱报', async () => {
  const sb = sandbox()
  const r = await tool(mkTools(sb), 'disk_status').execute({ args: {} })
  assert.doesNotMatch(String(r.content), /未决批次/, `无未决批次时不该出现该行：\n${r.content}`)
})

test('W55 ③：stage 失败时错误文案必须指出 disk_recover / disk_undo', async () => {
  const sb = sandbox()
  const runId = 'r-w55'
  const item = { id: 'x#1', title: 't', path: join(sb.root, 'does-not-exist'), bytes: 10, grade: 'green', blocked: null, executor: 'stage' }
  writeFileSync(
    join(sb.state, `${runId}.json`),
    JSON.stringify({ runId, domain: 'system', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: 10 } }),
  )
  const tools = mkTools(sb, { approvalEvidence: () => [{ role: 'user', content: '批准清理' }] })

  const plan = await tool(tools, 'disk_plan').execute({ args: { runId, itemIds: ['x#1'] } })
  assert.equal(plan.isError, undefined, `plan 不该失败：${plan.content}`)
  const planId = String(plan.content).match(/plan_id=(p-[a-z0-9]+)/)?.[1]
  const token = String(plan.content).match(/令牌 (\S+)（/)?.[1]

  const exec = await tool(tools, 'disk_exec').execute({ args: { planId, token, mode: 'stage', approval: '批准清理' } })
  assert.equal(exec.isError, true, '路径不存在时 stage 必须失败')
  assert.match(String(exec.content), /disk_recover/, `失败文案应指向 disk_recover：${exec.content}`)
  assert.match(String(exec.content), /disk_undo/, `失败文案应指向 disk_undo：${exec.content}`)
})
