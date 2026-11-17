// TPI 工具面：只有读与规划，没有执行（不变量 I4）。执行留给 W2 的 disk_exec。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pluginStatePaths, defaultHostDataDir } from '../core/paths.mjs'
import { matchApproval } from '../core/approval.mjs'
import { bucketAdvice } from '../core/advice.mjs'
import { sweepDrive } from '../core/sweep.mjs'
import { loadRules } from '../core/rules.mjs'
import { buildRun, resolveVars, matchRule, computeTotals } from '../core/run.mjs'
import { fmtBytes } from '../core/probe.mjs'
import { createPlan, isStageable } from '../core/plan.mjs'
import { stage, purge, undo, quarantineStats, quarantinePolicy, EXEC_ERRORS } from '../core/executor.mjs'
import { renderReport, renderDiff } from '../render/report.mjs'
import { diffRuns, summarizeDiff } from '../core/diff.mjs'
import { tianshuVars } from '../domains/tianshu.mjs'
import { scanSystem, systemRules, systemVars } from '../domains/system.mjs'
import { listDrives } from '../core/drives.mjs'
import { scanDrives } from '../domains/drives.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 默认落宿主数据目录，不是插件安装目录（安装目录是可替换的发行包）。
// 真实宿主的 activate(host) 注入 host.storage.dataDir()（见 index.js）；
// 这里的默认值只给非宿主调用（测试、bin/ 下的 CLI）。
const { stateDir, ledgerPath, quarantineRoot } = pluginStatePaths(defaultHostDataDir())
const plans = new Map() // planId -> plan（进程内；令牌一次性、10 分钟过期）
const readRules = () => loadRules(JSON.parse(readFileSync(join(root, 'rules', 'tianshu.rules.json'), 'utf8')))

export function createTools(deps = {}) {
  const projectRoot = () => deps.projectRoot || process.cwd()
  // 路径可注入：默认落插件目录，测试/演练可指向临时目录（隔离真实数据）
  const state = deps.stateDir ?? stateDir
  const ledger = deps.ledgerPath ?? join(state, 'ledger.jsonl')
  const quarantine = deps.quarantineRoot ?? quarantineRoot
  // 保留期/容量阈值可注入：默认走 quarantinePolicy 自身的默认值
  const policyOptions = deps.quarantinePolicyOptions ?? {}
  // 批准证据来源（宿主会话记录）。缺失时返回 null → 执行类工具 fail-closed。
  const approvalEvidence = deps.approvalEvidence

  return [
    {
      name: 'disk_scan',
      description: '只读扫描天枢两域磁盘占用，返回 run_id 与体积最大的若干项（全量落 .runs/<run_id>.json，再用 disk_plan 选择要清理的项）。不做任何删除。',
      inputSchema: {
        type: 'object',
        properties: {
          minBytes: { type: 'number', description: '只返回大于该字节数的项，默认 1MB' },
          domain: { type: 'string', enum: ['tianshu', 'system', 'both'], description: '必须显式指定：tianshu=天枢自有数据（~/.rivet 与项目 .rivet）/ system=操作系统缓存与临时目录 / both=两侧。插件不提供默认值——清哪一侧是用户的选择，不能由调用方替用户猜。仅整盘扫描（fullDrive）时可省略' },
          includeSamples: { type: 'boolean', description: '默认 false：结果里的 item.samples 一律清空、不写真实文件名；显式 true 才记录样本文件名（会随 run 落盘）' },
          allDrives: { type: 'boolean', description: '默认 false：为 true 时额外扫描当前设备上的全部盘（盘级容量 + 每盘顶层条目），结果挂在 run.drives' },
          driveDepth: { type: 'string', enum: ['summary', 'deep'], description: '配合 allDrives：summary 只列顶层条目（秒级）；deep 对顶层项逐个 measure 出占用排序，受 budgetMs 预算约束' },
          systemExec: { type: 'boolean', description: '默认 false：系统域只读——扫描、分级、解释，但不给任何项签发执行器（与 w4 不变量一致）。显式 true 才给非保护且未被挡的项 stage 执行器' },
          fullDrive: { type: 'string', description: '整盘扫描：盘符如 "C" 或路径。递归枚举盘内目录逐个过规则库，命中规则给分级与建议，未命中的仍报出体积但 advice=不建议删除（不当作垃圾）。与 domain 独立' },
          sweepDepth: { type: 'number', description: '配合 fullDrive：递归深度，默认 2（盘根 + 下两层）' },
          sweepBudgetMs: { type: 'number', description: '配合 fullDrive：整盘扫描预算毫秒，默认 120000；超预算标 truncated，不假装扫完了' },
        },
      },
      concurrencySafe: true,
      timeoutMs: 60000,
      async execute(call) {
        const min = Number(call?.args?.minBytes ?? 1048576)
        // 清哪一侧由用户决定：不提供默认值。缺省直接拒绝，逼调用方先去问。
        // fullDrive 是另一套口径（整盘），此时 domain 只用于摘要标注。
        const domain = call?.args?.domain ?? (call?.args?.fullDrive === undefined ? null : 'both')
        if (!domain) {
          return {
            content: 'SCAN_DOMAIN_REQUIRED: 必须先问用户要清哪一侧——domain="tianshu"（天枢自有数据）/ "system"（操作系统缓存与临时目录）/ "both"（两侧）。插件不替你选。',
            isError: true,
          }
        }
        const rules = readRules()
        const vars = {
          ...tianshuVars({ projectRoot: projectRoot() }),
          ...(call?.args?.includeSamples === true ? { includeSamples: true } : {}),
        }
        const run = await buildRun({
          rules,
          vars,
          // 增量索引：指纹命中或 60s 内复用；过期秒数会写进 item，plan 层据此拒绝
          refIndexDeps: { cachePath: join(state, 'refcache.json'), ttlMs: 60000 },
        })

        // 整盘扫描不分域：全盘口径下系统缓存（Edge/Temp 等）就是盘里的东西，
        // 而它们的真实路径在第 7~10 层，靠加深 sweep 深度去够代价是分钟级——
        // 系统域本来就直接测这些白名单目标，所以 fullDrive 时一并纳入。
        const sys = domain === 'tianshu' && call?.args?.fullDrive === undefined
          ? null
          : await scanSystem({ execEnabled: call?.args?.systemExec === true })
        const extra = sys
          ? `\n[系统域] ${sys.items.length} 项 / ${fmtBytes(sys.totals.bytes)}，可执行项需 disk_plan + 人工批准；` +
            `禁区拦截 ${sys.denied.length} 条` +
            (sys.denied.length ? '：' + sys.denied.map((d) => d.reason.split(':')[0]).join('、') : '')
          : ''
        const driveScan = call?.args?.allDrives === true
          ? await scanDrives({ deep: call?.args?.driveDepth === 'deep' })
          : null
        const merged = driveScan
          ? { ...mergeDomainRun({ run, sys, domain }), drives: driveScan }
          : mergeDomainRun({ run, sys, domain })
        const items = merged.items
        const top = items
          .filter((i) => i.bytes >= min)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 20)
          .map((i) => ({ id: i.id, title: i.title, path: i.path, bytes: i.bytes, grade: i.grade, blocked: i.blocked, executor: i.executor }))
        const summary =
          `扫描完成 run_id=${merged.runId}（域 ${domain}）\n` +
          `共 ${items.length} 项 / 可勾选 ${merged.totals.selectable} 项（${fmtBytes(merged.totals.selectableBytes)}）/ ` +
          `被挡 ${merged.totals.blocked} 项 / 受保护 ${items.filter((i) => i.grade === 'brown').length} 项 / ` +
          `未收录路径 ${merged.unmatched.length} 个（按保护处理）` +
          extra +
          (driveScan
            ? `\n[全部盘] ${driveScan.drives.length} 个盘：` +
              driveScan.drives
                .map((d) => `${d.letter} ${fmtBytes(d.freeBytes)}/${fmtBytes(d.totalBytes)} 可用` + (d.readError ? `（读取失败 ${d.readError}）` : ''))
                .join('｜') +
              `；深扫=${driveScan.deep}` +
              (driveScan.deep ? `｜顶层项合计 ${driveScan.drives.reduce((n, d) => n + d.topTotal, 0)}，未测 ${driveScan.drives.reduce((n, d) => n + d.unmeasured, 0)}` : '') +
              (driveScan.denied.length ? `｜禁区拦截 ${driveScan.denied.length} 条` : '')
            : '')
        // 整盘扫描（与两域独立）：回答「这块盘里哪里是垃圾」
        const sweep = call?.args?.fullDrive
          ? await sweepDrive({
              root: /^[A-Za-z]:?[\\/]?$/.test(String(call.args.fullDrive)) ? `${String(call.args.fullDrive)[0].toUpperCase()}:\\` : String(call.args.fullDrive),
              depth: Number(call.args.sweepDepth ?? 2),
              // 整盘扫描要同时用两套规则：只给天枢规则会让 C:\tmp 这类系统目录落进「未收录」
              rules: [...rules, ...systemRules()],
              vars: { ...vars, ...systemVars() },
              budgetMs: Number(call.args.sweepBudgetMs ?? 120000),
            })
          : null
        // 整盘画像也要落盘：否则只能活在一屏终端输出里——不能归档，也不能与下次扫描对比
        saveRun(state, sweep ? { ...merged, sweep } : merged)
        // 建议层：分级不是结论。用户要的是「这个删不删、不删的话它到底是什么」
        const advice = bucketAdvice(merged.items)
        const adviceSection = [
          `[建议] 建议清理 ${advice.clean.length} 项 / 谨慎 ${advice.caution.length} 项 / 不建议删除 ${advice.keep.length} 项`,
          ...[...advice.clean, ...advice.caution, ...advice.keep]
            .sort((a, b) => (b.item.bytes ?? 0) - (a.item.bytes ?? 0))
            .slice(0, 12)
            .map((a) => `· [${a.label}] ${a.item.title} ${fmtBytes(a.item.bytes ?? 0)} — ${a.reason}`),
        ].join('\n')
        const sweepSection = sweep
          ? [
              `[整盘] ${sweep.root} 深度 ${sweep.depth}｜扫了 ${sweep.scanned} 个目录｜候选 ${sweep.candidatesTotal} 项｜未收录 ${sweep.unmatched.length} 个路径按保护处理${sweep.truncated ? '｜预算已用尽（后续未测）' : ''}`,
              ...sweep.candidates.slice(0, 15).map((c) => `· [${c.advice.label}] ${c.title} ${fmtBytes(c.bytes ?? 0)} — ${c.advice.reason}｜${c.path}`),
            ].join('\n')
          : ''
        return { content: `${summary}\n${adviceSection}${sweepSection ? '\n' + sweepSection : ''}\n${JSON.stringify(top, null, 1)}` }
      },
    },
    {
      name: 'disk_status',
      description: '轻量概览：磁盘可用空间 + 天枢两域关键目录是否存在。不做递归遍历。',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: true,
      timeoutMs: 5000,
      async execute() {
        const vars = tianshuVars({ projectRoot: projectRoot() })
        const out = []
        const drives = await listDrives()
        if (!drives.length) out.push('磁盘：未发现任何盘（全部盘符 statfs 均失败）')
        for (const d of drives) {
          const usedPct = d.totalBytes ? Math.round((d.usedBytes / d.totalBytes) * 100) : 0
          out.push(
            `磁盘 ${d.letter}  ${fmtBytes(d.totalBytes)} 共 / ${fmtBytes(d.freeBytes)} 可用  (已用 ${usedPct}%)`,
          )
        }
        const fs = await import('node:fs/promises')
        for (const key of ['rivetHome', 'projectRivetHome', 'tmpDir']) {
          const ok = await fs.stat(vars[key]).then(() => true).catch(() => false)
          out.push(`${key.padEnd(18)} ${ok ? '存在' : '不存在'}  ${vars[key]}`)
        }
        try {
          // stats 提供条目数/最老天数；policy 提供保留期与容量阈值判定（两者都只读台账）
          const q = await quarantineStats({ ledgerPath: ledger, quarantineRoot: quarantine })
          const p = await quarantinePolicy({ ledgerPath: ledger, quarantineRoot: quarantine, ...policyOptions })
          const alerts = [
            p.expiredBatches.length ? `过期 ${p.expiredBatches.length} 批（>${p.retentionDays} 天）` : '',
            p.overLimit ? `超限 ${fmtBytes(p.bytes)} > ${fmtBytes(p.maxBytes)}` : '',
          ].filter(Boolean)
          out.push(
            `隔离区              ${q.batches} 批 / ${q.items} 项 / ${fmtBytes(q.bytes)} / 最老 ${q.oldestDays} 天` +
              (q.items ? '（永久删除走 disk_exec mode=purge，需人工批准）' : '') +
              (alerts.length ? '｜' + alerts.join('｜') : ''),
          )
        } catch (e) {
          out.push(`隔离区              读取失败：${e.code ?? e.message}`)
        }
        return { content: out.join('\n') }
      },
    },
    {
      name: 'disk_rules',
      description: '解释规则库：某路径命中哪条规则、为什么是该分级；未命中则说明按保护处理。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '要解释的路径（可选）' } },
        required: [],
      },
      concurrencySafe: true,
      timeoutMs: 3000,
      async execute(call) {
        const rules = readRules()
        const vars = tianshuVars({ projectRoot: projectRoot() })
        const target = call?.args?.path
        if (target) {
          const hit = rules.find((r) => matchRule(target, r, vars))
          if (!hit) return { content: `未命中任何规则 → 按保护处理（brown），不会出现在可清理清单里` }
          return {
            content: `${hit.id} → ${hit.grade}\n理由：${hit.reason}\n执行方式：${hit.executor ? hit.executor.type : '受保护，无执行分支'}`,
          }
        }
        return {
          content: rules
            .map((r) => `${r.id.padEnd(20)} ${r.grade.padEnd(7)} ${r.executor ? r.executor.type.padEnd(8) : 'protected'} ${r.title ?? ''}`)
            .join('\n'),
        }
      },
    },
    {
      name: 'disk_report',
      description: '把一次扫描渲染成可归档的 Markdown 报告（列全量条目 + 逐项解释），落 .runs/<run_id>.md。只读。',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      concurrencySafe: true,
      timeoutMs: 5000,
      async execute(call) {
        try {
          const run = loadRun(state, call.args.runId)
          const md = renderReport(run)
          const out = join(state, `${run.runId}.md`)
          writeFileSync(out, md, 'utf8')
          const head = md.split('\n').slice(0, 10).join('\n')
          return { content: `报告已生成：${out}（${md.length} 字符）\n\n${head}\n…` }
        } catch (e) {
          return { content: `${e.code ?? 'ERROR'}: ${e.message}`, isError: true }
        }
      },
    },
    {
      name: 'disk_diff',
      description: '对比两次扫描的增量（按路径对齐）：变大/变小/新增/消失。只读，可选写一份对比 Markdown。',
      inputSchema: {
        type: 'object',
        properties: {
          runIdA: { type: 'string' },
          runIdB: { type: 'string' },
          write: { type: 'boolean', description: 'true 时落 .runs/diff-<A>-<B>.md' },
        },
        required: ['runIdA', 'runIdB'],
      },
      concurrencySafe: true,
      timeoutMs: 10000,
      async execute(call) {
        try {
          const a = loadRun(state, call.args.runIdA)
          const b = loadRun(state, call.args.runIdB)
          const d = diffRuns(a, b)
          let extra = ''
          if (call.args.write) {
            const md = renderDiff(d, { prevRunId: a.runId, nextRunId: b.runId })
            const out = join(state, `diff-${a.runId}-${b.runId}.md`)
            writeFileSync(out, md, 'utf8')
            extra = `\n报告：${out}`
          }
          return { content: `对比 ${a.runId} → ${b.runId}\n${summarizeDiff(d)}${extra}` }
        } catch (e) {
          return { content: `${e.code ?? 'ERROR'}: ${e.message}`, isError: true }
        }
      },
    },
    {
      name: 'disk_plan',
      description: '把勾选项变成执行计划并签发一次性令牌。保护项/被挡项会被拒绝。计划本身不执行：先把它逐项给用户看，取得明确同意后再调 disk_exec。',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' } } },
        required: ['runId', 'itemIds'],
      },
      concurrencySafe: true,
      timeoutMs: 5000,
      async execute(call) {
        try {
          const run = loadRun(state, call.args.runId)
          const plan = createPlan({ run, itemIds: call.args.itemIds })
          plans.set(plan.planId, plan)
          const willFree = plan.items.reduce((s, i) => s + (i.bytes ?? 0), 0)
          return {
            content:
              `计划已生成 plan_id=${plan.planId}\n可释放 ${fmtBytes(willFree)} / 共 ${plan.items.length} 项\n` +
              `令牌 ${plan.token}（一次性，10 分钟内有效）\n` +
              plan.items.map((i) => `  · ${i.title} ${fmtBytes(i.bytes)} ← ${i.path}`).join('\n'),
          }
        } catch (e) {
          return { content: `${e.code ?? 'ERROR'}: ${e.message}`, isError: true }
        }
      },
    },
    {
      name: 'disk_exec',
      description: '执行计划。mode=stage 移入隔离区（可撤销）；mode=purge 永久删除，需同一计划的令牌且批次已 staged。执行前必须在对话中征得用户明确同意，并把用户的原话放进 approval——缺 approval 一律拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string' },
          token: { type: 'string' },
          mode: { type: 'string', enum: ['stage', 'purge'] },
          batchId: { type: 'string' },
          approval: { type: 'string', description: '用户在本轮对话中明确同意执行的原话（例如「批准」）。这是「人批准过」这个事实的唯一来源：缺失即拒绝执行，不要自行填写。' },
        },
        required: ['planId', 'token', 'mode'],
      },
      concurrencySafe: false,
      timeoutMs: 120000,
      async execute(call) {
        const plan = plans.get(call?.args?.planId)
        if (!plan) return { content: 'EXEC_PLAN_NOT_FOUND: 请重新 disk_plan', isError: true }
        // 边界："人批准过"只能从会话记录里核实（approval 是模型能填的字符串，单看非空等于自批）
        const check = matchApproval({ approval: call?.args?.approval, messages: approvalEvidence?.() })
        if (check.ok !== true) {
          return { content: `${check.code}: ${check.reason}——先把计划逐项给用户看并取得同意；approval 必须逐字取自本会话里用户自己发的消息`, isError: true }
        }
        const approved = { ...plan, issuer: 'human', confirmedBy: `chat:${check.quote}` }
        try {
          if (call.args.mode === 'stage') {
            const r = await stage({ plan: approved, token: call.args.token, items: plan.items, quarantineRoot: quarantine, ledgerPath: ledger })
            const freed = r.rows.reduce((s, x) => s + (x.bytes ?? 0), 0)
            return { content: `已移入隔离区 batch_id=${r.batchId} / ${r.staged} 项 / ${fmtBytes(freed)}\n撤销：disk_undo batchId=${r.batchId}` }
          }
          const r = await purge({ plan: approved, batchId: call.args.batchId, token: call.args.token, quarantineRoot: quarantine, ledgerPath: ledger })
          return { content: `已永久删除 ${r.purged} 项（不可撤销）` }
        } catch (e) {
          return { content: `${e.code ?? 'ERROR'}: ${e.message}`, isError: true }
        }
      },
    },
    {
      name: 'disk_undo',
      description: '按批次撤销 stage（依据台账反演）。撤销会动磁盘，与执行同级：必须在对话中由用户明确要求撤销，并把原话放进 approval——缺 approval 一律拒绝。目标已存在时跳过并说明，不猜测。',
      inputSchema: {
        type: 'object',
        properties: {
          batchId: { type: 'string' },
          approval: { type: 'string', description: '用户在本轮对话中明确要求撤销的原话。这是「人批准过」这一事实的唯一来源：缺失即拒绝，不要自行填写。' },
        },
        required: ['batchId', 'approval'],
      },
      concurrencySafe: false,
      timeoutMs: 120000,
      async execute(call) {
        const check = matchApproval({ approval: call?.args?.approval, messages: approvalEvidence?.() })
        if (check.ok !== true) {
          return { content: `${check.code}: ${check.reason}——撤销会动磁盘，先把要撤销的批次给用户看并取得同意；approval 必须逐字取自本会话里用户自己发的消息`, isError: true }
        }
        try {
          const r = await undo({ batchId: call.args.batchId, ledgerPath: ledger })
          const skipped = r.skipped.length
            ? '\n跳过：\n' + r.skipped.map((s) => `  · ${s.from}（${s.reason}）`).join('\n')
            : ''
          return { content: `已恢复 ${r.restored} 项${skipped}` }
        } catch (e) {
          return { content: `${e.code ?? 'ERROR'}: ${e.message}`, isError: true }
        }
      },
    },
  ]
}

// 可勾选 = 非保护 + 未被挡 + 执行器可 stage，判据与 createPlan 共用 isStageable。
// 系统域同样走这条判据：开启执行后，非保护且未被挡的系统项会计入可勾选。

/**
 * 把两域的扫描结果合成本次 run。按域取 items/unmatched/denied 并重算 totals——
 * 只替换 items 会把另一个域的 totals/unmatched/denied 留在本域 run 上
 * （系统域报告曾因此印着天枢的 60.5 MB、天枢的未收录路径、以及 0 条禁区拦截）。
 * @param {{run: any, sys?: any, domain: 'tianshu'|'system'|'both'}} opts
 */
export function mergeDomainRun({ run, sys = null, domain }) {
  if (!sys) return { ...run, domain }
  const items = domain === 'system' ? sys.items : [...run.items, ...sys.items]
  const unmatched = domain === 'system' ? sys.unmatched : [...run.unmatched, ...sys.unmatched]
  return { ...run, domain, items, unmatched, denied: sys.denied, totals: computeTotals(items, unmatched) }
}

function saveRun(dir, run) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run, null, 1))
}

function loadRun(dir, runId) {
  const p = join(dir, `${runId}.json`)
  if (!existsSync(p)) throw Object.assign(new Error(`run 不存在：${runId}`), { code: 'RUN_NOT_FOUND' })
  return JSON.parse(readFileSync(p, 'utf8'))
}
