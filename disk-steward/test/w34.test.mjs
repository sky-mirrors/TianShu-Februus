// W34：工具面的人工批准通道——"人批准过"这个事实由对话提供。
// 契约：disk_exec 的 approval 是唯一入口；缺它一律拒绝，有它才把计划升格为 human 签发。
// 真实文件系统 + 真实 createTools，不用 mock（与 w9 同款沙箱）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { readLedger } = await import('../core/ledger.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w34-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const data = join(root, 'data')
  mkdirSync(join(data, 'cache'), { recursive: true })
  writeFileSync(join(data, 'cache', 'a.txt'), 'X'.repeat(128))
  return { root, state, data, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl') }
}

const mkItem = (sb, over = {}) => ({
  id: 'ts.cache#1',
  title: '测试缓存',
  path: join(sb.data, 'cache'),
  kind: 'dir',
  bytes: 128,
  fileCount: 1,
  samples: ['a.txt'],
  ruleId: 'ts.cache',
  grade: 'green',
  blocked: null,
  executor: 'stage',
  decision: 'undecided',
  ...over,
})

// 批准证据：宿主会话记录里的用户消息。W39 起 approval 必须是用户真的说过的片段。
const USER_SAID = [
  { role: 'user', content: '这是测试，批准' },
  { role: 'user', content: '撤销刚才那次' },
]

function tools(sb) {
  return createTools({
    stateDir: sb.state, quarantineRoot: sb.quarantine, ledgerPath: sb.ledgerPath,
    approvalEvidence: () => USER_SAID,
  })
}

const tool = (t, name) => t.find((x) => x.name === name)

async function planOf(t, sb, item) {
  mkdirSync(sb.state, { recursive: true })
  writeFileSync(
    join(sb.state, 'r-w34.json'),
    JSON.stringify({ runId: 'r-w34', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: item.bytes } }),
  )
  const plan = await tool(t, 'disk_plan').execute({ args: { runId: 'r-w34', itemIds: [item.id] } })
  const token = /令牌 ([0-9a-f]+)/.exec(String(plan.content))?.[1]
  const planId = /plan_id=(\S+)/.exec(String(plan.content))?.[1]
  assert.ok(token && planId, `计划输出缺少令牌或 id：${plan.content}`)
  return { planId, token }
}

test('工具面：没有用户批准原话 → 拒绝执行，文件不动，台账为空', async () => {
  const sb = sandbox()
  const t = tools(sb)
  const item = mkItem(sb)
  const { planId, token } = await planOf(t, sb, item)

  for (const args of [{ planId, token, mode: 'stage' }, { planId, token, mode: 'stage', approval: '   ' }]) {
    const r = await tool(t, 'disk_exec').execute({ args })
    assert.equal(r.isError, true, `缺 approval 必须报错：${JSON.stringify(args)}`)
    assert.match(String(r.content), /EXEC_NOT_HUMAN_APPROVED/)
  }
  assert.equal(existsSync(join(sb.data, 'cache', 'a.txt')), true, '被拒时文件不得移动')
  assert.equal(readLedger(sb.ledgerPath).length, 0, '被拒时不得写台账')
})

test('工具面：用户批准原话到位 → stage 成功，台账记人工批准来源，undo 可还原', async () => {
  const sb = sandbox()
  const t = tools(sb)
  const item = mkItem(sb)
  const { planId, token } = await planOf(t, sb, item)

  const r = await tool(t, 'disk_exec').execute({ args: { planId, token, mode: 'stage', approval: '批准' } })
  assert.notEqual(r.isError, true, `带批准的执行应成功：${r.content}`)
  const batchId = /batch_id=(\S+)/.exec(String(r.content))?.[1]
  assert.ok(batchId, `应返回 batch_id：${r.content}`)
  assert.equal(existsSync(join(sb.data, 'cache', 'a.txt')), false, 'stage 后源文件应已移入隔离区')

  const intent = readLedger(sb.ledgerPath).find((x) => x.action === 'intent')
  assert.equal(intent.issuer, 'human', '台账必须记下"人批准过"')
  assert.match(String(intent.confirmedBy), /^chat:/, '台账必须能看出批准来自对话')

  const u = await tool(t, 'disk_undo').execute({ args: { batchId, approval: '撤销刚才那次' } })
  assert.equal(u.isError, undefined, `撤销应成功：${u.content}`)
  assert.equal(existsSync(join(sb.data, 'cache', 'a.txt')), true, 'undo 后源文件应回到原位')
})

// W38：撤销同样是「人批准过」的动作。缺 approval 的 undo 一律拒绝——
// 否则模型可以自说自话把一次已执行的清理悄悄撤掉，或对不属于本次对话的批次动手。
test('W38：工具面 undo 缺 approval 一律拒绝，且不动磁盘', async () => {
  const sb = sandbox()
  const t = tools(sb)
  const item = mkItem(sb)
  const { planId, token } = await planOf(t, sb, item)
  const staged = await tool(t, 'disk_exec').execute({ args: { planId, token, mode: 'stage', approval: '批准' } })
  const batchId = /batch_id=(\S+)/.exec(String(staged.content))?.[1]
  assert.ok(batchId, `应先把批次 stage 出来：${staged.content}`)

  for (const args of [{ batchId }, { batchId, approval: '   ' }]) {
    const r = await tool(t, 'disk_undo').execute({ args })
    assert.equal(r.isError, true, `缺 approval 的撤销必须拒绝：${JSON.stringify(args)}`)
    assert.match(String(r.content), /EXEC_NOT_HUMAN_APPROVED/)
  }
  assert.equal(existsSync(join(sb.data, 'cache', 'a.txt')), false, '被拒时隔离区不得移动')
})
