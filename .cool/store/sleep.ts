import { ref } from "vue";
import { request } from "../service";
import { isNull, isObject, parse } from "../utils";
import type {
	SleepStatusApiResponse,
	SleepMetricApiResponse,
	SleepModeApiResponse
} from "../types/sleep";
import type { TimeValuePair, DateValuePair } from "../types/common";

export class Sleep {
	statusData = ref<SleepStatusApiResponse | null>(null);
	metricData = ref<SleepMetricApiResponse | null>(null);
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
					reject(err);
				});
		});
	}

	fetchMetric(deviceId: string, date: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sleep_metric`,
				method: "GET",
				data: { date } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setMetricData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠指标失败:", err);
					reject(err);
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
					if (res != null && isObject(res)) {
						this.setTrendData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠趋势失败:", err);
					reject(err);
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
					reject(err);
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

	setMetricData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const metricData = parse<SleepMetricApiResponse>(data)!;
		this.metricData.value = metricData;
		this.sleepHeartRateData.value = metricData.sleepHeartRateData ?? [];
		this.sleepHrvData.value = metricData.sleepHrvData ?? [];
		this.sleepOxygenData.value = metricData.sleepOxygenData ?? [];
	}

	setTrendData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const trendDataResult = parse<DateValuePair[]>(data)!;
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

	clear(): void {
		this.statusData.value = null;

		this.metricData.value = null;
		this.trendData.value = [];
		this.totalSleep.value = 0;
		this.sleepProgress.value = 0;
		this.sleepDuration.value = "";
		this.sleepQuality.value = 0;
		this.suggestedSleepDuration.value = "";
		this.recoverySleepPercentage.value = 0;
		this.recoverySleepDuration.value = "";
		this.avgRecoverySleepPercentage.value = "";
		this.avgRecoverySleepDuration.value = "";
		this.sleepHeartRateData.value = [];
		this.sleepHrvData.value = [];
		this.sleepOxygenData.value = [];
		this.sleepTrendData.value = [];
		this.sleepModeData.value = null;
	}
}

export const sleep = new Sleep();
