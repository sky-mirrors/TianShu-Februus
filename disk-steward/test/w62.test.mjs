// W62：审核清单第四波
//  #6  tasklist 查询失败被当成「没有进程运行」（与文件顶部 fail-closed 注释相反）
//  #16 undo 用 itemId 判覆盖，会漏掉同目录下另一条尚无终态的 file-intent
//  #38 状态 done 无任何写入点，读侧 7 处是永不成立的死分支
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { checkPrecondition, defaultPs } = await import('../core/precondition.mjs')
const { undo } = await import('../core/executor.mjs')
const { readLedger } = await import('../core/ledger.mjs')

test('W62 ①：进程列表查询失败必须 fail-closed（#6）', async () => {
  const failed = await checkPrecondition(
    { kind: 'processNotRunning', name: 'msedge' },
    { ps: { async list() { throw new Error('tasklist timeout') } } },
  )
  assert.equal(failed.ok, false, `查询失败应拒绝，实际 ${JSON.stringify(failed)}`)
  assert.equal(failed.code, 'PRECONDITION_UNKNOWN')

  const empty = await checkPrecondition(
    { kind: 'processNotRunning', name: 'msedge' },
    { ps: { async list() { return [] } } },
  )
  assert.equal(empty.ok, true, '查询成功且确实没目标进程时仍应放行')

  const names = await defaultPs.list()
  assert.ok(Array.isArray(names) && names.length > 0, `本机 tasklist 应可用，实际 ${names?.length}`)
})

test('W62 ②：同批 A 有终态、B 无终态，undo 必须恢复两个文件（#16）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w62-'))
  const src = join(root, 'cache')
  const dest = join(root, 'trash', 'b-1', 'cache')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'a.txt'), 'AAA')
  writeFileSync(join(dest, 'b.txt'), 'BBB')
  const ledgerPath = join(root, 'ledger.jsonl')
  const common = { ts: 1, batchId: 'b-1', itemId: 'x#1', undoSupported: true }
  writeFileSync(ledgerPath, [
    JSON.stringify({ ...common, action: 'file-intent', granularity: 'file', from: join(src, 'a.txt'), to: join(dest, 'a.txt') }),
    JSON.stringify({ ...common, action: 'file-stage', granularity: 'file', from: join(src, 'a.txt'), to: join(dest, 'a.txt') }),
    JSON.stringify({ ...common, action: 'file-intent', granularity: 'file', from: join(src, 'b.txt'), to: join(dest, 'b.txt') }),
  ].join('\n') + '\n')

  const r = await undo({ batchId: 'b-1', ledgerPath })
  assert.equal(r.restored, 2, `应恢复 2 个文件，实际 ${JSON.stringify(r)}`)
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'AAA')
  assert.equal(readFileSync(join(src, 'b.txt'), 'utf8'), 'BBB')
})

test('W62 ③：每个被当终态读的 action 都应有写入点（#38）', () => {
  const src = readFileSync(join(process.cwd(), 'core', 'executor.mjs'), 'utf8')
  const written = new Set([...src.matchAll(/action:\s*'([a-z-]+)'/g)].map((m) => m[1]))
  const read = new Set([...src.matchAll(/action\s*===\s*'([a-z-]+)'/g)].map((m) => m[1]))
  for (const action of read) {
    assert.ok(written.has(action), `读侧把 '${action}' 当有效状态，但全文件没有写入点`)
  }
  // readLedger 里的 corrupt 是合法写入（降级行），不算死分支
  assert.equal(readLedger(join(process.cwd(), 'no-such-file.jsonl')).length, 0, '前置：readLedger 对缺失文件返回空')
})
