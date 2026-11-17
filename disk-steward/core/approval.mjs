// 批准证据校验：「人批准过」必须能从会话记录里核实，不能只凭一个字符串参数。
// 为什么——approval 是工具参数，模型可以往里填任何看起来像批准的字串；单看「非空」等于模型自批。
// 因此判据是：approval 必须是宿主提供的会话记录里、**user 角色**消息的原文片段。
// 助手自己写的、系统提示里的、本地文件里的都不算（那些模型自己也能写）。
//
// 边界：插件只回答「这句话是否出自用户」，**不判断它是否构成授权**。
// 「不要删除缓存」「不删 A、删 B」这类复杂语义由天枢（宿主侧对话理解）决定；
// 插件用词表去猜只会误伤，也会把一个语义判断藏进没人审的启发式里。
export const APPROVAL_ERRORS = {
  MISSING: 'EXEC_NOT_HUMAN_APPROVED',
  NOT_IN_TRANSCRIPT: 'EXEC_NOT_HUMAN_APPROVED',
  UNVERIFIABLE: 'EXEC_APPROVAL_UNVERIFIABLE',
}

// 引用过长的原文不值得匹配（也防止把一整段用户消息当批准）
export const APPROVAL_QUOTE_MAX = 200

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
  // 命中即承认：是否构成授权由天枢理解对话后判断，插件不做语义判断
  return { ok: true, quote: String(approval).trim() }
}
