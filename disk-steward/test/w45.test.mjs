// W45：规则匹配需要 glob。实测：prefix 只在目录边界生效，
// `{{rivetHome}}/tool-stream` 匹配不到 `tool-stream-2026.jsonl`（后面不是 '/'），
// 于是用户级根目录下的一次性日志与归档文件全落进「未收录」，规则库够不着它们。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { matchRule } = await import('../core/run.mjs')

const vars = { rivetHome: 'C:/Users/x/.rivet' }

test('W45：glob 能命中同目录下的文件名模式', () => {
  const rule = { id: 'ts.tool-stream', match: { kind: 'glob', path: '{{rivetHome}}/tool-stream-*.jsonl' } }
  assert.equal(matchRule('C:\\Users\\x\\.rivet\\tool-stream-2026110.jsonl', rule, vars)?.id, 'ts.tool-stream')
  assert.equal(matchRule('C:/Users/x/.rivet/HANDOFF.md', rule, vars), null, '不同模式不应命中')
})

test('W45：glob 的 * 不跨目录', () => {
  const rule = { match: { kind: 'glob', path: '{{rivetHome}}/tool-stream-*.jsonl' } }
  assert.equal(matchRule('C:/Users/x/.rivet/sub/tool-stream-a.jsonl', rule, vars), null, '* 不能吃掉分隔符')
})

test('W45：glob 仍按 Windows 语义忽略大小写', () => {
  const rule = { match: { kind: 'glob', path: '{{rivetHome}}/HANDOFF-archive-*.md' } }
  assert.ok(matchRule('C:/users/x/.RIVET/handoff-archive-2026-09-24.md', rule, vars))
})

test('W45：prefix 语义不变（目录边界仍生效，回归）', () => {
  const rule = { match: { kind: 'prefix', path: '{{rivetHome}}/tmp' } }
  assert.ok(matchRule('C:/Users/x/.rivet/tmp', rule, vars))
  assert.ok(matchRule('C:/Users/x/.rivet/tmp/a.bin', rule, vars))
  assert.equal(matchRule('C:/Users/x/.rivet/tmp-a.bin', rule, vars), null, '同名前缀不算子目录')
})

test('W45：正则元字符被当字面量（不因文件名里的点/括号误匹配）', () => {
  const rule = { match: { kind: 'glob', path: '{{rivetHome}}/a.b*.jsonl' } }
  assert.ok(matchRule('C:/Users/x/.rivet/a.b1.jsonl', rule, vars))
  assert.equal(matchRule('C:/Users/x/.rivet/aXb1.jsonl', rule, vars), null, '点必须当字面量')
})
