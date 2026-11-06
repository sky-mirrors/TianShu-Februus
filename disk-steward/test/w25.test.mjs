// W25：把 keepDir / noRecurse 的台账改成**文件粒度**，让这两类批次重新可撤销。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, undo } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { snapshot } = await import('../core/identity.mjs')
const { readLedger } = await import('../core/ledger.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w25-'))
  const src = join(root, 'cache')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'aaa')
  writeFileSync(join(src, 'sub', 'b.txt'), 'bbb')
  return { root, src, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

async function stageWith(s, flags) {
  const item = { id: 'x#1', path: s.src, bytes: 6, grade: 'green', blocked: null, executor: 'stage', flags }
  const identity = await snapshot(s.src)
  const plan = createPlan({ run: { items: [item] }, itemIds: ['x#1'], issuer: 'human', confirmedBy: 'test' })
  return stage({ plan, token: plan.token, items: [{ ...item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
}

test('noRecurse：文件粒度记账，undo 能把被移走的文件放回来', async () => {
  const s = scene()
  const r = await stageWith(s, ['noRecurse'])
  const rows = readLedger(s.ledgerPath)
  const fileRows = rows.filter((x) => x.action === 'file-stage')
  assert.equal(fileRows.length, 1, `应有一条文件级台账（a.txt），实际 ${fileRows.length}`)
  assert.equal(fileRows[0].granularity, 'file')
  const dirRow = rows.find((x) => x.action === 'stage')
  assert.equal(dirRow.undoSupported, false, '目录行不作为撤销依据')

  const u = await undo({ batchId: r.batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 1, `应恢复 1 个文件，实际 ${JSON.stringify(u)}`)
  assert.equal(readFileSync(join(s.src, 'a.txt'), 'utf8'), 'aaa', '内容必须原样回来')
  assert.equal(existsSync(join(s.src, 'sub', 'b.txt')), true, '子目录本来就没动')
})

test('keepDir：文件粒度记账，undo 能把内容放回空目录', async () => {
  const s = scene()
  const r = await stageWith(s, ['keepDir'])
  const fileRows = readLedger(s.ledgerPath).filter((x) => x.action === 'file-stage')
  assert.equal(fileRows.length, 2, `两个文件都应各记一行，实际 ${fileRows.length}`)

  const u = await undo({ batchId: r.batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 2)
  assert.equal(readFileSync(join(s.src, 'a.txt'), 'utf8'), 'aaa')
  assert.equal(readFileSync(join(s.src, 'sub', 'b.txt'), 'utf8'), 'bbb')
})

test('默认行为不受影响：目录行仍可撤销', async () => {
  const s = scene()
  const r = await stageWith(s, [])
  const dirRow = readLedger(s.ledgerPath).find((x) => x.action === 'stage')
  assert.equal(dirRow.undoSupported, true)
  assert.equal(readLedger(s.ledgerPath).filter((x) => x.action === 'file-stage').length, 0)
  const u = await undo({ batchId: r.batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 1)
  assert.equal(existsSync(join(s.src, 'sub', 'b.txt')), true)
})
