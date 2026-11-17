// W52：崩溃恢复必须有入口——recoverBatch 曾有实现、无接线。
// 契约：工具面提供 disk_recover；它只补记账、不动磁盘；不需要人工批准（因为不删不移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')
const { readLedger, appendLedger } = await import('../core/ledger.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w52-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  return { root, state, quarantine: join(root, 'trash'), ledgerPath: join(state, 'ledger.jsonl') }
}

const tool = (tools, name) => tools.find((t) => t.name === name)

test('W52：工具面必须有 disk_recover 入口（崩溃恢复不能只有实现）', async () => {
  const sb = sandbox()
  const tools = createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })
  const t = tool(tools, 'disk_recover')
  assert.ok(t, `工具面缺少 disk_recover，现有：${tools.map((x) => x.name).join(',')}`)
  assert.equal(tools.length, 9, `工具数应为 9，实际 ${tools.length}`)
  assert.equal(t.inputSchema.required.includes('batchId'), false, 'batchId 应为可选：不给则列出所有未决批次')
})

test('W52：对「文件已移动、终态行未落」的批次判为已完成并补记 stage（不动磁盘）', async () => {
  const sb = sandbox()
  const src = join(sb.root, 'cache')
  const batchId = 'b-crash'
  mkdirSync(join(sb.quarantine, batchId, 'cache'), { recursive: true })
  writeFileSync(join(sb.quarantine, batchId, 'cache', 'a.txt'), 'aaa')
  // 崩溃现场：源已不在，台账只有 intent
  appendLedger(sb.ledgerPath, {
    ts: Date.now(), batchId, action: 'intent', itemId: 'x#1',
    from: src, to: join(sb.quarantine, batchId, 'cache'), bytes: 3, undoSupported: true,
  })

  const tools = createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })
  const r = await tool(tools, 'disk_recover').execute({ args: { batchId } })
  assert.equal(r.isError, undefined, `不应报错：${r.content}`)

  const rows = readLedger(sb.ledgerPath).filter((x) => x.batchId === batchId)
  assert.ok(rows.some((x) => x.action === 'stage' && x.recovered === true), `应补记 stage(recovered)，实际 ${rows.map((x) => x.action).join(',')}`)
  // 不动磁盘：隔离区文件仍在原处，源目录没被重建
  assert.equal(existsSync(join(sb.quarantine, batchId, 'cache', 'a.txt')), true, '不得移动隔离区文件')
  assert.equal(existsSync(src), false, '不得凭空重建源目录')
})

test('W52：正常批次无所事事——重复调用不重复记账（幂等）', async () => {
  const sb = sandbox()
  const src = join(sb.root, 'cache')
  const batchId = 'b-ok'
  mkdirSync(join(sb.quarantine, batchId, 'cache'), { recursive: true })
  appendLedger(sb.ledgerPath, {
    ts: Date.now(), batchId, action: 'intent', itemId: 'x#1',
    from: src, to: join(sb.quarantine, batchId, 'cache'), bytes: 3, undoSupported: true,
  })
  const tools = createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })

  const first = await tool(tools, 'disk_recover').execute({ args: { batchId } })
  assert.equal(first.isError, undefined, String(first.content))
  const stagesAfterFirst = readLedger(sb.ledgerPath).filter((x) => x.action === 'stage').length

  const second = await tool(tools, 'disk_recover').execute({ args: { batchId } })
  assert.equal(second.isError, undefined, String(second.content))
  const stagesAfterSecond = readLedger(sb.ledgerPath).filter((x) => x.action === 'stage').length

  assert.equal(stagesAfterSecond, stagesAfterFirst, '第二次不该再补记 stage（终态已存在即跳过）')
  assert.match(String(second.content), /0/, '第二次应报告 0 个待处理')
})

test('W52：不给 batchId 时列出全部未决批次，供人决定', async () => {
  const sb = sandbox()
  for (const id of ['b-a', 'b-b']) {
    mkdirSync(join(sb.quarantine, id, 'cache'), { recursive: true })
    appendLedger(sb.ledgerPath, {
      ts: Date.now(), batchId: id, action: 'intent', itemId: 'x#1',
      from: join(sb.root, 'cache'), to: join(sb.quarantine, id, 'cache'), bytes: 3, undoSupported: true,
    })
  }
  const tools = createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })
  const r = await tool(tools, 'disk_recover').execute({ args: {} })
  assert.equal(r.isError, undefined, String(r.content))
  assert.match(String(r.content), /b-a/, `应列出 b-a：${r.content}`)
  assert.match(String(r.content), /b-b/, `应列出 b-b：${r.content}`)
})

test('W52：file 粒度重复调用不重复记 file-abort（幂等）', async () => {
  const sb = sandbox()
  const batchId = 'b-file'
  const src = join(sb.root, 'cache', 'a.txt')
  mkdirSync(join(sb.root, 'cache'), { recursive: true })
  writeFileSync(src, 'aaa')
  // 只记了 file-intent、文件还在原地 → 应判为未移动
  appendLedger(sb.ledgerPath, {
    ts: Date.now(), batchId, action: 'file-intent', granularity: 'file', itemId: 'x#1',
    from: src, to: join(sb.quarantine, batchId, 'cache', 'a.txt'), undoSupported: true,
  })
  const tools = createTools({ stateDir: sb.state, ledgerPath: sb.ledgerPath, quarantineRoot: sb.quarantine })
  const rec = tool(tools, 'disk_recover')

  await rec.execute({ args: { batchId } })
  const first = readLedger(sb.ledgerPath).filter((x) => x.action === 'file-abort').length
  assert.equal(first, 1, `第一次应补记 1 条 file-abort，实际 ${first}`)

  await rec.execute({ args: { batchId } })
  const second = readLedger(sb.ledgerPath).filter((x) => x.action === 'file-abort').length
  assert.equal(second, 1, `第二次不该重复补记（幂等），实际 ${second}`)
})
