// W42：路径匹配必须按 Windows 语义——大小写不敏感。
// 实测暴露：规则写 {{WINDIR}}/Temp（= C:\windows），真实目录是 C:\Windows，
// 旧实现逐字符比较 => 永远匹配不上，C:\Windows\Temp 被归成「未收录」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { matchRule } = await import('../core/run.mjs')

const vars = { WINDIR: 'C:\\windows', rivetHome: 'C:\\Users\\x\\.rivet' }

test('W42：盘符与目录大小写不同也算命中', () => {
  const rule = { id: 'sys.win-temp', match: { kind: 'prefix', path: '{{WINDIR}}/Temp' } }
  assert.ok(matchRule('C:\\Windows\\Temp', rule, vars), 'C:\\Windows 应命中 C:\\windows')
  assert.ok(matchRule('c:\\windows\\temp', rule, vars), '全小写路径也应命中')
})

test('W42：前缀边界不被吞（TempX 不算 Temp）', () => {
  const rule = { id: 'sys.win-temp', match: { kind: 'prefix', path: '{{WINDIR}}/Temp' } }
  assert.equal(matchRule('C:\\Windows\\TempX', rule, vars), null)
  assert.ok(matchRule('C:\\Windows\\Temp\\sub', rule, vars), '子路径应命中')
})

test('W42：天枢域既有规则不受影响（大小写混合仍命中）', () => {
  const rule = { id: 'ts.memory-db', match: { kind: 'prefix', path: '{{rivetHome}}/meridian.db' } }
  assert.ok(matchRule('C:\\Users\\x\\.rivet\\meridian.db', rule, vars))
})
