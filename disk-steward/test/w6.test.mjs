// W6：precondition（机器可检查的执行前置）。设计里写了但一直没实现的那个字段。
// 它拦住的是"顺序错了就出事"的场景：程序还开着就去清它的缓存。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { checkPrecondition } = await import('../core/precondition.mjs')
const { buildRun } = await import('../core/run.mjs')
const { createPlan, PLAN_ERRORS } = await import('../core/plan.mjs')

test('processNotRunning：进程在跑 → 不通过', async () => {
  const ps = { list: async () => ['chrome.exe', 'node.exe'] }
  const r = await checkPrecondition({ kind: 'processNotRunning', name: 'chrome' }, { ps })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PRECONDITION_FAILED')
  assert.match(r.reason, /chrome/)
})

test('processNotRunning：进程不在 → 通过（大小写/后缀无关）', async () => {
  const ps = { list: async () => ['node.exe'] }
  const r = await checkPrecondition({ kind: 'processNotRunning', name: 'Chrome.EXE' }, { ps })
  assert.equal(r.ok, true)
})

test('fileExists：缺文件 → 不通过；存在 → 通过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w6-'))
  const missing = await checkPrecondition({ kind: 'fileExists', path: join(root, 'nope') })
  assert.equal(missing.ok, false)

  const f = join(root, 'marker')
  writeFileSync(f, '1')
  const ok = await checkPrecondition({ kind: 'fileExists', path: f })
  assert.equal(ok.ok, true)
})

test('未知 precondition 一律不通过（fail-closed，不猜）', async () => {
  const r = await checkPrecondition({ kind: 'somethingNew' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PRECONDITION_UNKNOWN')
})

test('buildRun：precondition 不满足 → item 标记 precondition 且计划层拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w6b-'))
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'a.txt'), 'x'.repeat(64))

  const rules = [{
    id: 'test.guarded',
    title: '受前置条件保护的缓存',
    match: { kind: 'prefix', path: '{{root}}/cache' },
    grade: 'green',
    reason: '仅当关闭相关程序后才可清理',
    precondition: { kind: 'processNotRunning', name: 'chrome' },
    mtimeGuard: false,
    executor: { type: 'stage' },
  }]
  const run = await buildRun({
    rules,
    vars: { root },
    now: Date.now(),
    preconditionDeps: { ps: { list: async () => ['chrome.exe'] } },
    collectUnmatched: false,
  })
  assert.equal(run.items.length, 1)
  assert.equal(run.items[0].blocked, 'precondition')
  assert.match(run.items[0].blockedReason ?? '', /chrome/)
  assert.equal(run.totals.selectable, 0)
  assert.throws(
    () => createPlan({ run, itemIds: [run.items[0].id], issuer: 'human', confirmedBy: 'test' }),
    (e) => e.code === PLAN_ERRORS.REFUSED_BLOCKED,
  )
})

test('buildRun：precondition 满足时不阻塞', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w6c-'))
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'a.txt'), 'x'.repeat(64))
  const rules = [{
    id: 'test.guarded2',
    match: { kind: 'prefix', path: '{{root}}/cache' },
    grade: 'green',
    reason: 'ok',
    precondition: { kind: 'processNotRunning', name: 'chrome' },
    mtimeGuard: false,
    executor: { type: 'stage' },
  }]
  const run = await buildRun({
    rules,
    vars: { root },
    now: Date.now(),
    preconditionDeps: { ps: { list: async () => [] } },
    collectUnmatched: false,
  })
  assert.equal(run.items[0].blocked, null)
  assert.equal(run.totals.selectable, 1)
})
