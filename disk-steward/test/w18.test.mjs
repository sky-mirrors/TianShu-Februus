// W18：路径安全不能只靠字符串——软链/junction 必须解析后再判定；
// 且"解析结果"本身也要在执行时重新验证（防扫描后被重绑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { isDenied, assertRealAllowed, GUARD_ERRORS } = await import('../core/guard.mjs')
const { verifyMoved } = await import('../core/identity.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w18-'))
  const work = join(root, 'work')
  const normal = join(root, 'normal')
  mkdirSync(work, { recursive: true })
  mkdirSync(normal, { recursive: true })
  writeFileSync(join(normal, 'x.txt'), 'x')
  return { root, work, normal }
}

test('字符串放行但真实指向受保护目录 → 必须由 assertRealAllowed 拦住', async () => {
  const s = scene()
  const link = join(s.work, 'winlink')
  symlinkSync('C:\\Windows', link, 'junction') // 建不出来就让测试红，不静默跳过
  // 前提：纯字符串判定确实放行（这就是那个洞）
  assert.equal(isDenied(link), false, '字符串判定会放行，说明漏洞真实存在')
  // 修法：解析后判定
  const r = await assertRealAllowed(link)
  assert.equal(r.ok, false)
  assert.equal(r.code, GUARD_ERRORS.DENIED_REALPATH)
  rmSync(link, { force: true })
})

test('指向普通目录的链接：允许，但标出经过链接（供审计）', async () => {
  const s = scene()
  const link = join(s.work, 'oklink')
  symlinkSync(s.normal, link, 'junction')
  const r = await assertRealAllowed(link)
  assert.equal(r.ok, true)
  assert.equal(r.viaSymlink, true)
  assert.ok(r.realPath && r.realPath.toLowerCase().includes('normal'))
  rmSync(link, { force: true })
})

test('普通目录：允许且未经过链接', async () => {
  const s = scene()
  const r = await assertRealAllowed(s.normal)
  assert.equal(r.ok, true)
  assert.equal(r.viaSymlink, false)
})

test('路径不存在 → 拒绝（不猜）', async () => {
  const r = await assertRealAllowed(join(tmpdir(), 'ds-no-such-' + Date.now()))
  assert.equal(r.ok, false)
  assert.equal(r.code, GUARD_ERRORS.REALPATH_FAILED)
})

test('移动后校验：尺寸/时间与快照不符 → 判为不一致（供回滚）', () => {
  const ok = verifyMoved({ size: 5, mtimeMs: 1000 }, { size: 5, mtimeMs: 1000 })
  assert.equal(ok.ok, true)
  const bad = verifyMoved({ size: 5, mtimeMs: 1000 }, { size: 99, mtimeMs: 1000 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'POSTMOVE_MISMATCH')
})
