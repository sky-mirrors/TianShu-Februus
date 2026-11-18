# disk-steward 发行与提交审核

本文只记录「怎么把它交到 XiaoSi 插件库官方审核」这一步。插件本体说明见 README.md。

## 现状（本地已实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 生成发行目录 | `node scripts/pack-release.mjs` | 24 个文件（入口闭包 21 + rules 数据 1 + 清单 + 包声明） |
| 官方打包 | `npm run plugin -- pack <dist> <zip> --release-id … --publisher-id … --source-commit … --platforms win32-x64` | 生成 ZIP（114 509 字节） |
| 官方校验 | `npm run plugin -- validate <zip> --lane official_reviewed` | `valid: true`，`artifact_sha256 9f9c3cea…`，`manifest_sha256 12c0f1f9…` |

校验器用的就是 developer-kit 里的 `src/artifacts.ts`（`inspectArtifact`），与注册中心入库校验同一套 schema；宿主侧的 `parseTpiManifest` 也单独跑过，接受这份清单。

`dist/` 与 ZIP 都是生成物，不入库（见 `.gitignore`）。**改动源码后必须重新生成，不要复用旧 ZIP。**

## 谁必须提供（我无法代填）

1. `publisher_id` —— 开发者中心 `/developers/authorization` 完成发布者核验后由平台分配。上面的 `REPLACE_WITH_PUBLISHER_ID` 是占位符，真提交前替换。**这一项必须在浏览器里登录后人工完成**（或由用户把平台签发的 id 告我）。
2. `XPI_PUBLISHER_TOKEN` —— 发布者后台按插件和分区签发（形如 `XSPCI1_…`），只能由账号持有者取。

## 已具备的提交参数（不需再找人填）

| 参数 | 值 | 出处 |
|---|---|---|
| `--source-url` | `https://github.com/sky-mirrors/TianShu-Februus` | 公开仓库已发布（MIT） |
| `--license` | `MIT` | 仓库根 `LICENSE` 已就位，GitHub 已识别 |
| `--release-id` | `rel_disk_steward_0.1.0` | 版本号见 `tianshu.plugin.json` |
| `--platforms` | `win32-x64` | 只验证过本机平台 |
| `--data-use` | 见文末「数据与隐私」段原文 | — |
| `--source-commit` | 每次打包前取「实际被打包源码」的提交：`git rev-parse <commit>`。当前对应 `3c57e25e7619e9a65f8ac249f08d0c39fac0b044` | 源码改动后必须重打包并重取哈希 |

> `--license` 这一项原先缺 LICENSE 文件，现已解决：仓库根有 MIT 许可证。

## 提交命令

```sh
# 1) 重新生成发行目录（源码改动后必须做）
node scripts/pack-release.mjs

# 2) 打包（publisher-id 换成自己的，platforms 只写自己验证过的）
npm run plugin -- pack ./dist ./disk-steward-<version>.zip \
  --release-id rel_disk_steward_<version> \
  --publisher-id <publisher_id> \
  --source-commit <完整 40 位 commit> \
  --platforms win32-x64

# 3) 校验（本地，等价于入库那套规则）
npm run plugin -- validate ./disk-steward-<version>.zip --lane official_reviewed

# 4) 提交（走 CI 时也用它，凭据从 XPI_PUBLISHER_TOKEN 读）
export XPI_ORIGIN=https://xiaosiai.cn
export XPI_PUBLISHER_TOKEN=XSPCI1_…
npm run plugin -- submit ./disk-steward-<version>.zip --lane official_reviewed \
  --source-url <HTTPS 源码地址> --license <SPDX> \
  --data-use '<见下>' --release-notes '<版本说明>'

# 5) 跟踪
npm run plugin -- status rel_disk_steward_<version>
```

`pack` / `validate` / `submit` 分别需要 `packages:validate` / `releases:submit` / `releases:read` 权限，凭据在发布者后台按插件和分区签发。

## 清单里每个字段的取值依据

| 字段 | 值 | 依据 |
|---|---|---|
| `$tpi` / `kind` / `runtime` | `1.0` / `tianshu.plugin` / `agent` | 插件库首期只收 TPI 1.0 纯 JavaScript agent 包 |
| `id` | `disk-steward` | 不在保留名单（`xiaosi-axiom` 为内置），与入口 `index.js` 的 `defineTianshuPlugin({ id })` 一致 |
| `version` | `0.1.0` | 稳定 SemVer，无预发布标记。首发审核若按「第一个可用发行」处理，可改 `1.0.0` 后重打包 |
| `entry` | `index.js` | 包内相对路径，非空 UTF-8 JS |
| `capabilities` | `tools`, `storage`, `transcripts` | 工具面 + `activate(host)` 用 `host.storage.dataDir()`；`host.transcripts.read()` 用于核实「用户真的说过批准那句话」 |
| `contributes.tools` | 9 个 | 与 `createTools()` 返回的工具名一一对应（`test/w33.test.mjs` 断言） |
| `contributes.lifecycle` | `[]` | 插件不挂生命周期钩子 |
| `permissions.fs` | `true` | 扫描/移动/删除文件 |
| `permissions.shell` | `true` | `spawnSync` 调 `tasklist`、`sc.exe`、`net`（前置条件与提权检测） |
| `permissions.net` | `false` | 无任何网络访问 |
| `engines.tianshu` | `>=4.0.2 <5.0.0` | 打包器强制要求；发行记录里的 `compatibility.core` 与它必须一致 |

## 审核会被追问的几处，先说清

- **它真的会删文件**：8 个工具里 `disk_exec` 有写入权（`fs` 权限的实质来源）。防线是四层，缺一层就不执行：
  1. `disk_plan` 只对非保护、未被挡、可 stage 的项签发一次性令牌（10 分钟过期）；
  2. `disk_exec` / `disk_undo` 的 `approval` 不能只是非空字符串：插件用 `host.transcripts.read(sessionId)` 回到本会话记录，只认 `role === 'user'` 消息里的原文片段，助手自己写的话不算；宿主未提供会话记录时直接 `EXEC_APPROVAL_UNVERIFIABLE` 拒绝。插件只核实字面出处，**不判断这句话是否构成授权**——「不要删除」「不删 A 删 B」这类语义由天枢理解对话后决定，不做词表启发式；
  3. 默认 `mode=stage` 只是移入隔离区（可 `disk_undo` 撤销），`mode=purge` 永久删除另需批次已 staged + 同一令牌；
  4. 执行期对每个目标重新 `realpath` 判禁区、重新取 dev+ino+size+mtime 与扫描时比对，不符即回滚并记 `abort`。
- **写到哪里**：台账、run 落盘、隔离区都在宿主 `storage.dataDir()` 之下（`<dataDir>/runs`、`<dataDir>/trash`），不写插件安装目录——安装目录是随时可被更新/卸载替换的发行包。
- **第三方依赖**：零。`scripts/pack-release.mjs` 会走 import 图，遇到非 `node:` 且非相对路径的 import 直接报错，发行包里不可能带 `node_modules`。
- **原生二进制 / 安装脚本**：无（纯 ESM JS，`package.json` 只有标识字段，无 `scripts`、无 `dependencies`——这也是打包器 `validateFile` 的硬性要求）。
- **生命周期与脚本钩子**：无。因此也满足 `paid_unreviewed` 分区的形态要求（该分区要求贡献工具、禁止 lifecycle 与 hooks）——当前宿主阻止未审核付费包执行，先走 `official_reviewed`。
- **隐私**：扫描只读体积与路径，不读文件内容；`includeSamples` 默认关闭，结果里的样本文件名一律清空，显式 `true` 才会记录。`disk_report` 生成的是体积清单与逐项解释，不含文件内容。

## 提交页要填的三段文本（可直接粘贴）

### 数据用途

> 不收集、不上传任何用户数据。插件在本机运行，无网络访问（`permissions.net=false`）。扫描仅统计路径与占用体积，不读取文件内容；样本文件名默认脱敏（`includeSamples` 默认关闭）。台账、扫描结果与隔离区文件仅写入本机宿主数据目录（`storage.dataDir()`），供撤销与审计使用，不离开本机。

### 外部服务与费用

> **无外部服务**：零第三方依赖（发行包只含 `node:` 内建模块与相对路径 import），不访问任何网络端点、不调用云 API、无遥测与分析。
> **费用**：插件免费，无内购、无订阅、无按次计费。运行不产生任何费用。
> `permissions.shell=true` 仅用于调系统自带命令做前置条件检查与提权判定（`tasklist` / `sc.exe query` / `net`），不下载、不安装、不联网。

### 版本变更说明（0.1.0 首发）

> 首个公开版本。
>
> - 9 个工具：`disk_scan` / `disk_status` / `disk_rules` / `disk_report` / `disk_diff` / `disk_plan` / `disk_exec` / `disk_undo` / `disk_recover`
> - 双域扫描：天枢自身数据（`~/.rivet`、项目 `.rivet`）+ Windows 系统缓存（天枢域 21 条规则、系统域 35 条规则）
> - 两阶段执行：`stage` 移入隔离区（可撤销）→ `purge` 永久删除；执行前四层校验（一次性令牌 / 人工批准原话比对会话记录 / 批次已 staged / realpath + dev+ino+size+mtime 复核）
> - 硬禁区 10 类（含 UNC 网络路径），append-only 台账（坏行降级为 `corrupt` 不拖垮整批），崩溃恢复入口
> - 259 个用例全绿；仅验证 Windows x64

## 实测发现：release-id 不允许点号

`--release-id rel_disk_steward_0.1.0` 会被 zod 拒（`must match /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/`）。
改用下划线：**`rel_disk_steward_0_1_0`**。

## 已生成的发行包（源码 `3c57e25e7619e9a65f8ac249f08d0c39fac0b044`）

```
.tmp-devkit/disk-steward-0.1.0.zip   163 858 字节
release_id      = rel_disk_steward_0_1_0
publisher_id    = b226234e-c3c8-4223-9e58-7e9fadbb5bea   （写在包内 xiaosi.release.json）
artifact_sha256 = e9c7321a2c828137cff615e131d90fb3318c9810f689dc510daafdbcec4e645a
validate --lane official_reviewed → valid: true, errors: 0
```

> 该包已含 `dist/LICENSE`（与仓库根逐字节一致）。
> `publisher_id` **确实写进包内** `xiaosi.release.json`（曾误判为「不写进包」，解开 ZIP 实测纠正）。换发布者必须重打包。
