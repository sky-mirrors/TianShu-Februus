// 只读探测（不变量 I1）：只 readdir/stat，不创建、不移动、不删除。
import { readdir, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}

// 递归测量；返回字节数、文件数、扩展名构成、样本名、最新 mtime
// deadline（可选）：超过该时间点即停止遍历并置 partial=true——部分结果而不是挂死（全盘深扫用）
export async function measure(path, { sampleLimit = 3, extLimit = 4, deadline = Infinity } = {}) {
  const st = await stat(path)
  const exts = new Map()
  const samples = []
  let bytes = 0
  let fileCount = 0
  let latestMtime = st.mtimeMs
  let kind = 'file'

  if (!st.isDirectory()) {
    bytes = st.size
    fileCount = 1
    samples.push(basename(path))
    exts.set(extname(path) || '(无扩展名)', { files: 1, bytes: st.size })
  } else {
    kind = 'dir'
    let partial = false
    const walk = async (dir) => {
      if (partial) return
      if (Date.now() > deadline) {
        partial = true
        return
      }
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // 无权限：跳过，不猜测（不吞掉的是"跳过了"这个事实）
      }
      for (const e of entries) {
        if (partial) return
        // 预算必须在文件级也检查：只在进入目录时检查的话，单层几万个文件
        // 会一路 stat 到底（整盘深扫实测超预算 27.8s），deadline 形同虚设
        if ((fileCount & 63) === 0 && Date.now() > deadline) {
          partial = true
          return
        }
        const p = join(dir, e.name)
        if (e.isSymbolicLink()) continue // 不跟随符号链接（§7.4 规则 1）
        if (e.isDirectory()) { await walk(p); continue }
        let fst
        try { fst = await stat(p) } catch { continue }
        bytes += fst.size
        fileCount += 1
        if (fst.mtimeMs > latestMtime) latestMtime = fst.mtimeMs
        const ext = extname(e.name) || '(无扩展名)'
        const cur = exts.get(ext) || { files: 0, bytes: 0 }
        cur.files += 1
        cur.bytes += fst.size
        exts.set(ext, cur)
        if (samples.length < sampleLimit) samples.push(e.name)
      }
    }
    await walk(path)
    if (partial) {
      return { kind, bytes, fileCount, topExt: [], samples, latestMtime, partial: true }
    }
  }

  const topExt = [...exts.entries()]
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, extLimit)

  return { kind, bytes, fileCount, topExt, samples, latestMtime }
}

export async function exists(path) {
  try { await stat(path); return true } catch { return false }
}
