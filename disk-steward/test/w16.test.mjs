// W16：三处安全加固——① DB 行截断要记为不完整 ② DB 不再被语料通道重复统计 ③ 名字不具判别力时不许下结论
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const { buildRefIndex, classifyNode, isDiscriminativeName } = await import('../core/refindex.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w16-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, '157a5bbe-b631-431c-833f-2b710c1e4a45'), { recursive: true })
  writeFileSync(join(art, '157a5bbe-b631-431c-833f-2b710c1e4a45', 'p.png'), 'x'.repeat(32))
  return { root, art }
}

test('① DB 某表行数达到上限 → 记为 incomplete（不静默截断）', async () => {
  const s = scene()
  const dbPath = join(s.root, 'idx.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)')
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO big (body) VALUES (?)').run(`row ${i}`)
  db.close()

  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath, rowCap: 3 })
  const trunc = idx.incomplete.filter((x) => String(x.reason).includes('上限') || String(x.reason).includes('截断'))
  assert.ok(trunc.length >= 1, `应有截断记录，实际 ${JSON.stringify(idx.incomplete)}`)
  assert.equal(idx.nodes[0].refScanIncomplete, true)
})

test('② DB 文件不再被语料通道当作"超限文件"重复统计', async () => {
  const s = scene()
  const dbPath = join(s.root, 'idx.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE t (body TEXT)')
  db.prepare('INSERT INTO t (body) VALUES (?)').run('157a5bbe-b631-431c-833f-2b710c1e4a45')
  db.close()

  // 单文件上限设得很小，若仍走语料通道就会被判超限
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath, maxFileBytes: 64 })
  const oversize = idx.incomplete.filter((x) => String(x.reason).includes('超限') && String(x.reason).includes('idx.db'))
  assert.equal(oversize.length, 0, `DB 文件不该被语料通道记超限：${JSON.stringify(idx.incomplete)}`)
  assert.equal(idx.sources.db, true, 'DB 通道应已扫描')
  assert.ok(idx.nodes[0].refs >= 1, '应能从 DB 里读到引用')
})

test('③ 名字判别力：通用词不算，唯一标识算', () => {
  assert.equal(isDiscriminativeName('jobs'), false)
  assert.equal(isDiscriminativeName('tmp'), false)
  assert.equal(isDiscriminativeName('worker-batch-1-9c4ef'), true)
  assert.equal(isDiscriminativeName('157a5bbe-b631-431c-833f-2b710c1e4a45'), true)
})

test('③ 名不具判别力 → 永不 green（引用计数不可信），且不可执行', async () => {
  const s = scene()
  const art2 = join(s.root, 'artifacts2')
  mkdirSync(join(art2, 'jobs'), { recursive: true })
  writeFileSync(join(art2, 'jobs', 'a.json'), 'x'.repeat(16))
  const idx = await buildRefIndex({ artifactDir: art2, corpusRoots: [s.root], dbPath: null })
  const node = idx.nodes.find((n) => n.name === 'jobs')
  assert.equal(node.unstable, true, '通用名应标 unstable')
  const cls = classifyNode({ ...node, refs: 0, latestMtime: Date.now() - 90 * 86400000 }, { now: Date.now() })
  assert.notEqual(cls.grade, 'green')
  assert.equal(cls.executor, null)
  assert.match(cls.reason, /判别力|通用/)
})

test('③ 有唯一名的节点不受影响（对照，防止判定恒假）', async () => {
  const s = scene()
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath: null })
  const node = idx.nodes[0]
  assert.equal(node.unstable, false)
  const cls = classifyNode({ ...node, refs: 0, latestMtime: Date.now() - 90 * 86400000 }, { now: Date.now() })
  assert.equal(cls.grade, 'green')
  assert.equal(cls.executor, 'stage')
})
