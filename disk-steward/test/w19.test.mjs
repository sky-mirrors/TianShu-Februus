// W19：签发权与执行权分离——Agent 能签的计划，不能被执行。
// 令牌只是"能力凭证"；执行还要求"人批准过"这一独立事实。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createPlan } = await import('../core/plan.mjs')
const { stage, purge, EXEC_ERRORS } = await import('../core/executor.mjs')
const { readLedger } = await import('../core/ledger.mjs')
const { snapshot } = await import('../core/identity.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w19-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'hello')
  const item = { id: 'x#1', path: join(src, 'cache'), bytes: 5, grade: 'green', blocked: null, executor: 'stage' }
  return { root, src, item, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

test('计划默认由 agent 签发', () => {
  const s = scene()
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id] })
  assert.equal(plan.issuer, 'agent')
  assert.equal(plan.confirmedBy ?? null, null)
})

test('agent 签发的计划即使令牌正确也不能执行', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id] })
  await assert.rejects(
    stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.NOT_HUMAN_APPROVED,
  )
  assert.equal(existsSync(join(s.src, 'cache')), true, '拒绝时不得移动文件')
  assert.equal(readLedger(s.ledgerPath).length, 0, '拒绝时不得写台账')
})

test('人批准过的计划可以执行，且台账记录批准者', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'tui' })
  const r = await stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(r.staged, 1)
  const intent = readLedger(s.ledgerPath).find((x) => x.action === 'intent')
  assert.equal(intent.issuer, 'human')
  assert.equal(intent.confirmedBy, 'tui')
})

test('purge 同样要求人工批准（agent 计划不得永久删除）', async () => {
  const s = scene()
  const agentPlan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id] })
  agentPlan.stagedBatches = new Set(['b-1'])
  await assert.rejects(
    purge({ plan: agentPlan, batchId: 'b-1', token: agentPlan.token, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.NOT_HUMAN_APPROVED,
  )
})

test('human 计划但缺 confirmedBy → 仍拒绝（批准必须可追溯到人）', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human' })
  await assert.rejects(
    stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.NOT_HUMAN_APPROVED,
  )
})
