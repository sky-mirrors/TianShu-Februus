// W37：宿主注入契约。台账/隔离区/工作目录都由宿主给，不落在插件安装目录里。
// 安装目录是可替换的发行包（更新与卸载整目录替换），run 落盘与台账必须比它活得久；
// 且 dataDir 是宿主承诺的可写位置，插件的 fs 权限只在宿主授权路径内有意义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = Symbol.for('tianshu.tpi.plugin/v1')

globalThis.__tianshuTPI = {
  version: '1.0',
  defineTianshuPlugin: (spec) =>
    Object.freeze({ id: spec.id, activate: spec.activate, [BRAND]: Object.freeze({ tpi: '1.0' }) }),
}

const { default: plugin, pluginState } = await import('../index.js')
const { appendLedger } = await import('../core/ledger.mjs')

test('W37：pluginState 把宿主 dataDir 映射成 runs/ 与 trash/，cwd 作为工程根', () => {
  const dataDir = join(tmpdir(), 'ds-w37-data')
  assert.deepEqual(pluginState({ cwd: ROOT, storage: { dataDir: () => dataDir } }), {
    stateDir: join(dataDir, 'runs'),
    ledgerPath: join(dataDir, 'runs', 'ledger.jsonl'),
    quarantineRoot: join(dataDir, 'trash'),
    projectRoot: ROOT,
  })
})

test('W37：宿主不给 storage.dataDir() 时失败，不猜位置', () => {
  assert.throws(() => pluginState({}), /storage\.dataDir\(\)/)
  assert.throws(() => pluginState({ storage: {} }), /storage\.dataDir\(\)/)
})

test('W37：activate(host) 后工具读到的是宿主 dataDir 下的台账与隔离区', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-w37-'))
  const runs = join(dataDir, 'runs')
  mkdirSync(runs, { recursive: true })
  mkdirSync(join(dataDir, '.rivet'), { recursive: true })
  const batch = join(dataDir, 'trash', 'b-1')
  mkdirSync(batch, { recursive: true })
  writeFileSync(join(batch, 'a.txt'), 'x'.repeat(64))
  appendLedger(join(runs, 'ledger.jsonl'), {
    ts: Date.now(), batchId: 'b-1', action: 'stage', itemId: 'x#1',
    from: join(dataDir, 'orig'), to: batch, bytes: 64, undoSupported: true,
  })

  const { tools } = plugin.activate({ cwd: dataDir, storage: { dataDir: () => dataDir } })
  const status = tools.find((tool) => tool.name === 'disk_status')
  const out = String((await status.execute({})).content)

  // 台账在 dataDir/runs 里，隔离区在 dataDir/trash 里：两处都通，才说明 deps 真的注入了
  assert.match(out, /隔离区\s+1 批 \/ 1 项/, `隔离区应来自 ${dataDir}/trash，实际：\n${out}`)
  // cwd 注入：projectRivetHome 由 host.cwd 派生，dataDir/.rivet 存在即应显示“存在”
  assert.match(out, /projectRivetHome\s+存在/, `工程根应来自 host.cwd，实际：\n${out}`)
})
