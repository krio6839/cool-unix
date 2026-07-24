import { ref } from "vue";
import { request } from "../service";
import { getErrorMessage, isArray, isNull, isObject, parse } from "../utils";
import type { EnergyStatusApiResponse } from "../types/energy";
import type { TimeValuePair, DateValuePair } from "../types/common";

function isNoDataResponse(err?: any | null): boolean {
	return getErrorMessage(err).indexOf("No data found for device") >= 0;
}

export class Energy {
	data = ref<EnergyStatusApiResponse | null>(null);

	totalEnergy = ref<number>(0);
	energyProgress = ref<number>(0);
	totalCharge = ref<number>(0);
	totalConsume = ref<number>(0);
	energyChartData = ref<TimeValuePair[]>([]);
	bodyEnergyChartData = ref<DateValuePair[]>([]);

	fetchStatus(deviceId: string, date?: string): Promise<void> {
		if (deviceId == null || deviceId === "") {
			return Promise.reject("deviceId is null");
		}
		return new Promise((resolve, reject) => {
			const params: UTSJSONObject = {};
			if (date != null) {
				params["date"] = date;
			}

			request({
				url: `/devices/${deviceId}/energy_status`,
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
					console.error("获取储能状态失败:", err);
					if (isNoDataResponse(err)) {
						resolve();
						return;
					}
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	fetchTrend(deviceId: string, startDate: string, endDate: string): Promise<void> {
		if (deviceId == null || deviceId === "") {
			return Promise.reject("deviceId is null");
		}
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/energy_trend`,
				method: "GET",
				data: {
					startDate,
					endDate
				} as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isArray(res)) {
						const list = (res as any[]).map((item) => parse<DateValuePair>(item)!);
						this.bodyEnergyChartData.value = list;
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取储能趋势失败:", err);
					if (isNoDataResponse(err)) {
						resolve();
						return;
					}
					reject(getErrorMessage(err, "请求失败"));
				});
		});
	}

	setStatusData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const statusData = parse<EnergyStatusApiResponse>(data)!;
		this.data.value = statusData;
		this.totalEnergy.value = statusData.totalEnergy ?? 0;
		this.energyProgress.value = statusData.energyProgress ?? 0;
		this.totalCharge.value = statusData.totalCharge ?? 0;
		this.totalConsume.value = statusData.totalConsume ?? 0;
		this.energyChartData.value = statusData.energyChartData ?? [];
	}

	clearStatus(): void {
		this.data.value = null;
		this.totalEnergy.value = 0;
		this.energyProgress.value = 0;
		this.totalCharge.value = 0;
		this.totalConsume.value = 0;
		this.energyChartData.value = [];
	}

	clearTrend(): void {
		this.bodyEnergyChartData.value = [];
	}

	clear(): void {
		this.clearStatus();
		this.clearTrend();
	}
}

export const energy = new Energy();
