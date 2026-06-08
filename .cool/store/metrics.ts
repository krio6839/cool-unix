import { ref } from "vue";
import { request } from "../service";
import { isNull, isObject, parse } from "../utils";
import type { BodyMetricsApiResponse } from "../types/metrics";
import type { DateValuePair } from "../types/common";

export class Metrics {
	data = ref<BodyMetricsApiResponse | null>(null);

	currentData = ref<string>("");
	normalRange = ref<string>("");
	trendData = ref<DateValuePair[]>([]);
	trendValues = ref<number[]>([]);
	trendDates = ref<string[]>([]);
	analysisText = ref<string>("");
	updateTime = ref<string>("");

	fetchMetrics(
		deviceId: string,
		metric: string,
		startDate: string,
		endDate: string
	): Promise<void> {
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/body_metrics`,
				method: "GET",
				data: { metric, startDate, endDate } as UTSJSONObject
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setMetricsData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取身体指标失败:", err);
					this.clear();
					reject(err);
				});
		});
	}

	setMetricsData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const metricsData = parse<BodyMetricsApiResponse>(data)!;
		this.data.value = metricsData;
		this.currentData.value = metricsData.currentData ?? "";
		this.normalRange.value = metricsData.normalRange ?? "";
		this.trendData.value = metricsData.trendData ?? [];
		this.trendValues.value = metricsData.trendData.map((item) => item.value);
		this.trendDates.value = metricsData.trendData.map((item) => item.date);
		this.analysisText.value = metricsData.analysisText ?? "";
		this.updateTime.value = metricsData.updateTime ?? "";
	}

	clear(): void {
		this.data.value = null;
		this.currentData.value = "";
		this.normalRange.value = "";
		this.trendData.value = [];
		this.trendValues.value = [];
		this.trendDates.value = [];
		this.analysisText.value = "";
		this.updateTime.value = "";
	}
}

export const metrics = new Metrics();
