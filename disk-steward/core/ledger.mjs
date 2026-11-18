// 台账：append-only JSONL。没有台账的动作不允许执行（不变量 I5）。
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export function newId(prefix = 'b') {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

export function appendLedger(path, row) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
}

export function readLedger(path) {
  if (!existsSync(path)) return []
  const out = []
  // 一条坏行不该拖垮整批：undo / purgeBatch / quarantineStats 都建立在这上面，
  // 抛错等于"台账里有一行坏了，整批操作永久不可用"。
  // 坏行以 action:'corrupt' 现身（可见、可排查），但不会被当成有效记录参与判定。
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      // 语法合法不代表是台账行：null / 42 / "str" / {"action":{}} 都会让下游
      // 的 r.action 读取炸掉。只接受有字符串 action 的对象。
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.action === 'string') out.push(v)
      else out.push({ action: 'corrupt', raw: line.slice(0, 200) })
    } catch {
      out.push({ action: 'corrupt', raw: line.slice(0, 200) })
    }
  }
  return out
}

export function newToken() {
  return randomBytes(16).toString('hex')
}
