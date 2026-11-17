// W44：扫描必须先问「清哪一侧」。domain 有静默默认值 => 插件替用户做决定。
// 实测两次踩到：一次我自己传 both、一次默认 tianshu，用户从未指定过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createTools } = await import('../tools/index.mjs')

const makeTools = () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-w44-'))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  return createTools({ stateDir: state, quarantineRoot: join(root, 'trash'), projectRoot: root })
}

test('W44：不指定 domain 且不整盘扫描 → 拒绝并提示必须选一侧', async () => {
  const t = makeTools()
  const scan = t.find((x) => x.name === 'disk_scan')
  const r = await scan.execute({ args: {} })
  assert.equal(r.isError, true, '缺少 domain 不能默默按天枢侧扫')
  assert.match(String(r.content), /SCAN_DOMAIN_REQUIRED/)
})

test('W44：schema 描述不再对 domain 声明默认值', () => {
  const t = makeTools()
  const scan = t.find((x) => x.name === 'disk_scan')
  const desc = String(scan.inputSchema.properties.domain.description)
  assert.ok(!/默认\s*tianshu/.test(desc), `描述里不该再有默认值：${desc}`)
  assert.match(desc, /必须显式指定/, '描述应要求调用方显式指定')
})

test('W44：显式指定 domain 后正常工作', async () => {
  const t = makeTools()
  const r = await t.find((x) => x.name === 'disk_scan').execute({ args: { domain: 'tianshu' } })
  assert.notEqual(r.isError, true, `显式指定应能扫描：${r.content}`)
  assert.match(String(r.content), /run_id=/)
})
