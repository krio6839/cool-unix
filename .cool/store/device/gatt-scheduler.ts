import { EVENT_QUERY_TYPE_ALL } from "../../bluetooth";
import { sleepTimeout } from "../../utils";
import { repairFromBaseline } from "./history-repair";
import type { Device } from "./index";
import type {
	GattFlushReason,
	GattQueuePriority,
	GattQueueTaskKind,
	GattTaskOutcome,
	SyncReason
} from "./types/gatt-types";
import { logger } from "../../service/logger";
import { BROADCAST_TIME_DRIFT_SEC } from "./broadcast";
import type { ProtocolProbeResult } from "./protocol-probe";

const EVENT_SYNC_MAX_COUNT = 10;
const EVENT_SYNC_MAX_PAGES = 20;
const EVENT_SYNC_TIMEOUT_MS = 10000;
const EVENT_SYNC_AFTER_CONNECT_DELAY_MS = 800;
const TIMESTAMP_VERIFY_TIMEOUT_MS = 3000;
/**
 * 校时回读允许的秒级误差（下发到回读之间设备自己会走几秒）。
 *
 * 必须远小于广播那侧的校时门槛（60s）：真失败时回读的偏差是几十秒甚至几年，
 * 不会被这点余量放过。
 */
const TIMESTAMP_VERIFY_TOLERANCE_SEC = 10;

export type GattQueueTask = {
	seq: number;
	key: string;
	kind: GattQueueTaskKind;
	priority: GattQueuePriority;
	deviceId: string;
	manualName: string;
	manualRunner: (() => Promise<boolean>) | null;
	manualResolve: ((ok: boolean) => void) | null;
	eventSeq: number;
	diffSec: number;
	broadcastUtc: number;
	historyReason: SyncReason;
};

/**
 * 自动 GATT 任务调度器。
 *
 * 广播模式下只负责发现“需要连接才能完成”的工作；真正连接、串行执行、
 * 断开并恢复广播都集中在这里，避免多个模块各自连接/断开导致通道互相抢占。
 */
export class DeviceGattScheduler {
	private device: Device;
	private tasks: GattQueueTask[] = [];
	private taskSeq: number = 0;
	private flushing: boolean = false;
	private pendingFlushReason: GattFlushReason | "" = "";
	private pauseCurrentFlush: boolean = false;
	private runningTask: GattQueueTask | null = null;
	/**
	 * 本轮 flush 已执行过、又回队的任务 key。
	 * 同一轮内不再重复取用，否则回队任务会立刻再次命中预算检查，空转到整轮超时。
	 */
	private flushDeferredKeys = new Map<string, boolean>();
	/**
	 * 中止代号。`abortAll()` 自增，在途 flush 靠它发现自己已经作废。
	 *
	 * 只看 `tasks.length` 不够：任务被 `takeNextTask()` 取走后队列就是空的，flush 还会
	 * 接着探活、发帧，而那次连接可能已经被删除设备流程断开。
	 */
	private abortGeneration: number = 0;

	constructor(device: Device) {
		this.device = device;
	}

	/**
	 * 清空队列并中止在途 flush。
	 *
	 * 删除设备时 `unbind` 会抢通道、断连接，队列里的任务如果不作废，就会在一条已经
	 * 断掉（或即将断掉）的链路上继续写特征值，换回 10006/10004/10008 三连错误。
	 */
	abortAll(reason: string): void {
		const dropped = this.tasks.length;
		this.abortGeneration++;
		// 顺序不能反：`failManualTasks()` 靠遍历 `tasks` 找 manual 任务，清空后它就没事可做了，
		// 手动命令的调用方会永远挂在 await 上。
		this.failManualTasks();
		this.tasks = [];
		this.flushDeferredKeys.clear();
		this.pauseCurrentFlush = true;
		this.pendingFlushReason = "";
		// 已出队、正在跑的任务由 flush 的代号检查收尾，这里只负责队列里的。
		logger.info(
			"bluetooth",
			`[BOOM-SCHED] 队列已中止: reason=${reason}, 丢弃=${dropped}, 在途=${this.runningTask != null}`
		);
	}

	/** 当前这次 flush 是否已经被 `abortAll()` 作废。 */
	private isFlushAborted(generation: number): boolean {
		return generation != this.abortGeneration;
	}

	/**
	 * 探活读回的设备时间偏了就顺手排一次校时，本轮直接执行，不额外连一次设备。
	 *
	 * `sourceUtc` 传 0：这不是广播触发的，执行器按「探活发现偏差」记日志。
	 */
	private requestTimeSyncFromProbe(probe: ProtocolProbeResult): void {
		if (probe.deviceTimestamp <= 0) return;
		const nowSec = Math.floor(Date.now() / 1000);
		let diffSec = nowSec - probe.deviceTimestamp;
		if (diffSec < 0) diffSec = 0 - diffSec;
		if (diffSec <= BROADCAST_TIME_DRIFT_SEC) return;
		if (this.device.broadcast.tryEnqueueTimeSync(diffSec, 0) == true) {
			logger.warn(
				"bluetooth",
				`[BOOM-SCHED] 探活发现设备时间偏差，本轮顺带校时: diff=${diffSec}s`
			);
		}
	}

	enqueueTimeSync(diffSec: number, broadcastUtc: number): void {
		const task = this.makeTask("timeSync", "urgent");
		task.diffSec = diffSec;
		task.broadcastUtc = broadcastUtc;
		this.upsertTask(task);
		this.requestFlush("urgent");
	}

	enqueueReadEvent(deviceId: string, eventSeq: number): void {
		const task = this.makeTask("readEvent", "urgent");
		task.deviceId = deviceId;
		task.eventSeq = eventSeq;
		task.key = "readEvent";
		if (this.isTaskRunning("readEvent") == true) {
			logger.info("bluetooth", "[BOOM-SCHED] 事件读取正在执行，跳过重复事件任务");
			return;
		}
		this.upsertTask(task);
		this.requestFlush("urgent");
	}

	enqueueEventBackfill(deviceId: string, reason: SyncReason): boolean {
		if (deviceId == "") return false;
		// 兜底没有广播帧来推它，所以入队必须自己触发一次 flush，否则要等到下一次
		// `eventSeq` 变化才会被执行。因通道忙回队的事件任务同样要触发——回队后没人管
		// 正是它最大的风险，不能只靠下一次广播。
		if (this.hasQueuedTaskKind("readEvent") == true) {
			this.requestFlush("timer");
			return true;
		}
		if (this.isTaskRunning("readEvent") == true) return false;
		const task = this.makeTask("readEvent", "normal");
		task.deviceId = deviceId;
		task.eventSeq = -1;
		task.historyReason = reason;
		task.key = "readEvent";
		this.upsertTask(task);
		this.requestFlush("timer");
		return true;
	}

	enqueueHistoryRepair(reason: SyncReason): void {
		const task = this.makeTask("historyRepair", "tail");
		task.historyReason = reason;
		task.key = "historyRepair";
		if (this.isTaskRunning("historyRepair") == true) {
			logger.info("bluetooth", "[BOOM-SCHED] 历史补缺正在执行，跳过重复补缺任务");
			return;
		}
		this.upsertTask(task);
		if (reason == "manual") {
			this.requestFlush("manual");
		}
	}

	runManualGattTask(name: string, runner: () => Promise<boolean>): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			// 测试页/表单类命令统一走 manualCommand，避免为每个 0x31/0x35 等命令扩散队列类型。
			const task = this.makeTask("manualCommand", "urgent");
			task.manualName = name;
			task.manualRunner = runner;
			task.manualResolve = resolve;
			task.key = `manualCommand:${task.seq}`;
			this.upsertTask(task);
			this.requestFlush("manual");
		});
	}

	requestFlush(reason: GattFlushReason): void {
		if (this.flushing == true) {
			this.pendingFlushReason = this.getStrongerFlushReason(this.pendingFlushReason, reason);
			return;
		}
		this.flush(reason);
	}

	private makeTask(kind: GattQueueTaskKind, priority: GattQueuePriority): GattQueueTask {
		this.taskSeq = this.taskSeq + 1;
		return {
			seq: this.taskSeq,
			key: kind,
			kind,
			priority,
			deviceId: "",
			manualName: "",
			manualRunner: null,
			manualResolve: null,
			eventSeq: 0,
			diffSec: 0,
			broadcastUtc: 0,
			historyReason: "timer"
		} as GattQueueTask;
	}

	private upsertTask(task: GattQueueTask): void {
		const index = this.findTaskIndexByKey(task.key);
		if (index >= 0) {
			const old = this.tasks[index];
			task.seq = old.seq;
			this.tasks[index] = task;
			logger.info(
				"bluetooth",
				`[BOOM-SCHED] 任务合并: seq=${task.seq}, key=${task.key}, kind=${task.kind}, priority=${task.priority}, size=${this.tasks.length}`
			);
			return;
		}
		this.tasks.push(task);
		logger.info(
			"bluetooth",
			`[BOOM-SCHED] 任务入队: seq=${task.seq}, key=${task.key}, kind=${task.kind}, priority=${task.priority}, size=${this.tasks.length}`
		);
	}

	private findTaskIndexByKey(key: string): number {
		for (let i = 0; i < this.tasks.length; i++) {
			if (this.tasks[i].key == key) return i;
		}
		return -1;
	}

	/** 只检查排队中的任务，不包含正在执行的那个。 */
	private hasQueuedTaskKind(kind: GattQueueTaskKind): boolean {
		for (let i = 0; i < this.tasks.length; i++) {
			if (this.tasks[i].kind == kind) return true;
		}
		return false;
	}

	private isTaskRunning(kind: GattQueueTaskKind): boolean {
		const task = this.runningTask;
		return task != null && task.kind == kind;
	}

	private async flush(reason: GattFlushReason): Promise<void> {
		if (this.flushing == true) return;
		if (this.tasks.length == 0) return;
		this.flushing = true;
		this.pendingFlushReason = "";
		this.pauseCurrentFlush = false;
		this.flushDeferredKeys.clear();
		let shouldContinueFlush = false;
		let connected = false;
		let protocolHealthy = false;
		const generation = this.abortGeneration;
		let aborted = false;
		try {
			// 一轮 flush 只占用一次 GATT：停广播、连接、按优先级执行、最后恢复广播。
			logger.info(
				"bluetooth",
				`[BOOM-SCHED] 开始执行队列: reason=${reason}, tasks=${this.tasks.length}`
			);
			if (this.device.isGattTaskBusy() == true) {
				logger.info(
					"bluetooth",
					`[BOOM-SCHED] GATT 通道忙(${this.device.getGattTaskName()})，任务保留到下轮`
				);
				this.failManualTasks();
				return;
			}
			connected = await this.device.connection.switchToConnectMode("scheduler");
			if (connected == false) {
				logger.warn("bluetooth", "[BOOM-SCHED] 连接失败，任务保留到下轮");
				this.failManualTasks();
				return;
			}
			if (this.isFlushAborted(generation) == true) {
				aborted = true;
				logger.info("bluetooth", "[BOOM-SCHED] 本轮队列已中止，跳过探活");
				return;
			}
			await sleepTimeout(EVENT_SYNC_AFTER_CONNECT_DELAY_MS);
			if (this.isFlushAborted(generation) == true) {
				aborted = true;
				logger.info("bluetooth", "[BOOM-SCHED] 本轮队列已中止，放弃探活");
				return;
			}
			const initialProbe = await this.device.protocolProbe.check();
			if (this.isFlushAborted(generation) == true) {
				aborted = true;
				logger.info("bluetooth", "[BOOM-SCHED] 本轮队列已中止，跳过执行");
				return;
			}
			if (initialProbe.status != "OK") {
				this.device.health.recordUnresponsive();
				this.failManualTasks();
				logger.warn(
					"bluetooth",
					`[BOOM-SCHED] 设备协议探活失败，本轮任务保留: status=${initialProbe.status}`
				);
				return;
			}
			protocolHealthy = true;
			// 探活已经读回了设备时间：偏了就在本轮顺手校掉。连接态扫描是停的，收不到广播，
			// 设备 RTC 真偏了只能靠这里发现——绑定后的新设备往往就是这种情况。
			this.requestTimeSyncFromProbe(initialProbe);
			// 一次补录就是把 `[B, stableCeiling)` 读完，不设时长上限。连接期间掐掉广播留下的
			// 缺秒就是普通缺秒，断开时不需要为它做任何事，由下一次连接顺带补掉。
			while (this.tasks.length > 0 && this.isFlushAborted(generation) == false) {
				const task = this.takeNextTask();
				if (task == null) break;
				const outcome = await this.runTask(task);
				if (outcome == "STOP_DEVICE_UNRESPONSIVE") {
					protocolHealthy = false;
					this.device.health.recordUnresponsive();
					break;
				}
				if (this.isFlushAborted(generation) == true) {
					aborted = true;
					logger.info("bluetooth", "[BOOM-SCHED] 本轮队列已中止，停止执行后续任务");
					break;
				}
				if (this.pauseCurrentFlush == true) {
					logger.info("bluetooth", "[BOOM-SCHED] GATT 通道忙，暂停本轮执行");
					break;
				}
			}
			if (protocolHealthy == true) this.device.health.recordHealthyConnection();
			shouldContinueFlush = this.tasks.length > 0 && this.pendingFlushReason != "";
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-SCHED] 队列执行异常:", e);
		} finally {
			// 中止后连接归删除流程处理（它自己会断），这里再切广播会把扫描拉起来。
			if (connected == true && aborted == false) {
				if (this.shouldRestoreBroadcast() == true) {
					try {
						await this.device.connection.switchToBroadcastMode();
					} catch (e) {
						logger.warn("bluetooth", "[BOOM-SCHED] 恢复广播失败:", e);
					}
				} else {
					try {
						await this.device.connection.disconnectDevice();
					} catch (e) {
						logger.warn("bluetooth", "[BOOM-SCHED] 断开 GATT 失败:", e);
					}
				}
			}
			this.flushing = false;
			if (shouldContinueFlush == true && this.tasks.length > 0) {
				let nextReason: GattFlushReason = "timer";
				if (this.pendingFlushReason != "") {
					nextReason = this.pendingFlushReason as GattFlushReason;
				}
				this.requestFlush(nextReason);
			} else if (this.tasks.length > 0 && this.pendingFlushReason != "") {
				// 中止之后又入队的新任务（例如重绑后的校时）：本轮已作废，但 pending 不能吞掉，
				// 否则新任务要等到下一次有广播/心跳来推它才会执行。
				this.requestFlush(this.pendingFlushReason as GattFlushReason);
			}
		}
	}

	private takeNextTask(): GattQueueTask | null {
		if (this.tasks.length == 0) return null;
		let index = -1;
		let score = 0;
		for (let i = 0; i < this.tasks.length; i++) {
			// 本轮已经跑过又回队的任务留到下一轮，避免同一轮内反复命中预算检查。
			if (this.flushDeferredKeys.get(this.tasks[i].key) == true) continue;
			const itemScore = this.getTaskSortScore(this.tasks[i]);
			if (index < 0 || itemScore < score) {
				index = i;
				score = itemScore;
			}
		}
		if (index < 0) return null;
		const task = this.tasks[index];
		this.tasks.splice(index, 1);
		return task;
	}

	private getTaskSortScore(task: GattQueueTask): number {
		// 控制类任务优先，历史补缺永远排在最后，避免长历史读取挡住校时/事件。
		let priorityScore = 100;
		if (task.priority == "urgent") priorityScore = 0;
		if (task.priority == "normal") priorityScore = 100;
		if (task.priority == "tail") priorityScore = 200;
		let kindScore = 50;
		if (task.kind == "timeSync") kindScore = 10;
		if (task.kind == "manualCommand") kindScore = 40;
		if (task.kind == "readEvent") kindScore = 60;
		if (task.kind == "historyRepair") kindScore = 90;
		return priorityScore + kindScore;
	}

	private shouldRestoreBroadcast(): boolean {
		if (this.device.boundDeviceId == "") return false;
		if (this.device.errorMessage.value.indexOf("设备时间异常") >= 0) {
			return false;
		}
		return true;
	}

	private async runTask(task: GattQueueTask): Promise<GattTaskOutcome> {
		logger.info(
			"bluetooth",
			`[BOOM-SCHED] 执行任务: seq=${task.seq}, key=${task.key}, kind=${task.kind}`
		);
		this.runningTask = task;
		try {
			if (task.kind == "timeSync") {
				await this.runTimeSync(task);
				return "CONTINUE";
			}
			if (task.kind == "readEvent") {
				await this.runReadEvent(task);
				return "CONTINUE";
			}
			if (task.kind == "historyRepair") {
				return await this.runHistoryRepair(task);
			}
			if (task.kind == "manualCommand") {
				await this.runManualCommand(task);
				return "CONTINUE";
			}
			logger.info("bluetooth", `[BOOM-SCHED] 任务类型暂未接入执行器: ${task.kind}`);
			return "CONTINUE";
		} finally {
			this.runningTask = null;
		}
	}

	private async runTimeSync(task: GattQueueTask): Promise<void> {
		if (this.device.beginGattTask("timeSync") == false) {
			this.requeueTask(task);
			this.pauseCurrentFlush = true;
			return;
		}
		let ok = false;
		try {
			// `broadcastUtc == 0` 是探活那条路排的，此时没有广播可比对，不能说成「偏差过大」。
			const trigger =
				task.broadcastUtc > 0
					? "广播时间偏差过大"
					: "探活发现设备时间偏差";
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] ${trigger}: diff=${task.diffSec}s, advUtc=${task.broadcastUtc}`
			);
			const nowSec = Math.floor(Date.now() / 1000);
			const beforeSeq = this.device.event.boomTimestampSeqValue;
			const sent = await this.device.protocol.setTimestamp(nowSec);
			if (sent == false) {
				logger.warn("bluetooth", "[BOOM-ADV] 自动校时发送 0x33 失败");
				return;
			}
			await sleepTimeout(300);
			await this.device.protocol.readTimestamp();
			ok = await this.waitForTimestampResponse(beforeSeq, nowSec, TIMESTAMP_VERIFY_TIMEOUT_MS);
			if (ok == true) {
				logger.info("bluetooth", `[BOOM-ADV] 自动校时完成: utc=${nowSec}`);
				this.device.broadcast.markTimeSyncOk();
			} else {
				logger.warn("bluetooth", "[BOOM-ADV] 自动校时未生效: 回读未确认新时间");
			}
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-ADV] 自动校时异常:", e);
		} finally {
			this.device.endGattTask("timeSync");
			if (ok == false) {
				this.device.broadcast.markBoundDeviceUnavailable();
			}
		}
	}

	private async runReadEvent(task: GattQueueTask): Promise<void> {
		const isBackfill = task.eventSeq < 0;
		logger.info(
			"bluetooth",
			`[BOOM-EVENT] 开始读取${isBackfill ? "事件兜底" : "新事件"}: device=${task.deviceId}, eventSeq=${task.eventSeq}, maxCount=${EVENT_SYNC_MAX_COUNT}`
		);
		// 事件读取只按 globalSn 增量：0x3C 用「读全部」(type=0)，不再传时间窗口。
		// 设备本就不按窗口过滤（倒序从最新全给），早停由已读 sn 水位负责。
		const result = await this.device.history.readEventDataAuto({
			type: EVENT_QUERY_TYPE_ALL,
			startSec: 0,
			endSec: 0,
			maxCount: EVENT_SYNC_MAX_COUNT,
			maxPages: EVENT_SYNC_MAX_PAGES,
			timeoutMs: EVENT_SYNC_TIMEOUT_MS,
			persistSleepData: true,
			uploadAfterSave: true
		});
		if (result.status == "STOPPED" && result.message == "gatt busy") {
			this.requeueTask(task);
			this.pauseCurrentFlush = true;
			return;
		}
		logger.info(
			"bluetooth",
			`[BOOM-EVENT] 新事件读取完成: status=${result.status}, pages=${result.pages}, items=${result.items.length}, savedSleep=${result.savedSleepRecords}, saveOk=${result.saveOk}, 上传已尝试=${result.uploadAttempted}, upload=${result.uploadOk}`
		);
		if (result.items.length > 0) {
			logger.info(
				"bluetooth",
				`[BOOM-EVENT] 新事件解析结果:\n${this.device.history.formatEventAutoBrief(result.items, 20)}`
			);
		}
		// 读事件期间停广播留下的缺秒不在这里补：它和其他未记账的秒一样，由下一次连接
		// （10 分钟自动检查，或任何本来就要连的任务）按统一记账补掉。
	}

	private async runHistoryRepair(task: GattQueueTask): Promise<GattTaskOutcome> {
		// 读取窗口是 `[B, stableCeiling)` 一整段，不按区间逐段截断；连接本身由本调度器
		// 持有（停广播 → 连接 → 跑任务 → 恢复广播），`repairFromBaseline()` 只负责在
		// 已连接的通道上把这一段顺序读掉，不碰连接。
		// 返回值只用于判断设备是否失活；补录数字仍由历史模块自行记录。
		try {
			const stopReason = await repairFromBaseline(this.device.history, this.device.protocolProbe);
			this.device.tick.markHistorySynced();
			if (stopReason == "DEVICE_UNRESPONSIVE") return "STOP_DEVICE_UNRESPONSIVE";
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-HISTORY] 补录异常:", e);
		}
		return "CONTINUE";
	}

	private requeueTask(task: GattQueueTask): void {
		this.upsertTask(task);
		this.flushDeferredKeys.set(task.key, true);
		logger.info("bluetooth", `[BOOM-SCHED] 任务回队: seq=${task.seq}, key=${task.key}`);
	}

	private async runManualCommand(task: GattQueueTask): Promise<void> {
		let ok = false;
		try {
			logger.info("bluetooth", `[BOOM-SCHED] 执行手动 GATT 任务: ${task.manualName}`);
			const runner = task.manualRunner;
			if (runner != null) ok = await runner();
		} catch (e) {
			// Android 日志将 Error 对象序列化为 {}，必须写入字符串才方便定位测试命令异常。
			logger.warn(
				"bluetooth",
				`[BOOM-SCHED] 手动 GATT 任务异常: ${task.manualName}, error=${e}`
			);
			ok = false;
		} finally {
			const resolve = task.manualResolve;
			if (resolve != null) resolve(ok);
		}
	}

	private failManualTasks(): void {
		const kept: GattQueueTask[] = [];
		for (let i = 0; i < this.tasks.length; i++) {
			const task = this.tasks[i];
			if (task.kind == "manualCommand") {
				const resolve = task.manualResolve;
				if (resolve != null) resolve(false);
			} else {
				kept.push(task);
			}
		}
		this.tasks = kept;
	}

	/**
	 * 校时生没生效，只看设备回读的时间戳等不等于下发值。
	 *
	 * 设备写失败时同样会回一帧 0x33（回显的是改前的旧值），只判「有没有新帧」会把
	 * 失败当成功——既不重试也不提示，用户看到的就是「一直在校时、时间永远对不上」。
	 * 回显的值必须等于刚写下去的值。中间可能夹着上一帧的残响，所以要在超时窗口里
	 * 等到一帧匹配为止，而不是见到第一帧不一致就判死。
	 */
	private async waitForTimestampResponse(
		beforeSeq: number,
		expectedSec: number,
		timeoutMs: number
	): Promise<boolean> {
		const start = Date.now();
		let seenSeq = beforeSeq;
		let readBackSec = 0;
		while (Date.now() - start < timeoutMs) {
			const seq = this.device.event.boomTimestampSeqValue;
			if (seq > seenSeq) {
				seenSeq = seq;
				readBackSec = this.device.event.boomTimestamp.value;
				let skewSec = readBackSec - expectedSec;
				if (skewSec < 0) skewSec = 0 - skewSec;
				if (skewSec <= TIMESTAMP_VERIFY_TOLERANCE_SEC) return true;
			}
			await sleepTimeout(120);
		}
		if (readBackSec != 0) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 自动校时回读不一致: 下发=${expectedSec}, 回读=${readBackSec}`
			);
		}
		return false;
	}

	private getStrongerFlushReason(
		current: GattFlushReason | "",
		next: GattFlushReason
	): GattFlushReason {
		if (current == "") return next;
		if (current == "manual" || next == "manual") return "manual";
		if (current == "urgent" || next == "urgent") return "urgent";
		if (current == "startup" || next == "startup") return "startup";
		return "timer";
	}
}
