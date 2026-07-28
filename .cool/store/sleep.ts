import { ref } from "vue";
import { request } from "../service";
import { getErrorMessage, isArray, isNull, isObject, parse } from "../utils";
import type { SleepStatusApiResponse, SleepModeApiResponse } from "../types/sleep";
import type { TimeValuePair, DateValuePair } from "../types/common";

export class Sleep {
	statusData = ref<SleepStatusApiResponse | null>(null);
	metricData = ref<TimeValuePair[]>([]);
	trendData = ref<DateValuePair[]>([]);

	totalSleep = ref<number>(0);
	sleepProgress = ref<number>(0);
	sleepDuration = ref<string>("");
	sleepQuality = ref<number>(0);
	suggestedSleepDuration = ref<string>("");
	recoverySleepPercentage = ref<number>(0);
	recoverySleepDuration = ref<string>("");
	avgRecoverySleepPercentage = ref<string>("");
	avgRecoverySleepDuration = ref<string>("");
	sleepHeartRateData = ref<TimeValuePair[]>([]);
	sleepHrvData = ref<TimeValuePair[]>([]);
	sleepOxygenData = ref<TimeValuePair[]>([]);
	sleepTrendData = ref<DateValuePair[]>([]);
	sleepModeData = ref<SleepModeApiResponse | null>(null);

	fetchStatus(deviceId: string, date?: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const params: UTSJSONObject = {};
			if (date != null) {
				params["date"] = date;
			}

			request({
				url: `/devices/${deviceId}/sleep_status`,
				method: "GET",
				data: params
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setStatusData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠状态失败:", err);
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	fetchMetric(deviceId: string, date: string, metric: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sleep_metric`,
				method: "GET",
				data: { date, metric } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isArray(res)) {
						this.setMetricData(res, metric);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠指标失败:", err);
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	fetchTrend(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sleep_trend`,
				method: "GET",
				data: { startDate, endDate } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isArray(res)) {
						this.setTrendData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠趋势失败:", err);
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	fetchSleepMode(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sleep_mode`,
				method: "GET",
				data: { startDate, endDate } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setSleepModeData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠模式失败:", err);
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	setStatusData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const statusData = parse<SleepStatusApiResponse>(data)!;
		this.statusData.value = statusData;
		this.totalSleep.value = statusData.totalSleep ?? 0;
		this.sleepProgress.value = statusData.sleepProgress ?? 0;
		this.sleepDuration.value = statusData.sleepDuration ?? "";
		this.sleepQuality.value = statusData.sleepQuality ?? 0;
		this.suggestedSleepDuration.value = statusData.suggestedSleepDuration ?? "";
		this.recoverySleepPercentage.value = statusData.recoverySleepPercentage ?? 0;
		this.recoverySleepDuration.value = statusData.recoverySleepDuration ?? "";
		this.avgRecoverySleepPercentage.value = statusData.avgRecoverySleepPercentage ?? "";
		this.avgRecoverySleepDuration.value = statusData.avgRecoverySleepDuration ?? "";
	}

	setMetricData(data: any, metric: string): void {
		if (isNull(data)) {
			return;
		}

		const list = isArray(data)
			? (data as any[]).map((item: any): TimeValuePair => parse<TimeValuePair>(item)!)
			: [];
		this.metricData.value = list;

		if (metric === "hrv") {
			this.sleepHrvData.value = list;
		} else if (metric === "oxygen") {
			this.sleepOxygenData.value = list;
		} else {
			this.sleepHeartRateData.value = list;
		}
	}

	setTrendData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const trendDataResult = isArray(data)
			? (data as any[]).map((item: any): DateValuePair => parse<DateValuePair>(item)!)
			: [];
		this.trendData.value = trendDataResult;
		this.sleepTrendData.value = trendDataResult ?? [];
	}

	setSleepModeData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const modeData = parse<SleepModeApiResponse>(data)!;
		this.sleepModeData.value = modeData;
	}

	clearStatus(): void {
		this.statusData.value = null;
		this.totalSleep.value = 0;
		this.sleepProgress.value = 0;
		this.sleepDuration.value = "";
		this.sleepQuality.value = 0;
		this.suggestedSleepDuration.value = "";
		this.recoverySleepPercentage.value = 0;
		this.recoverySleepDuration.value = "";
		this.avgRecoverySleepPercentage.value = "";
		this.avgRecoverySleepDuration.value = "";
	}

	clearMetric(): void {
		this.metricData.value = [];
		this.sleepHeartRateData.value = [];
		this.sleepHrvData.value = [];
		this.sleepOxygenData.value = [];
	}

	clearTrend(): void {
		this.trendData.value = [];
		this.sleepTrendData.value = [];
	}

	clearSleepMode(): void {
		this.sleepModeData.value = null;
	}

	clear(): void {
		this.clearStatus();
		this.clearMetric();
		this.clearTrend();
		this.clearSleepMode();
	}
}

export const sleep = new Sleep();
