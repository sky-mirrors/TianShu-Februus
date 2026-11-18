// W56：UNC 路径曾是 guard 的盲区——9 条正则全部锚定 `X:/...`，
// `\\localhost\C$\Windows\...` 一条都不匹配，两层判定（字符串 + realpath）都会放行。
// 立场与 guard.mjs 第 2 行一致：宁可多保护。UNC 不在白名单规则库里，拦掉不损失任何功能。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isDenied, denyCode, denyReason } = await import('../core/guard.mjs')

test('W56：UNC 路径一律视为受保护（fail-closed）', () => {
  const unces = [
    '\\\\localhost\\C$\\Windows\\System32',
    '//localhost/C$/Windows',
    '\\\\127.0.0.1\\c$\\windows',
    '\\\\nas\\share\\Users\\x\\Documents',
  ]
  for (const p of unces) {
    assert.equal(isDenied(p), true, `${p} 应被拦，实际放行`)
    assert.equal(denyCode(p), 'UNC', `${p} 的拒绝码应为 UNC，实际 ${denyCode(p)}`)
    assert.match(String(denyReason(p)), /UNC/, `拒绝理由应自带 UNC 标记：${denyReason(p)}`)
  }
})

test('W56：正常本地路径与相对路径不受这条规则影响', () => {
  const ok = [
    'C:/Users/x/AppData/Local/Temp',
    'D:/Februus/.rivet/scratch',
    '/tmp/foo',
    'relative/path',
  ]
  for (const p of ok) {
    assert.equal(isDenied(p), false, `${p} 不该被 UNC 规则误伤（实际 ${denyCode(p)}）`)
  }
})
