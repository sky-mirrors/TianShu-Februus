// W14：图驱动判定——引用图决定"能不能删"，规则只管兜底。
// 场景：产物节点被历史会话引用 17 次 vs 零引用，二者必须有不同处置。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRefIndex, classifyNode } = await import('../core/refindex.mjs')
const { buildRun } = await import('../core/run.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w14-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, 'aaaa-1111'), { recursive: true })
  mkdirSync(join(art, 'bbbb-2222'), { recursive: true })
  writeFileSync(join(art, 'aaaa-1111', 'x.png'), 'x'.repeat(100))
  writeFileSync(join(art, 'bbbb-2222', 'y.png'), 'y'.repeat(200))
  // 语料：只引用 aaaa，引用 3 次；bbbb 零引用
  const sess = join(root, 'sessions')
  mkdirSync(sess, { recursive: true })
  writeFileSync(join(sess, 's1.md'), '见 artifacts/aaaa-1111/x.png 与 aaaa-1111，再次 aaaa-1111')
  writeFileSync(join(sess, 's2.md'), '无关内容')
  return { root, art, sess }
}

test('buildRefIndex：统计每个节点的被引用次数，且不把 artifacts 自身算进语料', async () => {
  const s = scene()
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root] })
  const byName = Object.fromEntries(idx.nodes.map((n) => [n.name, n]))
  assert.equal(byName['aaaa-1111'].refs, 3, `应统计到 3 次引用，实际 ${byName['aaaa-1111'].refs}`)
  assert.equal(byName['bbbb-2222'].refs, 0)
  assert.ok(idx.corpusFiles >= 2, '语料文件数应至少包含两个会话文件')
})

test('classifyNode：有引用 → brown 保护；零引用但太新 → 冷却中；零引用且够老 → green', () => {
  const now = Date.now()
  const old = now - 90 * 24 * 3600 * 1000
  assert.equal(classifyNode({ refs: 3, latestMtime: old }, { now }).grade, 'brown')
  assert.equal(classifyNode({ refs: 0, latestMtime: now }, { now }).grade, 'yellow')
  const g = classifyNode({ refs: 0, latestMtime: old }, { now })
  assert.equal(g.grade, 'green')
  assert.match(g.reason, /引用/)
})

test('buildRun：expand=refs 的规则展开成按节点分级，有引用的节点不可执行', async () => {
  const s = scene()
  const old = Date.now() - 90 * 24 * 3600 * 1000
  // 目录的 latestMtime 取子项最大值，所以要把子文件一起回拨，否则永远是"刚变动过"
  for (const n of ['aaaa-1111', 'bbbb-2222']) {
    utimesSync(join(s.art, n, n === 'aaaa-1111' ? 'x.png' : 'y.png'), new Date(old), new Date(old))
    utimesSync(join(s.art, n), new Date(old), new Date(old))
  }

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
    now: Date.now(),
    collectUnmatched: false,
    refIndexDeps: { artifactDir: s.art, corpusRoots: [s.root] },
  })

  const a = run.items.find((i) => i.path.endsWith('aaaa-1111'))
  const b = run.items.find((i) => i.path.endsWith('bbbb-2222'))
  assert.ok(a && b, `应产出两个节点项，实际 ${run.items.map((i) => i.path).join(',')}`)
  assert.equal(a.grade, 'brown', '有引用的节点必须保护')
  assert.equal(a.executor, null, '有引用的节点不可执行')
  assert.equal(b.grade, 'green', '零引用且够老 → 可回收')
  assert.equal(b.executor, 'stage')
  assert.match(a.explain.what, /引用/, '解释里要写明被引用情况')
})
