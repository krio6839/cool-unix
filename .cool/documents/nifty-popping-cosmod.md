# 收束三条链路：一个节奏、三个文件各管一件事

## Context

上一轮把「补录」重构到了基准时间 `B` 模型（`feat/boom-new-protocol` 已落地）。但驱动这三件事的骨架还是老结构，症状是：

- **节奏散落在三处。** 广播每收一帧就自己判断「跨没跨整分钟」（[broadcast.ts:629](.cool/store/device/broadcast.ts#L629) 的 `uploadCompletedMinuteIfCrossed`），跨了就同时喊两声：一声给判断（`sync.onMinuteBoundary`），一声给上传（`uploadData`）。而 `sync.ts` 自己另有一个「启动延迟 15 秒 → 每 10 分钟」的循环，`data-manager.ts` 构造函数里又起了第三个 60 秒定时器。三个定时器、三种节流，谁都不知道别人在做什么。
- **「整分钟」这个概念只服务于老的上传策略。** 判定早已不按分钟切（方案第 3 节），`B` 和 ready 区间都是秒级的。整分钟现在唯一的作用是「触发上传刚走完的那一分钟」——而上传本身取的是「所有 `timestamp <= cutoff` 的待传记录」，根本不关心分钟。它是个纯粹的历史包袱，还带来两个类字段（`lastBroadcastMinuteSec` / `minuteUploadBusy`）和一个跨模块的隐式约定。
- **`data-manager.ts` 是两件事拼起来的。** 1107 行里，一半是数据库增删查改，一半是上传编排（批循环、退避、定时器、睡眠 detail 组装、设备身份）。两半唯一的联系是「上传要读数据库」。
- **`sync.ts` 名不副实。** 重构后它只剩「分类 + 推进 + 列缺口」的规划职责（约 40 行），而这三步就是每个心跳该做的事，不构成一个独立模块。

目标：**一个心跳节奏，三个文件各管一件事，broadcast 退回纯采集。**

## 目标形态

```
广播（采集）        broadcast.ts   → 落库，喊一声 tick.poke()，不认识「判断」「上传」

心跳（节奏）        device-tick.ts → 唯一的周期决策点
                                     每秒级：classify → advanceBaseline → uploadData
                                     每10分钟：listRepairGaps → 有缺口才入队连接

判断（算法）        history/baseline.ts（不动）  classify / advanceBaseline / listRepairGaps

补数据（执行）      history/repair.ts（新）     一次连接内把全部缺口读完
                    gatt-scheduler.ts（瘦身）    连接内按优先级跑任务，调 repair

上传（编排）        upload.ts（新）              批循环 / 退避 / 定时兜底 / 设备身份

数据库（存储）      data-manager.ts（瘦身）      只做增删查改
```

`sync.ts` 删除，`sync` 字段从 `Device` 上换成 `tick`。

## 一、新增 `.cool/store/device/device-tick.ts`

唯一的周期决策点，替代 `sync.ts` 的 `runAutoLoop` + `onMinuteBoundary`，并吸收广播的整分钟判定。

```ts
const TICK_MIN_INTERVAL_MS = 60 * 1000;      // poke 限流 + 定时兜底间隔
const CONNECT_INTERVAL_MS = 10 * 60 * 1000;  // 连接最小间隔（原 HISTORY_AUTO_CHECK_INTERVAL_MS）

class DeviceTick {
  state = ref<DeviceSyncState>("idle");
  lastError = ref<string>("");
  lastPlan = ref<HistorySyncPlan | null>(null);
  lastCheckAt = ref<number>(0);          // 原 sync 的三个 ref 整体搬过来：
  lastHistorySyncAt = ref<number>(0);    // test.uvue 的 historyGapRevision 依赖它们
  poke(reason: TickReason): void;        // 广播每帧调；内部按 TICK_MIN_INTERVAL_MS 限流
  start(): void;                         // setInterval(60s) 兜底 + 首次 tick
  stop(): void;
}
export const deviceTick;
```

- `poke()` 是被 broadcast 和 keepalive 调用的唯一外部入口，**限流在内部**：距上次 tick 不足 60 秒直接返回。前台靠广播帧驱动、后台靠保活和定时器，两条路都走同一个节流。
- `runTick()`：`classify(now)` → `advanceBaseline(now)` → `uploader.uploadData()`。日志沿用 `[BOOM-BASE] 分类完成` / `[BOOM-BASE] 基准推进`，**删掉 `[BOOM-BASE] 分钟边界` 这一行**（它描述的东西不存在了）。
- `maybeConnect()`：`now - lastConnectCheckAt >= CONNECT_INTERVAL_MS` 时才 `listRepairGaps()`；有缺口就 `enqueueHistoryRepair()` + `requestFlush()`，并把 `lastConnectCheckAt` 置为当前时刻。失败退避由这个间隔天然提供（方案 8.3）。
- 不再需要「启动延迟 15 秒」：第一次 tick 就该把 App 关闭期间积压的时间判完（方案第 6 节），延迟只会让首次补录更晚。
- `boundaryBusy` 那套串行化可以去掉——tick 本身就是串行的（见下）。

**并发**：`poke` 可能被广播帧连续触发，用一个 `ticking: boolean` 守卫；进入时置真、`finally` 置假，重入直接返回。这就是原来 `boundaryBusy` 的职责，只是范围扩到整个 tick。

## 二、新增 `.cool/bluetooth/upload.ts`

把 `data-manager.ts` 的上传那一半整体搬出来。搬走后 `data-manager.ts` 只剩数据库职责。

搬移内容（含仅被上传使用的私有助手）：

| 搬移 | 说明 |
| --- | --- |
| `uploadData()` / `uploadPpiData()` / `uploadPpiIfPending()` | 入口与批循环 |
| `uploadSleepData()` / `uploadSleepRecords()` / `reuploadSleepData()` | 睡眠上传 |
| `scheduleUpload()` / `startUploadTimer()` / `stopUploadTimer()` | 触发与兜底 |
| `formatTimestamp()` / `sleepRecordIds()` / `buildSleepUploadItem()` / `normalizeSpo2ForUpload()` | 仅上传使用 |
| `deviceName` / `deviceAddress` / `setDeviceInfo()` / `clearDeviceInfo()` | 只被上传用到，是上传的身份信息 |
| `UPLOAD_*` / `PPI_UPLOAD_MAX_*` 常量 | 随代码一起走 |

依赖方向：`upload.ts → data-manager.ts`（单向，调 `getUnuploadedPpiData` / `markPpiDataAsUploaded` / `pruneUploadedPpiBefore` / `getUnuploadedSleepData` 等）。`data-manager.ts` 不再 import 任何上传代码，构造函数里也不再 `startUploadTimer()`——定时器改由 `deviceTick.start()` 驱动。

导出 `export const bluetoothUploader = new BluetoothUploader()`，从 `.cool/bluetooth/index.ts` 桶文件导出。

**行为变化（需要你确认的一点）**：上传触发从「刚走完的那一分钟」变成「本轮所有待传记录（≤ `cutoff`）」。tick 可能落在分钟中间，于是同一条实时流的秒会分两次上传（例如 12:00:35 传 35 秒，12:01:35 传剩下 25 秒 + 下一分钟）。服务端按 `time` 逐秒接收，这不影响正确性，但上传节奏从「整分钟一批」变成「每 60 秒一批」。如果你希望服务端看到的仍是整分钟批次，说一声，可以在 tick 里把上传上界对齐到「已完成的那一分钟」——但这会重新引入整分钟概念，与本次简化的方向相反。

## 三、`.cool/store/device/broadcast.ts` 退回纯采集

删掉：`uploadCompletedMinuteIfCrossed()`、`lastBroadcastMinuteSec`、`minuteUploadBusy`、`previous`/`minuteSec` 的换算逻辑。

`storeBroadcastPpiData()` 落库成功后只留一行：

```ts
if (ok == true) this.device.tick.poke("broadcast");
```

broadcast 从此不认识「分钟」「判断」「上传」任何一个概念。

## 四、`.cool/bluetooth/history/repair.ts`（新）承接补数据

`sync.ts` 的 `repairVitalHistoryGapsInCurrentConnection` / `runVitalGaps` / `makeGapResult` / `countSaved` 搬到这里，签名改为**只依赖它真正需要的东西**，不 import `Device`：

```ts
export type GapReader = { readVitalGapGroup(gap: HistoryGap): Promise<VitalAutoReadResult> };

export async function repairAllGaps(reader: GapReader): Promise<HistoryRepairResult>
```

内部直接调 `historyBaseline.classify/advanceBaseline/listRepairGaps`（`history/` 目录内部依赖，无环）。这样它在测试里可以配一个假 reader 独立跑，不需要构造 Device。

`gatt-scheduler.ts` 的 `runHistoryRepair()` 收缩成：确认已连接 → `repairAllGaps(this.device.history)` → 打印收尾行。

## 五、`.cool/store/device/sync.ts` 删除

`planHistorySync()` 的三步（classify / advance / listRepairGaps）并入 `device-tick.ts` 的 `runTick()` + `maybeConnect()`；三个 state ref 与类型（`HistorySyncPlan` / `HistoryRepairResult` / `HistoryGapRepairResult` / `DeviceSyncState` / `DeviceSyncReason`）分别落到 `device-tick.ts` 与 `history/repair.ts`。`index.ts` 的 `readonly sync` 换成 `readonly tick: DeviceTick`，`startAutoRepair`/`stopAutoRepair` 换成 `tick.start()`/`tick.stop()`。

## 六、其余调用点改指向

| 文件 | 改动 |
| --- | --- |
| `.cool/service/keepalive.ts` | `bluetoothDataManager.setDeviceInfo` → `bluetoothUploader`；`uploadData()` → `bluetoothUploader.uploadData()`；新增 `device.tick.poke("keepalive")`（后台时广播帧可能不来，这里是兜底驱动） |
| `.cool/store/device/connection.ts` | 三处 `setDeviceInfo` → `bluetoothUploader` |
| `.cool/store/device/history-reader.ts` | `scheduleUpload()` / `uploadData()` / `uploadSleepData()` → `bluetoothUploader`；其余不动 |
| `.cool/store/device/index.ts` | `sync` → `tick`；`destroy()` 调 `tick.stop()` |
| `pages/device/components/DataDiagnosticsPopup.uvue` | `reuploadSleepData` → `bluetoothUploader`；其余 DB 查询仍走 `bluetoothDataManager` |
| `pages/device/test.uvue` | `deviceStore.sync.lastCheckAt/lastHistorySyncAt` → `deviceStore.tick.*`（`historyGapRevision` 的两行）；手动读取路径不变 |

`clearAllData` / `getHistorySessionDiagnostics` 等留在 `data-manager.ts`（它们的本质是数据库操作）。

## 七、测试

`tests/helpers/boom-runtime.mjs` 加 `device-tick.ts` 与 `upload.ts` 的加载与暴露（`state.DeviceTick` / `state.uploader`），替换 `state.DeviceSync`。`instanceof`/命名相关的桩要同步。

`tests/boom-reliability.test.mjs` 重写这几条**断言旧驱动模型**的用例：

- `automatic history repair plans from the baseline cursor` — 改读 `device-tick.ts`，断言它调 `classify`/`advanceBaseline`/`listRepairGaps`，且 `sync.ts` 已不存在
- `upload has one automatic entry point and no count/interval gate` — 断言 `broadcast.ts` 里不再有 `uploadCompletedMinuteIfCrossed` / `lastBroadcastMinuteSec`，只有 `tick.poke`；断言 `upload.ts` 有 `uploadPpiIfPending` 与 `UPLOAD_FAILURE_BACKOFF_MS`
- `a connection has no duration budget and does nothing special about its own hole` — `sync.ts` 的断言改到 `device-tick.ts` / `history/repair.ts`
- `database scan failure does not plan a fabricated empty-history repair` — 改用 `DeviceTick`

新增用例：

- tick 限流：60 秒内连poke 多次只跑一轮 classify
- 每轮 tick 都跑 classify + advance + upload（三件事在一次 tick 里完成）
- broadcast 落库成功后调 `tick.poke`，且源码里没有「分钟」相关标识符
- `repairAllGaps` 用假 reader：一组失败不中止后续组（沿用现有用例的语义）

`npm run test:boom` 全绿。

## 八、文档

**`.cool/documents/BOOM蓝牙运行流程.md`（主文档）**

- §5「上传策略」的三行触发表 → 心跳触发（≤60 秒）+ 补录落库后 + 保活；删掉「广播跨整分钟（主）」整行
- §1 总体原则：「普通历史补缺由启动后和 10 分钟检查触发」→ 由心跳触发
- §2 启动流程第 4 步
- §7.5 `MIN_CONNECT_INTERVAL_MS` 改为心跳里的常量名
- §8.1 / §8.12：10 分钟检查的来源改为 device-tick
- §8.13 日志清单：删 `[BOOM-BASE] 分钟边界` 行，补心跳行
- §9 GATT 任务队列：检查 `sync` 相关描述

**`.cool/documents/BOOM基准补录重构方案.md`（重构临时文档）**

- §5.5 调用时机：1「广播跨整分钟」→「心跳」
- §7 整节重写：撤回整分钟主触发，新触发表
- §11 模块划分表：新增 `device-tick.ts` / `upload.ts` / `history/repair.ts`，删除 `sync.ts`
- §12 删除清单：新增整分钟触发、`onMinuteCompleted`、`uploadCompletedMinuteIfCrossed`、`lastBroadcastMinuteSec`、`minuteUploadBusy`、`HISTORY_AUTO_INITIAL_DELAY_MS`
- §13 日志检查清单：删 `[BOOM-BASE] 分钟边界`
- §14 顺带修掉上轮发现的两处不一致：区间推进的常量名（文档写 `MIN_CONNECT_INTERVAL_MS` 在 gatt-scheduler，实际是心跳里的常量）、`advanceBaseline()` 的「拆条」分支说明（代码是所有路径的 `from_sec >= B`，中间态不可达，整条删除）
- §15 变更记录：新增「2026-09-17 修订（七）：收束驱动骨架」，记决定与理由

## 验证

1. `npm run test:boom`（Node ≥ 22.18；本机 24.21）
2. 真机日志形态核对：
   - `[BOOM-BASE] 分类完成` 约每 60 秒一条，`落后` 贴着 0
   - `[BOOM-UPLOAD] 上传PPI数据` 紧随其后，`batch=1`、`count≈60`
   - `[BOOM-SCHED] 开始执行队列` 约每 10 分钟一条
   - `[BOOM-HISTORY] 补录结束` 的 `连接时长` 稳定在一个小值
   - `broadcast.ts` 相关日志里不再出现「分钟」
3. 关键回归：App 关闭数小时后再开 → 首次 tick 立刻 `分类完成` 报出大段缺口 → 10 分钟间隔内入队一次连接把它读完，`B` 追上 `stableCeiling`。
