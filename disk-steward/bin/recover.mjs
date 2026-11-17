#!/usr/bin/env node
// 人工面：崩溃后补齐台账终态。只改台账，不移动、不删除任何文件（所以不需要 --yes）。
import { pluginStatePaths, defaultHostDataDir } from '../core/paths.mjs'
import { recoverBatch, pendingBatches } from '../core/executor.mjs'

// 与插件工具面同一处推导：状态目录在宿主数据目录下，不在安装目录里（见 core/paths.mjs）
const { ledgerPath } = pluginStatePaths(defaultHostDataDir())

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null }
const batchId = flag('batch')

if (!batchId) {
  const list = await pendingBatches({ ledgerPath })
  if (!list.length) {
    console.log('没有未决批次：台账里每一条 intent 都已有终态，无需恢复。')
    process.exit(0)
  }
  console.log(`发现 ${list.length} 个未决批次（有 intent、缺终态）：`)
  for (const b of list) {
    console.log(`  · ${b.batchId}  待判定 ${b.pendingItems} 项 / ${b.pendingFiles} 个文件 / 最后活动 ${new Date(b.lastTs).toISOString().slice(0, 19)}`)
  }
  console.log('用法：node bin/recover.mjs --batch <batchId>')
  process.exit(0)
}

const r = await recoverBatch({ ledgerPath, batchId })
const nothing = r.completed + r.aborted + r.inconsistent + r.fileCompleted + r.fileAborted === 0
if (nothing) {
  console.log(`批次 ${batchId} 没有未决条目，台账本就完整。`)
  process.exit(0)
}
console.log(`批次 ${batchId} 恢复完成：`)
console.log(`  已完成（补记 stage）     ${r.completed} 项`)
console.log(`  未移动（补记 abort）     ${r.aborted} 项`)
console.log(`  不一致（保留现场待人工） ${r.inconsistent} 项`)
console.log(`  文件粒度：补记 file-stage ${r.fileCompleted} / file-abort ${r.fileAborted}`)
console.log('只改了台账，没有移动或删除任何文件。')
