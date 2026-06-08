import { ref } from "vue";
import { request } from "../service";
import { isNull, isObject, parse } from "../utils";
import type { SuperRecoveryApiResponse, AtlCtlTrendApiResponse } from "../types/recovery";

export class Recovery {
	data = ref<SuperRecoveryApiResponse | null>(null);
	trendData = ref<AtlCtlTrendApiResponse | null>(null);

	tsb = ref<number>(0);
	atl = ref<number>(0);
	ctl = ref<number>(0);
	atlTrendData = ref<number[]>([]);
	ctlTrendData = ref<number[]>([]);
	trendDates = ref<string[]>([]);

	fetchStatus(deviceId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/superrecovery`,
				method: "GET"
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setStatusData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取超量恢复状态失败:", err);
					this.clear();
					reject(err);
				});
		});
	}

	fetchTrend(deviceId: string, startDate: string, endDate: string): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/atlctl`,
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
					console.error("获取超量恢复趋势失败:", err);
					this.clear();
					reject(err);
				});
		});
	}

	setStatusData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const statusData = parse<SuperRecoveryApiResponse>(data)!;
		this.data.value = statusData;
		this.tsb.value = statusData.tsb ?? 0;
		this.atl.value = statusData.atl ?? 0;
		this.ctl.value = statusData.ctl ?? 0;
	}

	setTrendData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const trendDataResult = parse<AtlCtlTrendApiResponse>(data)!;
		this.trendData.value = trendDataResult;
		this.atlTrendData.value = trendDataResult.map((item) => item.atl);
		this.ctlTrendData.value = trendDataResult.map((item) => item.ctl);
		this.trendDates.value = trendDataResult.map((item) => item.date);
	}

	clear(): void {
		this.data.value = null;
		this.trendData.value = null;
		this.tsb.value = 0;
		this.atl.value = 0;
		this.ctl.value = 0;
		this.atlTrendData.value = [];
		this.ctlTrendData.value = [];
		this.trendDates.value = [];
	}
}

export const recovery = new Recovery();
