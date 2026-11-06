// W32：跨卷 stage 遇旧 mtime 时必须通过移动后校验——真机 GPUCache（15 天前 mtime）曾因此丢源目录。
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
  const src = mkdtempSync(join(tmpdir(), 'ds-xv-old-')) // 通常在 C:
  mkdirSync(join(src, 'cache'), { recursive: true })
  writeFileSync(join(src, 'cache', 'a.txt'), 'X'.repeat(256))
  mkdirSync(D_ROOT, { recursive: true })
  const quarantine = mkdtempSync(join(D_ROOT, 'q-')) // 通常在 D:
  const item = { id: 'x#1', path: join(src, 'cache'), bytes: 256, grade: 'green', blocked: null, executor: 'stage' }
  return { src, quarantine, item, ledgerPath: join(quarantine, 'ledger.jsonl') }
}

test('跨卷 stage：源目录 mtime 较早时，复制必须保留时间戳并校验通过', async () => {
  const s = scene()
  const devSrc = statSync(s.item.path).dev
  const devQ = statSync(s.quarantine).dev
  if (devSrc === devQ) {
    assert.ok(true, `同卷（dev=${devSrc}），跨卷分支无法执行——不造假通过`)
    return
  }

  const old = new Date(Date.now() - 2 * 86400000)
  utimesSync(join(s.item.path, 'a.txt'), old, old)
  utimesSync(s.item.path, old, old)
  const before = statSync(s.item.path).mtimeMs

  const plan = createPlan({ run: { items: [s.item] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  const r = await stage({ plan, token: plan.token, items: [s.item], quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  assert.equal(r.staged, 1)
  assert.equal(existsSync(s.item.path), false, '源目录应已移走')
  const after = statSync(r.rows[0].to).mtimeMs
  assert.ok(Math.abs(after - before) < 1000, `隔离区目录 mtime 应保留，实际偏移 ${Math.abs(after - before)}ms`)

  const u = await undo({ batchId: r.batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 1)
  assert.equal(readFileSync(join(s.item.path, 'a.txt'), 'utf8').length, 256, '撤销后内容完整')

  const row = readLedger(s.ledgerPath).find((x) => x.action === 'stage')
  assert.equal(row.crossVolume, true)
})
