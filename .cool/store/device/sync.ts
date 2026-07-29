import { ref } from "vue";
import { bluetoothDataManager } from "../../bluetooth/data-manager";
import type { VitalDataQueryResponse, VitalHistoryGapCheck } from "../../bluetooth";
import { sleepTimeout } from "../../utils";
import type { VitalAutoReadResult, HistoryReadStatus } from "./history-reader";
import type { Device } from "./index";
import { logger } from "../../service/logger";

export type DeviceSyncReason = "startup" | "timer" | "manual";

export type DeviceSyncState = "idle" | "planning" | "repairing";

/** 本地 `ppi_data` 中推导出的生命体征缺口，单位为 UTC 秒。 */
export type HistoryGap = {
	fromSec: number;
	toSec: number;
};

/** 一次缺口扫描的规划结果；这里只做规划，不直接触碰 GATT。 */
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
	uploadAttempted: boolean;
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
/** 后台低频检查间隔。只做本地 gap scan；有缺口就投递 scheduler 队列。 */
const HISTORY_AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** 事件数据低频兜底：只入队，不在 sync 里直接连接读取。 */
const EVENT_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;

/** 每次只扫描最近 24 小时的本地 PPI 时间点，避免全库 gap scan 太重。 */
const VITAL_SCAN_WINDOW_SEC = 24 * 60 * 60;
/** 本地完全没有 PPI 时，首次最多回补最近 6 小时，不盲读设备全部历史。 */
const VITAL_INITIAL_WINDOW_SEC = 6 * 60 * 60;
/** 相邻 PPI 时间点间隔超过 180 秒，就认为中间有缺口。 */
const VITAL_GAP_THRESHOLD_SEC = 180;
/** 补缺口时向前后各扩 2 分钟；入库 INSERT OR IGNORE，可安全重叠读取。 */
const VITAL_GAP_OVERLAP_SEC = 2 * 60;
/** 已经有可靠响应的补拉窗口，6 小时内不重复补，避免无效/稀疏时段反复连接。 */
const VITAL_CHECKED_GAP_SUPPRESS_MS = 6 * 60 * 60 * 1000;

/**
 * 设备后台历史同步。
 *
 * 这里负责生命体征 0x3A/0x3B 低频兜底：
 * - 启动后延迟检查一次；
 * - 之后低频扫描 ppi_data 缺口；
 * - 有缺口投递 historyRepair；
 * - 每 30 分钟投递一次事件兜底读取；
 * - 实际连接和执行由 DeviceGattScheduler 统一负责。
 */
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
		try {
			// 启动后先让 0x50 广播有机会落库，否则刚启动会把最近一段误判为缺口。
			await sleepTimeout(HISTORY_AUTO_INITIAL_DELAY_MS);
			if (this.isAutoGenerationActive(generation) == false) return;
			await this.runAutoRepair("startup");
			while (this.isAutoGenerationActive(generation) == true) {
				await sleepTimeout(HISTORY_AUTO_CHECK_INTERVAL_MS);
				if (this.isAutoGenerationActive(generation) == false) return;
				await this.runAutoRepair("timer");
			}
		} catch (e) {
			this.lastError.value = `${e}`;
			logger.error("bluetooth", "[BOOM-SYNC] 自动生命体征补缺循环异常", `${e}`);
		}
	}

	private isAutoGenerationActive(generation: number): boolean {
		return this.autoEnabled == true && this.autoGeneration == generation;
	}

	private async runAutoRepair(reason: DeviceSyncReason): Promise<void> {
		if (this.autoEnabled == false) return;
		// 历史和事件都只入队；真正连接、串行执行、断开恢复广播都交给 scheduler。
		await this.requestHistorySync(reason);
		this.requestEventBackfillIfNeeded(reason);
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
					(item.status == "TIMEOUT" || item.status == "SEND_FAILED")
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
		const scanStartSec = nowSec - VITAL_SCAN_WINDOW_SEC;
		const timestamps = await bluetoothDataManager.getPpiTimestampsBetween(scanStartSec, nowSec);
		if (timestamps.length == 0) {
			// 首次或清库后没有锚点，只补最近 6 小时，避免一上来追设备全部历史。
			return this.normalizeGaps(
				[
					{
						fromSec: nowSec - VITAL_INITIAL_WINDOW_SEC,
						toSec: nowSec
					} as HistoryGap
				],
				nowSec
			);
		}

		const rawGaps: HistoryGap[] = [];
		// 补扫描窗口开头到第一条本地数据之间的缺口。
		const first = timestamps[0];
		if (first - scanStartSec > VITAL_GAP_THRESHOLD_SEC) {
			rawGaps.push({ fromSec: scanStartSec, toSec: first - 1 } as HistoryGap);
		}
		// 补两条本地数据之间超过阈值的断档。
		for (let i = 1; i < timestamps.length; i++) {
			const prev = timestamps[i - 1];
			const next = timestamps[i];
			if (next - prev > VITAL_GAP_THRESHOLD_SEC) {
				rawGaps.push({ fromSec: prev + 1, toSec: next - 1 } as HistoryGap);
			}
		}
		// 补最后一条本地数据到当前时间之间的缺口。
		const last = timestamps[timestamps.length - 1];
		if (nowSec - last > VITAL_GAP_THRESHOLD_SEC) {
			rawGaps.push({ fromSec: last + 1, toSec: nowSec } as HistoryGap);
		}

		return await this.suppressRecentlyCheckedGaps(this.normalizeGaps(rawGaps, nowSec));
	}

	private normalizeGaps(rawGaps: HistoryGap[], nowSec: number): HistoryGap[] {
		const normalized: HistoryGap[] = [];
		const startLimit = nowSec - VITAL_SCAN_WINDOW_SEC;
		for (let i = 0; i < rawGaps.length; i++) {
			// overlap 让边界秒和设备返回窗口有少量重叠；落库用 INSERT OR IGNORE 去重。
			const g = this.withOverlap(rawGaps[i]);
			let fromSec = g.fromSec;
			let toSec = g.toSec;
			if (fromSec < startLimit) fromSec = startLimit;
			if (toSec > nowSec) toSec = nowSec;
			if (toSec <= fromSec) continue;
			normalized.push({ fromSec, toSec } as HistoryGap);
		}

		const recentFirst: HistoryGap[] = [];
		// 最近缺口优先，更容易补到用户当前关心的数据，也更接近设备历史末端。
		for (let i = normalized.length - 1; i >= 0; i--) {
			recentFirst.push(normalized[i]);
		}
		return recentFirst;
	}

	private withOverlap(gap: HistoryGap): HistoryGap {
		return {
			fromSec: gap.fromSec - VITAL_GAP_OVERLAP_SEC,
			toSec: gap.toSec + VITAL_GAP_OVERLAP_SEC
		} as HistoryGap;
	}

	private async suppressRecentlyCheckedGaps(gaps: HistoryGap[]): Promise<HistoryGap[]> {
		if (gaps.length == 0) return gaps;
		let minSec = gaps[0].fromSec;
		let maxSec = gaps[0].toSec;
		for (let i = 1; i < gaps.length; i++) {
			if (gaps[i].fromSec < minSec) minSec = gaps[i].fromSec;
			if (gaps[i].toSec > maxSec) maxSec = gaps[i].toSec;
		}
		const minCheckedAt = Date.now() - VITAL_CHECKED_GAP_SUPPRESS_MS;
		const checks = await bluetoothDataManager.getVitalHistoryGapChecksBetween(
			minSec,
			maxSec,
			minCheckedAt
		);
		if (checks.length == 0) return gaps;

		// 临时表中的窗口表示“设备已经响应过这段”，无论保存 0 条还是多条都不重复补。
		const suppressed: HistoryGap[] = [];
		for (let i = 0; i < gaps.length; i++) {
			this.appendGapMinusCheckedWindows(suppressed, gaps[i], checks);
		}
		logger.info(
			"bluetooth",
			`[BOOM-SYNC] 跳过近期已补拉确认的历史窗口: before=${gaps.length}, after=${suppressed.length}, checks=${checks.length}`
		);
		return suppressed;
	}

	private appendGapMinusCheckedWindows(
		output: HistoryGap[],
		gap: HistoryGap,
		checks: VitalHistoryGapCheck[]
	): void {
		// 一个 gap 可能被多个已检查窗口切开，逐个扣减后保留剩余未确认段。
		let segments: HistoryGap[] = [gap];
		for (let i = 0; i < checks.length; i++) {
			const next: HistoryGap[] = [];
			for (let j = 0; j < segments.length; j++) {
				this.appendSegmentMinusCheck(next, segments[j], checks[i]);
			}
			segments = next;
			if (segments.length == 0) break;
		}
		for (let i = 0; i < segments.length; i++) {
			if (segments[i].toSec > segments[i].fromSec) output.push(segments[i]);
		}
	}

	private appendSegmentMinusCheck(
		output: HistoryGap[],
		gap: HistoryGap,
		check: VitalHistoryGapCheck
	): void {
		if (check.toSec <= gap.fromSec || check.fromSec >= gap.toSec) {
			output.push(gap);
			return;
		}
		if (check.fromSec > gap.fromSec) {
			output.push({
				fromSec: gap.fromSec,
				toSec: Math.min(check.fromSec, gap.toSec)
			} as HistoryGap);
		}
		if (check.toSec < gap.toSec) {
			output.push({
				fromSec: Math.max(check.toSec, gap.fromSec),
				toSec: gap.toSec
			} as HistoryGap);
		}
	}

	private async runVitalGaps(
		gaps: HistoryGap[],
		deadlineAt: number
	): Promise<HistoryGapRepairResult[]> {
		const results: HistoryGapRepairResult[] = [];
		// 如果设备返回的历史已经早于目标，说明更晚的缺口继续问也没有意义。
		let deviceHistoryUpperBoundSec = 0;
		for (let i = 0; i < gaps.length; i++) {
			if (Date.now() >= deadlineAt) {
				results.push(this.makeGapBudgetReached(gaps[i]));
				break;
			}
			let gap = gaps[i];
			if (deviceHistoryUpperBoundSec > 0) {
				if (gap.fromSec >= deviceHistoryUpperBoundSec) {
					results.push(this.makeGapSkipped(gap, deviceHistoryUpperBoundSec));
					continue;
				}
				if (gap.toSec > deviceHistoryUpperBoundSec) {
					gap = {
						fromSec: gap.fromSec,
						toSec: deviceHistoryUpperBoundSec
					} as HistoryGap;
				}
				if (gap.toSec <= gap.fromSec) {
					results.push(this.makeGapSkipped(gap, deviceHistoryUpperBoundSec));
					continue;
				}
			}

			const result: VitalAutoReadResult = await this.device.history.readVitalWindow(
				gap.fromSec,
				gap.toSec
			);
			await this.rememberGapCheckIfReliable(gap, result);
			results.push(this.makeGapResult(gap, result));

			const upper = this.getVitalResultUpperBoundSec(result);
			if (upper > 0 && upper < gap.fromSec) {
				deviceHistoryUpperBoundSec = upper;
				logger.info(
					"bluetooth",
					`[BOOM-SYNC] 设备生命体征历史早于目标，收紧后续缺口: upper=${upper}, gapStart=${gap.fromSec}`
				);
			}
		}
		return results;
	}

	private async rememberGapCheckIfReliable(
		gap: HistoryGap,
		result: VitalAutoReadResult
	): Promise<void> {
		// 超时和发送失败属于通信失败，不能证明设备这段没有数据，所以不写检查记录。
		if (result.status == "TIMEOUT" || result.status == "SEND_FAILED") return;
		if (result.pages <= 0) return;
		await bluetoothDataManager.storeVitalHistoryGapCheck(
			gap.fromSec,
			gap.toSec,
			result.status,
			result.pages,
			result.savedRecords,
			result.message
		);
	}

	private getVitalResultUpperBoundSec(result: VitalAutoReadResult): number {
		let upper = 0;
		for (let i = 0; i < result.responses.length; i++) {
			const r: VitalDataQueryResponse = result.responses[i];
			if (r.startSec <= 0) continue;
			const minutes = r.n > 0 ? r.n : 5;
			const endSec = r.startSec + minutes * 60;
			if (endSec > upper) {
				upper = endSec;
			}
		}
		return upper;
	}

	private makeGapResult(gap: HistoryGap, result: VitalAutoReadResult): HistoryGapRepairResult {
		return {
			gap,
			status: result.status,
			message: result.message,
			pages: result.pages,
			savedRecords: result.savedRecords,
			uploadAttempted: result.uploadAttempted,
			uploadOk: result.uploadOk,
			skipped: false
		} as HistoryGapRepairResult;
	}

	private makeGapSkipped(gap: HistoryGap, upper: number): HistoryGapRepairResult {
		return {
			gap,
			status: "STOPPED",
			message: "skip newer gap by device history upper bound " + upper.toString(),
			pages: 0,
			savedRecords: 0,
			uploadAttempted: false,
			uploadOk: false,
			skipped: true
		} as HistoryGapRepairResult;
	}

	private makeGapBudgetReached(gap: HistoryGap): HistoryGapRepairResult {
		return {
			gap,
			status: "STOPPED",
			message: "history repair budget reached",
			pages: 0,
			savedRecords: 0,
			uploadAttempted: false,
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
