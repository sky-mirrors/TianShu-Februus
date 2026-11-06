// W24：让 flags 真的有执行语义（此前只有校验与传递）。
// keepDir  = 移走内容后把原目录重建为空目录（应用要求目录存在时用）
// noRecurse= 只移动直接子文件，子目录原地保留（不递归）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { stage, EXEC_ERRORS } = await import('../core/executor.mjs')
const { createPlan } = await import('../core/plan.mjs')
const { snapshot } = await import('../core/identity.mjs')
const { validateRule, RULE_ERRORS } = await import('../core/rules.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'ds-w24-'))
  const src = join(root, 'cache')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'aaa')
  writeFileSync(join(src, 'sub', 'b.txt'), 'bbb')
  const item = { id: 'x#1', path: src, bytes: 6, grade: 'green', blocked: null, executor: 'stage' }
  return { root, src, item, quarantine: join(root, 'trash'), ledgerPath: join(root, 'ledger.jsonl') }
}

async function runStage(s, flags) {
  const identity = await snapshot(s.item.path)
  const plan = createPlan({ run: { items: [{ ...s.item, flags }] }, itemIds: [s.item.id], issuer: 'human', confirmedBy: 'test' })
  return stage({
    plan,
    token: plan.token,
    items: [{ ...s.item, flags, identity }],
    quarantineRoot: s.quarantine,
    ledgerPath: s.ledgerPath,
  })
}

test('默认（无 flags）：整目录移走，源目录不存在', async () => {
  const s = scene()
  await runStage(s, [])
  assert.equal(existsSync(s.src), false)
})

test('keepDir：内容移走但把原目录重建为空目录', async () => {
  const s = scene()
  await runStage(s, ['keepDir'])
  assert.equal(existsSync(s.src), true, '源目录应被重建')
  assert.deepEqual(readdirSync(s.src), [], '重建后应为空')
})

test('noRecurse：只移直接子文件，子目录留在原地', async () => {
  const s = scene()
  await runStage(s, ['noRecurse'])
  assert.equal(existsSync(join(s.src, 'a.txt')), false, '直接子文件应被移走')
  assert.equal(existsSync(join(s.src, 'sub', 'b.txt')), true, '子目录内文件必须原地保留')
})

test('flags 白名单扩充后仍拒绝未知值', () => {
  const base = { id: 'f', match: { kind: 'prefix', path: '/x' }, grade: 'green', reason: 'r', executor: { type: 'stage' } }
  for (const f of ['recurse', 'noRecurse', 'removeSelf', 'keepDir']) {
    assert.equal(validateRule({ ...base, flags: [f] }), true, `${f} 应被接受`)
  }
  assert.throws(() => validateRule({ ...base, flags: ['nope'] }), (e) => e.code === RULE_ERRORS.BAD_FLAGS)
})
