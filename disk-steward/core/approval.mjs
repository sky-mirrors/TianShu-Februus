// 批准证据校验：「人批准过」必须能从会话记录里核实，不能只凭一个字符串参数。
// 为什么——approval 是工具参数，模型可以往里填任何看起来像批准的字串；单看「非空」等于模型自批。
// 因此判据是：approval 必须是宿主提供的会话记录里、**user 角色**消息的原文片段。
// 助手自己写的、系统提示里的、本地文件里的都不算（那些模型自己也能写）。
export const APPROVAL_ERRORS = {
  MISSING: 'EXEC_NOT_HUMAN_APPROVED',
  NOT_IN_TRANSCRIPT: 'EXEC_NOT_HUMAN_APPROVED',
  UNVERIFIABLE: 'EXEC_APPROVAL_UNVERIFIABLE',
}

// 引用过长的原文不值得匹配（也防止把一整段用户消息当批准）
export const APPROVAL_QUOTE_MAX = 200
// 否定词：用户说「不要删除」时其中也含「删除」，不能让片段匹配绕过否定
const NEGATION = /[不别勿没未]|无需|不用|暂不|先不/

const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * @param {{ approval: unknown, messages: unknown }} args
 * @returns {{ ok: true, quote: string } | { ok: false, code: string, reason: string }}
 */
export function matchApproval({ approval, messages }) {
  const quote = normalize(approval)
  if (!quote) return { ok: false, code: APPROVAL_ERRORS.MISSING, reason: '缺少 approval' }
  if (quote.length > APPROVAL_QUOTE_MAX) {
    return { ok: false, code: APPROVAL_ERRORS.NOT_IN_TRANSCRIPT, reason: `approval 超过 ${APPROVAL_QUOTE_MAX} 字符，不作为批准引用` }
  }
  // 没有会话记录 ≠ 通过：无法核实就 fail-closed
  if (!Array.isArray(messages)) {
    return { ok: false, code: APPROVAL_ERRORS.UNVERIFIABLE, reason: '宿主未提供会话记录，无法核实 approval 是否出自用户' }
  }
  const userText = messages
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => normalize(m.content))
    .join('\n')
  if (!userText) {
    return { ok: false, code: APPROVAL_ERRORS.NOT_IN_TRANSCRIPT, reason: '会话记录里没有用户消息可核实' }
  }
  const at = userText.indexOf(quote)
  if (at < 0) {
    return { ok: false, code: APPROVAL_ERRORS.NOT_IN_TRANSCRIPT, reason: '会话记录里没有用户说过这句话' }
  }
  // 命中位置前 4 个字符含否定词 → 视为「用户说的是不要做」
  const lead = userText.slice(Math.max(0, at - 4), at)
  if (NEGATION.test(lead)) {
    return { ok: false, code: APPROVAL_ERRORS.NOT_IN_TRANSCRIPT, reason: `该片段出现在否定语境中（…${lead}${quote}），不构成批准` }
  }
  return { ok: true, quote: String(approval).trim() }
}
