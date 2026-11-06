// W35：域隔离与分桶穷尽。三个真实缺陷的回归：
// ① 系统域 run 继承了天枢域的 totals/unmatched —— 报告写 60.5 MB，实际条目合计 3.26 GiB；
// ② scanSystem 的 denied 被 merge 丢掉 —— 报告「禁区拦截 0」，扫描回执实际 3 条；
// ③ executor='compact' 的 WAL 被算进「可勾选」（plan.mjs 会拒收），而报告分桶不穷尽时
//    yellow + executor=null 的项（Edge 缓存 793 MiB）在报告里彻底消失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { mergeDomainRun } = await import('../tools/index.mjs')
const { buildRun, computeTotals } = await import('../core/run.mjs')
const { isStageable } = await import('../core/plan.mjs')
const { renderReport } = await import('../render/report.mjs')
const { fmtBytes } = await import('../core/probe.mjs')

const mkItem = (id, bytes, over = {}) => ({
  id,
  title: id,
  path: `X:/${id}`,
  bytes,
  grade: 'yellow',
  blocked: null,
  executor: null,
  ...over,
})

test('isStageable：compact / 被挡 / 保护项都不算可勾选', () => {
  assert.equal(isStageable({ grade: 'blue', blocked: null, executor: 'compact' }), false, 'WAL 只能 checkpoint，不进清理计划')
  assert.equal(isStageable({ grade: 'green', blocked: 'active', executor: 'stage' }), false, '被挡项不可勾选')
  assert.equal(isStageable({ grade: 'brown', blocked: null, executor: 'stage' }), false, '保护项不可勾选')
  assert.equal(isStageable({ grade: 'green', blocked: null, executor: 'stage' }), true)
  assert.equal(isStageable({ grade: 'yellow', blocked: null, executor: null }), false)
})

test('mergeDomainRun：系统域不继承天枢域的 totals / unmatched / 丢弃 denied', () => {
  const tsItem = mkItem('ts.tmp#1', 13877458, { grade: 'green', executor: 'stage' })
  const run = {
    runId: 'r-ts',
    domain: 'tianshu',
    items: [tsItem],
    unmatched: Array.from({ length: 36 }, (_, i) => ({ path: `C:/Users/x/.rivet/stray-${i % 18}` })),
    denied: [],
    totals: { items: 21, bytes: 63479804, selectable: 12, selectableBytes: 13297456, blocked: 1, protected: 44 },
  }
  const sysItems = [
    mkItem('sys.user-temp#1', 2668565433, { grade: 'green', blocked: 'active' }),
    mkItem('sys.edge-cache#3', 489829226),
    mkItem('sys.edge-code-cache#4', 340800837),
    mkItem('sys.edge-gpu-cache#5', 557424),
  ]
  const sys = {
    items: sysItems,
    unmatched: [],
    denied: [
      { path: 'C:/Windows', reason: 'WINDOWS_DIR' },
      { path: 'C:/Windows/Temp', reason: 'WINDOWS_DIR' },
      { path: 'C:/$Recycle.Bin', reason: 'RECYCLE_BIN' },
    ],
    totals: { items: 4, bytes: 3499752920 },
  }

  const m = mergeDomainRun({ run, sys, domain: 'system' })
  assert.deepEqual(m.items.map((i) => i.id), sysItems.map((i) => i.id), '系统域只能看到系统域条目')
  assert.equal(m.unmatched.length, 0, '系统域不得列出天枢目录的未收录路径')
  assert.equal(m.denied.length, 3, '禁区拦截数必须搬进落盘的 run')
  assert.equal(m.totals.items, 4)
  assert.equal(m.totals.bytes, 3499752920, '体积必须按本域条目重算，不能沿用天枢的 60.5 MB')
  assert.equal(m.totals.selectable, 0, '系统域可勾选恒为 0（executor 恒 null）')
  assert.equal(m.totals.protected, 0, '系统域没有 brown 项时受保护必须是 0，不能拿条目总数顶替')
})

test('mergeDomainRun：both 域合并条目与未收录，禁区拦截取系统域', () => {
  const ts = { runId: 'r-b', domain: 'tianshu', items: [mkItem('ts.tmp#1', 10, { grade: 'green', executor: 'stage' })], unmatched: [{ path: 'C:/Users/x/.rivet/stray' }], denied: [], totals: {} }
  const sys = { items: [mkItem('sys.user-temp#1', 20)], unmatched: [], denied: [{ path: 'C:/Windows', reason: 'WINDOWS_DIR' }], totals: {} }
  const m = mergeDomainRun({ run: ts, sys, domain: 'both' })
  assert.equal(m.items.length, 2)
  assert.equal(m.unmatched.length, 1)
  assert.equal(m.denied.length, 1)
  assert.equal(m.totals.items, 2)
  assert.equal(m.totals.bytes, 30)
  assert.equal(m.totals.selectable, 1, 'both 域里只有天枢那条 stage 项可勾选')
})

test('computeTotals：可勾选按 isStageable 判定（compact 不计入）', () => {
  const items = [
    mkItem('a', 100, { grade: 'green', executor: 'stage' }),
    mkItem('b', 200, { grade: 'blue', executor: 'compact' }),
    mkItem('c', 300, { grade: 'brown', executor: null }),
    mkItem('d', 400, { grade: 'green', executor: 'stage', blocked: 'active' }),
  ]
  const t = computeTotals(items, [{ path: 'X:/stray' }])
  assert.equal(t.items, 4)
  assert.equal(t.bytes, 1000)
  assert.equal(t.selectable, 1, '只有 a 可勾选：b 是 compact、c 是保护、d 被挡')
  assert.equal(t.selectableBytes, 100)
  assert.equal(t.blocked, 1)
  assert.equal(t.protected, 2, 'brown 1 项 + 未收录 1 条')
})

test('findUnmatched：两个根指向同一目录时不得重复列示', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w35-'))
  writeFileSync(join(root, 'stray.txt'), 'x')
  const run = await buildRun({ rules: [], vars: { unmatchedRoots: [root, root] }, collectUnmatched: true })
  assert.equal(run.unmatched.length, 1, `同一目录写了两遍不应列两条：${JSON.stringify(run.unmatched.map((u) => u.path))}`)
})

test('renderReport：分桶穷尽——不可执行项必须可见，compact 不得进可勾选区', () => {
  const items = [
    { id: 'ts.tmp#1', title: '临时文件', path: 'C:/t/tmp', bytes: 13877458, grade: 'green', blocked: null, executor: 'stage', explain: { what: '是什么', why: '为什么', rebuild: '重建', undo: '可撤销' } },
    { id: 'ts.memory-wal#2', title: 'WAL', path: 'C:/t/meridian.db-wal', bytes: 5504352, grade: 'blue', blocked: null, executor: 'compact', explain: { what: 'WAL', why: '只能 checkpoint', rebuild: '自动', undo: '不删除数据，仅压实' } },
    { id: 'sys.edge-cache#3', title: 'Edge 缓存', path: 'C:/e/Cache', bytes: 489829226, grade: 'yellow', blocked: null, executor: null, explain: { what: '缓存', why: '可重建', rebuild: '自动', undo: '系统域只读' } },
    { id: 'ts.memory-db#4', title: '主库', path: 'C:/t/meridian.db', bytes: 48087040, grade: 'brown', blocked: null, executor: null, explain: { what: '主库', why: '删除等于失忆' } },
  ]
  const staleBytes = 63479804
  const run = { runId: 'r-w35', createdAt: 1793807474110, domain: 'system', items, unmatched: [], denied: [], totals: { items: 21, bytes: staleBytes } }
  const md = renderReport(run)

  for (const i of items) assert.ok(md.includes(i.title), `条目 ${i.id} 在报告里消失了`)
  assert.ok(!md.includes(fmtBytes(staleBytes)), '汇总体积不得沿用 run.totals 里的过期数字')
  assert.ok(md.includes(fmtBytes(items.reduce((s, i) => s + i.bytes, 0))), '汇总体积应等于条目之和')

  const selectableSection = md.split('\n## 可勾选')[1].split('\n## ')[0]
  assert.ok(selectableSection.includes('临时文件'), '可 stage 的项应进可勾选区')
  assert.ok(!selectableSection.includes('WAL'), 'compact 的 WAL 不得出现在可勾选区')
  assert.ok(!selectableSection.includes('Edge 缓存'), '无执行器的项不得出现在可勾选区')
  assert.ok(md.includes('可见但不可执行'), '不可执行项需要一个可见分区，否则就是静默消失')
})
