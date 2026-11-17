// W40：建议层。分级 ≠ 建议——用户要的是「删还是不删」，以及不删的地方到底是什么。
// 三档必须穷尽：每项都拿到 clean / caution / keep 之一，且非 clean 必须给出人能读懂的理由。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { advise, ADVICE, ADVICE_LABELS } = await import('../core/advice.mjs')

const item = (over = {}) => ({
  id: 'ts.cache#1', title: '测试缓存', path: 'C:/x/cache', bytes: 1024,
  grade: 'green', blocked: null, executor: 'stage',
  explain: { what: '浏览器 HTTP 缓存', why: '删后浏览时会自动重建', rebuild: '自动重建 → 无需审批' },
  ...over,
})

test('W40：green + 可执行 + 未挡 → 可清理', () => {
  const r = advise(item())
  assert.equal(r.verdict, ADVICE.CLEAN)
  assert.equal(r.label, ADVICE_LABELS[ADVICE.CLEAN])
})

test('W40：yellow/blue 即便可执行也只是「谨慎」', () => {
  for (const grade of ['yellow', 'blue']) {
    const r = advise(item({ grade }))
    assert.equal(r.verdict, ADVICE.CAUTION, `${grade} 不应被判为可直接清理`)
    assert.ok(r.reason.length > 0, '谨慎必须给理由')
  }
})

test('W40：被挡 → 谨慎，并说明挡在哪', () => {
  const r = advise(item({ blocked: 'active' }))
  assert.equal(r.verdict, ADVICE.CAUTION)
  assert.match(r.reason, /active/)
})

test('W40：受保护 / 无执行器 → 不建议删除，且指出是什么', () => {
  for (const over of [{ grade: 'brown', executor: null }, { executor: null }]) {
    const r = advise(item(over))
    assert.equal(r.verdict, ADVICE.KEEP)
    assert.match(r.reason, /浏览器 HTTP 缓存|没有|受保护/)
  }
})

test('W40：理由不空——每一项都能回答「为什么」', () => {
  for (const over of [{}, { grade: 'yellow' }, { blocked: 'precondition' }, { grade: 'brown', executor: null }]) {
    const r = advise(item(over))
    assert.ok(typeof r.reason === 'string' && r.reason.trim().length > 0, `缺理由：${JSON.stringify(over)}`)
    assert.ok(Object.values(ADVICE).includes(r.verdict))
  }
})

test('W40：explain 缺失也不泄漏 undefined 进给人看的结论', () => {
  const r = advise(item({ explain: undefined, grade: 'brown', executor: null }))
  assert.equal(r.verdict, ADVICE.KEEP)
  assert.ok(!/undefined|null/.test(r.reason), `理由里出现了空值：${r.reason}`)
})
