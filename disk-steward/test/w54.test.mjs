// W54：扫描类操作的预算必须可传导——否则「整盘扫描」这类调用会远超调用方给的时限。
// 实测背景：disk_scan({ fullDrive:'C', sweepBudgetMs:20000 }) 曾跑 84.4s，
// 其中 system 域（35 条规则）独占 51.5s，而这 51.5s 不受任何预算约束。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRun } = await import('../core/run.mjs')
const { scanSystem } = await import('../domains/system.mjs')

test('W54 ①：buildRun 的 deadline 到期后不再遍历，并通过 truncated 如实上报', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-w54-'))
  mkdirSync(join(dir, 'cache'), { recursive: true })
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, 'cache', `f${i}.bin`), 'x'.repeat(1024))

  const run = await buildRun({
    rules: [{ id: 'x.cache', match: { kind: 'prefix', path: join(dir, 'cache') }, grade: 'green', reason: 't', executor: { type: 'stage' } }],
    vars: {},
    collectUnmatched: false,
    deadline: Date.now() - 1, // 一开始就过期
  })

  assert.equal(run.truncated, true, `预算已过期必须报 truncated，实际 ${run.truncated}`)
  const item = run.items[0]
  assert.ok(item, '仍应给出条目（不完整也要可见）')
  assert.equal(item.partial, true, `条目必须标 partial，实际 ${item.partial}`)
  assert.equal(item.bytes, 0, `超预算时不得报出测了一半的字节数，实际 ${item.bytes}`)
})

test('W54 ②：scanSystem 接受 deadline 并把超预算事实透传给调用方', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ds-w54-sys-'))
  const cache = join(base, 'npm-cache')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'a.bin'), 'x'.repeat(2048))

  const sys = await scanSystem({
    env: { LOCALAPPDATA: base, USERPROFILE: base, APPDATA: base, SystemRoot: 'C:/Windows' },
    deadline: Date.now() - 1,
  })
  assert.equal(sys.truncated, true, `scanSystem 必须透传 truncated，实际 ${sys.truncated}`)
  const hit = sys.items.find((i) => i.ruleId === 'sys.npm-cache')
  assert.ok(hit, `应命中 sys.npm-cache，实际 ${sys.items.map((i) => i.ruleId).join(',')}`)
  assert.equal(hit.partial, true, '命中项应标 partial')
})
