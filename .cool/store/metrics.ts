import { ref } from "vue";
import { request } from "../service";
import { getErrorMessage, isNull, isObject, parse } from "../utils";
import type { BodyMetricsApiResponse } from "../types/metrics";
import type { DateValuePair } from "../types/common";

export class Metrics {
	data = ref<BodyMetricsApiResponse | null>(null);

	/**
	 * 四个指标共用一份 currentData，切换指标时上一次的值会短暂留在 ref 里。
	 * 页面靠这个标记把它显示成占位符，避免「点静息心率先看到心率的数字」。
	 */
	loading = ref<boolean>(false);
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
		this.loading.value = true;
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
					this.loading.value = false;
					resolve();
				})
				.catch((err) => {
					this.loading.value = false;
					console.error("获取身体指标失败:", err);
					reject(getErrorMessage(err, "请求失败"));
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
		this.loading.value = false;
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
