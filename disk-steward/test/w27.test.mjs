// W27：① 崩溃窗口复现（file-intent 已写但未移动）② keepDir 批次的 purgeBatch 专门测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, purgeBatch, recoverBatch } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { snapshot } = await import('../core/identity.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w27-'))
  const src = join(root, 'cache')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'aaa')
  writeFileSync(join(src, 'sub', 'b.txt'), 'bbb')
  return { root, src, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

test('崩溃复现：只写了 file-intent、还没移动 → recoverBatch 判为未移动，文件原封不动', async () => {
  const s = scene()
  const batchId = 'b-intent-only'
  const destDir = join(s.quarantine, batchId, 'cache')
  // 只记账、不动磁盘，模拟"写完 intent 就崩了"
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(s.src, 'a.txt'), to: join(destDir, 'a.txt'), undoSupported: true })

  const r = await recoverBatch({ ledgerPath: s.ledgerPath, batchId })
  assert.equal(r.fileAborted, 1, `应识别为未移动，实际 ${JSON.stringify(r)}`)
  assert.equal(r.fileCompleted ?? 0, 0, '绝不能判成已完成')
  assert.equal(readFileSync(join(s.src, 'a.txt'), 'utf8'), 'aaa', '源文件必须还在')
  assert.ok(readLedger(s.ledgerPath).some((x) => x.action === 'file-abort' && x.batchId === batchId), '应补写 file-abort')
})

test('keepDir 批次：purgeBatch 后隔离区清空、台账写 purge、源空目录保留', async () => {
  const s = scene()
  const item = { id: 'x#1', path: s.src, bytes: 6, grade: 'green', blocked: null, executor: 'stage', flags: ['keepDir'] }
  const identity = await snapshot(s.src)
  const plan = createPlan({ run: { items: [item] }, itemIds: ['x#1'], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [{ ...item, identity }], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(existsSync(s.src), true, 'keepDir 应保留源目录')
  assert.equal(existsSync(join(s.quarantine, r.batchId)), true, '隔离区里应有内容')

  const p = await purgeBatch({ batchId: r.batchId, ledgerPath: s.ledgerPath, quarantineRoot: s.quarantine, approval: { issuer: 'human', confirmedBy: 'test' } })
  assert.ok(p.purged >= 1, `应删除至少 1 项，实际 ${JSON.stringify(p)}`)
  const rows = readLedger(s.ledgerPath).filter((x) => x.batchId === r.batchId)
  assert.ok(rows.some((x) => x.action === 'purge'), '应写 purge 台账')
  assert.equal(existsSync(s.src), true, '源空目录仍保留（keepDir 语义）')
})
