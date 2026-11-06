// W22：把增量缓存的"过期"变成可执行性判断——引用结论过期就不许进执行计划。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRun } = await import('../core/run.mjs')
const { createPlan, PLAN_ERRORS } = await import('../core/plan.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w22-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, 'abcd-1234-ef56'), { recursive: true })
  writeFileSync(join(art, 'abcd-1234-ef56', 'x.bin'), 'x'.repeat(16))
  const corpus = join(root, 'sessions')
  mkdirSync(corpus, { recursive: true })
  writeFileSync(join(corpus, 'a.md'), '无关')
  return { root, art, corpus, cachePath: join(root, 'refcache.json') }
}

const rule = {
  id: 'ts.artifacts-graph',
  match: { kind: 'prefix', path: '{{art}}' },
  expand: 'refs',
  grade: 'green',
  reason: '按引用图判定',
  executor: { type: 'stage' },
}

test('展开出的节点项带引用来源与过期秒数', async () => {
  const s = scene()
  const deps = { artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath, ttlMs: 60000 }
  const run1 = await buildRun({ rules: [rule], vars: { art: s.art, root: s.root }, collectUnmatched: false, refIndexDeps: deps })
  assert.equal(run1.items[0].refsSource, 'fresh')
  assert.equal(run1.items[0].refsStaleSeconds, 0)

  const run2 = await buildRun({ rules: [rule], vars: { art: s.art, root: s.root }, collectUnmatched: false, refIndexDeps: deps })
  assert.ok(['fingerprint', 'ttl'].includes(run2.items[0].refsSource), `第二次应命中缓存，实际 ${run2.items[0].refsSource}`)
})

test('引用结论过期（staleSeconds > 0）→ 计划层拒绝', async () => {
  const run = {
    runId: 'r', items: [{
      id: 'a', path: '/x/a', bytes: 10, grade: 'green', blocked: null, executor: 'stage',
      refsSource: 'ttl', refsStaleSeconds: 42,
    }], unmatched: [], totals: {},
  }
  assert.throws(
    () => createPlan({ run, itemIds: ['a'], issuer: 'human', confirmedBy: 'test' }),
    (e) => e.code === PLAN_ERRORS.REFUSED_STALE_REFS,
  )
})

test('显式允许过期（allowStaleRefs）→ 可以进计划；新鲜结论默认放行', () => {
  const staleRun = {
    runId: 'r', items: [{ id: 'a', path: '/x/a', bytes: 10, grade: 'green', blocked: null, executor: 'stage', refsSource: 'ttl', refsStaleSeconds: 42 }], unmatched: [], totals: {},
  }
  const ok = createPlan({ run: staleRun, itemIds: ['a'], issuer: 'human', confirmedBy: 'test', allowStaleRefs: true })
  assert.equal(ok.items.length, 1)

  const freshRun = {
    runId: 'r2', items: [{ id: 'b', path: '/x/b', bytes: 10, grade: 'green', blocked: null, executor: 'stage', refsSource: 'fingerprint', refsStaleSeconds: 0 }], unmatched: [], totals: {},
  }
  const ok2 = createPlan({ run: freshRun, itemIds: ['b'], issuer: 'human', confirmedBy: 'test' })
  assert.equal(ok2.items.length, 1)
})
