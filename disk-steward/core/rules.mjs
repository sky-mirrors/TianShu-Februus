// 规则库：加载与校验。校验是 fail-closed 的落点（架构设计 §6.1）。
export const RULE_ERRORS = {
  EXPLAIN_INCOMPLETE: 'RULE_EXPLAIN_INCOMPLETE',
  BROWN_HAS_EXECUTOR: 'RULE_BROWN_HAS_EXECUTOR',
  MATCH_MISSING: 'RULE_MATCH_MISSING',
  BAD_FLAGS: 'RULE_BAD_FLAGS',
}

const GRADES = new Set(['green', 'yellow', 'orange', 'brown', 'blue'])
const FLAGS = new Set(['recurse', 'noRecurse', 'removeSelf', 'keepDir'])
const EXECUTORS = new Set(['stage', 'purge', 'migrate', 'compact'])

export function ruleError(code, rule, detail) {
  /** @type {Error & { code?: string, ruleId?: string | null }} */
  const e = new Error(`${code}: ${rule?.id ?? '<无 id>'} ${detail ?? ''}`.trim())
  e.code = code
  e.ruleId = rule?.id ?? null
  return e
}

export function validateRule(rule) {
  if (!rule || typeof rule !== 'object') throw ruleError(RULE_ERRORS.MATCH_MISSING, rule, '规则不是对象')
  if (!rule.match || !rule.match.path) throw ruleError(RULE_ERRORS.MATCH_MISSING, rule, '缺 match.path')
  if (!GRADES.has(rule.grade)) throw ruleError(RULE_ERRORS.EXPLAIN_INCOMPLETE, rule, `未知 grade=${rule.grade}`)
  // 硬规则 2：保护级不得出现 executable 分支
  if (rule.grade === 'brown' && rule.executor) throw ruleError(RULE_ERRORS.BROWN_HAS_EXECUTOR, rule)
  if (rule.grade !== 'brown') {
    if (!rule.executor || !EXECUTORS.has(rule.executor.type)) {
      throw ruleError(RULE_ERRORS.EXPLAIN_INCOMPLETE, rule, '非保护级必须声明合法 executor')
    }
  }
  // flags 只接受已知值：拼错的 flag 会让人以为生效了
  if (rule.flags !== undefined) {
    if (!Array.isArray(rule.flags)) throw ruleError(RULE_ERRORS.BAD_FLAGS, rule, 'flags 必须是数组')
    for (const f of rule.flags) {
      if (!FLAGS.has(f)) throw ruleError(RULE_ERRORS.BAD_FLAGS, rule, `未知 flag: ${f}`)
    }
  }
  // 硬规则 1：解释字段必填（reason 是 explain.why 的来源）
  if (!rule.reason || !String(rule.reason).trim()) {
    throw ruleError(RULE_ERRORS.EXPLAIN_INCOMPLETE, rule, 'reason 为空')
  }
  return true
}

export function loadRules(doc) {
  const rules = Array.isArray(doc) ? doc : doc?.rules
  if (!Array.isArray(rules)) throw new Error('规则库格式错误：缺 rules 数组')
  for (const r of rules) validateRule(r)
  return rules
}
