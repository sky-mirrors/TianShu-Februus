// W39：批准必须是「用户真的说过」的原文片段，且只认 user 角色消息。
// 为什么——approval 是工具参数，模型能填任何字串；单看非空等于模型自批。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { matchApproval, APPROVAL_ERRORS } = await import('../core/approval.mjs')
const { createTools } = await import('../tools/index.mjs')

test('W39：approval 必须是 user 角色消息的原文片段', () => {
  const messages = [{ role: 'user', content: '帮我清理 Edge 缓存，批准' }]
  assert.equal(matchApproval({ approval: '批准', messages }).ok, true)

  const assistantOnly = [{ role: 'assistant', content: '已批准清理' }]
  assert.equal(matchApproval({ approval: '已批准清理', messages: assistantOnly }).ok, false, '助手自己说的话不算证据')

  assert.equal(matchApproval({ approval: '全部删除', messages }).ok, false, '用户没说过就不算')
})

test('W39：否定语境不算批准（"不要删除"里也含"删除"）', () => {
  const messages = [{ role: 'user', content: '不要删除缓存目录' }]
  const r = matchApproval({ approval: '删除缓存目录', messages })
  assert.equal(r.ok, false)
  assert.equal(r.code, APPROVAL_ERRORS.NOT_IN_TRANSCRIPT)
  assert.match(r.reason, /否定语境/)
})

test('W39：拿不到会话记录时 fail-closed，不猜', () => {
  const r = matchApproval({ approval: '批准', messages: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, APPROVAL_ERRORS.UNVERIFIABLE)
})

test('W39：空白与超长引用一律拒绝', () => {
  assert.equal(matchApproval({ approval: '   ', messages: [] }).ok, false)
  assert.equal(matchApproval({ approval: 'x'.repeat(201), messages: [{ role: 'user', content: 'x'.repeat(300) }] }).ok, false)
})

test('W39：工具层拿不到会话记录 → 拒绝执行且不动磁盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w39-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const data = join(root, 'data')
  mkdirSync(join(data, 'cache'), { recursive: true })
  writeFileSync(join(data, 'cache', 'a.txt'), 'x'.repeat(64))
  const item = {
    id: 'ts.cache#1', title: '测试缓存', path: join(data, 'cache'), kind: 'dir', bytes: 64,
    fileCount: 1, samples: ['a.txt'], ruleId: 'ts.cache', grade: 'green', blocked: null,
    executor: 'stage', decision: 'undecided',
  }
  writeFileSync(
    join(state, 'r-w39.json'),
    JSON.stringify({ runId: 'r-w39', items: [item], unmatched: [], denied: [], totals: { items: 1, bytes: 64 } }),
  )

  // approvalEvidence 返回 null = 宿主没给会话记录
  const t = createTools({
    stateDir: state, quarantineRoot: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl'),
    approvalEvidence: () => null,
  })
  const plan = await t.find((x) => x.name === 'disk_plan').execute({ args: { runId: 'r-w39', itemIds: [item.id] } })
  const planId = /plan_id=(\S+)/.exec(String(plan.content))?.[1]
  const token = /令牌 ([0-9a-f]+)/.exec(String(plan.content))?.[1]
  const r = await t.find((x) => x.name === 'disk_exec').execute({ args: { planId, token, mode: 'stage', approval: '批准' } })

  assert.equal(r.isError, true, '无法核实批准时必须拒绝')
  assert.match(String(r.content), /EXEC_APPROVAL_UNVERIFIABLE/)
  assert.equal(existsSync(join(data, 'cache', 'a.txt')), true, '被拒时文件不得移动')
})
