# 架构设计：disk-steward —— 系统磁盘清理 + 天枢自身磁盘回收（单插件双域）

**状态**：设计稿（未实现）
**依据**：`docs\系统流畅度与磁盘清理插件调研报告.md`（下称"调研"）的架构结论 + 本机实测的天枢磁盘足迹
**目标读者**：实现者（下一波写代码的人）

---

## 1. 不变量台账（实现时必须逐条守住）

| # | 不变式 | 来源 |
| --- | --- | --- |
| I1 | 扫描阶段只读：`readdir`/`stat`/`du` 等价调用，不创建、不移动、不删除任何目标文件 | 调研 §7.4 规则 1（pancha） |
| I2 | 规则库未收录的路径一律视为保护；该判定优先级高于用户自定义规则与 Agent 决定 | 调研 §7.4 规则 2（c-cleanup"不明即不删"） |
| I3 | 永久删除只允许作用于本插件 `stage` 阶段移入隔离区的批次，且必须携带 `disk_plan` 签发的确认令牌 | 调研 §7.4 规则 5/6（deepclean 两阶段、pancha 只移动） |
| I4 | Agent 不持有执行权：Agent 只能 `scan`/`plan`/`decide`（写决定），`exec` 必须由用户显式触发（TUI 确认或带令牌的调用） | 调研 §7.4 规则 7（pancha"它没有执行权，只能写标记"） |
| I5 | 每一次状态变更追加一行到 `ledger.jsonl`，含 `before`/`after` 路径与反演指令；无台账的动作不允许执行 | 调研 §6.3（回滚取决于"记录了原始状态"） |

边界表述：**I1–I5 是代码里的硬约束**（分支/参数校验/拒绝执行），不是提示词约定。调研 §7.2 已经证明"软约束"在 DSH 生态里是真实漏洞，本设计不重复它。

---

## 2. 现状基线（本机实测，决定规则库长什么样）

天枢的磁盘足迹分两处，语义完全不同——这是"双域"设计的物理来源。

### 2.1 全局作用域 `~/.rivet`（实测 2026-11-04）

| 路径 | 体积 | 性质 | 可回收性 |
| --- | --- | --- | --- |
| `plugins/` | **61.7 MB**（其中 `media-toolkit/node_modules` 占 **61.5 MB**；该目录有 `package.json` + `package-lock.json`，可 `npm ci` 重建） | 已装插件代码（含 `test/`、`ui/`） | 🔴 不是垃圾；只有"已卸载插件的残留"与陈旧构建产物可清 |
| `meridian.db` | **46 MB** | 会话/记忆主库 | 🟠 不可删；可 `VACUUM` 压实（需独占、有风险） |
| `tmp/` | **13.2 MB**（其中 `pypi-names.txt` **单文件 13.1 MB**） | 临时工作文件 | 🟢 可清（不在使用时） |
| `scratch/` | **6.8 MB** | 一次性探针产物（约定位置） | 🟢 可清 |
| `meridian.db-wal` | **5.3 MB** | SQLite 预写日志 | 🟡 可 checkpoint 归并，不能直接删 |
| `artifacts/` | **4.7 MB** | 历史产物（截图/报告/媒体） | 🟡 按时间/会话引用保留最近 N |
| `backups/` | **4.2 MB** | 插件/配置备份 | 🟡 保留最近 N 份 |
| `skills/` `knowledge/` `plans/` | 1.2 MB / 217 KB / 112 KB | 能力与知识资产 | 🔴 永不自动删 |
| `HANDOFF.md` + 4 份 `HANDOFF-archive-*.md` | 88 KB + ~90 KB | 交接文档与归档 | 🟡 归档可清，最新一份必须保留 |
| `cache/` | 66 KB | 宿主缓存 | 🟢 可清 |

### 2.2 项目作用域 `D:\Februus\.rivet`（实测 6.8 MB）

| 路径 | 体积 | 性质 | 可回收性 |
| --- | --- | --- | --- |
| `cache/web-fetch/` | 3.8 MB | HTTP 抓取缓存 | 🟢 可清 |
| `meridian.db-wal` | 2.7 MB | 项目库 WAL | 🟡 checkpoint |
| `meridian.db` / `-shm` | 180 KB / 32 KB | 项目库 | 🟠 VACUUM only |
| `scratch/` | 108 KB | 一次性探针 | 🟢 可清 |
| `skills/` `knowledge/` `artifacts/` | 24 KB / 4 KB / 13 KB | 资产 | 🔴 / 🟡 |

### 2.3 系统临时区

| 路径 | 体积 | 性质 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Temp\rivet-raw\` | **活目录**：本次会话期间由 458 KB / 88 文件变为 211 KB / 93 文件 | 工具输出原文转储，会话结束即无引用 |

**结论**：天枢侧一次性可回收量 ≈ **25–30 MB**（🟢 级：tmp 13.2 + scratch 6.3 + 项目 cache 3.8 + 零碎；🟡 级另可释放 artifacts/backups 保留最新 N 份后的余量与 WAL checkpoint 约 5 MB）。`meridian.db` 的 VACUUM（需独占）与 `node_modules` 重建（可能离线失败）**都不计入**——它们不是"可回收"，是"可重建"。这个量级决定了**收益主要来自"定期归位"而非"一次性大扫除"**——与调研 §4.1 对 C 盘的判断同构：C 盘爆满多数是"东西放错了地方"，天枢目录膨胀也一样（tmp/artifacts 无限增长，因为没人负责归位）。

---

### 2.4 复核：两套独立实现的一致性

同一组数字用 `du -sh`（块级）与 Node/Python 的 `os.walk` 字节求和（长度级）分别测过，两种实现互不依赖：

| 项 | `du -sh` | python 字节求和 | 判读 |
| --- | --- | --- | --- |
| `~/.rivet` 总计 | — | 141.52 MB | 与上表分项相加一致 |
| `plugins/` | 62 MB | 61.68 MB | 一致 |
| `meridian.db` | 46 MB | 45.86 MB | 一致 |
| `tmp/` | 14 MB | 13.23 MB | 一致（`du` 取整） |
| `scratch/` | 6.8 MB | 6.33 MB | 一致 |
| `meridian.db-wal` | 5.3 MB | 5.25 MB | 一致 |
| `artifacts/` / `backups/` | 4.7 / 4.2 MB | 3.97 / 3.94 MB | 差 0.7/0.3 MB：`du` 计块对齐开销，属预期 |
| 项目 `.rivet` | 6.8 MB | 7.23 MB | 差异来自活着的 WAL，两次采样间隔内增长 |
| `%TEMP%\rivet-raw` | 458 KB / 88 文件 | 211 KB / 93 文件 | **同一目录两次采样不同 → 证明它在被写入** |

两个直接影响规则库的发现：

1. **体积集中度极高**：`tmp/` 的 13.2 MB 里有 13.1 MB 是单个文件 `pypi-names.txt`；`plugins/` 的 61.7 MB 里有 61.5 MB 是 `media-toolkit/node_modules`。所以**判定必须精确到 item（文件/子目录）级，不能停在目录级**——否则"整个 tmp 目录 🟢"这种规则会连带删掉目录里可能还有用的 JSON。
2. **`node_modules` 的语义是"可重建"不是"可删"**：它是依赖树，不是垃圾。重建需要网络与锁文件一致，离线环境可能失败——所以它属 🟡（谨慎），且只在"确实缺空间"时由人决定。

---

## 3. 为什么必须是一个插件

调研里三个清理插件是三个独立插件，代价是：三套分级、三份台账、三种撤销语义、用户要记三次。天枢这两域的形状却完全一致：

```
输入：一组路径 + 一个判定规则库
处理：量体积 → 分级 → 人决定 → 两阶段执行 → 记账 → 可撤销
输出：释放的字节数 + 一份可审计台账
```

差异只在两处，都可以参数化：

| 维度 | 系统域（System） | 天枢域（Tianshu） |
| --- | --- | --- |
| 规则来源 | 外部软件的缓存路径（我们无法控制，只能猜+保守） | **我们自己的目录语义**（可以把"什么能删"写进代码约束） |
| 权限 | 部分项需 UAC（`ProgramData`、`WinSxS`、其他用户目录） | 同用户即可，**不需要提权** |
| 判定确定性 | 低（IDE 索引可重建但代价未知） | 高（`scratch/` 是约定的一次性区，`knowledge/` 是永不删） |
| 危险动作 | 删用户文件、迁移 junction | 删自己的资产（误删代价是"失忆"，比文件丢失更难发现） |
| 保护对象 | 用户文档、凭据、虚拟磁盘 | `meridian.db`、`knowledge/`、`plans/`、`skills/`、最新 `HANDOFF.md` |

**所以一个插件、两个域适配器**：共享流水线（scan/grade/decide/stage/purge/undo），各带一份规则库与一份保护名单。这也是调研里唯一没被验证过的组合方式——三个 DSH 插件都没做"自应用清理"，天枢有天然优势：**我们拥有被清理对象的所有权，可以把每条规则写成可解释的断言，而不是启发式猜测**。

---

## 4. 分层架构

```
                ┌──────────────────────────────────────────────┐
   人（TUI）    │  /disk 面板：扫描结果、分级、决定、执行、撤销 │
   Agent       │  tools: disk_scan / plan / decide / exec ...  │
                └───────────────┬──────────────────────────────┘
                                │ 同一份数据（apply 与按键等价）
                ┌───────────────▼──────────────────────────────┐
                │              Orchestrator                    │
                │  run 生命周期、决定优先级、令牌签发、串行化    │
                └───┬──────────┬──────────┬──────────┬─────────┘
                    │          │          │          │
        ┌───────────▼──┐  ┌────▼─────┐  ┌─▼────────┐  ┌▼──────────┐
        │ Probe 探测层  │  │ Grader   │  │ Decider  │  │ Executor  │
        │ 只读，可并行  │  │ 分级器   │  │ 决定合并 │  │ 两阶段执行 │
        └───────┬──────┘  └────┬─────┘  └─┬────────┘  └┬──────────┘
                │              │          │            │
        ┌───────▼──────────────▼──────────▼────────────▼──────────┐
        │                    Domain Adapters                       │
        │  ┌────────────────────┐      ┌────────────────────────┐  │
        │  │ SystemDomain       │      │ TianshuDomain          │  │
        │  │ 规则: 外部软件路径 │      │ 规则: 天枢目录语义      │  │
        │  │ 提权: 按项可选      │      │ 提权: 无               │  │
        │  │ 执行: 删/移动/junction│    │ 执行: 删/移动/checkpoint│ │
        │  └────────────────────┘      └────────────────────────┘  │
        └───────────────────────────┬─────────────────────────────┘
                                    │ 每步写一行
                        ┌───────────▼───────────┐
                        │  Ledger (append-only) │
                        │  ledger.jsonl + 批次   │
                        └───────────────────────┘
```

四层职责与边界：

- **Probe**：只读，串行/并行均可（I1）。天枢域用 Node `fs.promises` 遍历 + 目录大小估算（硬链接去重用 `ino` 集）；系统域用 `Get-ChildItem -Recurse | Measure-Object -Sum Length` 或 `du` 等价（PowerShell，不提权也能读多数路径）。**扫描永不请求提权**——这是 I1 的推论，也让"扫描"这一步可以随时跑。
- **Grader**：纯函数。输入 `{path, size, matchedRule}`，输出 `{grade, reason, executor, undoable}`。**规则命中不到 = 保护**（I2），这条必须在 Grader 的第一行实现，不能作为"默认分支"。五级沿用调研 §4.1：🟢 安全删 / 🟡 谨慎删 / 🟠 建议迁移 / 🔴 保护 / 🔵 长期防护。
- **Decider**：把人（TUI 按键）与 Agent（`disk_decide`）的决定合并到同一数据结构，**人优先**；Agent 只能追加 `objection` 字段，不能翻转人的决定（调研 §4.2 的机制）。
- **Executor**：唯一有写权限的层。两阶段：`stage`（移动到隔离区，同卷 rename，瞬间完成、可撤销）→ `purge`（永久删除，需令牌，且只限本批次）。迁移动作用 `junction`（系统域）或配置路径改写（天枢域：如把 `TMP` 指到别的盘），动作本身也记台账以便反演。

---

## 5. 域适配器接口（唯一需要两份实现的契约）

```js
// domain adapter contract —— 两个域各自实现，Orchestrator 只认这个接口
export const contract = {
  id: 'tianshu' | 'system',
  // 1) 产出候选（只读）：返回 {path, bytes, kind, evidence}
  async scan({ roots, minBytes, signal }) {},
  // 2) 规则库：ruleId -> {grade, reason, executor, undo}
  rules() {},
  // 3) 执行单项（只被 Executor 调用；不得自行决定是否可执行）
  async execute(item, { mode, batchDir, signal }) {},   // mode: 'stage' | 'purge' | 'migrate'
  // 4) 反演（undo）：依据台账行恢复
  async revert(ledgerRow) {},
  // 5) 是否需要提权（只影响提示，不影响判定）
  requiresElevation(item) { return false },
}
```

关键约束：**规则库与执行器分离**。`rules()` 决定"该不该"，`execute()` 只负责"怎么做"。这样加规则不用碰执行代码（调研 §5.3 Dism++/BleachBit 的 "引擎 + 规则文件" 结构），也让规则可被单独测试。

---

## 6. 规则库格式（JSON，随插件发布）

```json
{
  "$schema": "disk-steward/rule@2",
  "domain": "tianshu",
  "rules": [
    {
      "id": "tianshu.scratch",
      "match": { "kind": "prefix", "path": "{{rivetHome}}/scratch" },
      "grade": "green",
      "reason": "一次性探针产物目录（约定位置），清理无信息损失",
      "executor": { "type": "stage" },
      "undo": true,
      "probe": "exists"
    },
    {
      "id": "tianshu.memory-db",
      "match": { "kind": "prefix", "path": "{{rivetHome}}/meridian.db" },
      "grade": "brown",
      "reason": "会话/记忆主库，删除等于失忆；只允许 checkpoint/VACUUM",
      "executor": { "type": "compact", "method": "wal_checkpoint" },
      "undo": false
    }
  ]
}
```

- 变量：`{{rivetHome}}`、`{{projectRivetHome}}`、`{{tmpDir}}`、`{{localAppData}}`。
- `grade` 取值：`green | yellow | orange | brown(保护) | blue(长期防护)`；**无匹配 → brown**。
- `executor.type` 只有四种：`stage`（可撤销）/ `purge`（需令牌）/ `migrate`（junction 或配置改写）/ `compact`（VACUUM/checkpoint，不可撤销但无数据损失）。
- 规则必须带 `reason`（调研 §4.1：分级必须带判定理由，否则用户无法决策）。

---

### 6.1 规则字段 v2（依据补充调研 §3.1 对 Winapp2 的实测）

首版只有 `match/grade/reason/executor`。对 4,068 条 Winapp2 规则做本地解析后，发现主流规则库都在解决四件事：**在哪找、删什么、不能删什么、删之前要知道什么**。首版缺了后三件，补齐为 v2：

| 字段 | 必填 | 语义 | 缺省行为 |
| --- | --- | --- | --- |
| `detect` | 否 | 前置存在性（glob）。**不命中则整条规则不参与扫描** | 无 `detect` = 恒参与（仅限无条件安全目标，如 `%TEMP%`） |
| `match` | 是 | 目标（`prefix` / `glob` / `kind`） | — |
| `exclude` | 否 | 规则内排除，**优先级高于 `match`**（例：缓存目录里的 `*.db` 不删） | 无 |
| `flags` | 否 | `recurse` / `removeSelf` | 默认不递归、不自清目录 |
| `grade` | 是 | `green/yellow/orange/brown/blue` | — |
| `reason` | 是 | 给人读的判定理由 | — |
| `precondition` | 否 | **机器可检查**的执行前置：`fileExists` / `serviceStopped` / `processNotRunning` | 无前置 |
| `sideEffect` | 否 | 人读的副作用（"会一并删掉应用设置"） | — |
| `executor` | 是 | `stage` / `purge` / `migrate` / `compact` | — |

三条实现期硬规则：

1. `precondition` 不满足 → 执行阶段该 item 自动 `skip` 并在报告里标注原因，**不猜、不重试**。（Winapp2 的五条 `Warning` 里有两条就是这类："先启动游戏一次再清否则 Steam 认为安装损坏"、"需安全模式或先停服务"。）
2. `grade=brown`（保护）的规则**不允许出现 `executor` 字段**，规则库加载时即校验失败（fail-closed 落到 schema，而不是落到运行时判断）。
3. `detect` 未命中 → **不产生 item、不进报告**，避免"列出一堆不存在的路径"的噪声（这正是 Winapp2 里 3,322 条 `DetectFile` 的用途）。

反面教训也记在这里：Winapp2 用节名末尾的 `*` 标记"危险项"，实测 **4,068 / 4,068 条全部带 `*`**，信号完全失效，真正的警告退化成 5 条自由文本。**不要用标记字符承载语义**——分级（`grade`）、先决条件（`precondition`）、副作用（`sideEffect`）必须是三个独立字段。

---

## 7. 运行状态机

```
   idle ──scan──► scanning ──完成──► reviewed ──decide──► planned
                                        │                   │
                                        │            ┌──────┴──────┐
                                        │        stage          (仅 blue 项)
                                        │            │              │
                                        │            ▼              ▼
                                        │        staged ──purge(令牌)──► purged
                                        │            │
                                        │            └──undo──► reverted
                                        └──scan 可随时重跑（只读，不打断已有 run）
```

约束：`purged` 是终态（不可逆）；`staged` 可回 `reverted`；同一时刻只允许一个 run 处于 `staged`（避免两批隔离区混在一起无法区分归属）。

---

## 8. 工具面（TPI 1.0 实现）

依据实测的插件清单契约（`$tpi`/`kind`/`runtime`/`entry`/`capabilities`/`contributes.tools`/`permissions`）与工具工厂契约（`createTools(deps)` 返回 `{name, description, inputSchema, pathParams, concurrencySafe, timeoutMs, execute(call) -> {content, isError}}`）：

```json
{
  "$tpi": "1.0", "kind": "tianshu.plugin", "id": "disk-steward",
  "displayName": "磁盘管家", "version": "0.1.0",
  "runtime": "agent", "entry": "index.js",
  "capabilities": ["tools"],
  "contributes": {
    "tools": [
      {"name": "disk_scan",   "description": "只读扫描：产出候选清单与 run_id（域可选 system/tianshu/both）"},
      {"name": "disk_report", "description": "生成完整分级报告（按体积排序，含每条规则的判定理由）"},
      {"name": "disk_decide", "description": "写入决定：clean/migrate/keep，只补未决定的项，不改人的决定"},
      {"name": "disk_plan",   "description": "生成执行计划并签发确认令牌（含预计释放、需提权项、不可逆项）"},
      {"name": "disk_exec",   "description": "执行：stage 移动入隔离区（可撤销）；purge 永久删除（需令牌）"},
      {"name": "disk_undo",   "description": "按批次撤销 stage（依据台账反演）"},
      {"name": "disk_status", "description": "轻量概览：各卷可用空间 + 天枢两域体积摘要"},
      {"name": "disk_rules",  "description": "列出/解释规则库：某路径为什么被判为某级"}
    ],
    "lifecycle": []
  },
  "permissions": { "fs": true, "net": false }
}
```

工具语义细节（决定实现是否安全）：

| 工具 | 只读 | 关键参数 | 返回 | 硬约束 |
| --- | --- | --- | --- | --- |
| `disk_scan` | ✅ | `domain`, `roots?`, `minBytes=1048576` | `{run_id, total_bytes, items: top20}` | 不做任何写操作；`items` 只回前 20 条，全量走 `disk_report`（token 经济，同 `dsh-ops` 思路） |
| `disk_report` | ✅ | `run_id`, `format=md` | 报告文件路径 | 落 `artifacts/disk-steward/<run_id>.md` |
| `disk_decide` | ❌(只改内存/账本的决定段) | `run_id`, `decisions:[{itemId, decision}]` | 合并结果 | 保护级项返回 `refused`，含理由（I2） |
| `disk_plan` | ✅ | `run_id` | `{plan_id, token, will_free, needs_elevation, irreversible}` | 令牌 = `sha256(plan_id + itemIds + 证据摘要)`，一次性 |
| `disk_exec` | ❌ | `plan_id`, `token`, `mode` | 每条结果 | `mode=purge` 无有效令牌 → 拒绝；`purge` 只接受本批次 `staged` 项（I3） |
| `disk_undo` | ❌ | `batch_id` | 恢复条数 | 只反演台账里 `undo_supported=true` 的行 |
| `disk_status` | ✅ | — | 卷/域摘要 | 不做全盘扫描（<200 ms） |
| `disk_rules` | ✅ | `path?` | 规则或"无匹配→保护" | 必须能解释"为什么删/为什么留" |

`pathParams`：`disk_report` 的产物写 `artifacts/` 标 `write`；其余工具不声明路径参数（它们操作的是 run 与台账，不是任意路径），避免把"任意路径写入"暴露给 Agent。

---

## 9. 台账与撤销（可回滚的物理基础）

`~/.rivet/disk-steward/ledger.jsonl`，append-only，一行一次状态变更：

```json
{"ts":1791372812870,"run":"r-7f2a","batch":"b-01","itemId":"tianshu.scratch:/.../scratch/research",
 "action":"stage","from":"D:/Februus/.rivet/scratch/research","to":"D:/Februus/.disk-steward-trash/b-01/…",
 "bytes":108000,"ruleId":"tianshu.scratch","undoSupported":true,"domain":"tianshu"}
```

- **隔离区同卷**：`<root>/.disk-steward-trash/<batch>/` → `rename` 即完成，撤销也是 `rename`，不产生跨卷复制（跨卷时退化为复制+删除，日志里标 `crossVolume:true`，并在计划阶段就提示代价）。
- **撤销 = 反演台账**：从最后一行往前，`to → from`；遇到 `crossVolume` 或目标已存在则跳过并报告，不猜测。
- **purge 也要记一行**：`action:"purge"`，`undoSupported:false`，保留 `from` 路径与字节数——**即使无法恢复，也要留下"删过什么"的证据**（调研 §8.2：不可逆动作必须可追溯）。

---

## 10. 权限与安全模型

| 层 | 权限 | 说明 |
| --- | --- | --- |
| Probe / Grader / Decider | 读 | 不需要提权；系统域扫描用 PowerShell 只读命令 |
| Executor（天枢域） | 写用户目录 | 无需提权 |
| Executor（系统域，用户态项） | 写用户目录 | 无需提权 |
| Executor（系统域，系统项） | **UAC** | 只在 `disk_exec` 阶段按项提升；计划阶段先告知"这些项需要提权" |

三条硬门（代码级，不靠提示词）：

1. `purge` 必须带 `disk_plan` 签发的一次性令牌，且令牌与 `plan_id` 绑定（重放失效）。
2. `purge` 的输入集合必须是本插件 `staged` 批次的真子集；清单里有任何未 `staged` 的项 → 整批拒绝（不做"部分执行"）。
3. 保护级（brown）项在任何路径上都没有 `exec` 分支——`disk_decide` 直接回 `refused`，`disk_exec` 在校验阶段过滤。

插件清单 `permissions` 只申请 `fs:true, net:false`：清理不需要网络，申请网络权限会扩大供应链攻击面（调研 §7.2）。

---

## 11. 目录与持久化布局

```
~/.rivet/plugins/disk-steward/          # 代码（跟随插件装载）
  tianshu.plugin.json
  index.js                              # entry：createTools(deps)
  tools/index.mjs                       # 8 个工具定义
  domains/system.mjs                    # SystemDomain（含 PowerShell 脚本模板）
  domains/tianshu.mjs                   # TianshuDomain（含目录语义与保护名单）
  rules/system.rules.json
  rules/tianshu.rules.json
  core/{probe,grader,decider,executor,ledger}.mjs
  ui/index.html + ui/server.mjs         # 可选：/disk 面板（TUI 之外）
  test/*.test.mjs

~/.rivet/disk-steward/                  # 运行态（不进版本控制）
  ledger.jsonl
  runs/<run_id>.json                    # 扫描快照 + 决定（供 report/plan 复现）
  plans/<plan_id>.json                  # 令牌与不可逆清单
```

数据与代码分离：卸载插件不丢台账（用户仍可查"删过什么"），重装后可继续 `disk_undo` 之前批次。

---

## 12. 分期实施与验收

| 波次 | 内容 | 验收（可执行） |
| --- | --- | --- |
| **W0** 骨架 + 天枢域只读 | 清单、entry、`domains/tianshu.mjs` 的 scan、`disk_scan`/`disk_status`/`disk_rules` | `node --test test/probe.test.mjs` 通过；`disk_scan` 报告的天枢两域数字与 `du -sh` 实测误差 <5%（本次基线：全局 141.5 MB、项目 7.2 MB，两套独立实现复核见 §2.4）；活跃目录排除：连续两次 `disk_scan`，第二次必须把首次之后被写入的项判为"跳过（活跃）" |
| **W1** 分级 + 报告 | grader（含"无匹配=保护"首行实现）、`disk_report` | 单测覆盖每个 grade 分支 + 未知路径落 brown；报告能回答"为什么删/为什么留" |
| **W2** 两阶段执行 | executor（stage/purge）、ledger、`disk_plan`/`disk_exec`/`disk_undo` | RED→GREEN：先写"无令牌 purge 必须失败"的测试；再写"stage 后 undo 能原样恢复（含 mtime/大小）" |
| **W3** 系统域 + 提权 | `domains/system.mjs`、UAC 按项提升、迁移（junction） | 在临时目录构造假目标做端到端：迁移后应用读原路径仍成功；撤销后 junction 消失 |
| **W4** 可视化与生命周期 | TUI `/disk` 面板（必需）+ `ui/` Web 面板（可选）、`lifecycle` 挂 checkpoint 建议 | §14.5 的 T1–T6 全绿；其中 **T2（每项必含 title/what/why/undo）提前到 W1** 作为扫描器的第一个 RED 测试 |

每个波次结束提交一次（`feat(disk-steward): ...`），W2 之后每次执行类改动都必须带 RED 测试。

---

## 13. 借鉴与改造对照（与调研的对应关系）

| 调研结论 | 本设计的落地 | 改造点 |
| --- | --- | --- |
| 五级分级（c-cleanup §4.1） | `grade` 五值 + `reason` 强制 | 增加 `compact` 执行器（天枢域特有：VACUUM 不是删除） |
| 不明即不删（fail-closed） | Grader 首行实现，未知→brown | 原文是"用户规则不得覆盖"，这里再加一条"Agent 决定不得覆盖" |
| Agent 只写标记（pancha §4.2） | I4 + `disk_decide` 的 `refused`/`objection` | 增加 `disk_rules` 让 Agent 能解释判据，减少"猜规则" |
| 两阶段清理（deepclean §4.3） | stage → purge + 令牌 | 令牌机制是新增（deepclean 靠 UI 二次确认，这里要挡住 Agent 调用） |
| 台账 + 撤销（§6.3） | append-only ledger + 反演 | 同卷 rename 优先，跨卷显式标注代价 |
| 迁移优先于删除（c-cleanup） | `executor.type=migrate`（junction / 配置改写） | 天枢域可改写自身配置（如 `TMP` 指向），比外部软件更容易做对 |
| 观测先行（perf-hud / §9） | `disk_status` 轻量概览 + 报告按体积排序 | 不做帧率/延迟观测（超出本插件范围） |
| 12 条安全设计清单（§7.4） | I1–I5 + §10 三道硬门 | 逐条对应，未新增未请求的防御 |

---

## 14. 可视化与勾选交互（清理前列全 + 逐项解释）

需求拆成三句可验收的话：**清理前列出全部可清理项**、**每项说清"这里面是什么"**、**用户勾选后只清勾中的**。三条都不靠菜谱式文案，而是靠数据契约。

### 14.1 唯一事实源：`runs/<run_id>.json`

UI、TUI、Agent 工具三者**读同一份文件**，不得各自重算（否则"面板显示的"与"实际执行的"必然漂移）。单条 item 的完整字段：

```json
{
  "id": "ts.scratch#1",
  "path": "C:/Users/x/.rivet/scratch/research",
  "kind": "dir",
  "bytes": 108000,
  "fileCount": 37,
  "topExt": [{"ext": ".png", "files": 12, "bytes": 62000}],
  "samples": ["shot-kawaii.png", "theme-dark.png", "notice-zoom.png"],
  "ruleId": "tianshu.scratch",
  "grade": "green",
  "title": "一次性探针产物（scratch/research）",
  "explain": {
    "what": "上一轮调研落的中间输出：3 个 md、37 个 png 截图",
    "why": "scratch 约定为一次性区，清后不影响 knowledge/plans/memory",
    "rebuild": "无需重建；要可重跑检索脚本",
    "risk": "无",
    "sideEffect": null,
    "undo": "同卷移入隔离区，可整批撤销"
  },
  "precondition": null,
  "active": false,
  "needsElevation": false,
  "blocked": null,
  "decision": "undecided"
}
```

两条硬约束：

1. **`title` / `explain.what` / `explain.why` / `explain.undo` 必填**。缺任一 → 整个 run 生成失败（宁可不出面板，不出残缺面板）。这是"告诉用户这里面是什么"的落点：内容由**规则 + 实测证据**合成——`what` 由 `topExt + samples + fileCount` 模板生成，`why` 取 `rule.reason`，`undo` 由 `executor.type` 推导。**不用 LLM 现编**，因为解释必须离线可复现、且与执行路径一致。
2. **`run.json` 存全量**（含 `brown` 保护项与 `blocked` 跳过项），UI 默认只显示可清理项，但提供"显示被保护/被跳过的项"开关——用户有权看到"工具故意没碰什么"，这是边界透明的关键。

### 14.2 两个视图，一份数据

| 视图 | 形态 | 适合 | 关键交互 |
| --- | --- | --- | --- |
| **TUI `/disk`**（必需） | 分组列表 + 右侧详情 | 天枢主场景、SSH/无浏览器 | `空格` 勾选、`a` 全选可清理、`f` 按 grade/域/大小过滤、`/` 搜路径、`enter` 看样本文件、`p` 预览计划、`x` 执行（二次确认） |
| **Web `ui/`**（可选） | 树图（treemap）+ 复选清单 + 逐项展开 | 需要"一眼看到体积分布"时 | 点方块看详情、勾选、预览、执行；仅 loopback，只接 `run_id`/`batch_id` |

两个视图**都只写 `decision` 字段**，执行统一走 `disk_plan` → `disk_exec`。UI 自己删文件是禁止的（会绕开 I4/I5 的令牌与台账）。

### 14.3 用户视角的六步

1. 面板首行给出总量：`共 23 项 / 可释放 812 MB / 需提权 2 项 / 被保护 7 项`。
2. 展开任一项，先看到 `title`，再看到 `what`（里面是什么）+ `samples`（前三例）+ `topExt`（体积构成）。
3. 勾选：🟢 可勾、🟡 需展开详情后才允许勾、🟠 默认不勾且提示可迁移、🔴 勾选框 `disabled` 且 hover 显示保护理由。
4. 点"预览计划"：释放量、提权项、**不可逆项**、被 `precondition` 挡住的项分别列出。
5. 执行 → `stage`（同卷 rename，秒级）→ 面板变为"已移入隔离区，可撤销（默认保留 7 天）"。
6. 满意后"永久删除这批"（二次确认 + 令牌）；不满意"撤销这批"。

### 14.4 可视化引入的新风险与护栏

| 风险 | 护栏 |
| --- | --- |
| 用户习惯性"下一步" | **默认不预勾选**（连 🟢 也不预勾），全选需显式 `a` 或 `--preset safe` |
| 保护项被误勾 | `brown` 行 `disabled`，键盘也不能选中（不是只把图标变灰） |
| "可撤销"与"永久"混在一屏 | 分两区渲染，按钮文案不同：`移入隔离区` / `永久删除（不可撤销）` |
| 大批量误操作 | 单次 >200 项或 >10 GB 需二次确认，并列出"其中 N 项在用户目录之外" |
| 面板开着时文件又被写入 | 点执行前**重算** `mtimeGuard` 与 `precondition`，命中的项转 `blocked` 并跳过（这是静默失效高发点） |
| 面板变成任意文件操作接口 | `ui/server.mjs` 只接 `run_id`/`batch_id`，不接受路径参数 |

### 14.5 验收（可视化也要可机器验证）

| # | 断言 | 验证方式 |
| --- | --- | --- |
| T1 | `run.json` 有 12 项时，TUI 与 Web 渲染出的条目数与总字节一致 | 两条渲染路径对同一文件，比对 JSON 输出 |
| T2 | 每项必含 `title/what/why/undo`，缺任一则不生成 run | **W1 第一个 RED 测试** |
| T3 | `brown` 项 `disabled=true`，快捷键无法勾中 | 单测：模拟按键序列后 `decision` 仍为 `undecided` |
| T4 | 勾选集合 == `disk_plan` 的 `itemIds` 集合 | 集合相等断言（多一个少一个都失败） |
| T5 | 执行后 `ledger.jsonl` 新增行数 == 勾选项数 + 1（batch 汇总行） | 数行数 |
| T6 | 活跃项（10 分钟内被写入）在点执行时转 `blocked`，且无任何写操作 | 造一个 mtime=now 的临时文件再点执行 |

---

## 15. 明确不做 / 未核实（写清边界）

**不做**（调研已证明无效或危险）：
- 注册表清理（§8.3：收益不可测、误删不可逆）。Winapp2 有 3,677 条 `RegKey` 目标，我们全部放弃，并在 `disk_rules` 里能解释"为什么不支持"。
- 分歧区目标（浏览器会话恢复、`Windows.old`、Prefetch、字体缓存、Store 应用缓存……）不进默认规则库，只以 🟡/🟠 级出现在规则库的可选段——分歧清单见 `调研补充-系统磁盘清理应用与边界对照.md` §4.2。
- 内存清理 / standby list（§8.1：在内存充足机器上净负收益）。
- 内核态组件、驱动、服务安装；不碰还原点、页面文件、休眠文件；不对 WinSxS 用 `/ResetBase`。
- 不做"一键全清"：所有 `purge` 都必须有人或带令牌的显式调用。
- 不接管宿主自身的生命周期（不删除 `meridian.db`、不自动 VACUUM，只提供 `compact` 建议与手动入口）。

**未核实（实现前必须确认）**：
1. `contributes.lifecycle` 的合法钩子名与触发时机——实测清单里是空数组 `[]`，没有样本可依据。
2. 插件是否需要显式声明数据目录（`~/.rivet/disk-steward/` 是本设计自选，宿主是否已有约定未知）。
3. `ui/server.mjs` 的暴露方式与鉴权（`media-toolkit` 有该文件，未读实现）。
4. 天枢域"当前是否正在使用某目录"的判定（`tmp/`、`scratch/` 可能被并发会话占用）——**已实测为活跃目录**（§2.4）：不再是待核实项，而是硬要求——所有 🟢 级规则必须带 `mtimeGuard`（默认跳过 10 分钟内有写入的项），W0 需对应测试。
