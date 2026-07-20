import { ref } from "vue";
import { bluetoothDataManager } from "../bluetooth/data-manager";
import type { RealtimeBroadcastRecord } from "../bluetooth/types";
import type { HealthCardValues } from "../types";

const BROADCAST_STALE_MS = 5 * 60 * 1000;

/**
 * 0x50 广播实时展示 store。
 *
 * 这里只保存“当前屏幕要展示的最新值”，数据来源是本地
 * realtime_broadcast_data 最新记录或新收到的 0x50 广播。
 * 趋势图、分析文案仍走各自接口 store，不放在这里。
 */
export class Realtime {
	private staleTimer: number = 0;
	private restoreTimer: number = 0;
	private restoreAttempts: number = 0;
	private readonly maxRestoreAttempts: number = 5;

	constructor() {
		this.scheduleInitialRestore();
	}

	/** 首页/metrics/状态页共享的当前生命体征值 */
	healthCardValues = ref<HealthCardValues>({
		heartRate: null,
		restingHeartRate: null,
		oxygen: null,
		hrv: null
	});

	/** 负荷页当前步数，来自新版 21B 广播 steps_everyday */
	steps = ref<number | null>(null);
	/** 负荷页当前卡路里，单位 kcal，来自 calorie_everyday / 100 */
	calories = ref<number | null>(null);
	/** 最近一次收到/恢复的广播时间，用于判断首页实时数据是否过期 */
	lastBroadcastReceivedAt = ref<number | null>(null);

	clear(): void {
		this.stopStaleTimer();
		this.healthCardValues.value = {
			heartRate: null,
			restingHeartRate: null,
			oxygen: null,
			hrv: null
		} as HealthCardValues;
		this.steps.value = null;
		this.calories.value = null;
		this.lastBroadcastReceivedAt.value = null;
	}

	setBroadcastValues(
		hr: number,
		bhr: number,
		spo2: number,
		ppi: number,
		steps: number,
		calorieEveryday: number,
		receivedAt: number = Date.now()
	): void {
		const current = this.healthCardValues.value as HealthCardValues;
		this.lastBroadcastReceivedAt.value = receivedAt;
		// 广播字段可能带无效占位值；保留最近有效值，直到广播整体过期。
		this.healthCardValues.value = {
			heartRate: hr >= 28 && hr <= 240 ? hr : (current.heartRate ?? null),
			restingHeartRate:
				bhr >= 28 && bhr <= 240 ? bhr : (current.restingHeartRate ?? null),
			oxygen: spo2 >= 700 && spo2 <= 1000 ? spo2 / 10 : (current.oxygen ?? null),
			hrv: ppi > 0 ? ppi : (current.hrv ?? null)
		} as HealthCardValues;
		this.steps.value = steps > 0 ? steps : this.steps.value;
		this.calories.value = calorieEveryday > 0 ? calorieEveryday / 100 : this.calories.value;
		this.startStaleTimer(receivedAt);
	}

	/** 页面进入时从本地数据库恢复最新广播记录，或广播入库后同步更新。 */
	setBroadcastRecord(record: RealtimeBroadcastRecord): void {
		if (this.isBroadcastStale(record.receivedAt)) {
			this.clear();
			return;
		}
		this.setBroadcastValues(
			record.hr,
			record.bhr,
			record.spo2,
			record.ppi,
			record.stepsEveryday,
			record.calorieEveryday,
			record.receivedAt
		);
	}

	async refreshFromLatestBroadcastRecord(): Promise<void> {
		const record = await bluetoothDataManager.getLatestRealtimeBroadcastRecord();
		if (record == null) {
			this.scheduleInitialRestore();
			return;
		}
		this.setBroadcastRecord(record);
	}

	isBroadcastStale(receivedAt: number | null = this.lastBroadcastReceivedAt.value): boolean {
		if (receivedAt == null || receivedAt <= 0) return true;
		return Date.now() - receivedAt > BROADCAST_STALE_MS;
	}

	clearIfStale(): void {
		if (this.isBroadcastStale()) {
			this.clear();
		}
	}

	private startStaleTimer(receivedAt: number): void {
		this.stopStaleTimer();
		const delay = receivedAt + BROADCAST_STALE_MS - Date.now();
		if (delay <= 0) {
			this.clearIfStale();
			return;
		}
		// @ts-ignore
		this.staleTimer = setTimeout(() => {
			this.clearIfStale();
		}, delay);
	}

	private stopStaleTimer(): void {
		if (this.staleTimer != 0) {
			clearTimeout(this.staleTimer);
			this.staleTimer = 0;
		}
	}

	private scheduleInitialRestore(): void {
		if (this.restoreTimer != 0) return;
		if (this.restoreAttempts >= this.maxRestoreAttempts) return;
		const delay = this.restoreAttempts == 0 ? 300 : 1000;
		// @ts-ignore
		this.restoreTimer = setTimeout(() => {
			this.restoreTimer = 0;
			this.restoreAttempts = this.restoreAttempts + 1;
			this.refreshFromLatestBroadcastRecord();
		}, delay);
	}
}

export const realtime = new Realtime();
