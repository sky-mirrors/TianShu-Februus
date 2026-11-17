// W50：跨机器安全性——规则库要能装到任何机器上。
// 核心断言：规则指向的应用不存在时，扫描静默跳过，不报错、不产生空 item。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { systemRules, systemVars } = await import('../domains/system.mjs')
const { buildRun } = await import('../core/run.mjs')
const { isDenied } = await import('../core/guard.mjs')

const rules = systemRules()
const byId = (id) => rules.find((r) => r.id === id)

test('W50：第四批规则覆盖常见工具链，且每条都有 reason 与合法 executor', () => {
  const ids = [
    'sys.go-build-cache', 'sys.go-module-cache', 'sys.gradle-cache',
    'sys.yarn-cache', 'sys.composer-cache', 'sys.firefox-cache',
  ]
  for (const id of ids) {
    const r = byId(id)
    assert.ok(r, `应有 ${id}`)
    assert.ok(String(r.reason ?? '').trim().length > 0, `${id} 缺 reason`)
    if (r.grade === 'brown') assert.equal(r.executor, undefined, `${id} brown 不得带执行器`)
    else assert.ok(r.executor, `${id} 非 brown 必须有执行器`)
  }
})

test('W50：变量缺失的规则不会炸（不同机器的环境变量不全）', async () => {
  // 只给 rivetHome，LOCALAPPDATA/USERPROFILE/APPDATA 全缺
  const run = await buildRun({
    rules: [{ id: 'probe', match: { kind: 'prefix', path: '{{LOCALAPPDATA}}/go-build' }, grade: 'green', reason: 'x', executor: { type: 'stage' } }],
    vars: {},
    collectUnmatched: false,
  })
  // 变量未展开成真实路径 => exists 为假 => 不产 item（也不抛错）
  assert.equal(run.items.length, 0, '变量缺失时不应产生 item')
})

test('W50：路径不存在的规则静默跳过（跨机器的核心语义）', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'ds-w50-')), 'definitely-not-installed-app')
  const run = await buildRun({
    rules: [
      { id: 'probe.missing', match: { kind: 'prefix', path: missing }, grade: 'green', reason: 'x', executor: { type: 'stage' } },
    ],
    vars: {},
    collectUnmatched: false,
  })
  assert.equal(run.items.length, 0, '不存在的应用不应产生 item')
  assert.equal(run.totals.selectable, 0)
})

test('W50：整本系统规则跑一遍不抛错，且每条都带解释（抽样，避免真测 15 GB 缓存）', async () => {
  // 只取不涉及大目录的规则：实测全量跑会把 15 GB 网易云缓存完整递归测量一遍（约 70 秒）。
  // 但「每条都有解释」这条断言必须保留——它曾因我写错字段名（explain.reason）而假红，
  // 当时我误判成「耗时太长」并把断言删了，等于掩盖真错误。正确字段是 explain.why。
  const cheap = rules.filter((r) => !/netease|npm-cache|ollama|user-temp|cargo|nuget|jetbrains/.test(r.id))
  const run = await buildRun({ rules: cheap, vars: systemVars(), collectUnmatched: false })
  assert.ok(Array.isArray(run.items), '应返回 items 数组')
  for (const i of run.items) {
    assert.ok(i.bytes >= 0, `${i.ruleId} 字节数异常`)
    assert.notEqual(i.explain?.why, undefined, `${i.ruleId} 缺 explain.why（解释的来源）`)
  }
})

test('W50：AppData\\Roaming 下的应用一律不进候选（guard 主动拦截）', () => {
  assert.equal(isDenied('C:/Users/x/AppData/Roaming/discord/Cache'), true)
  assert.equal(isDenied('C:/Users/x/AppData/Roaming/Code/Cache'), true)
  // 既然被拦，规则库就不该为 Roaming 写规则（写了也是死规则）。
  // 注意正则要带 {{ 边界：裸 `APPDATA}}` 会匹配到 `{{LOCALAPPDATA}}` 的尾部，把 24 条规则误判成 Roaming 规则。
  const roamingRules = rules.filter((r) => /\{\{APPDATA\}\}|AppData\/Roaming/.test(r.match.path))
  assert.equal(roamingRules.length, 0, `不应为 Roaming 写规则，实际有：${roamingRules.map((r) => r.id).join(',')}`)
})
