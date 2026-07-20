import { ref } from "vue";
import type { RealtimeBroadcastRecord } from "../bluetooth/types";
import type { HealthCardValues } from "../types";

/**
 * 0x50 广播实时展示 store。
 *
 * 这里只保存“当前屏幕要展示的最新值”，数据来源是本地
 * realtime_broadcast_data 最新记录或新收到的 0x50 广播。
 * 趋势图、分析文案仍走各自接口 store，不放在这里。
 */
export class Realtime {
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

	clear(): void {
		this.healthCardValues.value = {
			heartRate: null,
			restingHeartRate: null,
			oxygen: null,
			hrv: null
		} as HealthCardValues;
		this.steps.value = null;
		this.calories.value = null;
	}

	setBroadcastValues(
		hr: number,
		bhr: number,
		spo2: number,
		ppi: number,
		steps: number,
		calorieEveryday: number
	): void {
		// 广播字段可能带无效占位值；进入 UI store 前统一转为 null。
		this.healthCardValues.value = {
			heartRate: hr >= 28 && hr <= 240 ? hr : null,
			restingHeartRate: bhr >= 28 && bhr <= 240 ? bhr : null,
			oxygen: spo2 >= 700 && spo2 <= 1000 ? spo2 / 10 : null,
			hrv: ppi > 0 ? ppi : null
		} as HealthCardValues;
		this.steps.value = steps > 0 ? steps : null;
		this.calories.value = calorieEveryday > 0 ? calorieEveryday / 100 : null;
	}

	/** 页面进入时从本地数据库恢复最新广播记录，或广播入库后同步更新。 */
	setBroadcastRecord(record: RealtimeBroadcastRecord): void {
		this.setBroadcastValues(
			record.hr,
			record.bhr,
			record.spo2,
			record.ppi,
			record.stepsEveryday,
			record.calorieEveryday
		);
	}
}

export const realtime = new Realtime();
