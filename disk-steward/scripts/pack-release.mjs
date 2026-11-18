#!/usr/bin/env node
// 生成可提交的发行目录 dist/：只含运行时真正需要的文件。
// 为什么需要这一步——官方打包器（developer-kit 的 packagePlugin）会把源目录整颗收进 ZIP，
// 而源码目录里有 .runs/（run 落盘）、.trash/（隔离区）、test/、bin/、README.md，
// 以及带 "scripts" 的 package.json（打包器的 validateFile 见到 scripts 直接拒绝）。
// 这里按 import 图算出运行期闭包，再补上不在 import 图里、但运行时要读的数据文件。
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const ENTRY = 'index.js'

// 运行期会被 readFileSync 读、因而不出现在 import 图里的文件
const DATA_FILES = ['rules/tianshu.rules.json']

const toPosix = (p) => p.split(sep).join('/')
const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))

// 从入口出发走 import 图。只允许 node: 内置与相对路径——发行包不带 node_modules。
const closure = new Set()
const queue = [ENTRY]
while (queue.length) {
  const rel = queue.shift()
  if (closure.has(rel)) continue
  const abs = join(ROOT, rel)
  const source = readFileSync(abs, 'utf8') // 目标不存在就地抛错，不生成缺文件的包
  closure.add(rel)
  for (const match of source.matchAll(/from '([^']+)'/g)) {
    const spec = match[1]
    if (spec.startsWith('node:')) continue
    if (!spec.startsWith('.')) {
      throw new Error(`${rel}: 发行包不允许第三方依赖（${spec}）`)
    }
    queue.push(toPosix(relative(ROOT, resolve(dirname(abs), spec))))
  }
}

// 发行包的许可证来自仓库根（与 disk-steward/ 同级），不在 import 图里，
// 也不以规则数据的形式被 readFileSync 读到 —— 必须显式复制。
const ROOT_LICENSE = join(ROOT, '..', 'LICENSE')
rmSync(DIST, { recursive: true, force: true })
for (const rel of [...closure, ...DATA_FILES, 'tianshu.plugin.json']) {
  const dest = join(DIST, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(ROOT, rel), dest)
}
cpSync(ROOT_LICENSE, join(DIST, 'LICENSE'))

// 发行包的 package.json 只留标识：含 scripts / dependencies 会被官方校验器拒绝
writeFileSync(
  join(DIST, 'package.json'),
  JSON.stringify(
    {
      name: manifest.id,
      version: manifest.version,
      private: true,
      type: 'module',
      description: manifest.description,
    },
    null,
    2,
  ) + '\n',
)

const files = [...closure, ...DATA_FILES, 'tianshu.plugin.json', 'package.json', 'LICENSE'].sort()
console.log(`dist/ 就绪：${files.length} 个文件（入口闭包 ${closure.size} + 数据 ${DATA_FILES.length} + 清单/包声明）`)
console.log(files.map((f) => `  ${f}`).join('\n'))
