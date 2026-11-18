// W12：提权判定（真实可测）+ Edge 缓存的真实场景（本机已装 Edge）。
// 注意：本机当前会话已是 elevated（net session 成功、C:\Windows\Temp 可写），
// 所以"未提权"分支只能用注入来覆盖；"已提权"分支用真机实测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { isElevated, planElevation, systemDirWritable } = await import('../core/elevation.mjs')
const { scanSystem } = await import('../domains/system.mjs')

test('提权判定：net session 成功 = 已提权；失败 = 未提权（注入控两态）', async () => {
  const yes = await isElevated({ run: () => ({ status: 0 }) })
  assert.equal(yes.elevated, true)
  const no = await isElevated({ run: () => ({ status: 2 }) })
  assert.equal(no.elevated, false)
  const err = await isElevated({ run: () => ({ status: 1, error: 'ENOENT' }) })
  assert.equal(err.elevated, false, '查不到一律当未提权（fail-closed）')
  assert.match(err.reason, /无法确认|ENOENT/)
})

test('提权判定与目录可写性各自返回自身语义（两者不必然相等）', async () => {
  const e = await isElevated()
  assert.equal(typeof e.elevated, 'boolean')
  const w = await systemDirWritable()
  assert.equal(typeof w.writable, 'boolean')
  assert.equal(typeof w.code, 'string')
  // 「进程是否提权」与「C:\Windows\Temp 能否写」是两件事：管理员会话可写、
  // 普通会话也可能因 ACL 而可写。原断言把二者绑成相等，会在不同机器上假红。
})

test('提权命令是构造出来的字符串，不会被自动执行', () => {
  const p = planElevation('Remove-Item C:\\Windows\\Temp\\x.tmp -Force')
  assert.equal(p.executed, false, '构造阶段绝不执行')
  assert.match(p.command, /Start-Process/)
  assert.match(p.command, /-Verb RunAs/)
  assert.match(p.command, /Remove-Item/)
})

// 本机 Edge 缓存属于外部环境：它会被本插件自己清理掉（真机 purge 已发生过）。
// 依赖它的测试会在环境变化后误红，所以改成自建沙箱 + 注入 env，测规则语义而不是本机状态。
function sandboxEdge() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w12-'))
  const lapp = join(root, 'localappdata')
  const base = join(lapp, 'Microsoft/Edge/User Data/Default')
  const old = new Date(Date.now() - 11 * 60 * 1000)
  for (const d of ['Cache', 'Code Cache', 'GPUCache']) {
    mkdirSync(join(base, d), { recursive: true })
    const f = join(base, d, 'data_0')
    writeFileSync(f, 'x'.repeat(64))
    utimesSync(f, old, old)
  }
  return { root, env: { LOCALAPPDATA: lapp, TEMP: join(root, 'temp'), WINDIR: join(root, 'win'), SYSTEMDRIVE: root } }
}

test('Edge 三条缓存规则真实命中（沙箱环境，不依赖本机是否装有 Edge）', async () => {
  const { env } = sandboxEdge()
  const run = await scanSystem({ env, now: Date.now() })
  const edge = run.items.filter((i) => /Edge/i.test(i.title))
  assert.equal(edge.length, 3, `应识别到 3 条 Edge 缓存规则，实际 ${JSON.stringify(run.items.map((i) => i.title))}`)
  for (const i of edge) {
    assert.equal(i.executor, null, '系统域默认只读')
    assert.equal(i.needsElevation, false, 'Edge 缓存在用户目录，不需要提权')
    assert.ok(i.explain?.why, '每条都要有判定理由')
  }
  const total = edge.reduce((s, i) => s + i.bytes, 0)
  assert.ok(total > 0, 'Edge 缓存体积应大于 0')
})

test('Edge 缓存带 msedge 进程前置条件（浏览器开着就不许动）', async () => {
  const { systemRules } = await import('../domains/system.mjs')
  const rules = systemRules().filter((r) => /edge/i.test(r.id))
  assert.ok(rules.length >= 1, '应有 Edge 规则')
  for (const r of rules) {
    assert.deepEqual(r.precondition, { kind: 'processNotRunning', name: 'msedge' }, `${r.id} 缺前置条件`)
  }
})

test('Edge 路径不存在时不产 item（防空跑的反向检查）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w12-empty-'))
  const env = { LOCALAPPDATA: join(root, 'lapp'), TEMP: join(root, 'temp'), WINDIR: join(root, 'win'), SYSTEMDRIVE: root }
  const run = await scanSystem({ env, now: Date.now() })
  assert.equal(run.items.filter((i) => /Edge/i.test(i.title)).length, 0, '路径不存在的规则不应产 item')
})

test('同一路径被两条规则命中时只算一次（TEMP 去重）', async () => {
  const run = await scanSystem({})
  const paths = run.items.map((i) => i.path.toLowerCase())
  assert.equal(new Set(paths).size, paths.length, `存在重复路径：${paths.filter((p, i) => paths.indexOf(p) !== i)}`)
  assert.ok(Array.isArray(run.duplicates), '应记录被去重的项')
})
