import { historyBaseline } from "../../bluetooth/history/baseline";
import type { HistoryGap } from "../../bluetooth/history/baseline";
import { ref } from "vue";
import { sleepTimeout } from "../../utils";
import type { VitalAutoReadResult, HistoryReadStatus } from "./history-reader";
import type { Device } from "./index";
import { logger } from "../../service/logger";

export type DeviceSyncReason = "startup" | "timer" | "manual";

export type DeviceSyncState = "idle" | "planning" | "repairing";

/** 一次补录规划的结果：分类推进后的缺口快照。这里只做规划，不直接触碰 GATT。 */
export type HistorySyncPlan = {
	needed: boolean;
	gaps: HistoryGap[];
	baseline: number;
	ceiling: number;
	totalRepairSeconds: number;
};

/** 单个缺口在一次 GATT 连接中的补拉结果。 */
export type HistoryGapRepairResult = {
	gap: HistoryGap;
	status: HistoryReadStatus;
	message: string;
	pages: number;
	savedRecords: number;
	saveOk: boolean;
	uploadScheduled: boolean;
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
/** 后台低频检查间隔。连接一旦发生就要掐掉广播，所以间隔是这个量级而不是更短。 */
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
	/** 分钟边界基准推进的串行标志：分类 + 推进是一对，不能和上一轮交错。 */
	private boundaryBusy: boolean = false;

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
		logger.info("bluetooth", "[BOOM-SYNC] 已启动基准时间自动检查");
	}

	stopAutoRepair(): void {
		if (this.autoEnabled == false) return;
		this.autoEnabled = false;
		this.autoGeneration = this.autoGeneration + 1;
		logger.info("bluetooth", "[BOOM-SYNC] 已停止基准时间自动检查");
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
				logger.error("bluetooth", "[BOOM-SYNC] 本轮自动检查异常，下轮继续", `${e}`);
			}
			reason = "timer";
			// 取消连接时长上限后一轮就把缺口补完，不再需要「积压时缩短间隔」的双档设计。
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

	/**
	 * 规划 = 分类 + 推进基准 + 列出缺口。
	 *
	 * 分类是幂等的纯本地计算，所以每轮都从 `B` 走一遍没有副作用；`B` 因此永远
	 * 贴着 `stableCeiling`，不需要「已分类游标」这种额外状态。
	 */
	async planHistorySync(): Promise<HistorySyncPlan> {
		this.state.value = "planning";
		try {
			const nowSec = Math.floor(Date.now() / 1000);
			await historyBaseline.classify(nowSec);
			const baseline = await historyBaseline.advanceBaseline(nowSec);
			const gaps = await historyBaseline.listRepairGaps(nowSec);
			const plan: HistorySyncPlan = {
				needed: gaps.length > 0,
				gaps,
				baseline,
				ceiling: historyBaseline.stableCeiling(nowSec),
				totalRepairSeconds: historyBaseline.sumRepairSeconds(gaps)
			} as HistorySyncPlan;
			this.lastPlan.value = plan;
			this.lastCheckAt.value = Date.now();
			this.lastError.value = "";
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 刻度: now=${nowSec}, stableCeiling=${plan.ceiling}, B=${baseline}`
			);
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
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 基准停驻: B=${plan.baseline}, 缺口组=0, 缺口秒=0, reason=${reason}`
			);
			return false;
		}
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准停驻: B=${plan.baseline}, 阻塞起点=${plan.gaps[0].fromSec}, 缺口组=${plan.gaps.length}, 缺口秒=${plan.totalRepairSeconds}, reason=${reason}`
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

	/**
	 * 广播 `utc` 跨过整分钟时调用：这是基准推进的**正常路径**（5.5 的调用时机 1）。
	 *
	 * 判据用设备时钟的分钟边界（`broadcast.ts` 用 `utc` 切）而不是手机时钟：分钟边界
	 * 属于设备的数据时间轴，两者偏差由校时链路处理，不在这里再用手机时钟切一刀。
	 *
	 * 分类 + 推进是一个整体，缺一不可：分类把本轮新稳定的秒写进 `vital_ready_ranges`，
	 * `advanceBaseline()` 再把这个区间消费掉、`B` 才真的前进。广播在线时这一步每次都在
	 * 追，`B` 因此贴着 `stableCeiling ≈ now - 10s`，不累积。
	 */
	async onMinuteBoundary(minuteSec: number): Promise<void> {
		if (this.device.boundDeviceId == "") return;
		if (this.boundaryBusy == true) return;
		this.boundaryBusy = true;
		try {
			const nowSec = Math.floor(Date.now() / 1000);
			const classified = await historyBaseline.classify(nowSec);
			const baseline = await historyBaseline.advanceBaseline(nowSec);
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 分钟边界: minute=${minuteSec}, 未记账=${classified.unclassifiedSeconds}s, 新记账=${classified.qualifiedSeconds}s, 不合格段=${classified.unqualifiedSegments}, B=${baseline}, stableCeiling=${classified.ceiling}`
			);
			this.lastPlan.value = null;
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-BASE] 分钟边界基准推进异常:", e);
		} finally {
			this.boundaryBusy = false;
		}
	}

	/**
	 * 一次连接把 `listRepairGaps()` 的缺口全部读完（含桥接合并）。
	 *
	 * 没有连接时长预算：需要补的缺口就一直补，补到没有缺口再断开。连接自己留下的
	 * 缺秒不特殊处理，它是普通缺口，由下一次连接顺带补掉（方案 9.3）。
	 */
	async repairVitalHistoryGapsInCurrentConnection(
		reason: DeviceSyncReason
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
		const startedAt = Date.now();
		try {
			// 执行前重新规划一次，避免队列等待期间广播已经把缺口补上。
			const plan = await this.planHistorySync();
			this.state.value = "repairing";
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
				`[BOOM-HISTORY] 开始补录: B=${plan.baseline}, 缺口组=${plan.gaps.length}, 缺口秒=${plan.totalRepairSeconds}, bridge秒=${historyBaseline.sumBridgeSeconds(plan.gaps)}, stableCeiling=${plan.ceiling}, 连接开始=${startedAt}`
			);
			const results = await this.runVitalGaps(plan.gaps);
			let ok = true;
			for (let i = 0; i < results.length; i++) {
				const item = results[i];
				if (
					item.status == "TIMEOUT" ||
					item.status == "SEND_FAILED" ||
					item.saveOk == false
				) {
					ok = false;
				}
			}
			this.lastHistorySyncAt.value = Date.now();
			if (ok == false && this.lastError.value == "") {
				this.lastError.value = "history partial failed";
			}
			// 收尾重算：`B` 推到哪、还剩多少活，都由重新规划的缺口给出确切数字。
			const after = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000));
			const remaining = await historyBaseline.listRepairGaps(Math.floor(Date.now() / 1000));
			let failedGroups = 0;
			for (let i = 0; i < results.length; i++) {
				const item = results[i];
				if (item.status == "TIMEOUT" || item.status == "SEND_FAILED" || item.saveOk == false)
					failedGroups++;
			}
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 补录结束: B=${plan.baseline}->${after}, 已补组=${results.length - failedGroups}, 失败组=${failedGroups}, 落库秒=${this.countSaved(results)}, 剩余缺口=${remaining.length}, 剩余秒=${historyBaseline.sumRepairSeconds(remaining)}, stableCeiling=${historyBaseline.stableCeiling(Math.floor(Date.now() / 1000))}, 连接时长=${Math.round((Date.now() - startedAt) / 1000)}s, ok=${ok}`
			);
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

	private async runVitalGaps(gaps: HistoryGap[]): Promise<HistoryGapRepairResult[]> {
		const results: HistoryGapRepairResult[] = [];
		const total = gaps.length;
		for (let i = 0; i < gaps.length; i++) {
			const gap = gaps[i];
			if (this.device.boundDeviceId == "") break;
			// 每组记账推进了多少，用 `B` 的前后差量度量。这是核对「记账是否按预期推进」
			// 的直接证据：`B` 没动就说明这一组的读取没有转成记账（被 `stableCeiling`
			// 封顶、或落库失败），而这在 `落库秒` 上完全看不出来——两者是两件事。
			const before = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000));
			const result = await this.device.history.readVitalGapGroup(gap);
			const after = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000));
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 缺口组结束: ${i + 1}/${total}, window=${gap.fromSec}~${gap.toSec}, 缺口秒=${gap.repairSeconds}, bridge秒=${gap.bridgeSeconds}, status=${result.status}, pages=${result.pages}, 落库=${result.savedRecords}, B=${before}->${after}, 本组推进=${after - before}s`
			);
			results.push(this.makeGapResult(gap, result));
			if (result.status == "TIMEOUT" || result.status == "SEND_FAILED" || !result.saveOk)
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
			uploadScheduled: result.uploadScheduled
		} as HistoryGapRepairResult;
	}

	private countSaved(results: HistoryGapRepairResult[]): number {
		let saved = 0;
		for (let i = 0; i < results.length; i++) saved += results[i].savedRecords;
		return saved;
	}

	private emptyPlan(): HistorySyncPlan {
		return {
			needed: false,
			gaps: [],
			baseline: 0,
			ceiling: 0,
			totalRepairSeconds: 0
		} as HistorySyncPlan;
	}

	private makeResult(
		ok: boolean,
		message: string,
		plan: HistorySyncPlan,
		results: HistoryGapRepairResult[]
	): HistoryRepairResult {
		return {
			ok,
			message,
			plan,
			results,
			savedRecords: this.countSaved(results)
		} as HistoryRepairResult;
	}
}
