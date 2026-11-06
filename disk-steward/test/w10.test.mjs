// W10：跨卷（EXDEV）真实测试——C: 临时目录 → D: 隔离区，不 mock。
// 目的：那条"复制+删"的降级分支从来没被执行过，只在代码里存在。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, undo } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { readLedger } = await import('../core/ledger.mjs')

const D_ROOT = 'D:/Februus/.tmp-xvol'

function scene() {
  const src = mkdtempSync(join(tmpdir(), 'ds-xv-c-')) // 通常在 C:
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'X'.repeat(256))
  mkdirSync(D_ROOT, { recursive: true })
  const quarantine = mkdtempSync(join(D_ROOT, 'q-')) // 通常在 D:
  const item = { id: 'x#1', path: join(src, 'cache'), bytes: 256, grade: 'green', blocked: null, executor: 'stage' }
  return { src, quarantine, item, ledgerPath: join(quarantine, 'ledger.jsonl') }
}

test('跨卷 stage：走复制+删降级，台账标 crossVolume，内容不丢', async () => {
  const s = scene()
  const devSrc = statSync(s.item.path).dev
  const devQ = statSync(s.quarantine).dev
  if (devSrc === devQ) {
    assert.ok(true, `同卷（dev=${devSrc}），跨卷分支无法执行——不造假通过`)
    return
  }

  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [s.item], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(r.staged, 1)
  assert.equal(existsSync(join(s.src, 'cache')), false, '源目录应已移走')

  const row = readLedger(s.ledgerPath).find((x) => x.action === 'stage')
  assert.equal(row.crossVolume, true, `跨卷降级应被记录（dev ${devSrc} → ${devQ}）`)
  assert.equal(readFileSync(join(row.to, 'a.txt'), 'utf8').length, 256, '跨卷复制后内容完整')

  const u = await undo({ batchId: r.batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 1)
  assert.equal(readFileSync(join(s.src, 'cache', 'a.txt'), 'utf8').length, 256, '撤销后内容完整')
})

test('同卷 stage：crossVolume 为 false（对照组，证明判定不是恒真）', async () => {
  const src = mkdtempSync(join(tmpdir(), 'ds-xv-s-'))
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'b.txt'), 'Y'.repeat(64))
  const quarantine = join(src, 'trash')
  mkdirSync(quarantine, { recursive: true })
  const ledgerPath = join(src, 'ledger.jsonl')
  const item = { id: 'y#1', path: join(src, 'cache'), bytes: 64, grade: 'green', blocked: null, executor: 'stage' }
  const plan = createPlan({ run: { items: [item] }, itemIds: [item.id], issuer: 'human', confirmedBy: 'test' })
  await stage({ plan, token: plan.token, items: [item], quarantineRoot: quarantine, ledgerPath })
  const row = readLedger(ledgerPath).find((x) => x.action === 'stage')
  assert.equal(row.crossVolume, false, '同卷不应误标 crossVolume')
})
