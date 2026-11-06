// W3：勾选状态机（纯函数，可测）。可视化面板的"按键 → 选择集"必须与计划集合严格一致（T4）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createSession, handleKey, visibleItems, renderFrame } = await import('../render/tui.mjs')

const run = {
  runId: 'r-tui',
  items: [
    { id: 'a', title: '缓存', path: '/x/cache', bytes: 1000, grade: 'green', blocked: null, executor: 'stage', explain: { what: 'w', why: 'y', undo: 'u' } },
    { id: 'b', title: '备份', path: '/x/backups', bytes: 2000, grade: 'yellow', blocked: null, executor: 'stage', explain: { what: 'w', why: 'y', undo: 'u' } },
    { id: 'c', title: '主库', path: '/x/db', bytes: 5000, grade: 'brown', blocked: null, executor: null, explain: { what: 'w', why: 'y', undo: 'none' } },
    { id: 'd', title: '在写', path: '/x/hot', bytes: 300, grade: 'green', blocked: 'active', executor: 'stage', explain: { what: 'w', why: 'y', undo: 'u' } },
  ],
  unmatched: [],
  totals: { items: 4, bytes: 8300, selectable: 2, blocked: 1, protected: 1 },
}

test('空格切换勾选；保护项与已被挡项勾不上', () => {
  let s = createSession(run)
  s = handleKey(s, ' ').state // 光标在 a
  assert.deepEqual([...s.selected], ['a'])
  s = handleKey(s, ' ').state
  assert.deepEqual([...s.selected], [])

  // 移到 c（brown）后按空格无效
  s = handleKey(s, 'j').state
  s = handleKey(s, 'j').state
  assert.equal(visibleItems(s)[s.cursor].id, 'c')
  s = handleKey(s, ' ').state
  assert.deepEqual([...s.selected], [])
  assert.equal(s.refused, 'protected')
})

test('a 全选只勾可勾项（brown 与 blocked 排除）', () => {
  const s = handleKey(createSession(run), 'a').state
  assert.deepEqual([...s.selected].sort(), ['a', 'b'])
})

test('j/k 移动光标且不越界', () => {
  let s = createSession(run)
  s = handleKey(s, 'k').state
  assert.equal(s.cursor, 0, '顶部再上不越界')
  for (let i = 0; i < 10; i++) s = handleKey(s, 'j').state
  assert.equal(s.cursor, run.items.length - 1, '底部再下不越界')
})

test('f 循环过滤：全部 → 仅可勾 → 仅受保护 → 仅被挡 → 全部', () => {
  let s = createSession(run)
  assert.equal(s.filter, 'all')
  s = handleKey(s, 'f').state
  assert.equal(s.filter, 'selectable')
  assert.deepEqual(visibleItems(s).map((i) => i.id), ['a', 'b'])
  s = handleKey(s, 'f').state
  assert.equal(s.filter, 'protected')
  assert.deepEqual(visibleItems(s).map((i) => i.id), ['c'], '受保护（brown）单独一栏')
  s = handleKey(s, 'f').state
  assert.equal(s.filter, 'blocked')
  assert.deepEqual(visibleItems(s).map((i) => i.id), ['d'], '被挡住（在写）单独一栏')
  s = handleKey(s, 'f').state
  assert.equal(s.filter, 'all')
  assert.equal(visibleItems(s).length, 4)
})

test('p 返回 plan 动作，且计划集合 === 勾选集合（T4）', () => {
  let s = createSession(run)
  s = handleKey(s, ' ').state
  s = handleKey(s, 'j').state
  s = handleKey(s, ' ').state
  const { state, action } = handleKey(s, 'p')
  assert.equal(action.type, 'plan')
  assert.deepEqual([...state.selected].sort(), ['a', 'b'])
  assert.deepEqual(action.itemIds.sort(), [...state.selected].sort())
})

test('renderFrame 首行给出总量与可释放，且列出全量可见项', () => {
  const s = handleKey(createSession(run), 'a').state
  const lines = renderFrame(s)
  assert.match(lines[0], /共 4 项/)
  assert.match(lines[0], /已勾 2 项/)
  assert.match(lines[0], /2\.9 KB|2900/, '首行应给出将释放体积')
  assert.equal(lines.filter((l) => l.startsWith('  ')).length, 4)
})

test('compact（WAL 压实）不可勾选、也进不了清理计划', async () => {
  const { createPlan } = await import('../core/plan.mjs')
  const r2 = {
    runId: 'r2',
    items: [{ id: 'w', title: 'WAL', path: '/x/wal', bytes: 10, grade: 'blue', blocked: null, executor: 'compact', explain: { what: 'w', why: 'y', undo: 'u' } }],
    unmatched: [],
    totals: {},
  }
  let s = createSession(r2)
  s = handleKey(s, ' ').state
  assert.deepEqual([...s.selected], [], 'compact 项不该被勾上')
  assert.equal(s.refused, 'blocked')
  assert.throws(() => createPlan({ run: r2, itemIds: ['w'], issuer: 'human', confirmedBy: 'test' }), (e) => e.code === 'PLAN_REFUSED_NOT_STAGEABLE')
})
