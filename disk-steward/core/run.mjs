// 一次扫描 = 一份 run。UI/TUI/工具都读这份对象的落盘副本（§14.1 唯一事实源）。
import { readdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validateRule } from './rules.mjs'
import { measure, exists } from './probe.mjs'
import { buildExplain } from './explain.mjs'
import { normalizePath } from './paths.mjs'
import { checkPrecondition } from './precondition.mjs'
import { isStageable } from './plan.mjs'

// 极简 glob：** 任意层、* 单层内任意字符；其余按字面量（不用转义字符写源码）
const SPECIAL = new Set([String.fromCharCode(92), '^', '$', '.', '|', '?', '+', '(', ')', '[', ']', '{', '}'])
function globToRe(pat) {
  const p = normalizePath(pat).toLowerCase()
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') { out += '.*'; i++ }
    else if (c === '*') out += '[^/]*'
    else if (SPECIAL.has(c)) out += String.fromCharCode(92) + c
    else out += c
  }
  return new RegExp('^' + out + '$')
}

/** 主项是否命中规则内排除（优先级高于 match） */
export function isExcluded(path, rule) {
  const p = normalizePath(path).toLowerCase()
  for (const pat of rule?.exclude ?? []) {
    const norm = normalizePath(pat).toLowerCase()
    // 纯目录前缀写法（以 / 结尾或以 /** 结尾）按目录包含处理
    if (norm.endsWith('/**')) {
      if (p === norm.slice(0, -3) || p.startsWith(norm.slice(0, -2))) return true
      continue
    }
    if (globToRe(norm).test(p)) return true
  }
  return false
}
import { buildRefIndex, classifyNode } from './refindex.mjs'

/** @param {Record<string, any>} vars */
export function resolveVars(input, vars) {
  return String(input).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] ?? m))
}

// 规则命中判定：按段边界比较，且分隔符无关（Windows 上 _ 与 / 混用是常态）

// 把 glob 模式展开成同目录下真实存在的文件路径。
// 为什么需要：buildRun 是「路径存在就测量」，带 `*` 的路径永远 exists=false，
// 所以 glob 规则必须先展开成具体路径，再交给 buildRun。
export async function expandGlobFiles(pattern) {
  const parts = String(pattern).split(/[\\/]+/).filter(Boolean)
  const first = parts.findIndex((p) => p.includes('*'))
  // 没有通配符：原样返回，交给 buildRun 的 exists 判断
  if (first < 0) return [String(pattern)]
  let bases = [parts.slice(0, first).join('/')]
  for (const seg of parts.slice(first)) {
    if (!seg.includes('*')) {
      bases = bases.map((b) => `${b}/${seg}`)
      continue
    }
    const re = globToRe(seg.toLowerCase()) // Windows 上名字比较大小写不敏感
    const next = []
    for (const base of bases) {
      let entries
      try { entries = await readdir(base, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        if (re.test(e.name.toLowerCase())) next.push(`${base}/${e.name}`)
      }
    }
    bases = next
  }
  return bases
}

export function matchRule(path, rule, vars) {
  // Windows 路径大小写不敏感：规则里的 {{WINDIR}}/Temp（C:\windows）与真实目录 C:\Windows 是同一个。
  // 旧实现逐字符比较 => C:\Windows\Temp 永远匹配不上，被归进「未收录」。
  const target = normalizePath(resolveVars(rule.match.path, vars)).toLowerCase()
  const p = normalizePath(path).toLowerCase()
  // glob：* 不跨目录（只代表同目录下的文件名片段）。prefix 在目录边界就停，
  // 因此 `{{rivetHome}}/tool-stream` 匹配不到 `tool-stream-2026.jsonl`。
  if (rule.match.kind === 'glob') {
    return globToRe(target).test(p) ? rule : null
  }
  if (p !== target && !p.startsWith(target + '/')) return null
  return rule
}

function covered(childPath, rulePaths) {
  const p = normalizePath(childPath)
  return rulePaths.some((t) => p === t || p.startsWith(t + '/'))
}

// 只扫「我们拥有所有权」的根（vars.unmatchedRoots），不扫系统临时区——那里不是我们的目录，
// 否则会把 Temp 下成千上万个无关项算进「受保护」，把面板噪声化。
async function findUnmatched(vars, rules, deadline = Infinity) {
  const declared = (vars.unmatchedRoots ?? [vars.root, vars.rivetHome, vars.projectRivetHome].filter(Boolean)).filter(Boolean)
  // 同一个目录出现在多个根里（进程 cwd 等于家目录时 rivetHome 与 projectRivetHome 就是同一个），
  // 会让每个未收录路径被列 N 遍——按规范化路径去重，不靠调用方保证两个根不同。
  const seen = new Set()
  const roots = []
  for (const r of declared) {
    const key = normalizePath(r).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(r)
  }
  const rulePaths = rules.map((r) => normalizePath(resolveVars(r.match.path, vars)))
  const out = []
  for (const root of roots) {
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(root, e.name)
      if (covered(p, rulePaths)) continue
      // 带体积：否则「这 N 个路径没规则覆盖」无法判断值不值得补规则。只读 measure，不改执行路径。
      const stats = await measure(p, { deadline })
      out.push({ path: p, bytes: stats.bytes, grade: 'brown', executor: null, ruleId: null, reason: '未收录规则 → 按保护处理' })
    }
  }
  return out
}

/**
 * 一次 run 的汇总口径。可勾选一律按 isStageable，与 createPlan 的闸门同一判据。
 * @param {any[]} items
 * @param {any[]} [unmatched]
 */
export function computeTotals(items, unmatched = []) {
  const selectable = items.filter(isStageable)
  return {
    items: items.length,
    bytes: items.reduce((s, i) => s + i.bytes, 0),
    selectable: selectable.length,
    selectableBytes: selectable.reduce((s, i) => s + i.bytes, 0),
    blocked: items.filter((i) => i.blocked).length,
    protected: items.filter((i) => i.grade === 'brown').length + unmatched.length,
  }
}

/** @param {{rules: any[], vars?: Record<string, any>, now?: number, mtimeGuardMs?: number, collectUnmatched?: boolean, preconditionDeps?: any, refIndexDeps?: any, deadline?: number}} opts */
export async function buildRun({
  rules,
  vars = {},
  now = Date.now(),
  mtimeGuardMs = 10 * 60 * 1000,
  collectUnmatched = true,
  preconditionDeps = undefined,
  refIndexDeps = undefined,
  deadline = Infinity,
}) {
  const items = []
  // 预算耗尽是事实，要报给调用方：否则“扫了一半”和“扫完了”看起来一模一样
  let truncated = false
  // 隐私默认值：不把真实文件名写进结果；需要时显式 vars.includeSamples = true
  const includeSamples = vars.includeSamples === true
  for (const rule of rules) {
    validateRule(rule) // 任一规则不合格 → 抛错，不产出残缺 run（§14.1 硬约束 1）
    if (rule.detect?.path && !(await exists(resolveVars(rule.detect.path, vars)))) continue // 硬规则 3
    const path = resolveVars(rule.match.path, vars)
    if (!(await exists(path))) continue
    // 图驱动：一条规则展开成"每个产物节点一个 item"，判级由引用图决定
    if (rule.expand === 'refs') {
      const corpus = vars.corpusRoots ?? [vars.root, vars.rivetHome, vars.projectRivetHome].filter(Boolean)
      const dbPath = refIndexDeps?.dbPath ?? (vars.rivetHome ? join(vars.rivetHome, 'meridian.db') : null)
      const idx = await buildRefIndex({ artifactDir: path, corpusRoots: corpus, dbPath, ...(refIndexDeps ?? {}) })
      for (const node of idx.nodes) {
        const cls = classifyNode(node, { now })
        items.push({
          id: `${rule.id}#${node.name}`,
          title: rule.title ? `${rule.title} · ${node.name}` : node.name,
          path: node.path,
          kind: 'dir',
          bytes: node.bytes,
          fileCount: 0,
          topExt: [],
          samples: [],
          ruleId: rule.id,
          grade: cls.grade,
          blocked: null,
          blockedReason: null,
          executor: cls.executor,
          refs: node.refs,
          refsSource: idx.cached === false ? 'fresh' : idx.cached,
          refsStaleSeconds: idx.staleSeconds ?? 0,
          explain: {
            what: `产物节点 ${node.name}，在 ${idx.corpusFiles} 个语料文件中被引用 ${node.refs} 处${node.refScanIncomplete ? '；注意：引用扫描不完整，零引用不可信' : ''}`,
            why: cls.reason,
            rebuild: rule.rebuild ?? null,
            risk: cls.grade,
            sideEffect: rule.sideEffect ?? null,
            undo: cls.executor ? '移入隔离区（同卷 rename），可整批撤销' : '受保护，不执行',
          },
          decision: 'undecided',
        })
      }
      continue
    }

    // 规则内排除：命中则降级为保护（可见，但不可执行），绝不静默丢弃
    if (isExcluded(path, rule)) {
      const stats = await measure(path)
      const explain = buildExplain(rule, stats)
      items.push({
        id: `${rule.id}#${items.length + 1}`,
        title: rule.title || explain.what,
        path, kind: stats.kind, bytes: stats.bytes, fileCount: stats.fileCount,
        topExt: stats.topExt, samples: includeSamples ? stats.samples : [], samplesRedacted: !includeSamples, ruleId: rule.id,
        grade: 'brown', blocked: 'excluded', blockedReason: `命中规则内 exclude：${(rule.exclude ?? []).join(', ')}`,
        executor: null, flags: rule.flags ?? [], decision: 'undecided',
        explain: { ...explain, undo: '受保护（规则内排除），不执行' },
      })
      continue
    }

    const stats = await measure(path, { deadline })
    if (stats.partial) truncated = true
    const explain = buildExplain(rule, stats)
    const active = rule.mtimeGuard === false ? false : now - stats.latestMtime < mtimeGuardMs
    let blocked = active ? 'active' : null
    let blockedReason = active ? '10 分钟内有写入（可能仍在使用）' : null

    // precondition：机器可检查的执行前置。不满足就阻塞，不许"先删了再说"
    if (!blocked && rule.precondition) {
      const pc = await checkPrecondition(rule.precondition, preconditionDeps)
      if (!pc.ok) {
        blocked = 'precondition'
        blockedReason = `${pc.code}: ${pc.reason}`
      }
    }
    items.push({
      id: `${rule.id}#${items.length + 1}`,
      path,
      kind: stats.kind,
      bytes: stats.bytes,
      fileCount: stats.fileCount,
      partial: stats.partial === true,
      topExt: stats.topExt,
      samples: includeSamples ? stats.samples : [],
      samplesRedacted: !includeSamples,
      ruleId: rule.id,
      grade: rule.grade,
      title: rule.title || explain.what,
      explain,
      precondition: rule.precondition ?? null,
      active,
      needsElevation: Boolean(rule.needsElevation),
      executor: rule.executor?.type ?? null,
      blocked,
      blockedReason,
      flags: rule.flags ?? [],
      decision: 'undecided',
    })
  }

  // 同一路径被多条规则命中时只保留第一条：否则同一份数据会被重复计数
  const seen = new Set()
  const duplicates = []
  const deduped = items.filter((i) => {
    const key = normalizePath(i.path).toLowerCase()
    if (seen.has(key)) { duplicates.push(i.path); return false }
    seen.add(key)
    return true
  })
  items.length = 0
  items.push(...deduped)

  const unmatched = collectUnmatched ? await findUnmatched(vars, rules) : []
  const totals = computeTotals(items, unmatched)

  return {
    // runId 带随机后缀：只用时间戳的话，同一毫秒的两次并发扫描会得到同一个 id，
    // 落盘时后者覆盖前者（实测 Promise.all 两次扫描返回同一 run_id）
    runId: `r-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
    domain: vars.domain ?? 'tianshu',
    createdAt: now,
    items,
    duplicates,
    unmatched,
    totals,
    truncated,
    selectable: totals.selectable,
  }
}
