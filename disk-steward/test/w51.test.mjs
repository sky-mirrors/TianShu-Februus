// W51：代码审查暴露的三处缺陷的回归测试
// ① 同毫秒两次扫描的 runId 冲突（并发落盘互相覆盖）
// ② measure 的预算只在目录边界检查，单层巨量文件时整体超预算
// ③ undo 对「已移动但 stage 行未写」的崩溃批次无能为力（数据滞留在隔离区）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRun } = await import('../core/run.mjs')
const { measure } = await import('../core/probe.mjs')
const { undo } = await import('../core/executor.mjs')
const { appendLedger } = await import('../core/ledger.mjs')

test('W51 ①：同一毫秒生成的 runId 必须互不相同（否则并发扫描落盘互相覆盖）', async () => {
  const now = 1700000000000
  const opts = { rules: [], vars: {}, collectUnmatched: false, now }
  const a = await buildRun(opts)
  const b = await buildRun(opts)
  assert.notEqual(a.runId, b.runId, `同毫秒两次扫描得到同一 runId：${a.runId}`)
  assert.match(a.runId, /^r-[a-z0-9]+-[0-9a-f]+$/, `runId 应带随机后缀，实际 ${a.runId}`)
})

test('W51 ②：measure 的预算在文件级也生效，单层海量文件不得跑完全部 stat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w51-deadline-'))
  const N = 12000
  for (let i = 0; i < N; i++) writeFileSync(join(dir, `f${i}.bin`), '')
  const m = await measure(dir, { deadline: Date.now() + 150 })
  assert.equal(m.partial, true, `预算耗尽必须标 partial，实际 fileCount=${m.fileCount} partial=${m.partial}`)
  assert.ok(m.fileCount < N, `超预算后应停止遍历，实际仍统计了 ${m.fileCount} 个文件`)
})

test('W51 ③：undo 能恢复「文件已移动但 stage 行未写」的崩溃批次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w51-undo-'))
  const src = join(root, 'cache')
  const quarantine = join(root, 'trash')
  const batchId = 'b-crashed'
  mkdirSync(join(quarantine, batchId, 'cache'), { recursive: true })
  // 磁盘实际状态：源已不在（被 move 走了），隔离区里有一份
  writeFileSync(join(quarantine, batchId, 'cache', 'a.txt'), 'aaa')
  const ledgerPath = join(root, 'ledger.jsonl')
  // 台账状态：只写了 intent（移动完成后崩了，stage 行没落）
  appendLedger(ledgerPath, {
    ts: Date.now(), batchId, action: 'intent', itemId: 'x#1',
    from: src, to: join(quarantine, batchId, 'cache'), bytes: 3, undoSupported: true,
  })

  const r = await undo({ batchId, ledgerPath })
  assert.equal(r.restored, 1, `应凭 intent 恢复，实际 ${JSON.stringify(r)}`)
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'aaa', '文件必须回到原位置')
  assert.equal(existsSync(join(quarantine, batchId, 'cache')), false, '隔离区副本应已移走')
})
