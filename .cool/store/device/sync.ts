import { historyProgress } from "../../bluetooth/history-progress";
import type { HistoryTask } from "../../bluetooth/history-progress";
import { ref } from "vue";
import { sleepTimeout } from "../../utils";
import type { VitalAutoReadResult, HistoryReadStatus } from "./history-reader";
import type { Device } from "./index";
import { logger } from "../../service/logger";

export type DeviceSyncReason = "startup" | "timer" | "manual";

export type DeviceSyncState = "idle" | "planning" | "repairing";

/** 持久化设备历史任务，不从有效点密度推断缺口。 */
export type HistoryGap = HistoryTask;

/** 一次历史任务的规划结果；这里只做规划，不直接触碰 GATT。 */
export type HistorySyncPlan = {
	needed: boolean;
	gaps: HistoryGap[];
};

/** 单段缺口在一次 GATT 连接中的补拉结果。 */
export type HistoryGapRepairResult = {
	gap: HistoryGap;
	status: HistoryReadStatus;
	message: string;
	pages: number;
	savedRecords: number;
	saveOk: boolean;
	uploadAttempted: boolean;
	uploadScheduled: boolean;
	uploadOk: boolean;
	skipped: boolean;
};

export type HistoryRepairResult = {
	ok: boolean;
	message: string;
	plan: HistorySyncPlan;
	results: HistoryGapRepairResult[];
	savedRecords: number;
};

/** App 启动/绑定恢复后稍等一会儿，让广播先稳定入库，再检查缺口。 */
const HISTORY_AUTO_INITIAL_DELAY_MS = 15000;
/** 后台低频检查间隔。只规划本次 App 会话任务；有到期任务就投递 scheduler 队列。 */
const HISTORY_AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** 事件数据低频兜底：只入队，不在 sync 里直接连接读取。 */
const EVENT_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;

export class DeviceSync {
	/** 给页面/测试工具展示当前后台同步阶段，不作为业务锁。 */
	state = ref<DeviceSyncState>("idle");
	lastError = ref<string>("");
	lastPlan = ref<HistorySyncPlan | null>(null);
	lastCheckAt = ref<number>(0);
	lastHistorySyncAt = ref<number>(0);
	lastEventBackfillAt = ref<number>(0);

	private device: Device;
	/** 防止同一个 DeviceSync 在同一条 GATT 连接里被重复进入。 */
	private busy: boolean = false;
	private autoEnabled: boolean = false;
	/** 用 generation 让 stop 后旧的 async loop 自然失效，避免 UTS timer 取消差异。 */
	private autoGeneration: number = 0;

	constructor(device: Device) {
		this.device = device;
	}

	startAutoRepair(): void {
		if (this.autoEnabled == true) return;
		this.autoEnabled = true;
		this.autoGeneration = this.autoGeneration + 1;
		const generation = this.autoGeneration;
		this.runAutoLoop(generation);
		logger.info("bluetooth", "[BOOM-SYNC] 已启动生命体征历史缺口自动检查");
	}

	stopAutoRepair(): void {
		if (this.autoEnabled == false) return;
		this.autoEnabled = false;
		this.autoGeneration = this.autoGeneration + 1;
		logger.info("bluetooth", "[BOOM-SYNC] 已停止生命体征历史缺口自动检查");
	}

	stop(): void {
		this.stopAutoRepair();
	}

	private async runAutoLoop(generation: number): Promise<void> {
		let reason: DeviceSyncReason = "startup";
		let delayMs = HISTORY_AUTO_INITIAL_DELAY_MS;
		while (this.isAutoGenerationActive(generation) == true) {
			await sleepTimeout(delayMs);
			if (this.isAutoGenerationActive(generation) == false) return;
			try {
				await this.runAutoRepair(reason);
			} catch (e) {
				this.lastError.value = `${e}`;
				logger.error("bluetooth", "[BOOM-SYNC] 本轮自动补缺异常，下轮继续", `${e}`);
			}
			reason = "timer";
			delayMs = HISTORY_AUTO_CHECK_INTERVAL_MS;
		}
	}

	private isAutoGenerationActive(generation: number): boolean {
		return this.autoEnabled == true && this.autoGeneration == generation;
	}

	private async runAutoRepair(reason: DeviceSyncReason): Promise<void> {
		if (this.autoEnabled == false) return;
		// 历史和事件都只入队；真正连接、串行执行、断开恢复广播都交给 scheduler。
		try {
			await this.requestHistorySync(reason);
		} finally {
			if (this.autoEnabled == true) this.requestEventBackfillIfNeeded(reason);
		}
	}

	async planHistorySync(): Promise<HistorySyncPlan> {
		this.state.value = "planning";
		try {
			const nowSec = Math.floor(Date.now() / 1000);
			const vitalGaps = await this.planVitalGaps(nowSec);
			const plan: HistorySyncPlan = {
				needed: vitalGaps.length > 0,
				gaps: vitalGaps
			} as HistorySyncPlan;
			this.lastPlan.value = plan;
			this.lastCheckAt.value = Date.now();
			this.lastError.value = "";
			return plan;
		} catch (e) {
			this.lastError.value = `${e}`;
			throw e;
		} finally {
			this.state.value = "idle";
		}
	}

	async requestHistorySync(reason: DeviceSyncReason): Promise<boolean> {
		if (this.autoEnabled == false && reason != "manual") return false;
		const plan = await this.planHistorySync();
		if (this.autoEnabled == false && reason != "manual") return false;
		if (plan.needed == false) {
			logger.info("bluetooth", `[BOOM-SYNC] 无生命体征历史缺口: reason=${reason}`);
			return true;
		}
		logger.info(
			"bluetooth",
			`[BOOM-SYNC] 已规划生命体征历史缺口: reason=${reason}, gaps=${plan.gaps.length}`
		);
		this.device.scheduler.enqueueHistoryRepair(reason);
		this.requestSchedulerFlush(reason);
		return true;
	}

	private requestSchedulerFlush(reason: DeviceSyncReason): void {
		// 保留触发来源，方便 scheduler 日志区分启动、定时和用户手动触发。
		if (reason == "startup") {
			this.device.scheduler.requestFlush("startup");
		} else if (reason == "manual") {
			this.device.scheduler.requestFlush("manual");
		} else {
			this.device.scheduler.requestFlush("timer");
		}
	}

	private requestEventBackfillIfNeeded(reason: DeviceSyncReason): boolean {
		if (this.device.boundDeviceId == "") return false;
		const now = Date.now();
		// 事件兜底是“低频保险”：广播 eventSeq 变化仍会走加急读取。
		if (
			reason != "manual" &&
			now - this.lastEventBackfillAt.value < EVENT_BACKFILL_INTERVAL_MS
		) {
			return false;
		}
		const queued = this.device.scheduler.enqueueEventBackfill(
			this.device.boundDeviceId,
			reason
		);
		if (queued == true) {
			this.lastEventBackfillAt.value = now;
			logger.info("bluetooth", `[BOOM-SYNC] 已入队事件兜底读取: reason=${reason}`);
			this.requestSchedulerFlush(reason);
		}
		return queued;
	}

	async repairVitalHistoryGapsInCurrentConnection(
		reason: DeviceSyncReason,
		deadlineAt: number
	): Promise<HistoryRepairResult> {
		if (this.busy == true) {
			this.lastError.value = "history repair busy";
			return this.makeResult(false, this.lastError.value, this.emptyPlan(), []);
		}
		if (this.device.boundDeviceId == "") {
			this.lastError.value = "no bound device";
			return this.makeResult(false, this.lastError.value, this.emptyPlan(), []);
		}

		this.busy = true;
		this.state.value = "repairing";
		this.lastError.value = "";
		try {
			// 执行前重新规划一次，避免队列等待期间广播已经把 gap 补上。
			const plan = await this.planHistorySync();
			this.state.value = "repairing";
			this.lastPlan.value = plan;
			if (plan.needed == false) {
				this.lastError.value = "no history gaps";
				return this.makeResult(true, "no history gaps", plan, []);
			}

			if (this.device.currentDeviceId == "" || this.device.status.value != "CONNECTED") {
				this.lastError.value = "connect failed";
				return this.makeResult(false, this.lastError.value, plan, []);
			}

			logger.info(
				"bluetooth",
				"[BOOM-SYNC] 开始补生命体征历史",
				`reason=${reason}, gaps=${plan.gaps.length}`
			);
			const results = await this.runVitalGaps(plan.gaps, deadlineAt);
			let ok = true;
			for (let i = 0; i < results.length; i++) {
				const item = results[i];
				if (item.message == "history repair budget reached") {
					this.lastError.value = "history repair budget reached";
					ok = false;
					continue;
				}
				if (
					item.skipped == false &&
					(item.status == "TIMEOUT" ||
						item.status == "SEND_FAILED" ||
						item.saveOk == false)
				) {
					ok = false;
				}
			}
			this.lastHistorySyncAt.value = Date.now();
			if (ok == false && this.lastError.value == "") {
				this.lastError.value = "history partial failed";
			}
			return this.makeResult(
				ok,
				ok ? "history repair done" : this.lastError.value,
				plan,
				results
			);
		} catch (e) {
			this.lastError.value = `${e}`;
			return this.makeResult(false, `${e}`, this.lastPlan.value ?? this.emptyPlan(), []);
		} finally {
			this.state.value = "idle";
			this.busy = false;
		}
	}

	private async planVitalGaps(nowSec: number): Promise<HistoryGap[]> {
		return await historyProgress.plan(this.device.boundDeviceId, nowSec);
	}

	private async runVitalGaps(
		gaps: HistoryGap[],
		deadlineAt: number
	): Promise<HistoryGapRepairResult[]> {
		const results: HistoryGapRepairResult[] = [];
		for (let i = 0; i < gaps.length; i++) {
			if (Date.now() + 8000 >= deadlineAt) {
				results.push(this.makeGapBudgetReached(gaps[i]));
				break;
			}
			const gap = gaps[i];
			if (this.device.boundDeviceId != gap.deviceId) break;
			const result = await this.device.history.readVitalWindow(
				gap.fromSec,
				gap.toSec,
				gap,
				deadlineAt
			);
			results.push(this.makeGapResult(gap, result));
			if (
				result.message == "history repair budget reached" ||
				result.status == "TIMEOUT" ||
				result.status == "SEND_FAILED" ||
				!result.saveOk
			)
				break;
		}
		return results;
	}

	private makeGapResult(gap: HistoryGap, result: VitalAutoReadResult): HistoryGapRepairResult {
		return {
			gap,
			status: result.status,
			message: result.message,
			pages: result.pages,
			savedRecords: result.savedRecords,
			saveOk: result.saveOk,
			uploadAttempted: result.uploadAttempted,
			uploadScheduled: result.uploadScheduled,
			uploadOk: result.uploadOk,
			skipped: false
		} as HistoryGapRepairResult;
	}

	private makeGapBudgetReached(gap: HistoryGap): HistoryGapRepairResult {
		return {
			gap,
			status: "STOPPED",
			message: "history repair budget reached",
			pages: 0,
			savedRecords: 0,
			saveOk: true,
			uploadAttempted: false,
			uploadScheduled: false,
			uploadOk: false,
			skipped: true
		} as HistoryGapRepairResult;
	}

	private emptyPlan(): HistorySyncPlan {
		return {
			needed: false,
			gaps: []
		} as HistorySyncPlan;
	}

	private makeResult(
		ok: boolean,
		message: string,
		plan: HistorySyncPlan,
		results: HistoryGapRepairResult[]
	): HistoryRepairResult {
		let saved = 0;
		for (let i = 0; i < results.length; i++) {
			saved = saved + results[i].savedRecords;
		}
		return {
			ok,
			message,
			plan,
			results,
			savedRecords: saved
		} as HistoryRepairResult;
	}
}
