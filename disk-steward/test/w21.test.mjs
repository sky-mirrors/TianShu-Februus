// W21：扫描增量——语料/DB/节点集都没变时复用上次索引；任何变化都必须失效（防假阴性）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const { buildRefIndex } = await import('../core/refindex.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w21-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, 'abcd-1234-ef56'), { recursive: true })
  writeFileSync(join(art, 'abcd-1234-ef56', 'x.bin'), 'x'.repeat(32))
  const corpus = join(root, 'sessions')
  mkdirSync(corpus, { recursive: true })
  writeFileSync(join(corpus, 'a.md'), '无关内容')
  const cachePath = join(root, 'refcache.json')
  return { root, art, corpus, cachePath }
}

test('第一次构建写缓存；语料未变时第二次命中', async () => {
  const s = scene()
  const first = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  assert.equal(first.cached, false, '首次不应命中')
  const second = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  assert.equal(second.cached, 'fingerprint', '第二次应命中指纹缓存')
  assert.deepEqual(
    second.nodes.map((n) => [n.name, n.refs]),
    first.nodes.map((n) => [n.name, n.refs]),
    '命中缓存的结果必须与首次一致',
  )
})

test('语料文件变化 → 缓存失效，新增引用被算到', async () => {
  const s = scene()
  const first = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  assert.equal(first.nodes[0].refs, 0)

  appendFileSync(join(s.corpus, 'a.md'), '\n引用了 abcd-1234-ef56 这个产物\n')
  const second = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  assert.equal(second.cached, false, '语料变化必须失效')
  assert.equal(second.nodes[0].refs, 1, `应算到 1 处引用，实际 ${second.nodes[0].refs}`)
})

test('新增产物节点 → 即使语料未变也不命中（节点集参与指纹）', async () => {
  const s = scene()
  await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  mkdirSync(join(s.art, 'ffff-9999-0000'), { recursive: true })
  writeFileSync(join(s.art, 'ffff-9999-0000', 'y.bin'), 'y')
  const r = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], cachePath: s.cachePath })
  assert.equal(r.cached, false, '节点集变化必须失效')
  assert.equal(r.nodes.length, 2)
})

test('DB 文件变化 → 失效（DB 也是引用来源）', async () => {
  const s = scene()
  const dbPath = join(s.root, 'idx.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE t (body TEXT)')
  db.prepare('INSERT INTO t (body) VALUES (?)').run('无关')
  db.close()

  const first = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath, cachePath: s.cachePath })
  assert.equal(first.nodes[0].refs, 0)

  const db2 = new DatabaseSync(dbPath)
  db2.prepare('INSERT INTO t (body) VALUES (?)').run('abcd-1234-ef56')
  db2.close()
  const second = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath, cachePath: s.cachePath })
  assert.equal(second.cached, false, 'DB 变化必须失效')
  assert.ok(second.nodes[0].refs >= 1, '应算到 DB 里的引用')
})
