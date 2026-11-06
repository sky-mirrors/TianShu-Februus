// 路径归一：Windows 上同一路径可能以 \ 或 / 出现，比较前统一成 /。
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}
