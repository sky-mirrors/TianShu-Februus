// W13：系统域放开执行的前置——必须先看清楚、再问，得到 y 才能动。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { scanSystem } = await import('../domains/system.mjs')
const { renderConfirm } = await import('../render/confirm.mjs')
const { createSession, handleKey } = await import('../render/tui.mjs')

test('默认仍然只读：executor 恒为 null', async () => {
  const run = await scanSystem({})
  for (const i of run.items) assert.equal(i.executor, null, `${i.title} 默认不该可执行`)
})

test('打开 execEnabled 后：规则为"非保护 且 未被挡"才可执行', async () => {
  const run = await scanSystem({ execEnabled: true })
  for (const i of run.items) {
    const shouldExec = i.grade !== 'brown' && !i.blocked
    assert.equal(i.executor, shouldExec ? 'stage' : null, `${i.title} 执行资格不符（blocked=${i.blocked}）`)
  }
  // 本机当前 Edge 在跑、TEMP 刚被写过 → 全部 blocked，这正是 preconditions 在起作用
  assert.ok(run.items.length > 0, '至少应有扫描项')
})

const mkItem = (over = {}) => ({
  id: over.id ?? 'x1', title: over.title ?? 'Edge 缓存', path: over.path ?? 'C:/x/Cache',
  bytes: over.bytes ?? 1048576, grade: over.grade ?? 'yellow', blocked: over.blocked ?? null,
  executor: over.executor ?? 'stage',
  explain: { what: '浏览器 HTTP 缓存（图片与脚本副本）', why: '删后浏览时会自动重建', rebuild: '自动重建', sideEffect: null, undo: '移入隔离区可撤销' },
  ...over,
})

test('确认页必须写清：是什么、为什么、容量、路径、以及明确问句', () => {
  const items = [mkItem({ id: 'a', path: 'C:/x/Cache' }), mkItem({ id: 'b', path: 'C:/x/Code Cache', title: 'Edge 代码缓存', bytes: 2097152 })]
  const c = renderConfirm({ runId: 'r' }, items)
  const text = c.lines.join('\n')
  for (const i of items) {
    assert.ok(text.includes(i.path), `缺路径 ${i.path}`)
    assert.ok(text.includes(i.title), `缺标题 ${i.title}`)
    assert.ok(text.includes(i.explain.what), `缺"是什么" ${i.title}`)
    assert.ok(text.includes(i.explain.why), `缺"为什么" ${i.title}`)
  }
  assert.match(text, /MB|GB|KB|B/, '必须显示容量')
  assert.match(c.question, /\[y\/N\]/, `必须有明确的 y/N 询问：${c.question}`)
  assert.ok(!text.includes('undefined') && !text.includes('null'), '不得泄漏 undefined/null')
})

test('确认页给出合计容量与项数', () => {
  const items = [mkItem({ id: 'a' }), mkItem({ id: 'b', bytes: 2097152 })]
  const c = renderConfirm({ runId: 'r' }, items)
  assert.match(c.summary, new RegExp(`${items.length} 项`), `合计应含项数：${c.summary}`)
})

test('没有可删项时不给确认问句（不能空确认）', () => {
  const c = renderConfirm({ runId: 'r' }, [])
  assert.equal(c.question, null)
  assert.match(c.lines.join('\n'), /没有可删除|无可删除/)
})

test('TUI：x 只进入确认态，y 才产生 stage，n 取消', () => {
  const run = { runId: 'r', items: [{ id: 'a', title: 't', path: '/x/a', bytes: 10, grade: 'green', blocked: null, executor: 'stage', explain: { what: 'w', why: 'y', undo: 'u' } }], unmatched: [], totals: {} }
  let s = createSession(run)
  s = handleKey(s, ' ').state
  const afterX = handleKey(s, 'x')
  assert.equal(afterX.action.type, 'confirm', 'x 不该直接执行')
  assert.equal(afterX.state.confirmPending, true)

  const cancelled = handleKey(afterX.state, 'n')
  assert.equal(cancelled.action.type, 'cancel')
  assert.equal(cancelled.state.confirmPending, false)

  const confirmed = handleKey(afterX.state, 'y')
  assert.equal(confirmed.action.type, 'stage')
  assert.deepEqual(confirmed.action.itemIds, ['a'])
  assert.equal(confirmed.state.confirmPending, false)
})

test('被前置条件挡住的项，显示原因不能冒充"10 分钟内有写入"', async () => {
  const { renderFrame } = await import('../render/tui.mjs')
  const run = {
    runId: 'r', unmatched: [], totals: {},
    items: [
      mkItem({ id: 'a', blocked: 'precondition', blockedReason: 'PRECONDITION_FAILED: 进程 msedge 正在运行', executor: null }),
      mkItem({ id: 'b', blocked: 'active', blockedReason: '10 分钟内有写入', executor: null }),
    ],
  }
  const s = createSession(run)
  const text = renderFrame(s).join('\n')
  assert.match(text, /前置条件未满足/, 'precondition 要有自己的说明')
  assert.match(text, /10 分钟内有写入/, 'active 保留原说明')
})
