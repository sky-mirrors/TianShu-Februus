// 计划与令牌：保护项、被挡项一律进不了计划（不变量 I2/I3 的前置闸门）。
import { newId, newToken } from './ledger.mjs'

export const PLAN_ERRORS = {
  EMPTY: 'PLAN_EMPTY',
  NOT_FOUND: 'PLAN_ITEM_NOT_FOUND',
  REFUSED_PROTECTED: 'PLAN_REFUSED_PROTECTED',
  REFUSED_BLOCKED: 'PLAN_REFUSED_BLOCKED',
  REFUSED_NOT_STAGEABLE: 'PLAN_REFUSED_NOT_STAGEABLE',
  REFUSED_STALE_REFS: 'PLAN_REFUSED_STALE_REFS',
}

const STAGEABLE = new Set(['stage', 'migrate'])

/**
 * 「可进清理计划」的唯一判据。展示层（扫描摘要/表格/报告）必须与这里共用同一个判据，
 * 否则会出现「面板说可勾选、createPlan 却拒收」——compact 的 db-wal 就是这么被多算的。
 * @param {any} item
 */
export const isStageable = (item) =>
  item.grade !== 'brown' && !item.blocked && STAGEABLE.has(item.executor)

function err(code, detail) {
  /** @type {Error & { code?: string }} */
  const e = new Error(`${code}${detail ? ': ' + detail : ''}`)
  e.code = code
  return e
}

/**
 * @param {{ run: any, itemIds: string[], now?: number, ttlMs?: number, issuer?: 'agent'|'human', confirmedBy?: string|null, allowStaleRefs?: boolean }} opts
 */
export function createPlan({ run, itemIds, now = Date.now(), ttlMs = 10 * 60 * 1000, issuer = 'agent', confirmedBy = null, allowStaleRefs = false }) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw err(PLAN_ERRORS.EMPTY)
  const byId = new Map((run?.items ?? []).map((i) => [i.id, i]))
  const items = []
  for (const id of itemIds) {
    const item = byId.get(id)
    if (!item) throw err(PLAN_ERRORS.NOT_FOUND, id)
    if (item.grade === 'brown' || !item.executor) throw err(PLAN_ERRORS.REFUSED_PROTECTED, id)
    // compact/migrate 等不动文件的执行器不进清理计划：把它 stage 走 = 直接破坏数据
    if (!STAGEABLE.has(item.executor)) throw err(PLAN_ERRORS.REFUSED_NOT_STAGEABLE, `${id} (${item.executor})`)
    if (item.blocked) throw err(PLAN_ERRORS.REFUSED_BLOCKED, `${id} (${item.blocked})`)
    // 引用结论过期 => 可能已有新引用，不许据此进执行计划
    if (!allowStaleRefs && (item.refsStaleSeconds ?? 0) > 0) {
      throw err(PLAN_ERRORS.REFUSED_STALE_REFS, `${id} 的引用结论已过期 ${item.refsStaleSeconds}s`)
    }
    items.push(item)
  }
  return {
    planId: newId('p'),
    runId: run?.runId ?? null,
    token: newToken(),
    items,
    createdAt: now,
    expiresAt: now + ttlMs,
    issuer,
    confirmedBy,
    confirmedAt: confirmedBy ? now : null,
    stagedBatches: new Set(),
  }
}
