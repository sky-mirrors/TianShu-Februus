#!/usr/bin/env node
// 人工面：重启后释放隔离区空间。必须由人在终端确认（或显式 --yes + --by <name>）。
import { createInterface } from 'node:readline'
import { pluginStatePaths, defaultHostDataDir } from '../core/paths.mjs'
import { purgeBatch, quarantineStats } from '../core/executor.mjs'
import { fmtBytes } from '../core/probe.mjs'

// 与插件工具面同一处推导：状态目录在宿主数据目录下，不在安装目录里（见 core/paths.mjs）
const { ledgerPath, quarantineRoot } = pluginStatePaths(defaultHostDataDir())

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null }
const batchId = flag('batch')
const by = flag('by') ?? 'cli'
const yes = argv.includes('--yes')

if (!batchId) {
  const q = await quarantineStats({ ledgerPath, quarantineRoot })
  console.log(`隔离区：${q.batches} 批 / ${q.items} 项 / ${fmtBytes(q.bytes)} / 最老 ${q.oldestDays} 天`)
  console.log('用法：node bin/purge.mjs --batch <batchId> [--yes --by <你的名字>]')
  process.exit(0)
}

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((res) => rl.question(`永久删除批次 ${batchId}？不可撤销 [y/N] `, res))
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('已取消')
    process.exit(0)
  }
}

const r = await purgeBatch({ batchId, ledgerPath, quarantineRoot, approval: { issuer: 'human', confirmedBy: by } })
console.log(`已永久删除 ${r.purged} 项（batch ${r.batchId}）`)
