// W53：多进程并发写同一份台账——真实 spawn 子进程，不是同进程 Promise。
// 契约：append-only JSONL 必须在并发下保持「每行都是完整 JSON、行数等于写入次数」。
// 若这里红了，说明台账会损坏：purge/undo 靠 readLedger 全量解析，一条坏行就整批失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ledgerModule = join(here, '..', 'core', 'ledger.mjs').replace(/\\/g, '/')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w53-'))
  const worker = join(root, 'worker.mjs')
  writeFileSync(
    worker,
    `
const { appendLedger } = await import('file:///${ledgerModule}')
const [ledgerPath, tag, n, size] = process.argv.slice(2)
for (let i = 0; i < Number(n); i++) {
  appendLedger(ledgerPath, {
    ts: Date.now(), batchId: 'b-' + tag, action: 'stage', itemId: tag + '#' + i,
    from: 'C:/x', to: 'C:/y', pad: 'p'.repeat(Number(size)),
  })
}
`,
    'utf8',
  )
  return { root, worker, ledgerPath: join(root, 'ledger.jsonl') }
}

function runWorker(worker, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, err }))
  })
}

function audit(ledgerPath) {
  const raw = readFileSync(ledgerPath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  let bad = 0
  const badSamples = []
  for (const l of lines) {
    try { JSON.parse(l) } catch { bad += 1; if (badSamples.length < 2) badSamples.push(l.slice(0, 80)) }
  }
  return { lines: lines.length, bad, badSamples }
}

test('W53：8 个进程并发追加小行（每进程 400 次）——行数与 JSON 完整性', async () => {
  const s = scene()
  const N = 8
  const PER = 400
  const rs = await Promise.all(
    Array.from({ length: N }, (_, i) => runWorker(s.worker, [s.ledgerPath, `w${i}`, String(PER), '200'])),
  )
  for (const r of rs) assert.equal(r.code, 0, `子进程退出码 ${r.code}：${r.err.slice(0, 200)}`)
  assert.ok(existsSync(s.ledgerPath), '台账文件应存在')

  const a = audit(s.ledgerPath)
  assert.equal(a.lines, N * PER, `应有 ${N * PER} 行，实际 ${a.lines}（说明有写入丢失或交错）`)
  assert.equal(a.bad, 0, `有 ${a.bad} 行不是合法 JSON，样例：${a.badSamples.join(' | ')}`)
})

test('W53：8 个进程并发追加超 PIPE_BUF 的大行（每行 ~8KB）——不得交错', async () => {
  const s = scene()
  const N = 8
  const PER = 100
  const rs = await Promise.all(
    Array.from({ length: N }, (_, i) => runWorker(s.worker, [s.ledgerPath, `big${i}`, String(PER), '8000'])),
  )
  for (const r of rs) assert.equal(r.code, 0, `子进程退出码 ${r.code}：${r.err.slice(0, 200)}`)

  const a = audit(s.ledgerPath)
  assert.equal(a.lines, N * PER, `应有 ${N * PER} 行，实际 ${a.lines}`)
  assert.equal(a.bad, 0, `有 ${a.bad} 行不是合法 JSON（大行被并发撕开），样例：${a.badSamples.join(' | ')}`)
})
