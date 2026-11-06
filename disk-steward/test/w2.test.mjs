// W2：执行链路与撤销（两条硬门：无令牌不可 purge、只允许 purge 本批次已 staged 的项）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createPlan, PLAN_ERRORS } = await import('../core/plan.mjs')
const { stage, purge, undo, EXEC_ERRORS } = await import('../core/executor.mjs')
const { readLedger } = await import('../core/ledger.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w2-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'hello-a')
  writeFileSync(join(src, 'cache', 'b.txt'), 'hello-bb')
  const item = { id: 'ts.cache#1', path: join(src, 'cache'), bytes: 16, grade: 'green', blocked: null, executor: 'stage' }
  const brown = { id: 'ts.memory-db#2', path: join(src, 'db'), bytes: 8, grade: 'brown', blocked: null, executor: null }
  const run = { runId: 'r-w2', items: [item, brown], unmatched: [], totals: {} }
  return { root, src, item, brown, run, ledgerPath: join(root, 'ledger.jsonl'), quarantine: join(root, 'trash') }
}

test('计划拒绝保护项（brown 不可勾选进入计划）', () => {
  const s = scene()
  assert.throws(
    () => createPlan({ run: s.run, itemIds: [s.brown.id], issuer: 'human', confirmedBy: 'test' }),
    (e) => e.code === PLAN_ERRORS.REFUSED_PROTECTED,
  )
})

test('无令牌/错令牌的 purge 必须失败，且隔离区文件仍在', async () => {
  const s = scene()
  const plan = createPlan({ run: s.run, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const staged = await stage({ plan, token: plan.token, items: [s.item], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  await assert.rejects(
    purge({ plan, batchId: staged.batchId, token: 'not-the-token', quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.TOKEN_INVALID,
  )
  const q = join(s.quarantine, staged.batchId)
  assert.equal(existsSync(join(q, String(s.item.path).replace(/[:\\/]+/g, '_'))), true, '隔离区文件应当还在')
})

test('未 staged 的批次不能 purge', async () => {
  const s = scene()
  const plan = createPlan({ run: s.run, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  await assert.rejects(
    purge({ plan, batchId: 'b-never-staged', token: plan.token, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.BATCH_NOT_STAGED,
  )
})

test('stage 后源消失、隔离区存在、台账两行，undo 能原样恢复', async () => {
  const s = scene()
  const plan = createPlan({ run: s.run, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const staged = await stage({ plan, token: plan.token, items: [s.item], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })

  assert.equal(existsSync(join(s.src, 'cache')), false, '源目录应已移走')
  const qPath = join(s.quarantine, staged.batchId, String(s.item.path).replace(/[:\\/]+/g, '_'))
  assert.equal(existsSync(qPath), true, '隔离区应有该目录')
  assert.equal(readFileSync(join(qPath, 'a.txt'), 'utf8'), 'hello-a')

  const rows = readLedger(s.ledgerPath)
  assert.equal(rows.filter((r) => r.action === 'stage').length, 1)
  assert.equal(rows.filter((r) => r.action === 'batch').length, 1)

  const undone = await undo({ batchId: staged.batchId, ledgerPath: s.ledgerPath })
  assert.equal(undone.restored, 1)
  assert.equal(existsSync(join(s.src, 'cache', 'a.txt')), true, '撤销后源文件应回来')
  assert.equal(readFileSync(join(s.src, 'cache', 'a.txt'), 'utf8'), 'hello-a')
  assert.equal(readLedger(s.ledgerPath).filter((r) => r.action === 'undo').length, 1)
})

test('purge 只删本批次已 staged 的项，并要求令牌', async () => {
  const s = scene()
  const plan = createPlan({ run: s.run, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const staged = await stage({ plan, token: plan.token, items: [s.item], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  const qPath = join(s.quarantine, staged.batchId, String(s.item.path).replace(/[:\\/]+/g, '_'))

  const res = await purge({ plan, batchId: staged.batchId, token: plan.token, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(res.purged, 1)
  assert.equal(existsSync(qPath), false, 'purge 后隔离区条目应消失')
  const rows = readLedger(s.ledgerPath)
  assert.equal(rows.filter((r) => r.action === 'purge').length, 1)
})
