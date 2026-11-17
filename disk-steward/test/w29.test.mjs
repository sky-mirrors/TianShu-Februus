// W29：三处接线——① disk_status 显示保留期/容量告警 ② disk_scan 暴露隐私开关 ③ keepDir 的 recoverBatch 文件级恢复
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { recoverBatch, undo } = await import('../core/executor.mjs')
const { appendLedger, readLedger } = await import('../core/ledger.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w29-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  return { root, state, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl'), data: join(root, 'data') }
}

test('disk_status 显示隔离区保留期/容量告警（有老批次时）', async () => {
  const s = sandbox()
  const to = join(s.quarantine, 'b-old', 'x')
  mkdirSync(to, { recursive: true })
  writeFileSync(join(to, 'a.txt'), 'x'.repeat(64))
  appendLedger(s.ledgerPath, { ts: Date.now() - 10 * 86400000, batchId: 'b-old', action: 'stage', itemId: 'x#1', from: '/orig', to, bytes: 64, undoSupported: true })

  const t = createTools({ stateDir: s.state, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  const out = String((await t.find((x) => x.name === 'disk_status').execute({})).content)
  assert.match(out, /隔离区/, '应有隔离区一行')
  assert.match(out, /过期 1 批|过期批次 1/, `应报告 1 个过期批次，实际输出：\n${out}`)
})

test('disk_status 无告警时不制造噪音（对照）', async () => {
  const s = sandbox()
  const t = createTools({ stateDir: s.state, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath })
  const out = String((await t.find((x) => x.name === 'disk_status').execute({})).content)
  assert.match(out, /隔离区/)
  assert.ok(!/过期 \d+ 批|超限/.test(out), `空的隔离区不应报过期/超限，实际：\n${out}`)
})

test('disk_scan 暴露 includeSamples：默认脱敏，开启后才有文件名', async () => {
  const s = sandbox()
  mkdirSync(join(s.data, 'cache'), { recursive: true })
  writeFileSync(join(s.data, 'cache', 'visible-name.txt'), 'x'.repeat(32))
  const t = createTools({ stateDir: s.state, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath, projectRoot: s.root })

  // 直接走核心，避免依赖真实 ~/.rivet 的规则命中
  const { buildRun } = await import('../core/run.mjs')
  const rule = { id: 'p.c', match: { kind: 'prefix', path: '{{cache}}' }, grade: 'green', reason: '缓存', executor: { type: 'stage' } }
  const redacted = await buildRun({ rules: [rule], vars: { cache: join(s.data, 'cache') }, collectUnmatched: false })
  assert.deepEqual(redacted.items[0].samples, [])
  assert.equal(redacted.items[0].samplesRedacted, true)

  const shown = await buildRun({ rules: [rule], vars: { cache: join(s.data, 'cache'), includeSamples: true }, collectUnmatched: false })
  assert.deepEqual(shown.items[0].samples, ['visible-name.txt'])

  // 工具层：schema 里必须有这个入口
  const scan = t.find((x) => x.name === 'disk_scan')
  assert.ok(scan.inputSchema.properties.includeSamples, 'disk_scan 必须暴露 includeSamples 开关')
})

test('keepDir 现场的 recoverBatch：能凭 file-intent 补记账，并随后 undo 还原', async () => {
  const s = sandbox()
  const batchId = 'b-keepdir-crash'
  const src = join(s.root, 'cache')
  const dest = join(s.quarantine, batchId, 'cache')
  mkdirSync(src, { recursive: true })           // keepDir 保留了源目录（空的）
  mkdirSync(join(dest, 'sub'), { recursive: true })
  writeFileSync(join(dest, 'a.txt'), 'aaa')
  writeFileSync(join(dest, 'sub', 'b.txt'), 'bbb')
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(src, 'a.txt'), to: join(dest, 'a.txt'), undoSupported: true })
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1', from: join(src, 'sub', 'b.txt'), to: join(dest, 'sub', 'b.txt'), undoSupported: true })

  const r = await recoverBatch({ ledgerPath: s.ledgerPath, batchId })
  assert.equal(r.fileCompleted, 2, `应补记 2 个文件，实际 ${JSON.stringify(r)}`)
  assert.equal(readLedger(s.ledgerPath).filter((x) => x.action === 'file-stage' && x.batchId === batchId).length, 2)

  const u = await undo({ batchId, ledgerPath: s.ledgerPath })
  assert.equal(u.restored, 2, `应还原 2 个文件，实际 ${JSON.stringify(u)}`)
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'aaa')
  assert.equal(readFileSync(join(src, 'sub', 'b.txt'), 'utf8'), 'bbb')
})

test('disk_status 容量超限时显示超限告警（阈值可注入）', async () => {
  const s = sandbox()
  const to = join(s.quarantine, 'b-big', 'x')
  mkdirSync(to, { recursive: true })
  writeFileSync(join(to, 'a.txt'), 'x'.repeat(200))
  appendLedger(s.ledgerPath, { ts: Date.now(), batchId: 'b-big', action: 'stage', itemId: 'x#1', from: '/orig', to, bytes: 200, undoSupported: true })

  const t = createTools({
    stateDir: s.state,
    quarantineRoot: s.quarantine,
    ledgerPath: s.ledgerPath,
    quarantinePolicyOptions: { maxBytes: 100 },
  })
  const out = String((await t.find((x) => x.name === 'disk_status').execute({})).content)
  assert.match(out, /超限 200 B > 100 B/, `应报告容量超限，实际输出：\n${out}`)
})

test('disk_scan 工具层真正把 includeSamples 传到 buildRun（默认脱敏 / 开启后落盘含文件名）', async () => {
  const s = sandbox()
  const cacheDir = join(s.root, '.rivet', 'cache')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'visible-name.txt'), 'x'.repeat(32))

  const t = createTools({ stateDir: s.state, quarantineRoot: s.quarantine, ledgerPath: s.ledgerPath, projectRoot: s.root })
  const scan = t.find((x) => x.name === 'disk_scan')
  const loadItem = (content) => {
    const runId = /run_id=([\w-]+)/.exec(content)[1]
    const run = JSON.parse(readFileSync(join(s.state, `${runId}.json`), 'utf8'))
    const item = run.items.find((i) => i.path.startsWith(s.root) && i.path.endsWith('.rivet/cache'))
    assert.ok(item, `应命中 {{projectRivetHome}}/cache，实际 items：${run.items.map((i) => i.path).join('、')}`)
    return item
  }

  // 默认：脱敏（W44 起 domain 必须显式给，不再有静默默认值）
  const redacted = loadItem(String((await scan.execute({ args: { domain: 'tianshu' } })).content))
  assert.deepEqual(redacted.samples, [], '默认不得记录真实文件名')
  assert.equal(redacted.samplesRedacted, true)

  // 显式开启：落盘的 run 里带文件名
  const shown = loadItem(String((await scan.execute({ args: { domain: 'tianshu', includeSamples: true } })).content))
  assert.deepEqual(shown.samples, ['visible-name.txt'])
  assert.equal(shown.samplesRedacted, false)
})
