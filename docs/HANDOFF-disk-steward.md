# disk-steward 交接（实测前）

本文自包含：新会话读这一份就能接手，不需要其他上下文。

## 它是什么

可审计的磁盘清理插件：扫描分级 → 逐项解释 → 人工勾选 → 两阶段执行（stage 移入隔离区 / purge 永久删除）→ append-only 台账 + 撤销。默认只读，规则库 13 条天枢域 + 9 条系统域，硬禁区 9 类。

工作区：`D:\Februus\disk-steward`（源码与测试）；文档在 `D:\Februus\docs`。

## 装在哪（两套宿主，契约相反）

| 宿主 | 版本 | 插件目录 | 清单格式 |
|---|---|---|---|
| **桌面端（实际使用）** | `D:\Tianshu\rivet-runtime` **4.0.1** | `D:\Tianshu\TianshuData\.rivet\plugins\disk-steward\` | **只认 `tianshu.plugin.json`（TPI 1.0）**；`package.json#tianshu` 会被 `readTpiManifest` 判 `rejected_legacy_format` |
| npm 全局 CLI（非当前宿主） | `tianshu-harness` 3.35.0 | `C:\Users\Administrator\.rivet\plugins\disk-steward\` | 只认 `package.json#tianshu`，不读 TPI 清单 |

当前 `package.json` 刻意**不带** `tianshu` 字段，清单只在 `tianshu.plugin.json`。

入口契约（两套宿主一致）：`export const tools`，每项
`{ definition: { name, description, input_schema }, execute(params), requiresApproval(), isConcurrencySafe(), isEnabled() }`。
`index.js` 把内部 `{ name, description, inputSchema, execute({ args }) }` 适配成该形状，同时保留 `createTools` 导出供脚本/测试使用。

插件中心已于 2026-11-05 显示并加载（用户确认）。

## 已验证到哪一步

| 项 | 状态 |
|---|---|
| 清单解析（4.0.1 的 `readTpiManifest`） | `ok:true`，8 工具，`entry=index.js` |
| 入口导出 | `export tools = 8` |
| 工具实现（命令行 import 插件后直接 execute `disk_status`） | 正常，输出磁盘可用 + 三个目录 + 隔离区四行 |
| 宿主工具面调用 | **未验证**：插件目录尚无 `.runs`，说明宿主侧还没执行过任何工具 |
| 全量测试 | 150 用例 / 33 文件，全绿（`node --test test/*.test.mjs`） |
| 类型检查 | `..\node_modules\.bin\tsc --noEmit` exit 0（checkJs + JSDoc） |

## 下一个会话要做的实测清单

在桌面端会话（已加载插件）里按序执行，每步记录返回内容：

1. `disk_status` → 期望：磁盘可用 / rivetHome / projectRivetHome / tmpDir / 隔离区 五项。
2. `disk_scan`（默认）→ 期望：`run_id`；落盘 `D:\Tianshu\TianshuData\.rivet\plugins\disk-steward\.runs\<run_id>.json`；检查 item 的 `samples` 为空、`samplesRedacted: true`（隐私默认）。
3. `disk_scan` 带 `includeSamples: true` → 期望：`samples` 出现真实文件名。
4. `disk_rules` 带 `path`（例如某个 `~\.rivet\cache` 路径）→ 期望：命中规则 id + 分级 + 理由；未命中 → “按保护处理”。
5. `disk_report` 带 `runId` → 期望：生成 `.runs\<run_id>.md`，无 `undefined`/`null`。
6. `disk_diff` 带两次 `runId` + `write: true` → 期望：增量摘要 + `diff-<A>-<B>.md`。
7. `disk_plan` 带 `runId` + `itemIds` → 期望：`plan_id` 与一次性令牌。
8. `disk_exec`（`mode: 'stage'`，用上一步的 planId+token）→ 不带 `approval` 应返回 `EXEC_NOT_HUMAN_APPROVED`（工具面计划以 `issuer:'agent'` 签发）；带 `approval: '批准'`（用户对话里同意执行的原话）才执行。
9. `disk_undo` 带一个批次 → 对真实执行的批次可用；不存在批次返回“已恢复 0 项”。

安全侧要顺带核对的：

- 保护项（记忆库/知识库/计划/技能包/引用图产物）在 `disk_scan` 里是 `grade: brown` 且 `executor: null`；
- `C:\Windows\Temp`、`C:\Windows\WinSxS`、`C:\$Recycle.Bin` 在系统域被 `denied`；
- 10 分钟内有写入的项标 `blocked: 'active'`，进不了计划。

## 已知坑

- **跨卷 stage**：插件目录在 D:，`%TEMP%`/Edge 缓存在 C:，`stage` 走“复制+删”。这条路径曾因 `cpSync` 不保留目录 mtime 导致 postmove 校验误判、回滚又跨卷失败而丢源目录；现已修（`preserveTimestamps` + 复制后 `utimesSync` + 回滚按卷分支），`test\w32.test.mjs` 覆盖，修前 RED。
- **`disk_exec` 的人工批准门**（2026-11-05 已打通）：`createPlan` 默认 `issuer:'agent'`，执行器要求 `issuer === 'human'`；工具面现在由 `disk_exec` 的 `approval` 参数（用户在对话里同意执行的原话）提供该事实，缺失即拒绝。TUI（`bin\tui.mjs`）与 `bin\purge.mjs` 仍走本地键入。强度差异：`approval` 是 agent 转述，挡"没问就执行"，不挡"编一句批准"。
- **插件目录的 `.runs` / `.trash`** 是运行时数据，重新部署时不要复制这两个目录。
- **部署后必须重启桌面端**才会重新加载；改完记得同步到 `D:\Tianshu\TianshuData\.rivet\plugins\disk-steward\`（工作区改动不会自动同步）。

## 复现命令

```bash
cd /d/Februus/disk-steward
node --test test/*.test.mjs                    # 150 用例
../node_modules/.bin/tsc --noEmit              # exit 0

# 直接调用插件入口（不经宿主）验证工具实现
node -e '(async()=>{const m=await import("file:///D:/Tianshu/TianshuData/.rivet/plugins/disk-steward/index.js");const t=m.tools.find(x=>x.definition.name==="disk_status");console.log((await t.execute({})).content)})()'

# 宿主侧清单校验
node -e '(async()=>{const m=await import("file:///D:/Tianshu/rivet-runtime/chunk-XBKLPB3A.js");console.log(m.readTpiManifest("D:/Tianshu/TianshuData/.rivet/plugins/disk-steward").ok)})()'

# 部署（工作区 → 桌面端）
D="/d/Tianshu/TianshuData/.rivet/plugins/disk-steward"
cp -r index.js package.json tianshu.plugin.json README.md core domains render rules tools bin "$D/"
```

## 遗留物与状态

- 工作区 `.trash\b-mw342wzt044826` 有 6.1 MB 旧 GPUCache 副本（测试残留）。释放：`node bin/purge.mjs --batch b-mw342wzt044826`。
- Edge 当前未运行；GPUCache 已被删过一次并重建（重建耗时 0.5 s，体积 5 文件 / 557424 字节）。
- `D:\Februus` 不是 git 仓库，改动无法提交。
- 未验证：宿主工具面的真实调用链（本次实测要补）、GPUCache 长期命中率、`contributes.lifecycle` 与 `ui/` 鉴权。

## 文件地图

```
disk-steward\
  index.js              # 插件入口：export const tools（适配宿主契约）
  package.json          # 无 tianshu 字段（4.0 拒绝旧式清单）
  tianshu.plugin.json   # TPI 1.0 清单（4.0 唯一认的）
  tools\index.mjs       # 8 个工具：scan/status/rules/report/diff/plan/exec/undo
  core\                 # probe rules run refindex guard precondition plan executor identity ledger diff occupancy elevation explain paths
  domains\              # tianshu.mjs（13 条规则）、system.mjs（9 条 + execEnabled）
  render\               # table tui confirm report
  rules\tianshu.rules.json
  bin\                  # scan.mjs（只读面板）、tui.mjs（--allow-exec/--only-project/--with-system/--script）、purge.mjs
  test\                 # 33 个文件 / 150 用例
```
