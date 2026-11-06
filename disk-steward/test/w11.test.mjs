// W11：serviceStopped 增强——不只看"当前状态"，还要看启动类型与依赖链。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { checkPrecondition, defaultServices } = await import('../core/precondition.mjs')

const svc = (info) => ({ state: async () => info.state, info: async () => info })

test('自动启动的服务：即使已停，也要给出"可能被拉起"的警告', async () => {
  const r = await checkPrecondition(
    { kind: 'serviceStopped', name: 'wuauserv' },
    { services: svc({ state: 'stopped', startType: 'AUTO_START', dependents: [] }) },
  )
  assert.equal(r.ok, true, '已停 = 通过')
  assert.ok((r.warnings ?? []).some((w) => /自动启动/.test(w)), '应提示自动启动风险')
})

test('被禁用/手动启动的服务：通过且无警告', async () => {
  const r = await checkPrecondition(
    { kind: 'serviceStopped', name: 'x' },
    { services: svc({ state: 'stopped', startType: 'DEMAND_START', dependents: [] }) },
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings ?? [], [])
})

test('服务在跑且有从属服务：原因里要说清从属数量', async () => {
  const r = await checkPrecondition(
    { kind: 'serviceStopped', name: 'wuauserv' },
    { services: svc({ state: 'running', startType: 'AUTO_START', dependents: ['Wuauserv2', 'BITS'] }) },
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /2 个从属服务|从属/, `原因应提到从属服务：${r.reason}`)
})

test('info 查不到（unknown）仍然 fail-closed', async () => {
  const r = await checkPrecondition(
    { kind: 'serviceStopped', name: 'nope' },
    { services: svc({ state: 'unknown', startType: 'UNKNOWN', dependents: [] }) },
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'PRECONDITION_UNKNOWN')
})

test('真实后端 info 返回三字段，且启动类型属于已知集合', async () => {
  const info = await defaultServices.info('wuauserv')
  // 强化：sc.exe 能读到时，state 不允许长期是 unknown（这正是本轮漏掉的 bug 形态）
  assert.notEqual(info.state, 'unknown', '能读取的服务不允许返回 unknown')
  assert.ok(['AUTO_START', 'DEMAND_START', 'DISABLED', 'UNKNOWN'].includes(info.startType), `意外启动类型：${info.startType}`)
  assert.ok(Array.isArray(info.dependents))
})
