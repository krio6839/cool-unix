# BOOM 蓝牙运行流程说明

本文档说明当前 App 对 BOOM 新设备的蓝牙运行策略，方便对照日志排查。

## 1. 总体原则

- 已绑定设备默认使用广播模式，不主动保持 GATT 连接。
- 0x50 广播是实时展示和实时 PPI 入库的主要来源。
- GATT 只作为任务执行通道，不主动长连；任务完成后断开并恢复广播扫描。
- 自动 GATT 业务统一进入 `DeviceGattScheduler` 队列，批量连接执行，避免事件、历史、校时等命令互相掺杂。
- 加急任务会立即触发队列执行；普通历史补缺由启动后和 10 分钟检查触发。
- 事件读取有两类来源：广播 `eventSeq` 变化立即入队、自动同步每 30 分钟兜底入队。
- 连接初始化只准备 services / characteristics / notify，不自动读固件版本，不自动读 0x50。

## 2. 启动与广播模式

App 启动后，如果已有绑定设备：

1. 初始化蓝牙适配器。
2. 以后台扫描权限配置初始化 `kux-bluetooth`，并启动绑定设备广播扫描。
3. 从本地数据库恢复最近一次 `eventSeq`，避免首次广播误判为新事件。
4. 启动生命体征历史缺口自动检查，并按 30 分钟节奏投递事件兜底读取。

广播扫描只匹配当前绑定设备 ID。收到绑定设备广播后，按新版 24B `custom_adv_data_t` 解析：

- `utc`
- `voltage`
- `status` 派生出 PPG 佩戴、行为、活动状态
- `hr`
- `ppi`
- `spo2`
- `bhr`
- `status2` 派生出 `eventSeq` 和电池状态
- `steps_everyday`
- `calorie_everyday`
- `rmssd`

日志示例：

```text
[BOOM-ADV] 收到广播 #12: phone=... utc=... diff=1s timeValid=true eventSeq=5 ...
```

## 3. 广播时间校验

每条广播会先做缓存包识别，再校验 `utc` 是否可信。

缓存包识别规则：

- 如果本条广播 `timeValid=false`，并且 `utc` 没有比上一条可信广播前进，同时 `vHex` 和上一条可信广播完全相同，先记为一次疑似缓存。
- 连续 3 次疑似缓存后，才认为是 Android 扫描层缓存旧包。
- 缓存包直接丢弃，不入库、不更新首页、不触发事件、不触发校时。
- 丢弃后重启绑定广播扫描。
- 重启扫描有 20 秒冷却，避免 stop/start 过于频繁。

扫描无回调保护：

- 绑定广播扫描启动后，如果 12 秒内没有任何 `deviceFound` 回调，认为系统扫描管线卡住。
- 这种情况日志里会看到 `startDiscovery 成功` 和 `discovering=true`，但没有任何 `[BOOM-ADV] 收到广播` 或“未匹配绑定设备”日志。
- App 会主动重启绑定广播扫描。
- 这个保护和缓存包识别不同：缓存包是“有回调但包是旧的”，扫描无回调是“完全没有回调”。

后台保活扫描兜底：

- `kux-bluetooth` 初始化时开启 `accessBackgroundLocation=true`，确保插件请求后台定位权限链路。
- Android 保活服务每分钟唤醒一次 App 侧任务。
- 如果已有绑定设备、当前没有 GATT 连接、没有 GATT 队列任务执行中，保活会检查绑定广播扫描状态。
- 如果绑定广播扫描未启动，保活会直接拉起绑定设备过滤扫描。
- 如果绑定广播扫描已启动，但超过 70 秒没有任何扫描回调或绑定广播处理，保活会轻量重启扫描。
- 保活只维护扫描，不发送 GATT 命令；历史、事件、校时仍统一走 scheduler。
- 保活扫描维护失败只记录日志，不影响 PPI/睡眠上传兜底。
- 代码结构上，广播扫描分为三层：`startBoundBroadcastScan()` 只启动，`restartBoundBroadcastScan()` 只重启，`maintainBoundBroadcastScan()` 只检查并按需调用前两者。

后台兜底日志示例：

```text
[SCAN] 检查绑定广播扫描: reason=keepalive service, bound=..., scanning=true, purpose=boundBroadcast, current=, gattBusy=false, idleMs=..., maxIdleMs=70000
[SCAN] 绑定广播扫描无活跃回调，重启扫描
```

时间校验规则：

- `diff <= 10s`：认为时间可信，允许入库、更新首页、写 PPI。
- `10s < diff < 60s`：丢弃本条，不自动校时。通常是短暂缓存、扫描延迟或系统回调延迟。
- `diff >= 60s`：如果不是缓存包，认为设备时间明显异常，丢弃本条并尝试自动 GATT 校时。

坏时间广播不会写入：

- `realtime_broadcast_data`
- `ppi_data`
- 首页实时 store

自动校时流程：

1. 广播模块丢弃本条异常数据，并向 `DeviceGattScheduler` 投递 `timeSync` 加急任务。
2. Scheduler 停止广播扫描，连接/重建 GATT。
3. 发送 `0x33` 设置当前手机 UTC 秒。
4. 发送 `0x34` 读回设备时间确认。
5. 成功后继续顺带执行队列里已有任务，最后断开并恢复广播扫描。

如果校时失败：

- 不清除绑定关系。
- 停止当前自动使用。
- 清空当前实时展示。
- 断开当前 GATT 连接，不恢复广播扫描。
- 提示用户：设备时间异常且自动校时失败，请检查设备后手动重连。

## 4. 实时数据入库与首页展示

时间可信的广播会写入 `realtime_broadcast_data`。

首页、metrics、状态页、负荷页优先使用本地最新广播数据展示：

- 心率：`hr`
- 静息心率：`bhr`
- 血氧：`spo2`
- 心率变异性：`rmssd`
- 步数：`steps_everyday`
- 卡路里：`calorie_everyday / 100`

其中 `rmssd` 是 HRV 实时值，`ppi` 不再作为 HRV 展示值。

实时展示过期规则：

- App 启动或页面进入时，会从 `realtime_broadcast_data` 恢复最近一条广播记录。
- 如果最近一条广播记录的 `received_at` 距离当前超过 5 分钟，实时展示清空。
- 正常收到可信广播后，会刷新 `received_at` 并重新启动 5 分钟过期计时。
- 单个字段无效时不立刻清空该字段，例如 `hr=0`、`bhr=0`、`rmssd=-1`，会保留上一条有效值。
- 如果整个广播 5 分钟没有更新，首页、metrics、状态页、负荷页的实时值显示为 `-` 或空值。

## 5. PPI 保存与批量上传

广播中只要 `hr / spo2 / ppi` 至少有一个有效，就写入 `ppi_data`：

- `timestamp = 广播 utc`
- `hr = 无效时 0`
- `spo2 = 无效时 0`
- `ppi = 无效时 0`

历史生命体征 `0x3A/0x3B` 没有血氧字段，保存口径与广播保持一致：

- 每秒数据只要 `hr / ppi` 至少有一个有效，就写入 `ppi_data`。
- `timestamp = response.startSec + secondIndex`
- `spo2 = 0`
- `hr / ppi` 无效时按 0 保存。

上传策略：

- 不每秒上传。
- 满足任一条件才上传：
    - 未上传数据达到 30 条。
    - 距离上次上传尝试超过 30 秒。
- 定时兜底上传也走同一套 `requestPpiUpload()` 判断，不绕过批量策略。

日志中如果看到短时间连续上传少量数据，说明上传节流需要重点检查。

## 6. 新事件触发与读取

广播 `status2` 的高 4 位是 `eventSeq`。

处理规则：

1. App 启动时从数据库恢复最近 `eventSeq`。
2. 收到广播时，如果 `eventSeq` 相比上次变化，标记 `hasNewEvent=true`。
3. 向 `DeviceGattScheduler` 投递 `readEvent` 加急任务。
4. 如果队列里已有事件读取任务，会替换成最新一次；如果事件读取正在执行，则跳过重复入队。

事件兜底读取：

- 自动同步循环每 30 分钟投递一次普通优先级 `readEvent`。
- 兜底读取不依赖广播 `eventSeq` 变化。
- 兜底只负责“读事件”；读到 `SleepResult` 后才会保存睡眠并上传。
- 如果队列里已有 `readEvent`，或正在执行 `readEvent`，兜底不会重复入队。

事件读取流程：

1. Scheduler 停止广播扫描，连接/重建 GATT。
2. 发送 `0x3C`，按时间窗口读取最近 24 小时事件头。
3. 根据设备响应自动发送 `0x3D` 续读。
4. 解析事件明细并保存睡眠相关数据。
5. 打印解析摘要。
6. 读取结束后补最近 2 分钟生命体征。
7. 如果队列里还有历史补缺任务，继续执行；所有任务结束后断开回广播。

事件读取期间由 scheduler 持有临时 GATT 连接。页面不再维护 `testMode`；当前状态应由 `currentDeviceId`、`isGattTaskBusy()` 和 `getOnlineInfo()` 推导。

日志中正常事件读取会出现：

```text
[BOOM-EVENT] 开始读取新事件
[BOOM] 事件头: type=..., earliestSn=..., latestSn=...
[BOOM] 事件追加: count=10, total=...
[BOOM-EVENT] 新事件解析结果:
```

## 7. 事件读取后的历史补充

事件读取结束后一定会补一次最近 2 分钟生命体征，目的是覆盖 GATT 期间漏掉的广播数据。

流程：

1. Scheduler 在同一次 GATT 连接内继续执行。
2. 发送一次 `0x3A` 查询最近 2 分钟。
3. 如有必要，根据返回段和目标窗口判断是否继续 `0x3B`。
4. 保存 `hr / ppi` 至少一个有效的每秒记录到 `ppi_data`。
5. 释放 `vitalRecent` 锁。
6. 继续执行后续队列任务；若无任务则断开并恢复广播扫描。

如果设备返回的历史段早于目标窗口，会停止续读，避免一直翻更早数据。

日志示例：

```text
[BOOM-HISTORY] 最近窗口补拉: startSec=...
[BOOM-HISTORY] 最近窗口补拉段: page=1, responseStart=...
[BOOM-HISTORY] 最近窗口补拉停止续读: 返回段已早于目标窗口
```

## 8. 历史缺口与事件兜底

后台不存在连接态常驻轮询；需要读取历史生命体征或事件时，只投递 GATT 队列任务，由 scheduler 临时连接执行。

触发策略：

- App 启动后延迟 15 秒检查一次。
- 之后每 10 分钟检查一次生命体征缺口。
- 每 30 分钟投递一次事件兜底读取。
- 只扫描最近 24 小时的 `ppi_data.timestamp`。
- 相邻 PPI 时间戳间隔超过 180 秒，认为有缺口。
- 本地完全没有 PPI 时，首次最多补最近 6 小时。
- 每个缺口前后扩 2 分钟。
- 不再按 gap 数量限制每轮补缺；按最近优先补。
- 单次 scheduler 执行默认最多占用 GATT 90 秒，到点后剩余缺口留到下一轮。
- 只要某段缺口补拉收到设备可靠响应，就记录到临时表 `vital_history_gap_checks`。
- 近期已补拉确认的窗口 6 小时内不重复补；即使这段只有少量有效点或全无效，也不会在当前 App 运行期间每 10 分钟反复连接。
- `vital_history_gap_checks` 不长期保留，App 重启后会重新扫描最近 24 小时并重新判断缺口。
- 超时或发送失败不记录为已补拉，避免把通信失败误判成设备无数据。

历史补缺和事件兜底都不会自己连接设备；`sync` 只负责规划/投递队列任务。
Scheduler 会把历史补缺放在本轮队列最后执行，避免大段历史读取挡住校时、设置、事件读取等加急任务。

日志示例：

```text
[BOOM-SYNC] 已规划生命体征历史缺口: reason=startup, gaps=...
[BOOM-SCHED] 任务入队: seq=..., key=historyRepair, kind=historyRepair, priority=tail, size=...
[BOOM-SYNC] 开始补生命体征历史: reason=startup, gaps=...
[BOOM-SYNC] 跳过近期已补拉确认的历史窗口: before=..., after=..., checks=...
[BOOM-SYNC] 已入队事件兜底读取: reason=timer
```

## 9. GATT 任务队列与通道锁

自动 GATT 业务统一进入 `DeviceGattScheduler`：

- `timeSync`：加急，广播时间异常时立即执行。
- `readEvent`：广播 `eventSeq` 变化时加急执行；30 分钟兜底时普通优先级执行。
- `historyRepair`：尾部任务，启动后和每 10 分钟发现缺口时入队。
- `manualCommand`：测试页和手动 GATT 命令。

任务身份：

- 每个任务都有 `seq`，用于日志追踪一次入队到执行的生命周期。
- 每个任务都有 `key`，用于合并同类任务。
- `timeSync` 的 key 是 `timeSync`，重复入队时保留最新校时参数。
- `readEvent` 的 key 是 `readEvent`，广播新事件和 30 分钟兜底共享同一个槽位。
- `historyRepair` 的 key 是 `historyRepair`，重复入队只保留一个补缺任务。
- `manualCommand` 的 key 带 `seq`，所以不会合并。

去重规则：

- 队列里只保留一个 `readEvent`；新事件加急任务会替换已排队事件任务。
- `readEvent` 正在执行时，新的事件任务和事件兜底任务都会跳过，不再排下一轮重复读取。
- 队列里只保留一个 `historyRepair`；补历史正在执行时，新的补历史任务会跳过。
- `manualCommand` 不去重，用户触发几次就执行几次。
- flush 过程中如果又收到新的 flush 请求，会记录最强触发原因；只有队列里确实还有任务时才继续下一轮。
- 连接失败、GATT 忙、90 秒预算到达时，不会立刻自旋重试，剩余任务等待下一次触发。

Scheduler 执行顺序：

1. 加急控制类：`timeSync`、`manualCommand`
2. 数据类：`readEvent`
3. 尾部任务：`historyRepair`

Scheduler 执行流程：

1. 队列为空时不连接。
2. 有加急任务时立即 flush；普通历史/事件兜底由定时检查 flush。
3. flush 开始时停止广播扫描，连接或重建 GATT。
4. 每轮开始重新校验 service / notify，避免复用假连接。
5. 按顺序执行任务，所有任务共用 GATT 锁。
6. 任务完成后断开并恢复广播扫描；校时失败时断开但不恢复广播扫描。

所有会占用 GATT 命令通道的任务都要先抢锁：

- `timeSync`：自动校时
- `event`：事件读取
- `vitalRecent`：断开前最近 2 分钟补拉
- `vitalGap`：历史缺口补拉
- `vitalAuto`：手动生命体征自动续读
- `unbind`：删除设备时远端解绑
- `manual`：测试页手动命令预留

日志示例：

```text
[BOOM-SCHED] 任务入队: seq=12, key=readEvent, kind=readEvent, priority=urgent, size=1
[BOOM-SCHED] 任务合并: seq=12, key=readEvent, kind=readEvent, priority=urgent, size=1
[BOOM-SCHED] 执行任务: seq=12, key=readEvent, kind=readEvent
```

如果频繁看到“通道忙”，说明自动任务之间仍有冲突，需要调整触发时机。

## 10. 模式切换

### 广播模式

- 停止当前 GATT 任务后的连接占用。
- 断开当前 GATT。
- 启动绑定设备广播扫描。
- 页面用 `getOnlineInfo()` 显示广播在线/离线。

### 临时 GATT 任务

- 停止绑定广播扫描。
- 优先直连缓存绑定设备。
- 连接成功后只初始化协议通道，不自动读固件、不自动校时、不自动读 0x50。
- 执行队列任务，完成后断开并恢复广播扫描。

测试页不再手动切换连接模式；点击 GATT 命令后进入队列执行。

## 11. 删除设备与解绑

删除设备时：

1. 通过连接层进入 GATT 连接模式。
2. 发送 `0x41`，`code=1` 请求设备解绑并清除数据。
3. 等待 `0x41` 响应，`result=0` 表示成功。
4. 无论设备是否确认，最终清理本地绑定和本地数据。

注意：自动校时失败不会清绑定，只提示用户。

## 12. 日志检查清单

正常广播：

```text
timeValid=true
ppg=attached/detached
hr=...
ppi=...
eventSeq=...
```

缓存旧广播：

```text
检测到扫描缓存广播，丢弃并重启广播扫描
```

扫描启动但无回调：

```text
绑定广播扫描 12000ms 内无任何回调，重启扫描
重启绑定广播扫描: no scan callback
```

短暂旧广播：

```text
广播 UTC 轻微滞后，丢弃本条缓存数据
```

设备时间明显错误：

```text
广播 UTC 不可信，丢弃本条数据并尝试校时
广播时间偏差过大，自动校时
自动校时完成
```

事件读取成功：

```text
事件头
事件追加
新事件解析结果
```

历史补拉成功或安全停止：

```text
最近窗口补拉段
最近窗口补拉完成
最近窗口补拉停止续读
```

上传正常：

```text
未上传的PPI数据数量
上传PPI数据
PPI上传成功
```

异常重点：

- `SEND_FAILED`：通常是 protocol 未 ready 或连接已断。
- `TIMEOUT hadNotify=false`：发送后没有任何 notify，可能连接断开或设备未响应。
- 连续小批量上传：检查是否绕过 `requestPpiUpload()`。
- 频繁自动校时：检查是否被缓存旧广播误触发。
- 事件读取 `TIMEOUT pages=0`：检查 0x3C 是否有回包，notify 分片是否被重组。
