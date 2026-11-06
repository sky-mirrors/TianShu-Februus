// W17：执行期安全——① TOCTOU（执行前重验身份与禁区）② 崩溃一致性（intent→done，可恢复）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, recoverBatch, EXEC_ERRORS } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')
const { snapshot } = await import('../core/identity.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w17-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'hello')
  const item = { id: 'x#1', path: join(src, 'cache'), bytes: 5, grade: 'green', blocked: null, executor: 'stage' }
  return { root, src, item, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

test('TOCTOU：扫描后路径被改动（尺寸/时间不符）→ 拒绝执行且不动文件', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })

  // 模拟"扫描之后被人改过"
  writeFileSync(join(s.item.path, 'a.txt'), 'changed-content-longer')
  utimesSync(s.item.path, new Date(), new Date())

  await assert.rejects(
    stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.IDENTITY_CHANGED,
  )
  assert.equal(existsSync(join(s.src, 'cache')), true, '拒绝时不得移动任何文件')
})

test('TOCTOU：身份一致时才允许执行，并成功移入隔离区', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(r.staged, 1)
  assert.equal(existsSync(join(s.src, 'cache')), false)
})

test('执行期重验禁区：路径被篡改到禁区 → 拒绝', async () => {
  const s = scene()
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const evil = { ...s.item, path: 'C:\\Windows\\Temp\\x', identity: null }
  await assert.rejects(
    stage({ plan, token: plan.token, items: [evil], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath }),
    (e) => e.code === EXEC_ERRORS.REFUSED_DENIED,
  )
})

test('崩溃一致性：先写 intent 再动手，成功后写 done', async () => {
  const s = scene()
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [{ ...s.item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })

  const rows = readLedger(s.ledgerPath).filter((x) => x.batchId === r.batchId)
  const actions = rows.map((x) => x.action)
  assert.deepEqual(actions, ['intent', 'stage', 'batch'], `台账顺序应为 intent→stage→batch，实际 ${actions}`)
  assert.ok(rows[0].to && rows[0].from, 'intent 行必须记录 from/to，否则崩溃后无法恢复')
})

test('崩溃恢复：有 intent 无 done（已完成但未记账）→ 补写 done', async () => {
  const s = scene()
  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const batchId = 'b-crash-1'
  const dest = join(s.quarantine, batchId, 'x')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.txt'), 'hello')
  // "已完成"的含义就是源已经不在：只留目标
  rmSync(s.item.path, { recursive: true, force: true })
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'intent', itemId: 'x#1', from: s.item.path, to: dest, bytes: 5, undoSupported: true })

  const r = await recoverBatch({ ledgerPath: s.ledgerPath, batchId })
  assert.equal(r.completed, 1, `应识别为"已完成未记账"，实际 ${JSON.stringify(r)}`)
  assert.ok(readLedger(s.ledgerPath).some((x) => (x.action === 'stage' || x.action === 'done') && x.batchId === batchId), '应补写终态行')
})

test('崩溃恢复：源与目标同时存在（跨卷复制中途崩）→ 标记不一致，且不自动删除', async () => {
  const s = scene()
  const batchId = 'b-crash-2'
  const dest = join(s.quarantine, batchId, 'x')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.txt'), 'partial')
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'intent', itemId: 'x#1', from: s.item.path, to: dest, bytes: 5, crossVolume: true, undoSupported: true })

  const r = await recoverBatch({ ledgerPath: s.ledgerPath, batchId })
  assert.equal(r.inconsistent, 1, `应报不一致，实际 ${JSON.stringify(r)}`)
  assert.equal(existsSync(s.item.path), true, '源必须还在（不自动删除）')
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'partial', '半份副本也不自动清理，交由人决定')
})
