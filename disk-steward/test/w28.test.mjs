// W28：① 保留期/容量阈值（只告警，不自动删） ② 隐私默认值（默认不记真实文件名）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { quarantinePolicy } = await import('../core/executor.mjs')
const { appendLedger } = await import('../core/ledger.mjs')
const { buildRun } = await import('../core/run.mjs')

test('保留期：超过 retentionDays 的批次被标为过期，未超的不标', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w28-'))
  const ledgerPath = join(root, 'ledger.jsonl')
  const quarantineRoot = join(root, 'trash')
  const now = Date.now()
  const day = 86400000
  // 老批次（10 天前）与新批次（1 天前）
  for (const [batchId, ageDays] of [['b-old', 10], ['b-new', 1]]) {
    const to = join(quarantineRoot, batchId, 'x')
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'a.txt'), 'x'.repeat(100))
    appendLedger(ledgerPath, { ts: now - ageDays * day, batchId, action: 'stage', itemId: 'x#1', from: '/orig', to, bytes: 100, undoSupported: true })
  }
  const p = await quarantinePolicy({ ledgerPath, quarantineRoot, now, retentionDays: 7, maxBytes: 10 * 1024 * 1024 })
  assert.deepEqual(p.expiredBatches, ['b-old'], `只有老批次应过期，实际 ${JSON.stringify(p.expiredBatches)}`)
  assert.equal(p.overLimit, false)
})

test('容量阈值：超过 maxBytes 时 overLimit=true，但不自动删除任何东西', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w28b-'))
  const ledgerPath = join(root, 'ledger.jsonl')
  const quarantineRoot = join(root, 'trash')
  const to = join(quarantineRoot, 'b-big', 'x')
  mkdirSync(to, { recursive: true })
  writeFileSync(join(to, 'a.txt'), 'x'.repeat(200))
  appendLedger(ledgerPath, { ts: Date.now(), batchId: 'b-big', action: 'stage', itemId: 'x#1', from: '/orig', to, bytes: 200, undoSupported: true })

  const p = await quarantinePolicy({ ledgerPath, quarantineRoot, now: Date.now(), retentionDays: 7, maxBytes: 100 })
  assert.equal(p.overLimit, true, `应判定超限，实际 ${JSON.stringify(p)}`)
  assert.equal(p.bytes, 200)
})

test('隐私默认值：默认不把真实文件名写进 item.samples', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w28c-'))
  const cache = join(root, 'cache')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'secret-customer-list.csv'), 'x'.repeat(32))
  const rule = { id: 'p.cache', match: { kind: 'prefix', path: '{{root}}/cache' }, grade: 'green', reason: '缓存', executor: { type: 'stage' } }

  const run = await buildRun({ rules: [rule], vars: { root }, collectUnmatched: false })
  const item = run.items[0]
  assert.deepEqual(item.samples, [], `默认应清空文件名，实际 ${JSON.stringify(item.samples)}`)
  assert.equal(item.samplesRedacted, true)
  assert.ok(!JSON.stringify(item.explain).includes('secret-customer-list'), '解释文本也不得含真实文件名')
})

test('隐私开关：显式开启后才记录样本文件名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w28d-'))
  const cache = join(root, 'cache')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'visible.txt'), 'x'.repeat(8))
  const rule = { id: 'p.cache2', match: { kind: 'prefix', path: '{{root}}/cache' }, grade: 'green', reason: '缓存', executor: { type: 'stage' } }

  const run = await buildRun({ rules: [rule], vars: { root, includeSamples: true }, collectUnmatched: false })
  assert.deepEqual(run.items[0].samples, ['visible.txt'])
  assert.equal(run.items[0].samplesRedacted, false)
})
