import { EVENT_QUERY_TYPE_BY_TIME } from "../../bluetooth";
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
const GATT_FLUSH_BUDGET_MS = 90 * 1000;
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
		if (this.hasTaskKind("readEvent") == true) return false;
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

	private hasTaskKind(kind: GattQueueTaskKind): boolean {
		if (this.isTaskRunning(kind) == true) return true;
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
			while (this.tasks.length > 0) {
				const task = this.takeNextTask();
				if (task == null) break;
				await this.runTask(task, startedAt);
				if (this.pauseCurrentFlush == true) {
					logger.info("bluetooth", "[BOOM-SCHED] GATT 通道忙，暂停本轮执行");
					break;
				}
				if (Date.now() - startedAt >= GATT_FLUSH_BUDGET_MS) {
					logger.warn("bluetooth", "[BOOM-SCHED] 本轮执行到达时间预算，剩余任务下轮继续");
					break;
				}
			}
			shouldContinueFlush = this.tasks.length > 0 && this.pendingFlushReason != "";
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-SCHED] 队列执行异常:", e);
		} finally {
			if (connected == true) {
				if (this.shouldRestoreBroadcast() == true) {
					try {
						await this.device.connection.switchToBroadcastMode(false);
					} catch (e) {
						logger.warn("bluetooth", "[BOOM-SCHED] 恢复广播失败:", e);
					}
				} else {
					try {
						await this.device.connection.disconnectDevice(false);
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
			}
		}
	}

	private takeNextTask(): GattQueueTask | null {
		if (this.tasks.length == 0) return null;
		let index = 0;
		let score = this.getTaskSortScore(this.tasks[0]);
		for (let i = 1; i < this.tasks.length; i++) {
			const itemScore = this.getTaskSortScore(this.tasks[i]);
			if (itemScore < score) {
				index = i;
				score = itemScore;
			}
		}
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

	private async runTask(task: GattQueueTask, startedAt: number): Promise<void> {
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
				await this.runHistoryRepair(task, startedAt);
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
		// 读事件期间没有广播，结束后顺手补最近生命体征，填上处理事件时漏掉的 0x50。
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
			`[BOOM-EVENT] 新事件读取完成: status=${result.status}, pages=${result.pages}, items=${result.items.length}, savedSleep=${result.savedSleepRecords}, upload=${result.uploadOk}`
		);
		if (result.items.length > 0) {
			logger.info(
				"bluetooth",
				`[BOOM-EVENT] 新事件解析结果:\n${this.device.history.formatEventAutoBrief(result.items, 20)}`
			);
		}
		const vital = await this.device.history.readRecentVitalWindow();
		logger.info(
			"bluetooth",
			`[BOOM-HISTORY] 事件后补最近2分钟: status=${vital.status}, pages=${vital.pages}, saved=${vital.savedRecords}, upload=${vital.uploadOk}`
		);
	}

	private async runHistoryRepair(
		task: GattQueueTask,
		startedAt: number
	): Promise<HistoryRepairResult | null> {
		const deadlineAt = startedAt + GATT_FLUSH_BUDGET_MS;
		// gap 数量不强行截断，但每轮连接有时间预算，超时后剩余 gap 下轮继续。
		const result = await this.device.sync.repairVitalHistoryGapsInCurrentConnection(
			task.historyReason,
			deadlineAt
		);
		if (
			result.ok == false &&
			(result.message == "history repair budget reached" ||
				result.message == "history repair busy")
		) {
			this.requeueTask(task);
			if (result.message == "history repair busy") this.pauseCurrentFlush = true;
		}
		return result;
	}

	private requeueTask(task: GattQueueTask): void {
		this.upsertTask(task);
		logger.info("bluetooth", `[BOOM-SCHED] 任务回队: seq=${task.seq}, key=${task.key}`);
	}

	private async runManualCommand(task: GattQueueTask): Promise<void> {
		let ok = false;
		try {
			logger.info("bluetooth", `[BOOM-SCHED] 执行手动 GATT 任务: ${task.manualName}`);
			const runner = task.manualRunner;
			if (runner != null) ok = await runner();
		} catch (e) {
			logger.warn("bluetooth", `[BOOM-SCHED] 手动 GATT 任务异常: ${task.manualName}`, e);
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
