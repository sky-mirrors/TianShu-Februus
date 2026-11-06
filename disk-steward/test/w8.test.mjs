// W8：两件事一起做——serviceStopped 前置条件 + 两次扫描的增量对比。都只读。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { checkPrecondition, defaultServices } = await import('../core/precondition.mjs')
const { diffRuns } = await import('../core/diff.mjs')
const { renderDiff } = await import('../render/report.mjs')

const svc = (state) => ({ state: async () => state })

test('serviceStopped：服务在跑 → 不通过，并说清是哪个服务', async () => {
  const r = await checkPrecondition({ kind: 'serviceStopped', name: 'wuauserv' }, { services: svc('running') })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PRECONDITION_FAILED')
  assert.match(r.reason, /wuauserv/)
})

test('serviceStopped：服务已停 → 通过', async () => {
  const r = await checkPrecondition({ kind: 'serviceStopped', name: 'wuauserv' }, { services: svc('stopped') })
  assert.equal(r.ok, true)
})

test('serviceStopped：查不到状态一律不通过（fail-closed，不猜）', async () => {
  const r = await checkPrecondition({ kind: 'serviceStopped', name: 'nope' }, { services: svc('unknown') })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PRECONDITION_UNKNOWN')
})

test('真实后端能给出三态之一（不崩、不猜）', async () => {
  const s = await defaultServices.state('wuauserv')
  assert.ok(['running', 'stopped', 'unknown'].includes(s), `返回值应属三态，实际 ${s}`)
})

const runOf = (items) => ({ runId: 'r', items, unmatched: [], totals: {} })
const it = (path, bytes, extra = {}) => ({ id: path, path, bytes, title: path, grade: 'green', blocked: null, executor: 'stage', ...extra })

test('diffRuns：按路径识别新增/消失/变大/变小', () => {
  const prev = runOf([it('/a', 100), it('/b', 200), it('/c', 300)])
  const next = runOf([it('/a', 150), it('/b', 200), it('/d', 400)])
  const d = diffRuns(prev, next)
  assert.deepEqual(d.added.map((i) => i.path), ['/d'])
  assert.deepEqual(d.removed.map((i) => i.path), ['/c'])
  assert.deepEqual(d.grew.map((i) => i.path), ['/a'])
  assert.equal(d.grew[0].delta, 50)
  assert.equal(d.shrank.length, 0)
  assert.equal(d.unchanged, 1)
})

test('diffRuns：同一份 run 对比自己 → 全空，且不产生负增量', () => {
  const r = runOf([it('/a', 100), it('/b', 50)])
  const d = diffRuns(r, r)
  assert.deepEqual(d.added, [])
  assert.deepEqual(d.removed, [])
  assert.deepEqual(d.grew, [])
  assert.deepEqual(d.shrank, [])
  assert.equal(d.unchanged, 2)
  assert.equal(d.totalDelta, 0)
})

test('diffRuns：总量变化 = next − prev（与分项一致）', () => {
  const prev = runOf([it('/a', 100), it('/c', 300)])
  const next = runOf([it('/a', 400), it('/d', 100)])
  const d = diffRuns(prev, next)
  assert.equal(d.totalDelta, 500 - 400)
  const sum = d.added.reduce((s, i) => s + i.bytes, 0) + d.grew.reduce((s, i) => s + i.delta, 0)
    - d.removed.reduce((s, i) => s + i.bytes, 0) - d.shrank.reduce((s, i) => s + Math.abs(i.delta), 0)
  assert.equal(sum, d.totalDelta, '分项之和必须等于总量差')
})

test('renderDiff：给出人可读增量，且不泄漏 undefined/null', () => {
  const prev = runOf([it('/a', 100), it('/c', 300)])
  const next = runOf([it('/a', 400), it('/d', 100)])
  const md = renderDiff(diffRuns(prev, next), { prevRunId: 'r1', nextRunId: 'r2' })
  assert.ok(md.includes('/d'))
  assert.ok(md.includes('/c'))
  assert.ok(md.includes('/a'))
  assert.ok(!md.includes('undefined'))
  assert.ok(!md.includes('null'))
})
