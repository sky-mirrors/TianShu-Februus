// W33：TPI 1.0 入口契约。桌面端天枢 4.0.1 的 loadTpiPlugin 要求入口 default/plugin 导出
// defineTianshuPlugin(...) 的结果；只 `export const tools` 会被判 rejected_handshake，
// 插件中心能显示但工具面永远是空的（真机实测：discoverTpiPlugins → rejected_handshake）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 宿主在 import 插件入口之前调用 installTpiGlobalSdk() 注入这个全局对象；
// 品牌是 Symbol.for('tianshu.tpi.plugin/v1')，与宿主模块内是同一个 symbol。
const BRAND = Symbol.for('tianshu.tpi.plugin/v1')
globalThis.__tianshuTPI = {
  version: '1.0',
  defineTianshuPlugin: (spec) =>
    Object.freeze({ id: spec.id, activate: spec.activate, [BRAND]: Object.freeze({ tpi: '1.0' }) }),
}

// activate 需要宿主提供的 storage（状态目录）。这里只做握手，用临时目录，不碰真实数据。
const HOST = { cwd: ROOT, storage: { dataDir: () => join(tmpdir(), 'ds-w33') } }

const mod = await import('../index.js')
const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))

test('W33：默认导出是 TPI 1.0 定义（宿主 isTianshuPluginDefinition 通过）', () => {
  const def = mod.default
  assert.equal(def?.[BRAND]?.tpi, '1.0', '缺少 Symbol.for(tianshu.tpi.plugin/v1) 品牌')
  assert.equal(typeof def?.activate, 'function', '缺少 activate 函数')
  assert.equal(def.id, manifest.id)
})

test('W33：activate 返回的工具名与 manifest contributes.tools 一一对应', () => {
  const { tools } = mod.default.activate(HOST)
  const declared = manifest.contributes.tools.map((t) => t.name).sort()
  assert.deepEqual(tools.map((t) => t.name).sort(), declared)
})

test('W33：activate 返回的工具提供宿主 wrapTpiTool 读取的字段', () => {
  const { tools } = mod.default.activate(HOST)
  for (const t of tools) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
    assert.equal(t.inputSchema?.type, 'object', `${t.name} 缺少 inputSchema`)
    assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`)
  }
})

test('W33：清单声明宿主版本范围（发行记录要与它一致，缺失则打包器直接拒绝）', () => {
  assert.equal(typeof manifest.engines?.tianshu, 'string')
  assert.match(manifest.engines.tianshu, /^>=4\.0\.2 <5\.0\.0$/)
})

test('W33：用了宿主 storage 就必须声明 storage 能力', () => {
  assert.ok(manifest.capabilities.includes('storage'), 'activate 依赖 host.storage.dataDir()')
})
