import { ref } from "vue";
import { request } from "../service";
import { getErrorMessage, isNull, isObject, parse } from "../utils";
import type { StatusApiResponse } from "../types/status";
import type { TimeValuePair, DateValuePair } from "../types/common";

export class Status {
	data = ref<StatusApiResponse | null>(null);
	readinessData = ref<DateValuePair[]>([]);

	totalStatus = ref<number>(0);
	statusProgress = ref<number>(0);
	hrv = ref<number>(0);
	restingHeartRate = ref<number>(0);
	hrvData = ref<TimeValuePair[]>([]);

	fetchStatus(deviceId: string, date?: string): Promise<void> {
		if (deviceId == null || deviceId === "") {
			return Promise.reject("deviceId is null");
		}
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/status`,
				method: "GET",
				data: {
					date
				}
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setStatusData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取状态数据失败:", err);
					this.clear();
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	fetchReadiness(deviceId: string, startDate: string, endDate: string): Promise<void> {
		if (deviceId == null || deviceId === "") {
			return Promise.reject("deviceId is null");
		}
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/readiness`,
				method: "GET",
				data: {
					startDate,
					endDate
				}
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setReadinessData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取准备度数据失败:", err);
					this.readinessData.value = [];
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	setStatusData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const statusData = parse<StatusApiResponse>(data)!;
		this.data.value = statusData;
		this.totalStatus.value = statusData.totalStatus ?? 0;
		this.statusProgress.value = statusData.statusProgress ?? 0;
		this.hrv.value = statusData.hrv ?? 0;
		this.restingHeartRate.value = statusData.restingHeartRate ?? 0;
		this.hrvData.value = statusData.hrvData ?? [];
	}

	setReadinessData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const parsed = parse<DateValuePair[]>(data);
		if (parsed != null) {
			this.readinessData.value = parsed;
		} else {
			this.readinessData.value = [];
		}
	}

	clear(): void {
		this.data.value = null;
		this.readinessData.value = [];
		this.totalStatus.value = 0;
		this.statusProgress.value = 0;
		this.hrv.value = 0;
		this.restingHeartRate.value = 0;
		this.hrvData.value = [];
	}
}

export const status = new Status();
