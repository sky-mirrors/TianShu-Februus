// W58：.runs 只增不减会让状态目录无限长大（每次扫描 +1 个约 25KB 的 run 文件）。
// 保留策略：只留最近 N 个，按 mtime 删最旧的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { pruneRuns, RUN_KEEP } = await import('../tools/index.mjs')

test('W58 ①：超过保留上限时删最旧的，保留最近 N 个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w58-'))
  const total = RUN_KEEP + 7
  for (let i = 0; i < total; i++) {
    const p = join(dir, `r-old${String(i).padStart(3, '0')}.json`)
    writeFileSync(p, '{}')
    // 让 mtime 单调递增：i 越大越新
    const t = 1700000000 + i
    utimesSync(p, t, t)
  }
  pruneRuns(dir, RUN_KEEP)
  const left = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.equal(left.length, RUN_KEEP, `应剩 ${RUN_KEEP} 个，实际 ${left.length}`)
  assert.ok(!left.includes('r-old000.json'), '最旧的应被删掉')
  assert.ok(left.includes(`r-old${String(total - 1).padStart(3, '0')}.json`), '最新的必须保留')
})

test('W58 ②：不足上限时一个都不删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w58b-'))
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `r-a${i}.json`), '{}')
  pruneRuns(dir, RUN_KEEP)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 3, '不该动未超限的目录')
})

test('W58 ③：非 run 文件（refcache.json 等）不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w58c-'))
  writeFileSync(join(dir, 'refcache.json'), '{"keep":true}')
  for (let i = 0; i < RUN_KEEP + 2; i++) {
    const p = join(dir, `r-x${String(i).padStart(3, '0')}.json`)
    writeFileSync(p, '{}')
    utimesSync(p, 1700000000 + i, 1700000000 + i)
  }
  pruneRuns(dir, RUN_KEEP)
  const left = readdirSync(dir)
  assert.ok(left.includes('refcache.json'), 'refcache 不是 run，不该被删')
})
