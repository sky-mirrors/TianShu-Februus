// W49：第三批——实测存在的应用缓存。关键约束：只针对纯缓存子目录，父目录一律不碰。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { matchRule } = await import('../core/run.mjs')
const { systemRules, systemVars } = await import('../domains/system.mjs')

const rules = systemRules()
const vars = { ...systemVars(), LOCALAPPDATA: 'C:/Users/x/AppData/Local', USERPROFILE: 'C:/Users/x' }
const byId = (id) => rules.find((r) => r.id === id)

test('W49：网易云只清 Cache 子目录，绝不碰整个 CloudMusic', () => {
  const r = byId('sys.netease-cache')
  assert.ok(r, '应有 sys.netease-cache')
  assert.equal(r.grade, 'green')
  assert.ok(matchRule('C:/Users/x/AppData/Local/Netease/CloudMusic/Cache/Cache/abc', r, vars))
  assert.equal(matchRule('C:/Users/x/AppData/Local/Netease/CloudMusic/Library', r, vars), null, 'Library 存歌曲，不得命中')
})

test('W49：JetBrains 只清 */caches，不碰 config/plugins', () => {
  const r = byId('sys.jetbrains-caches')
  assert.ok(r, '应有 sys.jetbrains-caches')
  assert.equal(r.match.kind, 'glob')
  assert.equal(r.grade, 'yellow', '重建索引要时间，判 yellow')
  assert.ok(matchRule('C:/Users/x/AppData/Local/JetBrains/PyCharm2026.1/caches', r, vars))
  assert.equal(matchRule('C:/Users/x/AppData/Local/JetBrains/PyCharm2026.1/config', r, vars), null, '配置不得命中')
})

test('W49：Edge 新补的两条都带 msedge 前置条件', () => {
  for (const id of ['sys.edge-component-cache', 'sys.edge-gr-cache']) {
    const r = byId(id)
    assert.ok(r, `应有 ${id}`)
    assert.equal(r.precondition?.name, 'msedge', `${id} 必须卡 msedge 进程`)
    assert.equal(r.executor?.type, 'stage')
  }
})

test('W49：不允许任何规则命中 Edge 整个 User Data（含账号与 profile）', () => {
  const hit = rules.find((r) => r.match.path.includes('/Microsoft/Edge/User Data') && !r.match.path.includes('/Default/') && !r.match.path.includes('component_crx_cache') && !r.match.path.includes('GrShaderCache'))
  assert.equal(hit, undefined, '整目录规则会把 profile 一起删掉')
})

test('W49：规则总数不回退，id 唯一，reason 非空', () => {
  assert.ok(rules.length >= 20, `规则数 ${rules.length} 少于既有 20 条`)
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length)
  for (const r of rules) assert.ok(String(r.reason ?? '').trim().length > 0, `${r.id} 缺 reason`)
})
