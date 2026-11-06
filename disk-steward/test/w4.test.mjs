// W4 系统域：先立"不许删"的硬边界，再谈扫描。
// 关键性质：系统域默认只读（executor 恒为 null）→ 计划层直接拒绝，误删无从发生。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { isDenied, DENY } = await import('../core/guard.mjs')
const { scanSystem } = await import('../domains/system.mjs')
const { createPlan, PLAN_ERRORS } = await import('../core/plan.mjs')

const C = 'C:\\'

test('系统禁区：Windows / Program Files / 用户文档 / pagefile / WinSxS / 还原点', () => {
  const cases = [
    `${C}Windows\\System32\\kernel32.dll`,
    `${C}Windows\\Temp`,
    `${C}Program Files\\app\\x.dll`,
    `${C}Program Files (x86)\\app`,
    `C:\\Users\\x\\Documents\\thesis.docx`,
    `C:\\Users\\x\\Desktop\\a.txt`,
    `C:\\Users\\x\\Pictures`,
    `${C}pagefile.sys`,
    `${C}hiberfil.sys`,
    `${C}Windows\\WinSxS\\amd64_x86`,
    `C:\\System Volume Information\\x`,
    `C:\\$Recycle.Bin`,
    `C:\\ProgramData\\Microsoft\\Crypto\\Keys`,
  ]
  for (const p of cases) {
    assert.equal(isDenied(p), true, `应被拒绝：${p}`)
  }
})

test('禁区判定大小写不敏感、反斜杠正斜杠等价', () => {
  assert.equal(isDenied('c:\\windows\\system32'), true)
  assert.equal(isDenied('C:/Windows/System32'), true)
  assert.equal(isDenied('C:/PROGRAM FILES/app'), true)
})

test('禁区判定挡住 .. 穿越（C:\\Windows\\..\\Windows\\Temp 仍是禁区）', () => {
  assert.equal(isDenied('C:\\Windows\\..\\Windows\\Temp'), true)
  assert.equal(isDenied('C:\\Users\\x\\..\\..\\Windows\\Temp'), true)
})

test('大小写不同的 TEMP 文件名不被误判（Temp 在白名单里但 Windows\\Temp 在禁区）', () => {
  const env = { TEMP: 'C:\\Users\\x\\AppData\\Local\\Temp' }
  assert.equal(isDenied(env.TEMP, env), false, '用户 TEMP 是允许的')
  assert.equal(isDenied('C:\\Windows\\Temp', env), true, '系统 Temp 需单独标注，默认禁区')
})

test('系统域的 item 一律 executor=null（默认只读），计划层必然拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w4-'))
  const env = {
    TEMP: join(root, 'temp'),
    LOCALAPPDATA: join(root, 'localappdata'),
    USERPROFILE: join(root, 'user'),
    WINDIR: join(root, 'windows'),
  }
  mkdirSync(join(env.TEMP, 'sub'), { recursive: true })
  writeFileSync(join(env.TEMP, 'sub', 'a.tmp'), 'x'.repeat(512))
  mkdirSync(join(env.WINDIR, 'Temp'), { recursive: true })
  writeFileSync(join(env.WINDIR, 'Temp', 'b.tmp'), 'x'.repeat(256))

  const run = await scanSystem({ env, now: Date.now() })
  assert.ok(run.items.length > 0, '至少应产出用户 TEMP 一项')
  for (const i of run.items) {
    assert.equal(i.executor, null, `${i.path} 在系统域默认不可执行`)
  }
  assert.equal(run.totals.selectable, 0, '系统域可勾选数恒为 0（未传 execEnabled 时默认只读）')
  assert.equal(run.selectable, 0, '顶层 selectable 同样为 0')
  assert.throws(
    () => createPlan({ run, itemIds: [run.items[0].id], issuer: 'human', confirmedBy: 'test' }),
    (e) => e.code === PLAN_ERRORS.REFUSED_PROTECTED,
  )
})

test('系统域扫描把 Windows\\Temp 标为需提权且不执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w4b-'))
  const env = {
    TEMP: join(root, 'temp'),
    LOCALAPPDATA: join(root, 'la'),
    USERPROFILE: join(root, 'u'),
    WINDIR: join(root, 'windows'),
  }
  mkdirSync(join(env.WINDIR, 'Temp'), { recursive: true })
  writeFileSync(join(env.WINDIR, 'Temp', 'b.tmp'), 'y'.repeat(128))
  const run = await scanSystem({ env, now: Date.now() })
  const winTemp = run.items.find((i) => i.path.toLowerCase().includes('windows'))
  assert.ok(winTemp, '应识别到系统 Temp')
  assert.equal(winTemp.needsElevation, true)
  assert.equal(winTemp.executor, null)
  assert.equal(winTemp.grade, 'yellow')
})
