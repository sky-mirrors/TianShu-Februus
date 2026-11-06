// W26：文件安全优先——把"文件已进隔离区但台账还没记"的崩溃窗口关掉。
// 做法：移动**之前**先写 file-intent（纯记录，不动磁盘）；移动成功后再写 file-stage。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, undo, recoverBatch } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { snapshot } = await import('../core/identity.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w26-'))
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

test('台账顺序：file-intent 必须出现在 file-stage 之前', async () => {
  const s = scene()
  await stageWith(s, ['keepDir'])
  const actions = readLedger(s.ledgerPath).map((x) => x.action)
  const firstIntent = actions.indexOf('file-intent')
  const firstStage = actions.indexOf('file-stage')
  assert.ok(firstIntent >= 0, `应写 file-intent，实际 ${actions.join(',')}`)
  assert.ok(firstStage > firstIntent, `file-intent 应早于 file-stage，实际 ${actions.join(',')}`)
})

test('崩溃复现：只有 file-intent（移动已发生但未记账）→ undo 仍能还原', async () => {
  const s = scene()
  // 手工构造"崩在 file-stage 之前"的现场：文件已在隔离区，台账只有 intent
  const batchId = 'b-crash-file'
  const destDir = join(s.quarantine, batchId, 'cache')
  mkdirSync(join(destDir, 'sub'), { recursive: true })
  renameSync(join(s.src, 'a.txt'), join(destDir, 'a.txt'))
  renameSync(join(s.src, 'sub', 'b.txt'), join(destDir, 'sub', 'b.txt'))
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(s.src, 'a.txt'), to: join(destDir, 'a.txt'), undoSupported: true })
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(s.src, 'sub', 'b.txt'), to: join(destDir, 'sub', 'b.txt'), undoSupported: true })

  const r = await undo({ batchId, ledgerPath: s.ledgerPath })
  assert.equal(r.restored, 2, `应凭 intent 还原 2 个文件，实际 ${JSON.stringify(r)}`)
  assert.equal(readFileSync(join(s.src, 'a.txt'), 'utf8'), 'aaa')
  assert.equal(readFileSync(join(s.src, 'sub', 'b.txt'), 'utf8'), 'bbb')
})

test('recoverBatch 能识别"有 file-intent 无 file-stage 且文件已在隔离区"为已完成', async () => {
  const s = scene()
  const batchId = 'b-crash-file2'
  const destDir = join(s.quarantine, batchId, 'cache')
  mkdirSync(destDir, { recursive: true })
  renameSync(join(s.src, 'a.txt'), join(destDir, 'a.txt'))
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(s.src, 'a.txt'), to: join(destDir, 'a.txt'), undoSupported: true })

  const r = await recoverBatch({ ledgerPath: s.ledgerPath, batchId })
  assert.ok(r.fileCompleted >= 1, `应识别出 1 个文件已完成，实际 ${JSON.stringify(r)}`)
  assert.ok(readLedger(s.ledgerPath).some((x) => x.action === 'file-stage' && x.batchId === batchId), '应补写 file-stage')
})
