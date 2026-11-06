// 引用图：把"谁引用了这个产物"变成可计算的输入。
// 安全立场：**扫不全就不许判可回收**。任何来源不可读 -> 节点置 refScanIncomplete -> 永不 green。
import { readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const TEXT_EXTS = ['.md', '.json', '.jsonl', '.txt', '.log', '.csv', '.ini', '.xml', '.yaml', '.yml']
const DEFAULT_MAX_FILE = 32 * 1024 * 1024
const DEFAULT_BUDGET = 128 * 1024 * 1024
const DB_ROW_CAP = 100000 // 只作病态表的保险丝，不作为常态截断
const DB_BYTE_BUDGET = 64 * 1024 * 1024

async function walk(dir, { depth = 0, maxDepth = 5, skip = new Set() } = {}) {
  const out = []
  if (depth > maxDepth) return out
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (skip.has(e.name)) continue
      out.push(...(await walk(p, { depth: depth + 1, maxDepth, skip })))
    } else {
      out.push(p)
    }
  }
  return out
}

async function dirSize(dir) {
  let total = 0
  let latest = 0
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return { bytes: 0, latestMtime: 0 } }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const r = await dirSize(p)
      total += r.bytes
      latest = Math.max(latest, r.latestMtime)
    } else {
      try {
        const s = await stat(p)
        total += s.size
        latest = Math.max(latest, s.mtimeMs)
      } catch { /* 读不到就跳过，不猜 */ }
    }
  }
  return { bytes: total, latestMtime: latest }
}

// DB 是"零引用"可信的关键来源：知识/会话很可能只存在库里
/** @param {string} dbPath @param {{ rowCap?: number, incomplete?: any[], sources?: any }} [opts] */
async function readDbCorpus(dbPath, { rowCap = DB_ROW_CAP, incomplete = [], sources = {} } = {}) {
  if (!dbPath) return ''
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    incomplete.push({ source: 'db', reason: '当前 Node 无 node:sqlite' })
    return ''
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (e) {
    incomplete.push({ source: 'db', reason: `打不开 ${dbPath}: ${e.code ?? e.message}` })
    return ''
  }
  let out = ''
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    for (const { name } of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM ${name} LIMIT ${rowCap}`).all()
        const chunk = JSON.stringify(rows)
        if (out.length + chunk.length > DB_BYTE_BUDGET) {
          incomplete.push({ source: `db:${name}`, reason: `DB 语料超出字节预算（${Math.round(DB_BYTE_BUDGET / 1048576)}MB），该表未纳入扫描` })
          continue
        }
        out += chunk
        if (rows.length >= rowCap) {
          // 静默截断是安全洞：没扫到的行里可能正藏着引用
          incomplete.push({ source: `db:${name}`, reason: `行数达到上限 ${rowCap}（截断），该表可能有引用未被扫到` })
        }
      } catch (e) {
        incomplete.push({ source: `db:${name}`, reason: e.code ?? e.message })
      }
    }
    sources.db = true
  } finally {
    try { db.close() } catch { /* 关闭失败不影响已有结论 */ }
  }
  return out
}

/**
 * @param {{ artifactDir?: string, corpusRoots?: string[], dbPath?: string|null, maxDepth?: number,
 *           maxFileBytes?: number, budgetBytes?: number, rowCap?: number, cachePath?: string|null, ttlMs?: number }} [opts]
 */
export async function buildRefIndex({
  artifactDir,
  corpusRoots = [],
  dbPath = null,
  maxDepth = 5,
  maxFileBytes = DEFAULT_MAX_FILE,
  budgetBytes = DEFAULT_BUDGET,
  rowCap = DB_ROW_CAP,
  cachePath = null,
  ttlMs = 0,
} = {}) {
  const incomplete = []
  const sources = { text: false, binary: false, db: false }

  let names = []
  try {
    names = (await readdir(artifactDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { nodes: [], corpusFiles: 0, corpusBytes: 0, incomplete, sources }
  }

  const cacheAbs = cachePath ? resolve(cachePath).toLowerCase() : null
  const files = []
  for (const root of corpusRoots) {
    // 语料不包含 artifacts 自身：否则目录名会自己引用自己，引用恒大于 0
    files.push(...(await walk(root, { maxDepth, skip: new Set(['artifacts', 'plugins', 'node_modules']) })))
  }

  // 指纹：每个语料文件的 路径+大小+mtime、DB 的 大小+mtime、以及产物节点集
  // 注意：缓存文件自身必须排除，否则"写缓存"会改语料 → 指纹变化 → 永远不命中
  const stats = []
  for (const f of files) {
    if (cacheAbs && resolve(f).toLowerCase() === cacheAbs) continue
    try {
      const st = await stat(f)
      stats.push({ path: f, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
    } catch { /* 读不到的不进指纹，但也不会被读进语料 */ }
  }
  let dbStat = null
  if (dbPath) {
    try {
      const st = await stat(dbPath)
      dbStat = { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
    } catch { /* DB 不存在：由 readDbCorpus 记录 incomplete */ }
  }
  const fingerprint = createHash('sha1')
    .update(JSON.stringify({ names: [...names].sort(), stats: stats.map((x) => [x.path, x.size, x.mtimeMs]).sort(), dbStat }))
    .digest('hex')

  if (cachePath && existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (c.fingerprint === fingerprint) {
        return { ...c.payload, cached: 'fingerprint', staleSeconds: 0 }
      }
      if (ttlMs > 0 && c.writtenAt && Date.now() - c.writtenAt < ttlMs) {
        // 活库（WAL 持续写入）下指纹必然变；此时用 TTL 换速度，但如实标出可能过期
        return { ...c.payload, cached: 'ttl', staleSeconds: Math.round((Date.now() - c.writtenAt) / 1000) }
      }
    } catch { /* 缓存坏了就当没有，重算 */ }
  }

  let textCorpus = ''
  let binaryCorpus = ''
  let spent = 0
  let corpusFiles = 0

  const dbAbs = dbPath ? resolve(dbPath).toLowerCase() : null
  for (const st of stats) {
    const f = st.path
    // DB 只走 DB 通道，不能被语料通道当成"超限文件"重复统计
    if (dbAbs && resolve(f).toLowerCase() === dbAbs) continue
    const s = { size: st.size, mtimeMs: st.mtimeMs }
    if (spent + s.size > budgetBytes) {
      incomplete.push({ source: 'files', reason: `扫描预算用尽（${Math.round(budgetBytes / 1048576)}MB），剩余文件未扫` })
      break
    }
    if (s.size > maxFileBytes) {
      incomplete.push({ source: 'files', reason: `跳过超限文件 ${f}（${Math.round(s.size / 1024)}KB）` })
      continue
    }
    try {
      if (TEXT_EXTS.includes(extname(f).toLowerCase())) {
        textCorpus += await readFile(f, 'utf8')
        sources.text = true
      } else {
        const buf = await readFile(f)
        binaryCorpus += buf.toString('latin1')
        sources.binary = true
      }
      corpusFiles += 1
      spent += s.size
    } catch (e) {
      incomplete.push({ source: 'files', reason: `读不了 ${f}: ${e.code ?? e.message}` })
    }
  }

  const dbCorpus = await readDbCorpus(dbPath, { incomplete, sources, rowCap })
  const all = textCorpus + binaryCorpus + dbCorpus
  const refScanIncomplete = incomplete.length > 0

  const nodes = []
  for (const name of names) {
    const { bytes, latestMtime } = await dirSize(join(artifactDir, name))
    const refs = all.split(name).length - 1
    const unstable = !isDiscriminativeName(name)
    nodes.push({ name, path: join(artifactDir, name), bytes, refs, latestMtime, refScanIncomplete, unstable })
  }
  const payload = { nodes, corpusFiles, corpusBytes: all.length, incomplete, sources }
  if (cachePath) {
    try {
      writeFileSync(cachePath, JSON.stringify({ fingerprint, payload, writtenAt: Date.now() }), 'utf8')
    } catch { /* 写缓存失败不影响本次结果，只是下次仍要重算 */ }
  }
  return { ...payload, cached: false, staleSeconds: 0 }
}

// 名字是否具备判别力：'jobs' 这种通用词的子串计数会把无关文本算成引用
export function isDiscriminativeName(name) {
  const s = String(name ?? '')
  if (s.length < 8) return false
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(s)) return true
  // 有结构 = 同时含数字与分隔符（aaaa-1111 / worker-batch-1-9c4ef 都算；jobs / tmp 不算）
  return /[0-9]/.test(s) && /[-_]/.test(s)
}

/**
 * 图判定：有引用 -> 保护；扫描不完整 -> 观察（不许回收）；零引用但冷却中 -> 观察；零引用且够老 -> 可回收
 * @param {{ refs: number, latestMtime: number, refScanIncomplete?: boolean, unstable?: boolean }} node
 * @param {{ now?: number, cooldownDays?: number }} [opts]
 */
export function classifyNode(node, { now = Date.now(), cooldownDays = 30 } = {}) {
  const ageDays = node.latestMtime ? (now - node.latestMtime) / 86400000 : Infinity
  if (node.unstable) {
    // 名字不具判别力：引用计数本身不可信，既不能据此回收，也不该假装"被引用"
    return { grade: 'yellow', reason: '名称不具判别力（可能是通用词），引用计数不可信，不参与回收判定', executor: null }
  }
  if (node.refs > 0) {
    return { grade: 'brown', reason: `被引用 ${node.refs} 处，删除会造成断链`, executor: null }
  }
  if (node.refScanIncomplete) {
    return { grade: 'yellow', reason: '引用扫描不完整（有来源不可读），无法确认零引用，不参与回收', executor: null }
  }
  if (ageDays < cooldownDays) {
    return { grade: 'yellow', reason: `零引用，但最近 ${ageDays.toFixed(1)} 天内仍在变动，处于冷却期`, executor: 'stage' }
  }
  return { grade: 'green', reason: `零引用且已 ${Math.floor(ageDays)} 天未变动`, executor: 'stage' }
}
