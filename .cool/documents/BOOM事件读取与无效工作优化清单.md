# BOOM App 事件读取与无效工作优化清单

> 项目：`D:/work/cool-unix`（BOOM 智能穿戴手环配套 App，uni-app x / UTS / Vue3 / TS）
> 分支：`feat/boom-forward-read`（HEAD `58c6790`）
> 日期：2026-11-19
> 依据：三天诊断日志（20261117/18/19，共 671 文件 / 115202 条）+ 源码逐行核对

---

## 一、问题本质

日志里 41 次事件读取的实测：

| 指标 | 实测 | 应有 |
|---|---|---|
| 结束状态 | `LIMIT` 38 / `TIMEOUT` 3 / **`DONE` 0** | 正常 `DONE` |
| 每次读取 | 平均 **18.5 页 / 185 条**（上限 20 页 200 条） | 窗口内 1 页左右 |
| 事件头跨度 | 平均 **33.7 小时** | 窗口仅 24h |
| 睡眠落库计数 | `savedSleep` 合计 424 | 实际新增睡眠仅 2 条 |
| 睡眠上传日志 | 真正上传 2 次 + `无待上传睡眠数据` **2807 条** | 无新增则不触发 |

**共性**：设备每页都返回满 10 条且事件倒序（最新在前），而代码缺少"窗口边界"判断，导致读到 20 页上限才停——**把大量用不上的旧事件读进来、写进去、反复触发上传**。这类"无效工作"在读取、落库、上传、广播四处都有。

---

## 二、已修复 ✅ 事件读取窗口下界早停

**文件**：`.cool/store/device/history-reader.ts` → `readEventDataAutoInner`

- **早停**：批次回调后，当 `startSec > 0` 且本批出现 `item.ts < startSec`，立即 `DONE("window reached")`，不再发 `0x3D`；本批数据完整保留
- **例外**：手动测试页（type=ALL，`startSec=0`）跳过此判断，保持持续读取语义（`test.uvue:1273`，`maxPages=0`）
- **日志**：`0x3C` 头解析后记录 `head` 与 `window` 对比（`exceeds` / `allBefore`），全部早于窗口时打 warn；**只告警不裁剪**，防止设备时间回退到 epoch 时误伤
- **测试**：新增 2 例（自动早停 / 手动忽略边界），`npm run test:boom` **175/175 全过**
- 状态：改动在工作区，未 commit / push

---

## 三、待优化（按 收益 × 确定性 排序）

### #1 睡眠落库计数虚高 → 每次读取都触发无谓上传 ★最高确定性

**位置**
- `.cool/store/device/history-reader.ts:1031-1032`：`storeSleepData()` 返回 `true` 就 `saved++`
- `.cool/bluetooth/data-manager.ts:510-519`：`INSERT OR IGNORE` 后 `return ok`
- `.cool/bluetooth/database.ts:340-342`：`success: (_res) => resolve(true)`，不读 `changes()`，被 IGNORE 也返回 true
- `.cool/store/device/history-reader.ts:753-755`：`saved > 0` 就调 `uploadSleepData()`

**为什么无效**：`savedSleep=11~12` 计的是"SQL 执行成功次数"，不是"新增行数"。历史重复事件被 `INSERT OR IGNORE` 静默跳过仍 `+1`，随后无条件触发一次睡眠上传（哪怕零新增）。这正是日志里 2807 条"无待上传睡眠数据"噪音的来源。

**建议**：让 `storeSleepData` 返回"是否真的插入"（`changes()` / `RETURNING` / 先查主键）；只按真实新增决定是否 `uploadSleepData()`。

### #2 睡眠落库不做窗口过滤、不查库去重，逐条写库

**位置**：`.cool/store/device/history-reader.ts:1010-1041`（`persistSleepResultsFromEvents`）

- `:1014` 的 `seen` 只在**本批内**去重，不查库、不看 `startSec`
- `:1031` 每条睡眠各执行一次 `storeSleepData()` → `execute()`（含 `ensureDatabaseReady` + 数据库串行队列）

**为什么无效**：早停虽然不读窗口外的页了，但已读入的老睡眠（设备倒序返回，`ts < startSec`）仍被逐条 `INSERT OR IGNORE`。N 条 = N 次数据库往返，全都白写。

**建议**：
1. 传入窗口下界，跳过 `item.ts < startSec`
2. 批量 `SELECT report_timestamp ... IN (...)` 过滤已落库的
3. 多条合并成一条多值 `INSERT OR IGNORE`，N 次 execute 压成 1 次

### #3 事件列表只追加不清空，每次全量 slice ★长期收益

**位置**：`.cool/store/device/history-reader.ts:178 / 212 / 282 / 993`

- `:178` `eventDataListRaw: LogDataItem[] = []`，`:282` 唯一写入是 concat，全文件无清空
- `:212 / :284` `publishSnapshot` 把**整个累积列表** slice 给响应式 ref
- `:993` `slice(startListCount)` 取本次结果

**为什么无效**：每小时兜底 + `eventSeq` 变化触发的读取都 append，永不释放，内存单调增长；每次恢复显示又全量复制触发 UI 更新。日志佐证：单次累积 `total` 最高到 **7470**。与同文件 `:74-75` 对生命体征"长读取不留内存"的设计原则自相矛盾（vital 有 `retainResponses` 开关，事件没有）。

**建议**：取出本次结果后清掉窗口外旧数据，或只保留最近 N 条给调试页；`publishSnapshot` 不每次全量 slice。

### #4 广播无效帧反复刷 UI + warn 无节流

**位置**：`.cool/store/device/broadcast.ts`

- `:420` 缓存包、`:540` 无效时间帧，每次都 `publishDebugInfoByDevice`（Vue ref → UI 更新）
- `:556-561` "继续观察"分支的 warn **无节流**（`:549` 的 5s 节流只管"校时冷却中"分支）

**为什么无效**：设备时钟异常时 10Hz 每帧都走这个分支，确认前每帧打一条 warn。这正对应日志里 **37069 条"已持续=0ms"** 的刷屏——文件 `:62-67` 自己都注释说每 100ms 一条 warn 会冲掉日志缓冲。

**建议**：无效/缓存帧降频更新 debug（只在状态变化时更新）；`:557` 的 warn 复用 `lastTimeSyncSkipLogAt` 做 5s 节流。

---

## 四、收益有限 / 未发现问题

| 项 | 结论 |
|---|---|
| 睡眠上传加 60s 退避 | PPI 有退避、睡眠没有（`upload.ts:35/170-185` vs `:310-312`），理论有弱网密集重试风险；但日志中睡眠上传失败为 0，当前未触发，优先级低 |
| 生命体征补录 | 未发现读到窗口外不停或页停滞仍继续。`history-reader.ts:455-492` 与 `history-repair.ts:62,66` 已处理 |
| GATT 任务队列 | 未发现重复入队 / 探活过频 / 空转。`upsertTask` 按 key 合并、三处 `isTaskRunning`、空队列 return 均在位 |
| PPI 上传上界 | 未发现冻结上界下反复扫旧数据。`upload.ts:95` 已用 `getLatestPpiTimestamp()` 冻结窗口 |
| 广播重复回调 / 扫描重启 | 未发现重复回调；扫描重启已有 20s 冷却、防重入锁、12s/18s watcher |

---

## 五、建议执行顺序

1. **#1 + #2**：与已修复的早停同属"事件读取 → 落库 → 上传"链路，改完才算闭环（读得少、写得准、传得对）
2. **#3**：内存与 UI 收益，改动独立、风险低
3. **#4**：日志降噪，改动小，可顺手做

> 所有改动默认停留在工作区，commit / push 需另行确认。真机验证看日志：`[BOOM] 事件读取到达窗口下界`、`status=DONE`、睡眠上传只在真新增时出现。
