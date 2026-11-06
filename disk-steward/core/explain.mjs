// 解释合成：回答"这里面是什么"。证据 + 规则合成，不用 LLM 现编（§14.1）。
import { RULE_ERRORS, ruleError } from './rules.mjs'
import { fmtBytes } from './probe.mjs'

const UNDO_TEXT = {
  stage: '移入同卷隔离区，可整批撤销',
  purge: '不可撤销（永久删除）',
  migrate: '台账记录原路径，可反移',
  compact: '不删除数据，仅压实',
}

export function describeContent(stats) {
  const parts = []
  if (stats.fileCount) parts.push(`${stats.fileCount} 个文件`)
  if (stats.topExt?.length) {
    parts.push(stats.topExt.map((e) => `${e.ext} ${fmtBytes(e.bytes)}`).join('、'))
  }
  return parts.join('，') || '空目录'
}

export function buildExplain(rule, stats) {
  const why = String(rule.reason ?? '').trim()
  if (!why) throw ruleError(RULE_ERRORS.EXPLAIN_INCOMPLETE, rule, 'reason 为空，无法生成解释')
  const content = describeContent(stats)
  return {
    what: rule.what ? `${rule.what}（${content}）` : content,
    why,
    rebuild: rule.rebuild ?? null,
    risk: rule.grade,
    sideEffect: rule.sideEffect ?? null,
    undo: rule.executor ? UNDO_TEXT[rule.executor.type] : '受保护，不执行',
  }
}
