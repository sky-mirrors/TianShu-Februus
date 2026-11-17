#!/usr/bin/env node
// 文本面板原型：真扫本机，渲染"清理前列全 + 逐项解释"的视图。
// 只读，不执行任何删除（W0/W1 范围）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pluginStatePaths, defaultHostDataDir } from '../core/paths.mjs'
import { loadRules } from '../core/rules.mjs'
import { buildRun } from '../core/run.mjs'
import { renderTable, renderDetail } from '../render/table.mjs'
import { fmtBytes } from '../core/probe.mjs'
import { tianshuVars } from '../domains/tianshu.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

export async function scan({ projectRoot = process.cwd(), writeRun = true } = {}) {
  const rules = loadRules(JSON.parse(readFileSync(join(root, 'rules', 'tianshu.rules.json'), 'utf8')))
  const vars = tianshuVars({ projectRoot })
  const run = await buildRun({ rules, vars })
  if (writeRun) {
    // run 落盘进宿主数据目录（core/paths.mjs），不写插件安装目录
    const dir = pluginStatePaths(defaultHostDataDir()).stateDir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run, null, 1))
  }
  return run
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const run = await scan({ projectRoot: process.argv[2] })
  const lines = renderTable(run, { cursor: 0, selected: new Set() })
  console.log(lines.join('\n'))
  const t = run.totals
  console.log(
    `\n可释放（可勾选项）= ${fmtBytes(t.selectableBytes)}，另有 ${run.unmatched.length} 个未匹配路径按保护处理`,
  )
  const biggest = [...run.items].filter((i) => i.grade !== 'brown').sort((a, b) => b.bytes - a.bytes)[0]
  if (biggest) {
    console.log(`\n详情示例（选中最大项）：`)
    console.log(renderDetail(biggest).map((l) => '  ' + l).join('\n'))
  }
  const prot = run.items.filter((i) => i.grade === 'brown')
  if (prot.length) {
    console.log(`\n被保护（默认不勾选）：` + prot.map((p) => `${p.title} ${fmtBytes(p.bytes)}`).join(' | '))
  }
}
