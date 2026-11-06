// W31：报告渲染端到端——run 里字段缺失/为 null 时，报告一律显示 '—'，绝不泄漏 undefined/null。
// 场景来源：`expand=refs` 分支曾漏 title，面板打出 "undefined 70.5 KB"；报告侧靠 dash() 兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { renderReport, renderDiff } = await import('../render/report.mjs')

test('renderReport：真实 run 注入缺失字段后，报告不出现 undefined / null', () => {
  const run = {
    runId: 'r-e2e',
    createdAt: 1793807474110,
    domain: 'tianshu',
    items: [
      // ① 只给 id 与体积：title/path/grade/explain 全缺（refs 分支漏字段时的形态）
      { id: 'a#1', bytes: 100 },
      // ② 显式 null / undefined / 空串混入
      {
        id: 'a#2',
        title: null,
        path: undefined,
        grade: 'brown',
        bytes: 5,
        explain: { what: undefined, why: null, rebuild: '', sideEffect: undefined, undo: null },
      },
      // ③ 正常项（对照组：确认渲染没有把正常内容也抹成 —）
      { id: 'a#3', title: '正常项', path: 'D:/x', grade: 'green', executor: 'stage', bytes: 3, explain: { what: '是什么', why: '为什么', rebuild: '重建方式' } },
      // ④ 被挡但缺 blockedReason
      { id: 'a#4', title: '被挡项', path: 'D:/b', grade: 'yellow', executor: null, blocked: 'active', bytes: 1 },
    ],
    unmatched: [{ path: undefined }, { path: null }],
    denied: [{ path: undefined, reason: undefined }],
    totals: {},
  }

  const md = renderReport(run)
  assert.ok(!md.includes('undefined'), `报告泄漏 undefined：\n${md}`)
  assert.ok(!md.includes('null'), `报告泄漏 null：\n${md}`)
  assert.ok(md.includes('—'), '缺字段应显示 —')
  assert.ok(md.includes('正常项'), '正常项必须原样出现，不被兜底抹掉')
  assert.ok(md.includes('是什么'), '正常 explain 必须原样出现')
})

test('renderDiff：对比报告的缺失字段同样显示 —', () => {
  const d = {
    added: [{ path: undefined, bytes: undefined }],
    removed: [],
    grew: [{ path: null, before: undefined, after: 10, delta: 10 }],
    shrank: [],
    unchanged: 0,
    totalPrev: undefined,
    totalNext: 10,
    totalDelta: 10,
  }
  const md = renderDiff(d, {})
  assert.ok(!md.includes('undefined'), `对比报告泄漏 undefined：\n${md}`)
  assert.ok(!md.includes('null'), `对比报告泄漏 null：\n${md}`)
})
