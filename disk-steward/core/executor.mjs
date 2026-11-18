// 执行器：两阶段（stage → purge）+ 撤销。唯一有写权限的层。
// 硬门：purge 必须令牌正确且批次已 staged；stage 只做同卷 rename（跨卷退化为复制+删并标注）。
import { mkdirSync, renameSync, cpSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { appendLedger, readLedger, newId } from './ledger.mjs'
import { snapshot, sameIdentity, verifyMoved } from './identity.mjs'
import { isDenied, denyReason, assertRealAllowed } from './guard.mjs'

export const EXEC_ERRORS = {
  TOKEN_INVALID: 'EXEC_TOKEN_INVALID',
  IDENTITY_CHANGED: 'EXEC_IDENTITY_CHANGED',
  NOT_HUMAN_APPROVED: 'EXEC_NOT_HUMAN_APPROVED',
  BATCH_NOT_FOUND: 'EXEC_BATCH_NOT_FOUND',
  BATCH_PATH_ESCAPE: 'EXEC_BATCH_PATH_ESCAPE',
  REFUSED_DENIED: 'EXEC_REFUSED_DENIED',
  BATCH_NOT_STAGED: 'EXEC_BATCH_NOT_STAGED',
  PLAN_EXPIRED: 'EXEC_PLAN_EXPIRED',
  NOTHING_STAGED: 'EXEC_NOTHING_STAGED',
}

const err = (code, detail) => Object.assign(new Error(`${code}${detail ? ': ' + detail : ''}`), { code })
export const quarantineName = (p) => String(p).replace(/[:\\/]+/g, '_')

export async function stage({ plan, token, items, quarantineRoot, ledgerPath, now = Date.now() }) {
  // stage 也要令牌：移动文件本身就可能毁数据（意图与 purge 同级）
  if (!plan?.token || !token || token !== plan.token) throw err(EXEC_ERRORS.TOKEN_INVALID, '缺令牌或令牌不匹配')
  // 令牌只是能力凭证；执行还要求"人批准过"这一独立事实
  if (plan.issuer !== 'human' || !plan.confirmedBy) {
    throw err(EXEC_ERRORS.NOT_HUMAN_APPROVED, `issuer=${plan.issuer ?? '未知'}，需人工确认后才能执行`)
  }
  if (now > plan.expiresAt) throw err(EXEC_ERRORS.PLAN_EXPIRED)
  const list = items ?? plan.items ?? []
  if (!list.length) throw err(EXEC_ERRORS.NOTHING_STAGED)

  const batchId = newId('b')
  const batchRoot = join(quarantineRoot, batchId)
  mkdirSync(batchRoot, { recursive: true })

  const rows = []
  const usedDest = new Set()
  for (const item of list) {
    if (item.grade === 'brown' || !item.executor) throw err(EXEC_ERRORS.TOKEN_INVALID, `保护项 ${item.id}`)

    // ① 执行期重验禁区：字符串判定 + **解析真实路径后**再判定（软链/junction 指不到禁区去）
    if (isDenied(item.path)) throw err(EXEC_ERRORS.REFUSED_DENIED, `${item.path} → ${denyReason(item.path)}`)
    const guardReal = await assertRealAllowed(item.path)
    if (!guardReal.ok) {
      throw err(EXEC_ERRORS.REFUSED_DENIED, `${item.path} → ${guardReal.code} ${guardReal.reason ?? ''}`.trim())
    }
    const target = guardReal.realPath

    // ② 执行期重验身份（TOCTOU）：对**解析后的对象**取 dev+ino+size+mtime
    const actual = await snapshot(target)
    if (!actual) throw err(EXEC_ERRORS.IDENTITY_CHANGED, `${item.path} 在执行时已不存在`)
    const expected = item.identity ?? actual
    if (item.identity && !sameIdentity(item.identity, actual)) {
      throw err(EXEC_ERRORS.IDENTITY_CHANGED, `${item.path} 与扫描时不一致（可能已被替换或改写）`)
    }

    // quarantineName 把 :\/ 全压成 _，不同源路径可能撞到同一目标
    // （source/a_b.txt 与 source_a/b.txt），撞上就覆盖前一个文件，撤销也救不回。
    // 只在真撞了才加序号：没撞时保持原目的名，既有台账/测试的路径假设不变。
    const base = quarantineName(target)
    let leaf = base
    let n = 1
    while (usedDest.has(leaf)) leaf = `${String(n++).padStart(3, '0')}-${base}`
    usedDest.add(leaf)
    const dest = join(batchRoot, leaf)
    mkdirSync(dirname(dest), { recursive: true })

    const flags = new Set(item.flags ?? [])
    const noRecurse = flags.has('noRecurse')
    const keepDir = flags.has('keepDir')
    const fileGranular = noRecurse || keepDir

    // ③ 先写 intent 再动手：崩溃时凭它恢复，否则磁盘动了账上没有
    const intent = {
      ts: now, batchId, action: 'intent', itemId: item.id,
      from: target, declaredPath: item.path, viaSymlink: guardReal.viaSymlink, to: dest, bytes: item.bytes ?? null,
      identity: expected, identitySource: item.identity ? 'scan' : 'at-exec',
      issuer: plan.issuer, confirmedBy: plan.confirmedBy,
      undoSupported: true,
    }
    appendLedger(ledgerPath, intent)

    // 文件安全优先：先把"即将移动哪些文件"记账，再动磁盘。
    // 这样即使崩在 rename 与 file-stage 之间，undo 也能凭 intent 找到每个文件的原位置。
    let plannedFiles = []
    if (fileGranular) {
      const walkSrc = (dir, relBase) => {
        const out = []
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, e.name)
          const rel = relBase ? join(relBase, e.name) : e.name
          if (e.isDirectory()) out.push(...walkSrc(abs, rel))
          else out.push({ rel })
        }
        return out
      }
      plannedFiles = walkSrc(target, '')
      for (const f of plannedFiles) {
        appendLedger(ledgerPath, {
          ts: now, batchId, action: 'file-intent', granularity: 'file', itemId: item.id,
          from: join(target, f.rel), to: join(dest, f.rel), undoSupported: true,
        })
      }
    }

    let crossVolume = false
    let partial = false
    try {
      if (noRecurse && actual.isDir) {
        // noRecurse：只移直接子文件，子目录原地保留（目录本身也不动）
        mkdirSync(dest, { recursive: true })
        for (const e of readdirSync(target, { withFileTypes: true })) {
          if (e.isDirectory()) continue
          renameSync(join(target, e.name), join(dest, e.name))
        }
        partial = true
      } else {
        renameSync(target, dest)
      }
    } catch (e) {
      if (e.code !== 'EXDEV') {
        appendLedger(ledgerPath, { ts: now, batchId, action: 'abort', itemId: item.id, reason: e.code ?? String(e) })
        throw e
      }
      cpSync(target, dest, { recursive: true, preserveTimestamps: true })
      // Windows 上 cpSync 保留不了目录 mtime（写子项会刷新它），复制后显式设回，
      // 否则 postmove 校验必误判为“已被换掉”并回滚
      try { utimesSync(dest, actual.mtimeMs / 1000, actual.mtimeMs / 1000) } catch { /* 设不回就靠校验拦 */ }
      rmSync(target, { recursive: true, force: true })
      crossVolume = true
    }

    // ④ 移动后校验：目标侧的尺寸/时间必须与快照吻合，否则回滚（防"检查后、动手前"被换）
    //    部分移动（noRecurse）天然与整目录快照不符，跳过尺寸比对并在台账里标出
    const moved = await snapshot(dest)
    const check = partial ? { ok: true, skipped: 'partial' } : verifyMoved({ size: expected.size, mtimeMs: expected.mtimeMs }, moved)
    if (!check.ok) {
      // 回滚也要按卷走：跨卷 rename 必抛 EXDEV，静默吞掉就把源目录丢了
      try {
        if (crossVolume) {
          cpSync(dest, target, { recursive: true, preserveTimestamps: true })
          try { utimesSync(target, actual.mtimeMs / 1000, actual.mtimeMs / 1000) } catch { /* 时间戳不是回滚的必要条件 */ }
          rmSync(dest, { recursive: true, force: true })
        } else renameSync(dest, target)
      } catch { /* 回滚失败也要留下 abort 记录 */ }
      appendLedger(ledgerPath, { ts: now, batchId, action: 'abort', itemId: item.id, reason: `postmove:${check.reason}` })
      throw err(EXEC_ERRORS.IDENTITY_CHANGED, `移动后校验失败已回滚：${check.reason}`)
    }

    // keepDir：内容已移走，把原目录重建为空目录（某些应用要求目录必须存在）
    if (keepDir && actual.isDir && !noRecurse) mkdirSync(target, { recursive: true })

    const row = {
      ...intent, ts: now, action: 'stage', crossVolume, flags: [...flags], partial,
      verify: check.skipped ?? 'full', granularity: 'dir',
      // 文件粒度批次：目录行只作审计，撤销靠逐文件行
      undoSupported: !fileGranular,
    }
    appendLedger(ledgerPath, row)
    rows.push(row)

    // 文件粒度记账：noRecurse/keepDir 保留了原目录，目录级撤销会命中"目标已存在"，
    // 因此按每个被移动的文件各记一行，undo 逐文件反演、不依赖目录是否存在
    if (fileGranular) {
      const walkFiles = (dir, relBase) => {
        const out = []
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, e.name)
          const rel = relBase ? join(relBase, e.name) : e.name
          if (e.isDirectory()) out.push(...walkFiles(abs, rel))
          else out.push({ abs, rel })
        }
        return out
      }
      for (const f of walkFiles(dest, '')) {
        appendLedger(ledgerPath, {
          ts: now, batchId, action: 'file-stage', granularity: 'file',
          itemId: item.id, from: join(target, f.rel), to: f.abs,
          bytes: existsSync(f.abs) ? undefined : undefined,
          undoSupported: true,
        })
      }
    }
  }

  appendLedger(ledgerPath, {
    ts: now, batchId, action: 'batch', items: rows.length,
    bytes: rows.reduce((s, r) => s + (r.bytes ?? 0), 0),
  })
  plan.stagedBatches?.add(batchId)
  return { batchId, staged: rows.length, rows }
}

export async function purge({ plan, batchId, token, quarantineRoot, ledgerPath, now = Date.now() }) {
  if (!token || !plan?.token || token !== plan.token) throw err(EXEC_ERRORS.TOKEN_INVALID)
  if (plan.issuer !== 'human' || !plan.confirmedBy) {
    throw err(EXEC_ERRORS.NOT_HUMAN_APPROVED, `issuer=${plan.issuer ?? '未知'}，永久删除必须人工确认`)
  }
  if (now > plan.expiresAt) throw err(EXEC_ERRORS.PLAN_EXPIRED)
  if (!plan.stagedBatches?.has(batchId)) throw err(EXEC_ERRORS.BATCH_NOT_STAGED, batchId)

  const rows = readLedger(ledgerPath).filter((r) => r.batchId === batchId && (r.action === 'done' || r.action === 'stage'))
  let purged = 0
  for (const r of rows) {
    if (!existsSync(r.to)) continue
    rmSync(r.to, { recursive: true, force: true })
    appendLedger(ledgerPath, { ts: now, batchId, action: 'purge', itemId: r.itemId, from: r.from, to: r.to, bytes: r.bytes })
    purged += 1
  }
  return { purged }
}

export async function undo({ batchId, ledgerPath, now = Date.now() }) {
  const rows = readLedger(ledgerPath).filter(
    (r) =>
      r.batchId === batchId &&
      ['stage', 'done', 'file-stage', 'file-intent', 'intent'].includes(r.action) &&
      r.undoSupported,
  )
  // intent 是兜底凭据：正常批次里它已被同 item 的 stage/done 行取代，只有
  // 「移动完成、stage 行没落」的崩溃批次才靠它。不排除的话同一条目会被处理两次
  // （先按 stage 恢复成功，再按 intent 命中"目标已存在"记一条噪声 skip）。
  const covered = new Set(
    rows.filter((r) => r.action !== 'intent' && r.action !== 'file-intent').map((r) => r.itemId),
  )
  const recoverable = rows.filter(
    (r) => (r.action !== 'intent' && r.action !== 'file-intent') || !covered.has(r.itemId),
  )
  let restored = 0
  const skipped = []
  for (const r of [...recoverable].reverse()) {
    if (existsSync(r.from)) { skipped.push({ from: r.from, reason: '目标已存在，跳过不猜测' }); continue }
    if (!existsSync(r.to)) { skipped.push({ from: r.from, reason: '隔离区条目已不在' }); continue }
    mkdirSync(dirname(r.from), { recursive: true })
    try {
      renameSync(r.to, r.from)
    } catch (e) {
      if (e.code !== 'EXDEV') throw e
      cpSync(r.to, r.from, { recursive: true, preserveTimestamps: true })
      rmSync(r.to, { recursive: true, force: true })
    }
    appendLedger(ledgerPath, { ts: now, batchId, action: 'undo', itemId: r.itemId, from: r.to, to: r.from })
    restored += 1
  }
  return { restored, skipped }
}

/**
 * 崩溃恢复：只看 intent 与终态（done/abort）的差集。
 * - 目标在、源不在 → 实际已完成但没记账 → 补 done
 * - 源与目标同时存在 → 跨卷复制中途崩，两边都不完整 → 报不一致，不自动删任何一边
 * - 目标不在、源还在 → 根本没动 → 记 abort
 * @param {{ ledgerPath: string, batchId: string, now?: number }} args
 */
export async function recoverBatch({ ledgerPath, batchId, now = Date.now() }) {
  const rows = readLedger(ledgerPath).filter((r) => r.batchId === batchId)
  const terminal = new Set(rows.filter((r) => r.action === 'stage' || r.action === 'done' || r.action === 'abort').map((r) => r.itemId))
  const intents = rows.filter((r) => r.action === 'intent' && !terminal.has(r.itemId))
  const terminalFiles = new Set(rows.filter((r) => r.action === 'file-stage' || r.action === 'file-abort').map((r) => r.to))

  let completed = 0
  let inconsistent = 0
  let aborted = 0
  const details = []

  for (const it of intents) {
    const destExists = existsSync(it.to)
    const srcExists = existsSync(it.from)
    if (destExists && !srcExists) {
      appendLedger(ledgerPath, { ...it, ts: now, action: 'stage', recovered: true })
      completed += 1
      details.push({ itemId: it.itemId, verdict: 'completed' })
    } else if (destExists && srcExists) {
      // 两边都在：跨卷复制中途崩，或目标被别的进程占用；保留现场交给人判断
      inconsistent += 1
      details.push({ itemId: it.itemId, verdict: 'inconsistent', from: it.from, to: it.to })
    } else {
      appendLedger(ledgerPath, { ...it, ts: now, action: 'abort', reason: 'nothing-moved' })
      aborted += 1
      details.push({ itemId: it.itemId, verdict: 'aborted' })
    }
  }
  // 文件粒度：有 file-intent 但缺 file-stage，且隔离区里确有文件 → 判为已完成并补记账
  const fileIntents = rows.filter((r) => r.action === 'file-intent' && !terminalFiles.has(r.to))
  let fileCompleted = 0
  let fileAborted = 0
  for (const fi of fileIntents) {
    if (existsSync(fi.to) && !existsSync(fi.from)) {
      appendLedger(ledgerPath, { ...fi, ts: now, action: 'file-stage', recovered: true })
      fileCompleted += 1
    } else if (!existsSync(fi.to) && existsSync(fi.from)) {
      // 只记了账、还没移动就崩：明确记为未移动，绝不当成已完成
      appendLedger(ledgerPath, { ...fi, ts: now, action: 'file-abort', reason: 'not-moved' })
      fileAborted += 1
    }
  }

  return { batchId, completed, inconsistent, aborted, fileCompleted, fileAborted, details }
}

/**
 * 未决批次：有 intent/file-intent 却缺对应终态的批次。崩溃后不必靠人翻台账找现场。
 * 只读：不写台账、不动磁盘。
 * @param {{ ledgerPath: string }} args
 */
export async function pendingBatches({ ledgerPath }) {
  const rows = readLedger(ledgerPath)
  const byBatch = new Map()
  for (const r of rows) {
    let b = byBatch.get(r.batchId)
    if (!b) {
      b = { batchId: r.batchId, items: new Set(), files: new Set(), doneItems: new Set(), doneFiles: new Set(), bytes: 0, lastTs: 0 }
      byBatch.set(r.batchId, b)
    }
    if ((r.ts ?? 0) > b.lastTs) b.lastTs = r.ts ?? 0
    if (r.action === 'intent') {
      b.items.add(r.itemId)
      b.bytes += r.bytes ?? 0
    } else if (r.action === 'file-intent') {
      b.files.add(r.to)
    } else if (r.action === 'stage' || r.action === 'done' || r.action === 'abort') {
      b.doneItems.add(r.itemId)
    } else if (r.action === 'file-stage' || r.action === 'file-abort') {
      b.doneFiles.add(r.to)
    }
  }
  const out = []
  for (const b of byBatch.values()) {
    const pendingItems = [...b.items].filter((id) => !b.doneItems.has(id)).length
    const pendingFiles = [...b.files].filter((to) => !b.doneFiles.has(to)).length
    if (pendingItems || pendingFiles) {
      out.push({ batchId: b.batchId, pendingItems, pendingFiles, bytes: b.bytes, lastTs: b.lastTs })
    }
  }
  return out.sort((a, b) => b.lastTs - a.lastTs)
}

const underRoot = (child, root) => {
  const c = resolve(child).toLowerCase()
  const r = resolve(root).toLowerCase()
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * 重启后仍可释放空间：只凭台账 + 人工批准，不依赖内存里的 plan。
 * 安全前提：台账里每条目标路径都必须落在 quarantineRoot 之下（防台账被篡改后越界删）。
 * @param {{ batchId: string, ledgerPath: string, quarantineRoot: string, approval?: {issuer?: string, confirmedBy?: string|null}, now?: number }} args
 */
export async function purgeBatch({ batchId, ledgerPath, quarantineRoot, approval, now = Date.now() }) {
  if (!approval || approval.issuer !== 'human' || !approval.confirmedBy) {
    throw err(EXEC_ERRORS.NOT_HUMAN_APPROVED, `issuer=${approval?.issuer ?? '未知'}，永久删除必须人工确认`)
  }
  const rows = readLedger(ledgerPath).filter((r) => r.batchId === batchId)
  const staged = rows.filter((r) => r.action === 'stage' || r.action === 'done')
  if (!staged.length) throw err(EXEC_ERRORS.BATCH_NOT_FOUND, batchId)
  for (const r of staged) {
    if (!underRoot(r.to, quarantineRoot)) throw err(EXEC_ERRORS.BATCH_PATH_ESCAPE, `${r.to} 不在隔离区内`)
  }

  const alreadyPurged = new Set(rows.filter((r) => r.action === 'purge').map((r) => r.itemId))
  let purged = 0
  for (const r of staged) {
    if (alreadyPurged.has(r.itemId)) continue
    if (!existsSync(r.to)) continue
    rmSync(r.to, { recursive: true, force: true })
    appendLedger(ledgerPath, { ts: now, batchId, action: 'purge', itemId: r.itemId, from: r.from, to: r.to, bytes: r.bytes, issuer: approval.issuer, confirmedBy: approval.confirmedBy })
    purged += 1
  }
  return { batchId, purged }
}

/**
 * 隔离区概览：多少批、占多少字节、最老一批多久了（让"空间没释放"可见）。
 * @param {{ ledgerPath: string, quarantineRoot: string, now?: number }} args
 */
export async function quarantineStats({ ledgerPath, quarantineRoot, now = Date.now() }) {
  const rows = readLedger(ledgerPath)
  const purgedItems = new Set(rows.filter((r) => r.action === 'purge').map((r) => `${r.batchId}:${r.itemId}`))
  // 只算“文件仍真实存在”的条目：被 undo 回去或已 purge 的不该继续占额度
  const live = rows.filter(
    (r) => (r.action === 'stage' || r.action === 'done') && !purgedItems.has(`${r.batchId}:${r.itemId}`) && existsSync(r.to),
  )
  const batches = new Set(live.map((r) => r.batchId))
  const bytes = live.reduce((n, r) => n + (r.bytes ?? 0), 0)
  const oldestTs = live.length ? Math.min(...live.map((r) => r.ts ?? now)) : now
  return {
    quarantineRoot,
    batches: batches.size,
    items: live.length,
    bytes,
    oldestDays: Number(((now - oldestTs) / 86400000).toFixed(1)),
  }
}

/**
 * 隔离区策略：只判定"哪些批次已过保留期 / 是否超出容量阈值"，不执行任何删除。
 * 自动删除等于绕过人工确认，这里刻意不提供。
 * @param {{ ledgerPath: string, quarantineRoot: string, now?: number, retentionDays?: number, maxBytes?: number }} args
 */
export async function quarantinePolicy({ ledgerPath, quarantineRoot, now = Date.now(), retentionDays = 7, maxBytes = 2 * 1024 * 1024 * 1024 }) {
  const rows = readLedger(ledgerPath)
  const purged = new Set(rows.filter((r) => r.action === 'purge').map((r) => `${r.batchId}:${r.itemId}`))
  const live = rows.filter(
    (r) => (r.action === 'stage' || r.action === 'done') && !purged.has(`${r.batchId}:${r.itemId}`) && existsSync(r.to),
  )
  const byBatch = new Map()
  for (const r of live) {
    const cur = byBatch.get(r.batchId) ?? { ts: r.ts ?? now, bytes: 0 }
    cur.ts = Math.min(cur.ts, r.ts ?? now)
    cur.bytes += r.bytes ?? 0
    byBatch.set(r.batchId, cur)
  }
  const expiredBatches = []
  let bytes = 0
  for (const [batchId, v] of byBatch) {
    bytes += v.bytes
    if (now - v.ts > retentionDays * 86400000) expiredBatches.push(batchId)
  }
  return {
    quarantineRoot,
    batches: byBatch.size,
    bytes,
    retentionDays,
    maxBytes,
    expiredBatches,
    overLimit: bytes > maxBytes,
  }
}
