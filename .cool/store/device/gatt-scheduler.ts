import { EVENT_QUERY_TYPE_BY_TIME } from "../../bluetooth";
import { historyBaseline } from "../../bluetooth/history/baseline";
import { getHistoryTunables } from "../../bluetooth/history/tunables";
import { sleepTimeout } from "../../utils";
import type { Device } from "./index";
import type { DeviceSyncReason, HistoryRepairResult } from "./sync";
import type { GattFlushReason, GattQueuePriority, GattQueueTaskKind } from "./types/gatt-types";
import { logger } from "../../service/logger";

const EVENT_SYNC_WINDOW_SECONDS = 24 * 60 * 60;
const EVENT_SYNC_MAX_COUNT = 10;
const EVENT_SYNC_MAX_PAGES = 20;
const EVENT_SYNC_TIMEOUT_MS = 10000;
const EVENT_SYNC_AFTER_CONNECT_DELAY_MS = 800;
const TIMESTAMP_VERIFY_TIMEOUT_MS = 3000;

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
	historyReason: DeviceSyncReason;
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

	constructor(device: Device) {
		this.device = device;
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

	enqueueEventBackfill(deviceId: string, reason: DeviceSyncReason): boolean {
		if (deviceId == "") return false;
		// 因通道忙回队的事件任务还在排队：不重复入队，但仍要触发 flush，
		// 否则它会一直等到下一次 eventSeq 变化才被执行。
		if (this.hasQueuedTaskKind("readEvent") == true) return true;
		if (this.isTaskRunning("readEvent") == true) return false;
		const task = this.makeTask("readEvent", "normal");
		task.deviceId = deviceId;
		task.eventSeq = -1;
		task.historyReason = reason;
		task.key = "readEvent";
		this.upsertTask(task);
		return true;
	}

	enqueueHistoryRepair(reason: DeviceSyncReason): void {
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
		const startedAt = Date.now();
		let connected = false;
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
			await sleepTimeout(EVENT_SYNC_AFTER_CONNECT_DELAY_MS);
			// 没有时长上限：需要补的缺口就一直补，补到没有缺口再断开。原来「120 秒必须
			// 断开把通道还给广播」的约束由收尾的大空洞补读取代（9.3）——长连接留下的
			// 空洞在断开前就地消化，不再转交给下一次连接。
			while (this.tasks.length > 0) {
				const task = this.takeNextTask();
				if (task == null) break;
				await this.runTask(task, startedAt);
				if (this.pauseCurrentFlush == true) {
					logger.info("bluetooth", "[BOOM-SCHED] GATT 通道忙，暂停本轮执行");
					break;
				}
			}
			shouldContinueFlush = this.tasks.length > 0 && this.pendingFlushReason != "";
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-SCHED] 队列执行异常:", e);
		} finally {
			if (connected == true) {
				// 大空洞补读必须在断开之前：断开之后 GATT 已释放，读不了了。
				await this.readConnectionTailHoleBeforeDisconnect();
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
			// 空洞标记**不在这里清**：小空洞（tail <= 宽限）正是靠保留它、由 9.4 的
			// 广播接续判定消费；清掉就等于把这段秒漏给下一次连接。
			this.flushing = false;
			if (shouldContinueFlush == true && this.tasks.length > 0) {
				let nextReason: GattFlushReason = "timer";
				if (this.pendingFlushReason != "") {
					nextReason = this.pendingFlushReason as GattFlushReason;
				}
				this.requestFlush(nextReason);
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

	/**
	 * 9.3 大空洞补读：断开前读一次这条连接自己留下的空洞。
	 *
	 * **这是整套设计里唯一一次「为连接自己的尾巴读设备」的读取。** 连接期间广播停了，
	 * 广播又不携带历史秒，所以这段空洞只有 `0x3A`/`0x3B` 能拿回来。
	 *
	 * 判据是**空洞宽度**，不是连接时长：留不留缺口取决于空洞形状——连接 12:00:20~12:00:30
	 * 只跨 10 秒，却让 `[12:00,12:01)` 连续缺 10 秒；反过来一条 3 分钟的连接如果中途广播
	 * 短暂恢复，空洞反而可能很小。
	 *
	 * ```
	 * tail > BROADCAST_RESUME_GRACE_SEC → 读设备把真数据拿回来（用户连接期间戴着设备，
	 *                                    那几十秒在 flash 里真实存在，放弃就等于永久丢掉）
	 * tail <= BROADCAST_RESUME_GRACE_SEC → 不读。1~2 页的读取要额外几秒 GATT 占用，
	 *                                    那几秒又在制造新空洞，而它买来的只是「B 到位」，
	 *                                    9.4 的广播接续判定在同样的小空洞上能免费给出同样结果
	 * ```
	 *
	 * 右端按**断开时刻**重算，不取开始时的值：补录期间时间在走，断开时算出的
	 * `stableCeiling` 比开始时大得多。`anchor` 取断开时刻的原始秒、不对齐（8.1）。
	 */
	private async readConnectionTailHoleBeforeDisconnect(): Promise<void> {
		const holeFrom = this.device.connection.getConnectionHoleFrom();
		if (holeFrom <= 0) return;
		if (this.device.boundDeviceId == "") return;
		const disconnectAt = Math.floor(Date.now() / 1000);
		const tail = disconnectAt - holeFrom;
		const grace = getHistoryTunables().broadcastResumeGraceSec;
		if (tail <= grace) {
			// 小空洞：B 停在这里，整段交给 9.4 的广播接续判定。
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 连接尾巴: holeFrom=${holeFrom}, disconnectAt=${disconnectAt}, tail=${tail}s, 宽限=${grace}s, 决策=交给广播接续`
			);
			return;
		}
		try {
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 连接尾巴: holeFrom=${holeFrom}, disconnectAt=${disconnectAt}, tail=${tail}s, 宽限=${grace}s, 决策=读设备`
			);
			const result = await this.device.history.readVitalTailHole(holeFrom, disconnectAt);
			const baseline = await historyBaseline.advanceBaseline(disconnectAt);
			// 空洞被这次补读闭环了就清标记——`clearConnectionHole()` 写明了两个闭环条件，
			// 「已读设备补回」就是这一条。不清的话，只要广播恢复时的 `gap > 宽限`
			// （`markBroadcastResume()` 返回 -1、`tryBroadcastResume()` 提前返回），标记
			// 就会一直挂着；而 `markConnectionHoleStart()` 不覆盖已有值，于是**下一次连接
			// 沿用这个更早的 `holeFrom`**，算出大得多的 tail，把设备里已经读过的秒再读一遍，
			// 且每轮连接都更长一点。
			//
			// 判据用 `B` 的位置而不是 `status`：只有 `B` 推到 `stableCeiling` 才说明整段
			// 都记了账。补读只拿回一部分时 `B` 停在中间，**必须留着标记**——那时 `B` 仍在
			// 空洞里，下一次连接从原始 `holeFrom` 重读才是对的（`gap > 宽限` 时 9.4 的
			// 接续判定帮不上忙，它只覆盖宽限以内的空洞）。
			if (baseline >= historyBaseline.stableCeiling(disconnectAt)) {
				this.device.connection.clearConnectionHole();
			}
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 连接尾巴补读完成: status=${result.status}, pages=${result.pages}, 落库=${result.savedRecords}, saveOk=${result.saveOk}, B=${baseline}`
			);
		} catch (e) {
			// 补读失败不回退 flush：缺口仍在，下一次连接至少 10 分钟后才来（9.7），
			// 天然退避；这段秒也还有 9.4 的接续判定兜底。
			logger.warn("bluetooth", "[BOOM-ADV] 连接尾巴补读异常:", e);
		}
	}

	private async runTask(task: GattQueueTask): Promise<void> {
		logger.info(
			"bluetooth",
			`[BOOM-SCHED] 执行任务: seq=${task.seq}, key=${task.key}, kind=${task.kind}`
		);
		this.runningTask = task;
		try {
			if (task.kind == "timeSync") {
				await this.runTimeSync(task);
				return;
			}
			if (task.kind == "readEvent") {
				await this.runReadEvent(task);
				return;
			}
			if (task.kind == "historyRepair") {
				await this.runHistoryRepair(task);
				return;
			}
			if (task.kind == "manualCommand") {
				await this.runManualCommand(task);
				return;
			}
			logger.info("bluetooth", `[BOOM-SCHED] 任务类型暂未接入执行器: ${task.kind}`);
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
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播时间偏差过大，自动校时: diff=${task.diffSec}s, advUtc=${task.broadcastUtc}`
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
			ok = await this.waitForTimestampResponse(beforeSeq, TIMESTAMP_VERIFY_TIMEOUT_MS);
			if (ok == true) {
				logger.info("bluetooth", `[BOOM-ADV] 自动校时完成: utc=${nowSec}`);
				this.device.broadcast.markTimeSyncOk();
			} else {
				logger.warn("bluetooth", "[BOOM-ADV] 自动校时读回超时");
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
		const endSec = Math.floor(Date.now() / 1000) + 60;
		const startSec = endSec - EVENT_SYNC_WINDOW_SECONDS;
		logger.info(
			"bluetooth",
			`[BOOM-EVENT] 开始读取${isBackfill ? "事件兜底" : "新事件"}: device=${task.deviceId}, eventSeq=${task.eventSeq}, window=${startSec}~${endSec}, maxCount=${EVENT_SYNC_MAX_COUNT}`
		);
		const result = await this.device.history.readEventDataAuto({
			type: EVENT_QUERY_TYPE_BY_TIME,
			startSec,
			endSec,
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
		// 读事件期间停广播留下的秒级空洞不在这里补：交给下一轮自动历史检查，
		// 由 recent / incremental 任务按统一记账补回，避免第二条绕过任务表的写入路径。
	}

	private async runHistoryRepair(task: GattQueueTask): Promise<HistoryRepairResult | null> {
		// 缺口不截断、连接不设时长：一轮把 `listRepairGaps()` 的缺口全部读完。
		const result = await this.device.sync.repairVitalHistoryGapsInCurrentConnection(
			task.historyReason
		);
		if (result.ok == false && result.message == "history repair busy") {
			this.requeueTask(task);
			this.pauseCurrentFlush = true;
		}
		return result;
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

	private async waitForTimestampResponse(beforeSeq: number, timeoutMs: number): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.device.event.boomTimestampSeqValue > beforeSeq) {
				return true;
			}
			await sleepTimeout(120);
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
