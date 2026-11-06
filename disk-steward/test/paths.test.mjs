// 回归测试：Windows 上同一路径可能以 \ 或 / 出现，匹配不能因此失效。
// 这是自检时抓到的真 bug（disk_rules 对 C:/.../meridian.db 返回"未命中任何规则"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRule } from '../core/run.mjs'

const rule = {
  id: 'ts.memory-db',
  match: { kind: 'prefix', path: '{{rivetHome}}/meridian.db' },
  grade: 'brown',
  reason: '主库保护',
}

test('反斜杠路径也能命中规则（不因分隔符风格失配）', () => {
  const vars = { rivetHome: 'C:\\Users\\x\\.rivet' }
  assert.equal(matchRule('C:\\Users\\x\\.rivet\\meridian.db', rule, vars)?.id, 'ts.memory-db')
})

test('正斜杠与混合斜杠都能命中', () => {
  const vars = { rivetHome: 'C:\\Users\\x\\.rivet' }
  assert.equal(matchRule('C:/Users/x/.rivet/meridian.db', rule, vars)?.id, 'ts.memory-db')
  assert.equal(matchRule('C:\\Users\\x\\.rivet/meridian.db', rule, vars)?.id, 'ts.memory-db')
})

test('相邻同名前缀不算命中（避免 meridian.db 命中 meridian.db-wal 之外的误判）', () => {
  const vars = { rivetHome: 'C:\\Users\\x\\.rivet' }
  assert.equal(matchRule('C:\\Users\\x\\.rivet\\meridian.db-wal', rule, vars), null)
})
