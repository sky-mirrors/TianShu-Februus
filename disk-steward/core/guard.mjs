// 系统域禁区判定：纯函数，可注入 env，跨平台可测。
// 设计立场：宁可多保护。任何命中即拒绝，且优先级高于规则库与用户决定（不变量 I2 的最强形态）。
import { realpath } from 'node:fs/promises'
import { normalizePath } from './paths.mjs'

const collapse = (p) => {
  const out = []
  for (const seg of normalizePath(p).split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

export const DENY = {
  WINDOWS_DIR: 'Windows 系统目录',
  PROGRAM_FILES: 'Program Files 安装目录',
  PROGRAMDATA: 'ProgramData 系统共享数据',
  USER_DOCS: '用户个人目录（文档/桌面/图片/下载等）',
  PAGE_HIBER: '页面文件/休眠文件',
  RECYCLE_BIN: '回收站（本插件不接管）',
  VSS: '还原点/卷影副本',
  CRYPTO: '凭据/DPAPI 密钥',
  WINSXS: '组件存储 WinSxS',
  UNC: '网络共享路径（不在白名单规则库里，一律不碰）',
}

const RULES = [
  { code: 'WINDOWS_DIR', re: /^[a-z]:\/windows(\/|$)/ },
  { code: 'PROGRAM_FILES', re: /^[a-z]:\/program files( \(x86\))?(\/|$)/ },
  { code: 'PROGRAMDATA', re: /^[a-z]:\/programdata(\/|$)/ },
  { code: 'USER_DOCS', re: /^[a-z]:\/users\/[^/]+\/(documents|desktop|pictures|videos|music|downloads|onedrive|appdata\/roaming)(\/|$)/ },
  { code: 'PAGE_HIBER', re: /^[a-z]:\/(pagefile\.sys|hiberfil\.sys|swapfile\.sys)$/ },
  { code: 'RECYCLE_BIN', re: /^[a-z]:\/\$recycle\.bin(\/|$)/ },
  { code: 'VSS', re: /^[a-z]:\/system volume information(\/|$)/ },
  { code: 'WINSXS', re: /\/winsxs(\/|$)/ },
  { code: 'CRYPTO', re: /\/crypto\/keys(\/|$)|\/microsoft\/protect(\/|$)/ },
]

export function denyCode(path) {
  // UNC 必须在 collapse **之前**判：collapse 会吃掉空段，把 `//host/share`
  // 变成 `host/share`，之后任何 ^// 或 ^\\ 的判据都失效。
  if (String(path).replace(/\\/g, '/').startsWith('//')) return 'UNC'
  const p = collapse(path).toLowerCase()
  for (const r of RULES) if (r.re.test(p)) return r.code
  return null
}

export function isDenied(path) {
  return denyCode(path) !== null
}

export function denyReason(path) {
  const code = denyCode(path)
  return code ? `${code}: ${DENY[code]}` : null
}

export const GUARD_ERRORS = {
  DENIED_REALPATH: 'GUARD_DENIED_REALPATH',
  REALPATH_FAILED: 'GUARD_REALPATH_FAILED',
}

/**
 * 真实路径判定：字符串判定只挡"写出来的路径"，挡不住软链/junction 指向。
 * 这里先解析到底，再对解析结果跑一遍同样的禁区规则。
 * @param {string} path
 */
export async function assertRealAllowed(path) {
  let real
  try {
    real = await realpath(path)
  } catch (e) {
    return { ok: false, code: GUARD_ERRORS.REALPATH_FAILED, reason: e.code ?? String(e) }
  }
  const viaSymlink = normalizePath(real).toLowerCase() !== normalizePath(path).toLowerCase()
  if (isDenied(real)) {
    return { ok: false, code: GUARD_ERRORS.DENIED_REALPATH, realPath: real, viaSymlink, reason: denyReason(real) }
  }
  return { ok: true, realPath: real, viaSymlink }
}
