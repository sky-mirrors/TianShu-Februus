// W48：系统域第二批扩展——用户主目录下的包缓存 + 浏览器站点缓存 + 模型资产。
// 分两类：可重建的判 yellow（删了要重下），用户资产判 brown（绝不删）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { matchRule } = await import('../core/run.mjs')
const { systemRules, systemVars } = await import('../domains/system.mjs')

const rules = systemRules()
const vars = { ...systemVars(), LOCALAPPDATA: 'C:/Users/x/AppData/Local', USERPROFILE: 'C:/Users/x' }
const byId = (id) => rules.find((r) => r.id === id)

test('W48：变量表提供 USERPROFILE（用户主目录下的缓存要用它）', () => {
  assert.equal(typeof systemVars({ USERPROFILE: 'C:/Users/x' }).USERPROFILE, 'string')
  assert.equal(systemVars({ USERPROFILE: 'C:/Users/x' }).USERPROFILE, 'C:/Users/x')
})

test('W48：包管理器缓存判 yellow（可重建，但要重下）', () => {
  for (const [id, path] of [
    ['sys.cargo-registry', 'C:/Users/x/.cargo/registry'],
    ['sys.maven-repo', 'C:/Users/x/.m2/repository'],
    ['sys.nuget-packages', 'C:/Users/x/.nuget/packages'],
  ]) {
    const r = byId(id)
    assert.ok(r, `应有 ${id}`)
    assert.equal(r.grade, 'yellow', `${id} 应判 yellow`)
    assert.equal(r.executor?.type, 'stage', `${id} 应可 stage`)
    assert.ok(matchRule(path, r, vars), `${id} 应命中 ${path}`)
  }
})

test('W48：Edge 站点缓存可清（Service Worker / IndexedDB）', () => {
  for (const [id, path] of [
    ['sys.edge-sw-cache', 'C:/Users/x/AppData/Local/Microsoft/Edge/User Data/Default/Service Worker'],
    ['sys.edge-indexeddb', 'C:/Users/x/AppData/Local/Microsoft/Edge/User Data/Default/IndexedDB'],
  ]) {
    const r = byId(id)
    assert.ok(r, `应有 ${id}`)
    assert.equal(r.executor?.type, 'stage')
    assert.ok(matchRule(path, r, vars))
  }
})

test('W48：模型资产判 brown（是下载的资产，不是缓存）', () => {
  const r = byId('sys.ollama-models')
  assert.ok(r, '应有 sys.ollama-models')
  assert.equal(r.grade, 'brown', 'Ollama 模型是用户资产，删了要重新下载数 GB')
  assert.equal(r.executor, undefined, 'brown 不得带执行器')
  assert.ok(matchRule('C:/Users/x/.ollama/models/blobs', r, vars))
})

test('W48：UWP 应用数据判 brown（含账号与设置）', () => {
  const r = byId('sys.uwp-packages')
  assert.ok(r, '应有 sys.uwp-packages')
  assert.equal(r.grade, 'brown')
})

test('W48：规则 id 唯一且每条都有 reason', () => {
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length)
  for (const r of rules) assert.ok(String(r.reason ?? '').trim().length > 0, `${r.id} 缺 reason`)
})
