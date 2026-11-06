// W23：规则里声明了却没实现的 exclude / flags——现在真的生效（并拒绝非法值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { buildRun } = await import('../core/run.mjs')
const { validateRule, RULE_ERRORS } = await import('../core/rules.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w23-'))
  const cache = join(root, 'cache')
  mkdirSync(join(cache, 'keepdb'), { recursive: true })
  writeFileSync(join(cache, 'a.txt'), 'x'.repeat(16))
  return { root, cache }
}

test('exclude 命中 → 该项标为保护（brown）且不可执行，但不静默消失', async () => {
  const s = scene()
  const rule = {
    id: 't.excl',
    match: { kind: 'prefix', path: '{{root}}/cache' },
    exclude: ['**/keepdb'],
    grade: 'green',
    reason: '可清缓存',
    executor: { type: 'stage' },
  }
  const run = await buildRun({ rules: [rule], vars: { root: s.root }, collectUnmatched: false })
  // 主项本身不命中 exclude → 正常
  assert.equal(run.items.length, 1)
  assert.equal(run.items[0].grade, 'green')

  // 换成主项命中 exclude 的规则
  const rule2 = { ...rule, match: { kind: 'prefix', path: '{{root}}/cache/keepdb' } }
  const run2 = await buildRun({ rules: [rule2], vars: { root: s.root }, collectUnmatched: false })
  assert.equal(run2.items.length, 1, '被排除的项仍要出现，不能静默丢掉')
  assert.equal(run2.items[0].grade, 'brown')
  assert.equal(run2.items[0].executor, null)
  assert.match(run2.items[0].blockedReason ?? '', /exclude|排除/)
})

test('exclude 未命中 → 不影响判定（对照组）', async () => {
  const s = scene()
  const rule = {
    id: 't.excl2',
    match: { kind: 'prefix', path: '{{root}}/cache/keepdb' },
    exclude: ['**/somethingelse'],
    grade: 'green',
    reason: '可清缓存',
    executor: { type: 'stage' },
  }
  const run = await buildRun({ rules: [rule], vars: { root: s.root }, collectUnmatched: false })
  assert.equal(run.items[0].grade, 'green')
  assert.equal(run.items[0].executor, 'stage')
})

test('flags 只接受已知值，未知值让规则校验失败', () => {
  const base = { id: 'f', match: { kind: 'prefix', path: '/x' }, grade: 'green', reason: 'r', executor: { type: 'stage' } }
  assert.equal(validateRule({ ...base, flags: ['removeSelf'] }), true)
  assert.equal(validateRule({ ...base, flags: ['recurse'] }), true)
  assert.throws(() => validateRule({ ...base, flags: ['不存在的flag'] }), (e) => e.code === RULE_ERRORS.BAD_FLAGS)
})

test('flags 会带到 item 上（供执行器与报告使用）', async () => {
  const s = scene()
  const rule = {
    id: 't.flags',
    match: { kind: 'prefix', path: '{{root}}/cache' },
    flags: ['removeSelf'],
    grade: 'green',
    reason: '可清缓存',
    executor: { type: 'stage' },
  }
  const run = await buildRun({ rules: [rule], vars: { root: s.root }, collectUnmatched: false })
  assert.deepEqual(run.items[0].flags, ['removeSelf'])
})
