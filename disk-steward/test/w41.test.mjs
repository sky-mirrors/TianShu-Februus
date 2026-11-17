// W41：整盘 sweep。用户要的是「扫整个 C 盘，然后告诉我哪里是垃圾」——
// 只算顶层体积回答不了这个问题。这里把盘内目录递归枚举后逐个过规则库，
// 命中规则给分级与建议，未命中的按保护处理（并明确标 unmatched，不静默丢弃）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { sweepDrive } = await import('../core/sweep.mjs')

// 注入磁盘访问，测试不碰真实盘
const fakeTree = {
  'C:\\': { entries: [{ name: 'CacheA', dir: true }, { name: 'KeepMe', dir: true }, { name: 'tiny', dir: true }] },
  'C:\\CacheA': { entries: [{ name: 'a.bin', dir: false }] },
  'C:\\KeepMe': { entries: [{ name: 'doc.txt', dir: false }] },
  'C:\\tiny': { entries: [{ name: 'x.txt', dir: false }] },
}
const readdirFn = async (p) => {
  const node = fakeTree[p]
  if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return node.entries.map((e) => ({ name: e.name, isDirectory: () => e.dir, isSymbolicLink: () => false }))
}
const measureFn = async (p) => {
  if (p === 'C:\\CacheA') return { bytes: 10 * 1024 * 1024, partial: false }
  if (p === 'C:\\KeepMe') return { bytes: 20 * 1024 * 1024, partial: false }
  if (p === 'C:\\tiny') return { bytes: 1024, partial: false }
  return { bytes: 0, partial: false }
}
const rules = [
  { id: 'sys.cache-a', grade: 'green', match: { kind: 'prefix', path: 'C:/CacheA' }, executor: { type: 'stage' }, explain: { what: 'A 缓存', why: '可重建' } },
]

const run = await sweepDrive({
  root: 'C:\\',
  depth: 2,
  rules,
  vars: {},
  minBytes: 1024 * 1024,
  readdirFn,
  measureFn,
  isDeniedFn: () => false,
  clock: () => 0,
})

test('W41：命中规则的目录给出分级与建议', () => {
  const a = run.candidates.find((c) => c.path.endsWith('CacheA'))
  assert.ok(a, '应枚举到 CacheA')
  assert.equal(a.grade, 'green')
  assert.equal(a.advice.verdict, 'clean')
  assert.match(a.advice.reason, /A 缓存/)
})

test('W41：未命中规则的目录不当垃圾，但路径要交出来（供补规则）', () => {
  assert.equal(run.candidates.some((c) => c.path.endsWith('KeepMe')), false, '未命中规则不得进候选')
  assert.ok(run.unmatched.some((p) => p.endsWith('KeepMe')), '未命中的路径必须列出')
})

test('W41：未命中的小目录也不进候选（体积阈值只作用于命中项）', () => {
  assert.equal(run.candidates.some((c) => c.path.endsWith('tiny')), false)
  assert.ok(run.unmatched.some((p) => p.endsWith('tiny')), '未命中就是未收录，与大小无关')
})

test('W41：禁区路径不进候选，只登记', () => {
  const r = sweepDrive({
    root: 'C:\\', depth: 1, rules, vars: {}, minBytes: 0, readdirFn, measureFn,
    isDeniedFn: (p) => p.endsWith('KeepMe'),
    denyReasonFn: () => 'DENIED_TEST',
    clock: () => 0,
  })
  return r.then((res) => {
    assert.equal(res.candidates.some((c) => c.path.endsWith('KeepMe')), false)
    assert.ok(res.denied.some((d) => d.reason === 'DENIED_TEST'))
  })
})

test('W41：预算耗尽时标记 truncated，明确「没测完」而不是当作已完成', async () => {
  let t = 0
  const res = await sweepDrive({
    root: 'C:\\', depth: 2, rules, vars: {}, minBytes: 0, readdirFn, measureFn,
    isDeniedFn: () => false, clock: () => (t += 10000), budgetMs: 1,
  })
  assert.equal(res.truncated, true)
})

test('W41：系统目录允许只读测量与遍历（看得见），但永不进执行列表（动不了）', async () => {
  const tree = async (p) => {
    if (p === 'C:\\') return [{ name: 'Windows', isDirectory: () => true, isSymbolicLink: () => false }]
    if (p === 'C:\\Windows') return [{ name: 'Temp', isDirectory: () => true, isSymbolicLink: () => false }]
    return []
  }
  const res = await sweepDrive({
    root: 'C:\\',
    depth: 2,
    rules: [{
      id: 'sys.win-temp', grade: 'green', match: { kind: 'prefix', path: 'C:/Windows/Temp' },
      executor: { type: 'stage' }, reason: 'Windows 临时目录',
    }],
    vars: {},
    minBytes: 0,
    readdirFn: tree,
    measureFn: async () => ({ bytes: 12345678, partial: false }),
    isDeniedFn: (p) => /^c:\\windows(\\)?/i.test(String(p).replace(/\//g, '\\')),
    denyReasonFn: () => 'WINDOWS_DIR: Windows 系统目录',
    clock: () => 0,
  })
  assert.ok(res.denied.length > 0, '系统目录仍要登记为禁区（审计需要）')
  const hit = res.candidates.find((c) => /temp$/i.test(c.path))
  assert.ok(hit, '系统目录必须能被看见：枚举 + 测体积')
  assert.equal(hit.executor, null, '看得见 ≠ 能执行：executor 必须为空')
  assert.equal(hit.advice.verdict, 'keep', '建议应落在「不建议删除」')
})

test('W41：同一规则命中父子目录时只报父一次（避免同一份数据重复计数）', async () => {
  const tree = async (p) => {
    if (p === 'C:\\') return [{ name: 'A', isDirectory: () => true, isSymbolicLink: () => false }]
    if (p === 'C:\\A') return [{ name: 'sub', isDirectory: () => true, isSymbolicLink: () => false }]
    if (p === 'C:\\A\\sub') return [{ name: 'sub2', isDirectory: () => true, isSymbolicLink: () => false }]
    return []
  }
  const res = await sweepDrive({
    root: 'C:\\',
    depth: 3,
    rules: [{ id: 'r.a', grade: 'green', match: { kind: 'prefix', path: 'C:/A' }, executor: { type: 'stage' }, reason: '测试目录' }],
    vars: {},
    minBytes: 0,
    readdirFn: tree,
    measureFn: async () => ({ bytes: 1000, partial: false }),
    isDeniedFn: () => false,
    clock: () => 0,
  })
  const hits = res.candidates.filter((c) => c.ruleId === 'r.a')
  assert.equal(hits.length, 1, `同一规则应只报父一次，实际 ${hits.length} 条：${hits.map((h) => h.path).join(', ')}`)
  assert.match(hits[0].path, /A$/, '报的应是父目录')
})
