#!/usr/bin/env node
// TUI 面板：勾选 → 预览计划 →（显式 --allow-exec 才真正执行）→ 撤销。
// 默认只读：不加 --allow-exec 时，x/u 也只会打印将要发生什么。
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadRules } from '../core/rules.mjs'
import { buildRun } from '../core/run.mjs'
import { createPlan } from '../core/plan.mjs'
import { stage, undo } from '../core/executor.mjs'
import { scanSystem } from '../domains/system.mjs'
import { fmtBytes } from '../core/probe.mjs'
import { tianshuVars } from '../domains/tianshu.mjs'
import { createSession, handleKey, renderFrame } from '../render/tui.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ledgerPath = join(root, '.runs', 'ledger.jsonl')
const quarantineRoot = join(root, '.trash')

const argv = process.argv.slice(2)
/** @returns {string | null} */
const opt = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return null
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}
const allowExec = argv.includes('--allow-exec')      // 真正执行；不加则只预览
const onlyProject = argv.includes('--only-project')   // 安全阀：只看项目域，绝不触碰 ~/.rivet
const withSystem = argv.includes('--with-system')     // 系统域：需 x→确认→y 才会真正执行
const script = opt('script')
const projectRoot = opt('project') || process.cwd()

async function loadRun() {
  const rules = loadRules(JSON.parse(readFileSync(join(root, 'rules', 'tianshu.rules.json'), 'utf8')))
  const base = await buildRun({ rules, vars: tianshuVars({ projectRoot }) })
  let run = base
  if (withSystem) {
    const sys = await scanSystem({ execEnabled: true })
    run = { ...base, items: [...base.items, ...sys.items], domain: 'both', totals: { ...base.totals, items: base.items.length + sys.items.length } }
  }
  if (!onlyProject) return run
  const projRoot = join(projectRoot, '.rivet').toLowerCase()
  // 系统域项不属于项目目录，--with-system 时必须放行，否则会被一起过滤掉
  const items = run.items.filter((i) => i.path.toLowerCase().startsWith(projRoot) || String(i.ruleId ?? '').startsWith('sys.'))
  return { ...run, items, totals: { items: items.length, selectable: items.filter((i) => !i.blocked && i.grade !== 'brown' && i.executor).length } }
}

async function main() {
  const run = await loadRun()
  let s = createSession(run)
  let lastBatch = null
  const log = []

  const apply = async (action) => {
    if (action.type === 'confirm') return `请确认：将删除 ${action.itemIds.length} 项（按 y 确认 / n 取消）`
    if (action.type === 'cancel') return '已取消，未做任何操作'
    if (action.type === 'plan') {
      if (!action.itemIds.length) return '未勾选任何项'
      try {
        const plan = createPlan({ run, itemIds: action.itemIds, issuer: 'human', confirmedBy: 'tui' })
        const willFree = plan.items.reduce((n, i) => n + (i.bytes ?? 0), 0)
        return `计划 ${plan.planId}：${plan.items.length} 项 / ${fmtBytes(willFree)}（令牌 ${plan.token.slice(0, 8)}…）`
      } catch (e) {
        return `计划被拒绝：${e.code}`
      }
    }
    if (action.type === 'stage') {
      if (!action.itemIds.length) return '未勾选任何项'
      if (!allowExec) return `预览：将把这 ${action.itemIds.length} 项移入隔离区（加 --allow-exec 才真正执行）`
      const plan = createPlan({ run, itemIds: action.itemIds, issuer: 'human', confirmedBy: 'tui' })
      const r = await stage({ plan, token: plan.token, items: plan.items, quarantineRoot, ledgerPath })
      lastBatch = r.batchId
      return `已移入隔离区 batch=${r.batchId}（${r.staged} 项）——按 u 可撤销`
    }
    if (action.type === 'undo') {
      if (!lastBatch) return '本会话没有可撤销的批次'
      if (!allowExec) return `预览：将撤销批次 ${lastBatch}（加 --allow-exec 才真正执行）`
      const r = await undo({ batchId: lastBatch, ledgerPath })
      return `已撤销 ${r.restored} 项${r.skipped.length ? `，跳过 ${r.skipped.length} 项` : ''}`
    }
    return null
  }

  const step = async (key) => {
    const { state, action } = handleKey(s, key)
    s = state
    const msg = await apply(action)
    if (msg) {
      s = { ...s, message: msg }
      log.push(msg)
    }
    return action.type
  }

  if (script) {
    for (const key of script) {
      if (key === '\\') continue
      const t = await step(key === '_' ? ' ' : key)
      if (t === 'quit') break
    }
    console.log(renderFrame(s).join('\n'))
    if (log.length) console.log('\n动作记录：\n' + log.map((m) => '  · ' + m).join('\n'))
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  if (process.stdin.isTTY) rl.setPrompt('')
  const draw = () => {
    process.stdout.write('\x1b[2J\x1b[H' + renderFrame(s).join('\n') + '\n')
  }
  draw()
  rl.on('keypress', async (_str, key) => {
    if (!key) return
    const map = { space: ' ', return: 'p' }
    const k = map[key.name] ?? key.name
    if (k === 'q') { rl.close(); return }
    const t = await step(k)
    draw()
    if (t === 'quit') rl.close()
  })
}

main().catch((e) => {
  console.error('TUI 启动失败：', e.message)
  process.exitCode = 1
})
