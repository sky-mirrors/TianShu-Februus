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
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export function newToken() {
  return randomBytes(16).toString('hex')
}
