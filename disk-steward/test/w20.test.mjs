// W20：重启后仍能释放空间——purge 凭台账 + 人工批准，不再依赖内存里的 plan；
// 同时给出隔离区占用概览（否则"空间没释放"在工具面上看不见）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, purgeBatch, quarantineStats, EXEC_ERRORS } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')
const { snapshot } = await import('../core/identity.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w20-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'hello')
  const item = { id: 'x#1', path: join(src, 'cache'), bytes: 5, grade: 'green', blocked: null, executor: 'stage' }
  return { root, src, item, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

async function stagedScene() {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  return { ...s, batchId: r.batchId }
}

test('重启后（无内存 plan）凭台账 + 人工批准可永久删除', async () => {
  const s = await stagedScene()
  // 模拟重启：不传任何 plan，只给 batchId 与批准信息
  const r = await purgeBatch({ batchId: s.batchId, ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, approval: { issuer: 'human', confirmedBy: 'tui' } })
  assert.equal(r.purged, 1)
  const rows = readLedger(s.ledgerPath).filter((x) => x.batchId === s.batchId)
  assert.ok(rows.some((x) => x.action === 'purge'), '应写入 purge 台账行')
  assert.equal(existsSync(join(s.quarantine, s.batchId, rows.find((x) => x.action === 'stage').to.split(/[\\/]/).pop())), false)
})

test('无人工批准 → 拒绝，且一个字节都不删', async () => {
  const s = await stagedScene()
  await assert.rejects(
    purgeBatch({ batchId: s.batchId, ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, approval: { issuer: 'agent' } }),
    (e) => e.code === EXEC_ERRORS.NOT_HUMAN_APPROVED,
  )
  const staged = readLedger(s.ledgerPath).find((x) => x.action === 'stage')
  assert.equal(existsSync(staged.to), true, '被拒时必须原样保留')
})

test('批次不存在 → BATCH_NOT_FOUND（不猜）', async () => {
  const s = scene()
  await assert.rejects(
    purgeBatch({ batchId: 'b-nope', ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, approval: { issuer: 'human', confirmedBy: 'tui' } }),
    (e) => e.code === EXEC_ERRORS.BATCH_NOT_FOUND,
  )
})

test('台账里的目标路径不在隔离区内 → 拒绝（防台账被篡改后越界删）', async () => {
  const s = scene()
  const batchId = 'b-evil'
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'stage', itemId: 'x#1', from: join(s.root, 'x'), to: join(s.root, 'outside', 'evil'), bytes: 1, undoSupported: true })
  await assert.rejects(
    purgeBatch({ batchId, ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, approval: { issuer: 'human', confirmedBy: 'tui' } }),
    (e) => e.code === EXEC_ERRORS.BATCH_PATH_ESCAPE,
  )
})

test('隔离区概览：批次/字节/最老天数', async () => {
  const s = await stagedScene()
  const st = await quarantineStats({ ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, now: Date.now() })
  assert.equal(st.batches, 1)
  assert.ok(st.bytes > 0, `应统计到占用字节，实际 ${st.bytes}`)
  assert.ok(typeof st.oldestDays === 'number')
})
