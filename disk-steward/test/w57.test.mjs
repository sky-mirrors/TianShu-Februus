// W57：一条坏行不该让整批失效——readLedger 是全量解析，遇到坏行原先直接抛错，
// 而 undo / purgeBatch / quarantineStats 都建立在它之上（掉电截断、手工编辑、并发写坏行都会造成）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { readLedger } = await import('../core/ledger.mjs')
const { undo } = await import('../core/executor.mjs')

test('W57 ①：坏行被跳成可见的 corrupt 行，不抛异常、不吞掉好行', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w57-'))
  const p = join(root, 'ledger.jsonl')
  appendFileSync(p, JSON.stringify({ action: 'stage', batchId: 'b1', itemId: 'x#1' }) + '\n')
  appendFileSync(p, '{"action":"stage","batchId":"b1",,,BROKEN\n') // 截断/损坏行
  appendFileSync(p, JSON.stringify({ action: 'stage', batchId: 'b1', itemId: 'x#2' }) + '\n')

  const rows = readLedger(p)
  assert.equal(rows.length, 3, `应保留 3 条（2 好 + 1 坏），实际 ${rows.length}`)
  assert.equal(rows.filter((r) => r.action === 'stage').length, 2, '两条好行都要在')
  const bad = rows.find((r) => r.action === 'corrupt')
  assert.ok(bad, '坏行必须以 action="corrupt" 现身，而不是静默消失')
  assert.match(String(bad.raw), /BROKEN/, 'corrupt 行要带上原始片段供人排查')
})

test('W57 ②：台账里有坏行时 undo 仍然能恢复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w57-undo-'))
  const src = join(root, 'cache')
  const quarantine = join(root, 'trash')
  const batchId = 'b-crash'
  mkdirSync(join(quarantine, batchId, 'cache'), { recursive: true })
  writeFileSync(join(quarantine, batchId, 'cache', 'a.txt'), 'aaa')
  const ledgerPath = join(root, 'ledger.jsonl')
  appendFileSync(ledgerPath, 'GARBAGE-NOT-JSON\n')
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: Date.now(), batchId, action: 'intent', itemId: 'x#1', from: src, to: join(quarantine, batchId, 'cache'), bytes: 3, undoSupported: true }) + '\n',
  )

  const r = await undo({ batchId, ledgerPath })
  assert.equal(r.restored, 1, `坏行不该阻止恢复，实际 ${JSON.stringify(r)}`)
})
