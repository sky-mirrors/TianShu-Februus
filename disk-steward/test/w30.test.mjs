// W30：每个 item 必须有可读标题——文本面板/报告不得出现 "undefined"
// 回归自真机：`node bin/scan.mjs` 的"被保护"行曾输出 "undefined 70.5 KB"（expand=refs 分支漏了 title）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRun } = await import('../core/run.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w30-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, 'aaaa-1111'), { recursive: true })
  mkdirSync(join(art, 'bbbb-2222'), { recursive: true })
  writeFileSync(join(art, 'aaaa-1111', 'x.png'), 'x'.repeat(100))
  writeFileSync(join(art, 'bbbb-2222', 'y.png'), 'y'.repeat(200))
  const sess = join(root, 'sessions')
  mkdirSync(sess, { recursive: true })
  writeFileSync(join(sess, 's1.md'), '见 aaaa-1111 这一节点')
  const cache = join(root, 'cache')
  mkdirSync(join(cache, 'keepdb'), { recursive: true })
  writeFileSync(join(cache, 'keepdb', 'db.bin'), 'x'.repeat(32))
  return { root, art, sess, cache }
}

const assertTitled = (item) => {
  assert.equal(typeof item.title, 'string', `${item.id} 的 title 必须是字符串，实际 ${typeof item.title}`)
  assert.ok(item.title.trim().length > 0, `${item.id} 的 title 不得为空`)
  assert.ok(!item.title.includes('undefined'), `${item.id} 的 title 泄漏 undefined：${item.title}`)
}

test('expand=refs 展开出的每个节点项都有可读标题（含节点名）', async () => {
  const s = scene()
  const rule = {
    id: 'ts.artifacts-graph',
    title: '历史产物（按引用图判定）',
    match: { kind: 'prefix', path: '{{art}}' },
    expand: 'refs',
    grade: 'green',
    reason: '按引用图判定：无引用且过冷却期才可回收',
    executor: { type: 'stage' },
  }
  const run = await buildRun({
    rules: [rule],
    vars: { art: s.art, root: s.root },
    collectUnmatched: false,
    refIndexDeps: { artifactDir: s.art, corpusRoots: [s.root] },
  })
  assert.equal(run.items.length, 2, `应产出两个节点项，实际 ${run.items.map((i) => i.id).join(',')}`)
  for (const i of run.items) assertTitled(i)
  assert.match(run.items.find((i) => i.path.endsWith('aaaa-1111')).title, /aaaa-1111/, '标题应能区分具体节点')
})

test('exclude 降级为 brown 的项也有可读标题', async () => {
  const s = scene()
  const rule = {
    id: 't.excl',
    title: '缓存目录',
    match: { kind: 'prefix', path: '{{root}}/cache/keepdb' },
    exclude: ['**/keepdb'],
    grade: 'green',
    reason: '可清缓存',
    executor: { type: 'stage' },
  }
  const run = await buildRun({ rules: [rule], vars: { root: s.root }, collectUnmatched: false })
  assert.equal(run.items[0].grade, 'brown')
  assertTitled(run.items[0])
})
