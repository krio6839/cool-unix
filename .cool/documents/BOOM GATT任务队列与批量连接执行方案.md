# BOOM GATT 任务队列与批量连接执行方案

## Summary

- 将现在各模块各自“连接 -> 执行 -> 断开 -> 恢复广播”的模式，收敛成统一 `DeviceGattScheduler`。
- 普通任务每 10 分钟批量执行；加急任务立即触发执行，并顺带处理队列里的其他任务。
- 一次连接内按优先级顺序执行多个任务，历史生命体征补缺固定最后执行。
- 无任务时不连接；任务完成后统一断开并恢复绑定广播扫描。

## Key Changes

### 新增 GATT 任务队列

- 任务类型使用显式 UTS type：`timeSync`、`setDeviceNumber`、`setBiometric`、`readEvent`、`unbind`、`historyRepair`、`manualCommand`。
- 任务优先级：`urgent`、`normal`、`tail`。
- 当前已接入执行器：`timeSync`、`readEvent`、`historyRepair`。
- `setDeviceNumber`、`setBiometric`、`unbind`、`manualCommand` 作为后续任务类型预留，真正接入前仍走现有显式连接/命令流程。
- `timeSync` 为加急任务，入队后立即触发执行。
- `readEvent` 由广播 `eventSeq` 变化入队，按加急处理，但同设备只保留最新一次事件任务。
- `historyRepair` 由启动后 15 秒和每 10 分钟检查入队，优先级固定 `tail`。

### 统一执行流程

- `scheduler.enqueue(task)` 只入队和触发，不直接连接。
- `scheduler.flush(reason)` 是唯一自动 GATT 执行入口：停止广播扫描 -> 连接/重建 GATT -> 执行任务 -> 断开 -> 恢复广播扫描。
- 如果已有可用 GATT 连接，复用连接，但每轮开始仍重新校验 service/notify。
- flush 运行中新增任务只入队；当前任务结束后若仍在时间预算内继续执行，否则留到下一轮。

### 任务顺序

- 先执行加急控制类：`unbind`、`timeSync`、`setDeviceNumber`、`setBiometric`、`manualCommand`，其中当前只有 `timeSync` 已接入执行器。
- 再执行数据类：`readEvent`。
- 最后执行 `historyRepair`。
- `historyRepair` 不再限制 gap 段数；按最近优先补，单次 flush 设置最大执行时长，默认 90 秒，到点后保留剩余 gap 下轮继续。
- 如果设备返回历史数据已经早于目标窗口，继续使用当前 upper-bound 逻辑跳过更新的无效 gap。

### 模块改造

- `broadcast` 不再自己连接读事件/校时，只负责解析广播并 enqueue 对应任务。
- `sync` 不再自己连接补历史，只负责规划 gap 并 enqueue `historyRepair`。
- `connection.switchToConnectMode/switchToBroadcastMode` 是唯一底层模式切换入口，scheduler 和页面都通过它切换。
- 现有 `DeviceGattTaskLock` 保留为 scheduler 内部执行锁，页面和业务模块不直接抢锁。
- 测试页手动 GATT 命令仍作为调试入口直接发送；后续接入 `manualCommand` 后再由 scheduler 统一执行。

## Test Plan

- 无任务时等待 10 分钟：确认不会发起 GATT 连接，只保持广播扫描。
- 广播时间异常：确认入队 `timeSync` 后立即连接，校时完成后顺带执行队列中已有任务，最后恢复广播。
- 设置编号：当前仍走手动连接/命令；接入 scheduler 后再验证 `setDeviceNumber`。
- 设置生物信息：当前仍走手动连接/命令；接入 scheduler 后再验证 `setBiometric`。
- 广播事件序号变化：确认只入队最新 `readEvent`，连接后读取事件；读取事件结束后再补历史。
- 历史缺口：确认启动后和每 10 分钟只规划并入队；flush 中历史补缺最后执行，gap 不再按 4 段截断，但 90 秒到点会暂停到下轮。
- 并发场景：校时、事件、历史同时出现时只发生一次连接，任务按顺序执行，不出现 3A/3D 交错污染。
- 连接异常：假连接或 notify 不可用时重新初始化失败应断开并重连；本轮失败任务保留或按任务策略重试，不清绑定。
- 解绑：删除设备时当前仍走显式连接并发送 `0x41`；后续接入 `unbind` 队列后再统一到 scheduler。

## Assumptions

- 普通批量检查间隔默认 10 分钟。
- 加急任务立即触发 flush，并顺带执行已有普通任务。
- 历史补缺不限制 gap 数，但单次 GATT 执行总时长默认限制为 90 秒。
- 历史生命体征仍只用 0x3A/0x3B；事件读取仍由广播 eventSeq 变化触发。
- 自动业务流完成后默认断开 GATT 并恢复广播模式，避免长连占用广播数据来源。
