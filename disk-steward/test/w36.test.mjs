// W36：全部盘扫描——盘符枚举（注入 probe 控两态）、顶层扫描（summary）、深扫预算与排序、guard 集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listDrives, driveRoot, DRIVE_LETTERS } = await import('../core/drives.mjs')
const { scanDrives } = await import('../domains/drives.mjs')

const dirent = (name, dir = false, link = false) => ({ name, isDirectory: () => dir, isSymbolicLink: () => link })

test('driveRoot：C / c: / C:\\ 一律归一成 C:\\', () => {
  assert.equal(driveRoot('C'), 'C:\\')
  assert.equal(driveRoot('c:'), 'C:\\')
  assert.equal(driveRoot('D:\\'), 'D:\\')
  assert.equal(driveRoot('e:/'), 'E:\\')
})

test('listDrives：只返回 statfs 成功的盘，容量字段按 bsize*blocks 计算', async () => {
  const probe = async (root) => {
    if (root === 'C:\\') return { bsize: 4096, blocks: 1000, bavail: 250 }
    if (root === 'D:\\') return { bsize: 4096, blocks: 2000, bavail: 500 }
    const e = new Error('ENOENT')
    e.code = 'ENOENT'
    throw e
  }
  const ds = await listDrives({ probe, letters: ['C', 'D', 'E'] })
  assert.deepEqual(ds.map((d) => d.letter), ['C:', 'D:'])
  assert.equal(ds[0].totalBytes, 4096 * 1000)
  assert.equal(ds[0].freeBytes, 4096 * 250)
  assert.equal(ds[0].usedBytes, 4096 * 750)
  assert.equal(ds[1].root, 'D:\\')
})

test('listDrives：真机至少能看到一个盘，且盘符形如 C:', async () => {
  const ds = await listDrives()
  assert.ok(ds.length >= 1, '真实设备至少有一个可 statfs 的盘')
  for (const d of ds) {
    assert.match(d.letter, /^[A-Z]:$/)
    assert.ok(d.totalBytes > 0)
    assert.ok(d.freeBytes >= 0 && d.freeBytes <= d.totalBytes)
  }
  assert.equal(DRIVE_LETTERS.length, 26)
})

test('scanDrives summary：只 readdir 顶层，不做测量，禁区项进 denied 不进 top', async () => {
  const readdirFn = async () => [
    dirent('Users', true),
    dirent('Windows', true),
    dirent('$Recycle.Bin', true),
    dirent('System Volume Information', true),
    dirent('notes.txt', false),
  ]
  const { drives, denied, deep } = await scanDrives({
    drives: [{ letter: 'C:', root: 'C:\\', totalBytes: 100, freeBytes: 40, usedBytes: 60 }],
    readdirFn,
    measureFn: () => {
      throw new Error('summary 不应测量任何项')
    },
  })
  assert.equal(deep, false)
  assert.equal(drives.length, 1)
  // Windows 目录同样命中禁区：可见于 denied，不进可勾选清单
  assert.equal(drives[0].dirCount, 1)
  assert.equal(drives[0].fileCount, 1)
  assert.deepEqual(drives[0].top.map((t) => t.name).sort(), ['Users', 'notes.txt'].sort())
  assert.equal(drives[0].unmeasured, 2)
  assert.deepEqual(denied.map((d) => d.reason.split(':')[0]), ['WINDOWS_DIR', 'RECYCLE_BIN', 'VSS'])
})

test('scanDrives deep：按占用降序、受预算截断时标 unmeasured 而不静默少报', async () => {
  let clock = 0
  const readdirFn = async () => [dirent('big', true), dirent('mid', true), dirent('small', true)]
  const measureFn = async (p) => {
    clock += 1000 // 每项消耗 1s
    const bytes = p.includes('big') ? 900 : p.includes('mid') ? 500 : 100
    return { bytes }
  }
  const r = await scanDrives({
    drives: [{ letter: 'D:', root: 'D:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 }],
    deep: true,
    readdirFn,
    measureFn,
    budgetMs: 1500,
    clock: () => clock,
  })
  assert.equal(r.deep, true)
  const top = r.drives[0].top
  assert.equal(top[0].name, 'big')
  assert.equal(top[0].bytes, 900)
  assert.equal(r.drives[0].topTotal, 3)
  // 第三次测量落在预算外：必须标成未测，而不是给出错误的 0 字节
  assert.equal(r.drives[0].unmeasured, 1)
  assert.equal(r.truncated, true)
  assert.equal(top.find((t) => t.name === 'small').measured, false)
})

test('scanDrives deep：顶层 junction/符号链接不 measure（否则 C:\Documents and Settings 会把整个 Users 重复算一遍）', async () => {
  const calls = []
  const r = await scanDrives({
    drives: [{ letter: 'C:', root: 'C:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 }],
    deep: true,
    readdirFn: async () => [dirent('Documents and Settings', true, true), dirent('Users', true)],
    measureFn: async (p) => {
      calls.push(p)
      return { bytes: 123 }
    },
  })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].endsWith('Users'))
  assert.equal(r.drives[0].top.find((t) => t.name === 'Documents and Settings').measured, false)
  assert.equal(r.drives[0].top.find((t) => t.name === 'Users').bytes, 123)
})

test('scanDrives deep：measure 返回 partial 时标为未完整测量，不当作可信占用', async () => {
  const r = await scanDrives({
    drives: [{ letter: 'D:', root: 'D:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 }],
    deep: true,
    readdirFn: async () => [dirent('huge', true)],
    measureFn: async () => ({ bytes: 42, partial: true }),
  })
  assert.equal(r.drives[0].top[0].partial, true)
  assert.equal(r.drives[0].top[0].measured, false)
  assert.equal(r.truncated, true)
})

test('scanDrives deep：多盘时预算按盘平摊，后一盘不会被前一盘饿死', async () => {
  let clock = 0
  const calls = []
  const r = await scanDrives({
    drives: [
      { letter: 'C:', root: 'C:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 },
      { letter: 'D:', root: 'D:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 },
    ],
    deep: true,
    budgetMs: 2000, // 每盘 1000ms
    readdirFn: async (root) => [dirent(root.startsWith('C') ? 'c1' : 'd1', true)],
    measureFn: async (p) => {
      clock += 800
      calls.push(p)
      return { bytes: 1 }
    },
    clock: () => clock,
  })
  assert.equal(calls.length, 2, '两盘各测一次，而不是第一盘吃光预算')
  assert.equal(r.truncated, false)
})

test('scanDrives：顶层项超过 topLimit 时 top 截断但 topTotal 报真实数量', async () => {
  const readdirFn = async () => [dirent('a', true), dirent('b', true), dirent('c', true)]
  const r = await scanDrives({
    drives: [{ letter: 'E:', root: 'E:\\', totalBytes: 1, freeBytes: 0, usedBytes: 1 }],
    readdirFn,
    topLimit: 2,
  })
  assert.equal(r.drives[0].top.length, 2)
  assert.equal(r.drives[0].topTotal, 3)
})

test('scanDrives：盘存在但读不了时记 readError，不当作空盘', async () => {
  const readdirFn = async () => {
    const e = new Error('not ready')
    e.code = 'ENOTREADY'
    throw e
  }
  const r = await scanDrives({
    drives: [{ letter: 'F:', root: 'F:\\', totalBytes: 1, freeBytes: 1, usedBytes: 0 }],
    readdirFn,
  })
  assert.equal(r.drives[0].readError, 'ENOTREADY')
  assert.equal(r.drives[0].dirCount, 0)
})

test('scanDrives：真机扫本机所有盘顶层（只 readdir，不进禁区），单盘毫秒级', async () => {
  const drives = await listDrives()
  const t0 = Date.now()
  const r = await scanDrives({ drives })
  const ms = Date.now() - t0
  assert.equal(r.drives.length, drives.length)
  assert.ok(ms < 5000, `顶层扫描应在秒级，实际 ${ms}ms`)
  for (const d of r.drives) {
    assert.ok(!d.top.some((t) => /Recycle\.Bin/i.test(t.name)), `${d.letter} 顶层不应含回收站`)
  }
})

test('沙箱：真实目录树上 deep 扫描得到正确占用排序', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w36-'))
  mkdirSync(join(root, 'big'), { recursive: true })
  mkdirSync(join(root, 'small'), { recursive: true })
  writeFileSync(join(root, 'big', 'a.bin'), Buffer.alloc(3000))
  writeFileSync(join(root, 'small', 'b.bin'), Buffer.alloc(10))
  const r = await scanDrives({
    drives: [{ letter: 'X:', root, totalBytes: 1, freeBytes: 1, usedBytes: 0 }],
    deep: true,
  })
  const top = r.drives[0].top
  assert.equal(top[0].name, 'big')
  assert.ok(top[0].bytes >= 3000)
  assert.equal(top.find((t) => t.name === 'small').bytes, 10)
  assert.equal(r.truncated, false)
})
