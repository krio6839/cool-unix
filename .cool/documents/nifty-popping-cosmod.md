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



# 收束之后的第二轮：清账

## Context

上一轮的重构（一个心跳、三个文件各管一件事，`sync.ts` 删除、`device-tick.ts` / `upload.ts` / `history-repair.ts` 建立）已经全部落地，117 条测试全绿。这一轮问的是「还有精简空间吗」——有，而且是可核实的，不是风格问题。三类：

**一、重构留下的死代码。** 上一轮是「搬 + 改指向」，搬完之后有些东西没了引用者，但文件还在。逐个核实过（全仓 `\bname\b` 边界匹配，排除定义处）：

| 位置 | 事实 |
| --- | --- |
| `.cool/store/device/device-tick.ts:47` `state` | 只有本文件写，全仓**零读者**（`lastCheckAt` / `lastHistorySyncAt` 有 test.uvue 读，它没有） |
| `.cool/store/device/device-tick.ts:48` `lastError` | 只有本文件写 + 测试读。**两份文档都写着「看测试页的 `deviceStore.tick.lastError`」，而 test.uvue 压根没读它** —— 文档悬空 |
| `.cool/store/device/connection.ts:15` | `bluetoothDataManager` 已随上传搬走，这个 import 是死引用 |
| `.cool/bluetooth/upload.ts:34` | `PPI_UPLOAD_MAX_RECORDS = 300` 定义了没人用；真正生效的是 `data-manager.ts:26` 的 `PPI_UPLOAD_PAGE_SIZE = 300`（SQL LIMIT） |
| `.cool/bluetooth/upload.ts:41,397-411` | 上传定时器四件套（`uploadTimer` / `startUploadTimer` / `stopUploadTimer` / `UPLOAD_RETRY_INTERVAL_MS`）零调用方 |
| `.cool/bluetooth/data-manager.ts:426` | `getPpiTimestampsBetween` 全仓无人用，且是 `historyCoverage.getPpiTimestamps` 的重复实现（边界一个 `<=` 一个 `<`） |
| `.cool/bluetooth/data-manager.ts:677` | `getLatestSleepData` 全仓无人用 |
| `.cool/bluetooth/data-manager.ts:697-698` | `destroy()` 零调用方，方法体只留一句注释说定时器归 uploader 管 |
| `.cool/bluetooth/history/baseline.ts` | `advanceBaseline` 的 `while(true)` 里第 451 行分支**不可达**：能进循环体说明 `first.fromSec <= baseline`，于是要么 `first.toSec > baseline`（走 462 行推进 `B`），要么 `first.toSec <= baseline`（走 452 行删除）。推进路径把 `baseline = first.toSec`，下一轮 `first` 若是同一条，`fromSec <= baseline = toSec` 且 `toSec > baseline` 不成立 → 必走删除分支。两条路都不产生 `fromSec > baseline` 后继续循环的情形 |

**二、造出来就被丢掉的返回值链。** `repairAllGaps()` 花了 ~40 行组装 `HistoryRepairResult`（含 `HistorySyncPlan`、逐组 `HistoryGapRepairResult` 的字段拷贝、`countSaved`），唯一的调用方 [gatt-scheduler.ts:410](.cool/store/device/gatt-scheduler.ts#L410) 拿到手就丢；`runTask` 在 317 行 `await this.runHistoryRepair(task);` 更是直接忽略返回值。三个类型从 `index.ts:651` 再导出，**全仓零消费者**。测试也不看它——`tests/boom-reliability.test.mjs` 里那三处 `savedRecords` 断言读的是 `reader.readVitalGapGroup()` 的返回（t:1078），不是这个。

**三、每轮心跳重复查库。** 一次 tick 的调用链里同一份数据被反复读：

- `getBaseline()` 一轮 **3 次**：`classify` → `clampToRetention`、`advanceBaseline` → `clampToRetention`、`maybeConnect:148`。而 `advanceBaseline` 刚把 `B` 算好返回给 `runTick`，`runTick` 拿它打了条日志就扔了。
- `listReadyRanges()` 一轮 **≥3 次**：`classify`、`advanceBaseline` 的循环（**每轮迭代各一次**）、`listRepairGaps`。
- `clampToRetention()` 一轮 3 次（上面两个方法各一次 + `listRepairGaps` 一次），每次都要读 `B`。

断网时 `getBaseline` 会 throw（`baseline.ts:110`），一次 tick 里 3 次跨桥调用就是 3 次异常风险 —— 这条链本身也是重复。

目标：**删掉没人用的东西，把返回值收敛到真正要用的形状，把一轮 tick 的重复读降到必要次数。**

## 一、删死代码

全部是删除动作，没有替代实现：

- `device-tick.ts`：`state` 字段与 113 / 130 两行赋值。
- `connection.ts:15`：import 里去掉 `bluetoothDataManager`。
- `upload.ts`：`PPI_UPLOAD_MAX_RECORDS`；`uploadTimer` 字段、`startUploadTimer()`、`stopUploadTimer()`、`UPLOAD_RETRY_INTERVAL_MS`。整段「有意保留、当前无调用方」的注释一并删除——**它的保留理由是「定时器还会跑时可以一行接回去」，而心跳每轮已经调 `uploadData()`，接回去就是重新引入第二个节奏来源，正是上轮要消掉的东西**。真出问题该修心跳。
- `data-manager.ts`：`getPpiTimestampsBetween()`、`getLatestSleepData()`、`destroy()`。`destroy()` 删掉后 697 行那句「上传定时器由 `bluetoothUploader.stopUploadTimer()` 管」的注释也没了归属（那个方法本轮也删了）。
- `baseline.ts:451-458`：删掉不可达的 `if (first.toSec <= baseline)` 分支 —— 连同 `while` 里的 `consumed++` 计数一并调整（推进分支保留计数）。

## 二、返回值收敛到 void

- `history-repair.ts` 的 `HistoryRepairResult` 与 `HistorySyncPlan` 两个类型删除，`repairAllGaps()` 改成 `Promise<void>`：内部保留 `plan`（日志要用它的字段）、保留逐组结果数组（收尾日志要 `results.length - failedGroups` 与 `countSaved`），只是不再打包成对象返回。
- `HistoryGapRepairResult` 不再逐字段拷贝 `VitalAutoReadResult`（`status`/`message`/`pages`/`savedRecords`/`saveOk`/`uploadScheduled` 六个字段是纯搬运），改成 `{ gap, read: VitalAutoReadResult }`。`VitalAutoReadResult` 从 `./history-reader` 本来就是 `import type`，不新增依赖方向。
- `gatt-scheduler.ts:405`：`runHistoryRepair()` 返回类型改 `Promise<void>`，内部 `try/catch` 保留（异常要吞掉并记 warn），去掉 `return result` / `return null`。
- `index.ts:651`：删除 `HistoryGapRepairResult, HistoryRepairResult, HistorySyncPlan` 的再导出。**注意 `HistoryGap` / `TickReason` / `SyncReason` 三条导出有人用，保留。**

净效果：`history-repair.ts` 从 151 行降到约 110 行，且「补录结果」这条链上不再有第二个真相来源。

## 三、每轮 tick 的重复读

只做**可证明等价**的部分。每条都独立，任一条觉得不划算可以单独砍掉：

1. **`advanceBaseline` 用自己的累加器，不再每轮迭代查全表。**
   把 `let ready = await this.listReadyRanges()` 提到循环外，删除分支里从数组头部 `shift()`（它是按 `from_sec` 排好序的），推进分支删掉刚消费的那一条。省的是「消费 N 条区间时的 N-1 次全表读」——`mergeReadyRanges` 是整表归一化写入，区间条数受「不合格段数」约束，长时间不补录时会累起来，这里正是它最坏的地方。

2. **`mergeReadyRanges(ranges, existing?)` 由 `classify` 传入已读的列表。**
   `classify:306` 已经读了 `ready`，`mergeReadyRanges:164` 又读一遍。加一个可选参数，`classify` 传进去。`markReady` 那条路径（`history-reader` 每页调一次）没有现成列表，继续走原路。

3. **`maybeConnect(nowSec, baseline)`：`baseline` 由 `runTick` 传。**
   `runTick:117` 刚从 `advanceBaseline` 拿到 `baseline`，打个日志就扔，然后 `maybeConnect:148` 再 `getBaseline()` 读一次同样的值。直接传参。这同时省掉断网时的一次跨桥异常点。

4. **`clampToRetention` 接一个「调用方已读到的 `B`」。**
   签名改 `clampToRetention(nowSec, knownBaseline?)`：`knownBaseline` 有值且 `>= retentionStart` 时直接返回，不再 `getBaseline()`。三个调用点各传自己已有的值——`classify` 传 `runTick` 给的、`advanceBaseline` 传上一轮返回的、`listRepairGaps` 不传（它没有）。**保留全部钳制语义**：`knownBaseline` 缺失或低于保留起点时，照旧读库、跳 `B`、删过期区间。

5. **`runVitalGaps` 把上一组的 `after` 当下一组的 `before`。**
   现在是每组 `advanceBaseline` 调两次（110 / 112 行），N 组就 2N 次。第 i 组的 `after` 就是第 i+1 组的 `before`（组之间没有别的写入者）。改成进循环前先取一次，循环里只取 `after`。省 N 次。

**明确不做的一件事**：不把 `ready` 列表跨 `classify` → `advanceBaseline` 缓存复用。`classify` 刚写完 `vital_ready_ranges`，`advanceBaseline` 必须看到新写的行才能推进 `B`；复用旧快照会让 `B` 落后一整轮。第 1 条是「循环内部复用自己刚读的」，与这个是两回事。

## 四、`lastError` 接到测试页

`runTick` 的 catch 是整轮 tick 抛出时**唯一**留下错误文本的地方（日志之外），而两份文档都已经让用户去测试页看它。补上落点而不是删掉信号：

- `pages/device/test.uvue`：在基准面板附近显示 `deviceStore.tick.lastError.value`，为空时不显示。测试页已有 `tick.lastCheckAt` / `tick.lastHistorySyncAt` 的 `historyGapRevision` 计算属性，按同一风格接。
- 两份文档里指向 `deviceStore.tick.lastError` 的句子**本轮不动**——它们原来悬空，接完就成立了。

## 五、测试

`npm run test:boom`（`node --test tests/boom-reliability.test.mjs tests/boom-history-progress.test.mjs`）必须全绿。受影响的：

- **`history-repair.ts` 的返回签名**：`tests/boom-reliability.test.mjs:359,364` 只 `await r.historyRepair.repairAllGaps(reader)` 不看返回值，签名改 void 后无需改动。
- **删掉的东西要能被断言「不再回来」**：在已有的源码断言用例里追加（沿用现有 `readFile` + `includes` 的写法）：
  - `upload.ts` 不含 `startUploadTimer` / `stopUploadTimer` / `UPLOAD_RETRY_INTERVAL_MS` / `PPI_UPLOAD_MAX_RECORDS`
  - `data-manager.ts` 不含 `getPpiTimestampsBetween` / `getLatestSleepData`
  - `device-tick.ts` 不含 `state = ref`
- **本轮已有的行为用例是第三层的兜底**，必须逐条盯：
  - `one tick does classification, baseline advance, and upload in a fixed order`（断言 `deepEqual(order, ["classify","advance","upload"])` 与 `baseline === now - 10`）—— 覆盖第 3、4 条
  - `automatic history repair plans from the baseline cursor, not a task queue`
  - `a gap with no device data does not abort the remaining gaps in one connection`（假 reader，两组缺口）—— 覆盖第 5 条
  - `poke is rate-limited to one tick per minute and never re-enters`
  - `data diagnostics popup shows logs and defers full export to auto-archived files`（源码断言，接 `lastError` 时留意别写坏）
- 顺带确认 `tests/helpers/boom-runtime.mjs` 里 `state.historyRepair` 仍能加载（类型导出变了但模块还在）。

**第三层的额外验证**：跑一条端到端场景断言「一次 tick 内 `bluetoothDatabase.query` 的调用次数」比改动前少。运行时已经有 `r.db`（in-memory SQLite），给 `bluetoothDatabase.query` 包一层计数即可，比读源码断言可靠。

## 六、文档

两份都要改，改动都不大：

**`.cool/documents/BOOM蓝牙运行流程.md`**
- 181 行：删「`upload.ts` 里的 60 秒定时兜底（`UPLOAD_RETRY_INTERVAL_MS`）…保底」整条——定时器已删。
- 182 行：`PPI_UPLOAD_MAX_RECORDS = 300` 改成实际生效的 `PPI_UPLOAD_PAGE_SIZE`（在 `data-manager.ts`），并说明单批上限来自 SQL LIMIT 而不是编排层的常量。
- 802 行：保留（`lastError` 接上测试页后这句话成立）。
- 核对 §8.13 日志清单里是否还有被删方法产生的日志行。

**`.cool/documents/BOOM基准补录重构方案.md`**（本轮重构的临时文档）
- 259 / 260 行：同上的两条清理。
- 513 行：`data-manager.ts` 的 `startUploadTimer()` 已不在（上轮删过一次，这里是残留描述）。
- 484 / 488 行：`history-repair.ts` 的描述里 `repairAllGaps(reader)` 补一句「返回 `void`，结果只进日志」。
- 675 行：入口收敛表里 `startUploadTimer` 已不存在，从历史对照里划掉或注明已删。
- §15 变更记录：新增一条「2026-09-18 修订（八）：收束后的清账」，记三类清理与「为什么不保留上传定时器」。

## 验证

1. `npm run test:boom` 全绿。
2. 所有改动的 TS 文件过一遍 `stripTypeScriptTypes` 解析（沿用上轮的检查方式）。
3. 全局搜一遍被删标识符，确认零残留：`getPpiTimestampsBetween`、`getLatestSleepData`、`startUploadTimer`、`stopUploadTimer`、`UPLOAD_RETRY_INTERVAL_MS`、`PPI_UPLOAD_MAX_RECORDS`、`HistorySyncPlan`、`HistoryRepairResult`、`HistoryGapRepairResult`。
4. **一次 tick 的查询次数**（第三层的成败判据）：用测试运行时包一层计数，断言改动后一次 tick 的 `query` 次数低于改动前。断网场景额外确认 `getBaseline` 只在必要处被调用。
5. 真机日志形态核对（应与上轮一致，本轮**不应**产生任何行为差异）：
   - `[BOOM-BASE] 刻度` 仍约每 60 秒一条，`B` 仍贴着 `stableCeiling`
   - `[BOOM-HISTORY] 缺口组结束` 的 `本组推进` 仍能报出非零值（第 5 条改动直接喂这行）
   - `[BOOM-HISTORY] 补录结束` 的 `剩余缺口` / `剩余秒` 仍准确（第二层改签名后这行必须原样成立）
   - 测试页打开后，人为制造一次整轮失败（如断网 + 清库），`lastError` 文本出现在页面上
