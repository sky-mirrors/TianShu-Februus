// W61：审核清单第三波
//  #8  工具面 purge 不校验台账目标是否落在隔离区内
//  #17 createPlan 不去重 itemIds（重复勾选产生半途失败的不可发现批次）
//  #27 发行构建遗漏 MIT 许可证
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const { createPlan } = await import('../core/plan.mjs')
const { purge } = await import('../core/executor.mjs')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w61-'))
  return { root, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

test('W61 ①：purge 拒绝台账里越出隔离区的目标（#8）', async () => {
  const sb = sandbox()
  const outside = join(sb.root, 'elsewhere', 'cache')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'a.txt'), 'AAA')
  writeFileSync(sb.ledgerPath, JSON.stringify({
    ts: 1, batchId: 'b-x', action: 'stage', itemId: 'x#1',
    from: join(sb.root, 'cache'), to: outside, bytes: 3,
  }) + '\n')
  const plan = {
    token: 'tk', issuer: 'human', confirmedBy: 'chat:批准',
    expiresAt: Date.now() + 60000, stagedBatches: new Set(['b-x']), items: [],
  }
  await assert.rejects(
    () => purge({ plan, batchId: 'b-x', token: 'tk', quarantineRoot: sb.quarantine, ledgerPath: sb.ledgerPath }),
    (e) => e.code === 'EXEC_BATCH_PATH_ESCAPE',
    '目标不在隔离区内时必须拒绝删除',
  )
  assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'AAA', '不得删掉范围外的文件')
})

test('W61 ②：重复 itemIds 在计划层就被拒绝（#17）', () => {
  const item = { id: 'x#1', grade: 'green', blocked: null, executor: 'stage' }
  const run = { runId: 'r-w61', items: [item], unmatched: [], totals: {} }
  assert.throws(
    () => createPlan({ run, itemIds: ['x#1', 'x#1'] }),
    /PLAN_REFUSED_DUPLICATE/,
    '重复勾选不该进入执行器',
  )
  assert.equal(createPlan({ run, itemIds: ['x#1'] }).items.length, 1, '正常单次勾选不受影响')
})

test('W61 ③：发行目录必须包含与仓库根逐字节一致的 LICENSE（#27）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, '..', 'scripts', 'pack-release.mjs')
  const dist = join(here, '..', 'dist')
  const rootLicense = join(here, '..', '..', 'LICENSE')
  execFileSync(process.execPath, [script], { stdio: 'pipe' })
  assert.ok(existsSync(join(dist, 'LICENSE')), 'dist/LICENSE 应存在')
  assert.deepEqual(readFileSync(join(dist, 'LICENSE')), readFileSync(rootLicense), '许可证正文必须逐字节一致')
})
