import { ref } from "vue";
import { request } from "../service";
import { isNull, isObject, parse } from "../utils";
import type { LoadStatusApiResponse } from "../types/load";
import type { TimeValuePair, DateValuePair } from "../types/common";

export class Load {
	data = ref<LoadStatusApiResponse | null>(null);
	trendData = ref<DateValuePair[]>([]);
	sportLoadData = ref<DateValuePair[]>([]);
	sleepPressureData = ref<DateValuePair[]>([]);

	totalLoad = ref<number>(0);
	loadProgress = ref<number>(0);
	avgLoad = ref<number>(0);
	restingHeartRate = ref<number>(0);
	steps = ref<number>(0);
	calories = ref<number>(0);
	realtimeLoadData = ref<TimeValuePair[]>([]);
	loadZones = ref<UTSJSONObject | null>(null);
	heartRateZoneData = ref<TimeValuePair[]>([]);
	heartRateZoneItems = ref<UTSJSONObject | null>(null);
	loadTrendData = ref<DateValuePair[]>([]);
	sportLoadTrendData = ref<DateValuePair[]>([]);
	sleepPressureTrendData = ref<DateValuePair[]>([]);

	fetchStatus(deviceId: string, date?: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const params: UTSJSONObject = {};
			if (date != null) {
				params["date"] = date;
			}

			request({
				url: `/devices/${deviceId}/load_status`,
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
					console.error("获取负荷状态失败:", err);
					reject(err);
				});
		});
	}

	fetchTrend(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/load_trend`,
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
					console.error("获取负荷趋势失败:", err);
					reject(err);
				});
		});
	}

	fetchSportLoad(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sport_load`,
				method: "GET",
				data: { startDate, endDate } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.sportLoadData.value = parse<DateValuePair[]>(res)!;
						this.sportLoadTrendData.value = this.sportLoadData.value ?? [];
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取运动负荷失败:", err);
					reject(err);
				});
		});
	}

	fetchSleepPressure(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/sleep_pressure`,
				method: "GET",
				data: { startDate, endDate } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.sleepPressureData.value = parse<DateValuePair[]>(res)!;
						this.sleepPressureTrendData.value = this.sleepPressureData.value ?? [];
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取睡眠压力失败:", err);
					reject(err);
				});
		});
	}

	setStatusData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const statusData = parse<LoadStatusApiResponse>(data)!;
		this.data.value = statusData;
		this.totalLoad.value = statusData.totalLoad ?? 0;
		this.loadProgress.value = statusData.loadProgress ?? 0;
		this.avgLoad.value = statusData.avgLoad ?? 0;
		this.restingHeartRate.value = statusData.restingHeartRate ?? 0;
		this.steps.value = statusData.steps ?? 0;
		this.calories.value = statusData.calories ?? 0;
		this.realtimeLoadData.value = statusData.realtimeLoadData ?? [];
		this.loadZones.value = (statusData.loadZones as UTSJSONObject) ?? null;
		this.heartRateZoneData.value = statusData.heartRateZoneData ?? [];
		this.heartRateZoneItems.value = (statusData.heartRateZoneItems as UTSJSONObject) ?? null;
	}

	setTrendData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const trendDataResult = parse<DateValuePair[]>(data)!;
		this.trendData.value = trendDataResult;
		this.loadTrendData.value = trendDataResult ?? [];
	}

	clear(): void {
		this.data.value = null;
		this.trendData.value = [];
		this.sportLoadData.value = [];
		this.sleepPressureData.value = [];
		this.totalLoad.value = 0;
		this.loadProgress.value = 0;
		this.avgLoad.value = 0;
		this.restingHeartRate.value = 0;
		this.steps.value = 0;
		this.calories.value = 0;
		this.realtimeLoadData.value = [];
		this.loadZones.value = null;
		this.heartRateZoneData.value = [];
		this.heartRateZoneItems.value = null;
		this.loadTrendData.value = [];
		this.sportLoadTrendData.value = [];
		this.sleepPressureTrendData.value = [];
	}
}

export const load = new Load();
