// W15：把"零引用"变成可信结论——扩扫描面（DB / 二进制 / 任意文件），
// 并且：**扫不全就不许判可回收**。安全优先于产出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const { buildRefIndex, classifyNode } = await import('../core/refindex.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w15-'))
  const art = join(root, 'artifacts')
  mkdirSync(join(art, 'dddd-4444'), { recursive: true })
  writeFileSync(join(art, 'dddd-4444', 'f.bin'), 'x'.repeat(64))
  mkdirSync(join(art, 'eeee-5555'), { recursive: true })
  writeFileSync(join(art, 'eeee-5555', 'g.bin'), 'y'.repeat(64))
  const corpus = join(root, 'sessions')
  mkdirSync(corpus, { recursive: true })
  writeFileSync(join(corpus, 'note.md'), '完全无关的文字')
  return { root, art, corpus }
}

test('二进制文件里的引用也要算进来（不只看 .md/.json）', async () => {
  const s = scene()
  // 写一个后缀不在白名单、内容含节点名的文件
  writeFileSync(join(s.corpus, 'blob.dat'), 'junk dddd-4444 junk')
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root] })
  const d = idx.nodes.find((n) => n.name === 'dddd-4444')
  assert.ok(d.refs >= 1, `应把 blob.dat 里的引用算上，实际 refs=${d.refs}`)
})

test('SQLite 库里的引用也要算进来', async () => {
  const s = scene()
  const dbPath = join(s.root, 'index.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, body TEXT)')
  db.prepare('INSERT INTO logs (body) VALUES (?)').run('引用了 eeee-5555 这个产物')
  db.prepare('INSERT INTO logs (body) VALUES (?)').run('无关')
  db.close()

  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath })
  const e = idx.nodes.find((n) => n.name === 'eeee-5555')
  assert.ok(e.refs >= 1, `应把 DB 里的引用算上，实际 refs=${e.refs}`)
  assert.ok(idx.sources?.db === true, '应记录 DB 源已扫')
})

test('DB 扫不了 → 标记 refScanIncomplete，且该节点不许判可回收', async () => {
  const s = scene()
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath: join(s.root, 'not-a-db.sqlite') })
  assert.ok(idx.incomplete?.length >= 1, '扫描不完整必须被记录下来')
  const node = idx.nodes.find((n) => n.name === 'dddd-4444')
  assert.equal(node.refScanIncomplete, true, '节点应继承"扫描不完整"这一事实')

  const old = Date.now() - 90 * 24 * 3600 * 1000
  const cls = classifyNode({ ...node, refs: 0, latestMtime: old }, { now: Date.now() })
  assert.notEqual(cls.grade, 'green', '扫描不完整时绝不能判成可回收')
  assert.equal(cls.executor, null, '扫描不完整时连执行资格都不该有')
  assert.match(cls.reason, /不完整/)
})

test('扫描完整且零引用够老 → 才允许 green', async () => {
  const s = scene()
  const idx = await buildRefIndex({ artifactDir: s.art, corpusRoots: [s.root], dbPath: null })
  assert.equal(idx.incomplete.length, 0, `无 DB 不算不完整，实际 ${JSON.stringify(idx.incomplete)}`)
  const node = idx.nodes.find((n) => n.name === 'dddd-4444')
  const old = Date.now() - 90 * 24 * 3600 * 1000
  const cls = classifyNode({ ...node, refs: 0, latestMtime: old }, { now: Date.now() })
  assert.equal(cls.grade, 'green')
  assert.equal(cls.executor, 'stage')
})
