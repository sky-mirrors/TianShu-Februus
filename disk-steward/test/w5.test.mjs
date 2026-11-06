// W5：占用探测。原则——**绝不为了试探而重命名/移动真实文件**。
// 手段只有两种：在目录里建一个临时探针文件再删掉（判断可写），以及对目标文件做只读打开（判断是否被独占）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { probeWritable, probeLock, probeItem } = await import('../core/occupancy.mjs')

test('可写目录：探针建完即删，目录内容不留痕', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w5-'))
  mkdirSync(join(root, 'cache'))
  writeFileSync(join(root, 'cache', 'a.txt'), 'x')
  const before = readdirSync(join(root, 'cache')).sort()
  const r = await probeWritable(join(root, 'cache'))
  assert.equal(r.ok, true)
  assert.equal(r.code, 'WRITABLE')
  const after = readdirSync(join(root, 'cache')).sort()
  assert.deepEqual(after, before, '探测不得留下任何文件')
})

test('目标不存在 → 不可写，且原因明确（不猜）', async () => {
  const r = await probeWritable(join(tmpdir(), 'ds-definitely-missing-' + Date.now()))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ENOENT')
})

test('EBUSY/EACCES 映射到占用原因（用注入的 fs 造确定场景）', async () => {
  const fakeBusy = {
    writeFile: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    unlink: async () => {},
  }
  const r1 = await probeWritable('/whatever', { fs: fakeBusy })
  assert.equal(r1.code, 'LOCKED')

  const fakeDenied = {
    writeFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
    unlink: async () => {},
  }
  const r2 = await probeWritable('/whatever', { fs: fakeDenied })
  assert.equal(r2.code, 'NO_PERMISSION')
})

test('只读打开被拒 → 判为被占用；正常文件 → 空闲', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w5b-'))
  const f = join(root, 'x.tmp')
  writeFileSync(f, 'data')
  const free = await probeLock(f)
  assert.equal(free.code, 'FREE')

  const fakeFs = {
    open: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    close: async () => {},
  }
  const locked = await probeLock(f, { fs: fakeFs })
  assert.equal(locked.code, 'LOCKED')
})

test('禁区内的路径一律拒探（不在 C:\\Windows 里建探针文件）', async () => {
  const r = await probeWritable('C:\\Windows\\Temp')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'REFUSED_DENIED')
})

test('probeItem 汇总出 occupancy 字段且不改动文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w5c-'))
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'a.txt'), 'x'.repeat(32))
  const stBefore = statSync(join(root, 'cache', 'a.txt'))
  const item = { id: 'i1', path: join(root, 'cache'), grade: 'green', blocked: null, executor: null }
  const out = await probeItem(item)
  assert.equal(out.occupancy, 'WRITABLE')
  const stAfter = statSync(join(root, 'cache', 'a.txt'))
  assert.equal(stAfter.mtimeMs, stBefore.mtimeMs, '探测不能改动文件时间戳')
  assert.equal(readdirSync(join(root, 'cache')).length, 1)
  assert.equal(item.occupancy, undefined, 'probeItem 不得就地修改入参')
})
