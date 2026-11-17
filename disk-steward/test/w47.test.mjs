// W47：系统域补齐「用户级缓存/转储」这一类真实垃圾。
// 只补 %LOCALAPPDATA% 下能真正生效的项：C:\Windows\* 会被 guard 的 WINDOWS_DIR 硬禁区拦住，
// 加规则也只会得到死规则（items 里永远不出现），所以不在本文件断言范围内。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { matchRule } = await import('../core/run.mjs')
const { systemRules, systemVars } = await import('../domains/system.mjs')

const rules = systemRules()
// 用同一份 vars，但把 LOCALAPPDATA 换成假路径：否则断言里的 C:/Users/x 永远匹配不上本机真实目录
const vars = { ...systemVars(), LOCALAPPDATA: 'C:/Users/x/AppData/Local' }
const byId = (id) => rules.find((r) => r.id === id)

test('W47：pip 包缓存可清（可重建，属真实垃圾）', () => {
  const r = byId('sys.pip-cache')
  assert.ok(r, '应有 sys.pip-cache 规则')
  assert.equal(r.grade, 'green')
  assert.equal(r.executor?.type, 'stage')
  assert.ok(matchRule('C:/Users/x/AppData/Local/pip/Cache/http', r, vars), '应命中 pip/Cache 下的内容')
})

test('W47：崩溃转储与缩略图缓存可清', () => {
  for (const [id, path] of [
    ['sys.crash-dumps', 'C:/Users/x/AppData/Local/CrashDumps'],
    ['sys.explorer-thumbs', 'C:/Users/x/AppData/Local/Microsoft/Windows/Explorer'],
    ['sys.d3d-cache', 'C:/Users/x/AppData/Local/D3DSCache'],
    ['sys.pnpm-store', 'C:/Users/x/AppData/Local/pnpm'],
  ]) {
    const r = byId(id)
    assert.ok(r, `应有 ${id} 规则`)
    assert.equal(r.grade, 'green', `${id} 应为 green`)
    assert.equal(r.executor?.type, 'stage', `${id} 应可 stage`)
    assert.ok(matchRule(path, r, vars), `${id} 应命中 ${path}`)
  }
})

test('W47：npm 缓存判 yellow 而非 green（删了要重下全部依赖）', () => {
  const r = byId('sys.npm-cache')
  assert.ok(r, '应有 sys.npm-cache 规则')
  assert.notEqual(r.grade, 'green', 'npm 缓存不能判 green：删后离线会直接失败')
  // validateRule 是二分模型：brown=受保护无执行器，其余分级必须有合法 executor。
  // 所以「yellow 且不可执行」这个组合不存在；谨慎性由 advise 层呈现，清理仍需逐项点名。
  assert.equal(r.executor?.type, 'stage')
})

test('W47：绝不把用户装的应用本体（%LOCALAPPDATA%\\Programs）纳入任何规则', () => {
  const hit = rules.find((x) => matchRule('C:/Users/x/AppData/Local/Programs/Ollama', x, vars))
  assert.equal(hit, undefined, 'Programs 是应用本体，必须保持未收录→按保护处理')
})

test('W47：系统域规则总数不少于 9（不回退既有覆盖）', () => {
  assert.ok(rules.length >= 9, `规则数 ${rules.length} 少于既有 9 条`)
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, '规则 id 不得重复')
})

test('W47：新规则都带 reason（解释层要求 reason 非空）', () => {
  for (const id of ['sys.pip-cache', 'sys.crash-dumps', 'sys.explorer-thumbs', 'sys.d3d-cache', 'sys.pnpm-store', 'sys.npm-cache']) {
    const r = byId(id)
    assert.ok(String(r?.reason ?? '').trim().length > 0, `${id} 缺 reason`)
  }
})
