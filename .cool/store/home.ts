import { ref } from "vue";
import { isNull, isObject, parse } from "../utils";
import type { HomeData, HealthStatus, HealthCardValues, TrainingDetails } from "../types/home";
import { request } from "../service";

export class Home {
	data = ref<HomeData | null>(null);

	healthStatus = ref<HealthStatus>({
		status: 0,
		sleep: 0,
		load: 0
	});

	healthCardValues = ref<HealthCardValues>({
		heartRate: null,
		restingHeartRate: null,
		oxygen: null,
		hrv: null
	});

	boomGoText = ref<string>("");
	energyPercentage = ref<number>(0);
	details = ref<TrainingDetails>({
		supercompensationTime: ""
	});

	fetch(deviceId: string): Promise<void> {
		if (deviceId == null || deviceId === "") {
			return Promise.reject("deviceId is null");
		}
		return new Promise((resolve, reject) => {
			request({
				url: `/devices/${deviceId}/go`,
				method: "GET"
			})
				.then((res) => {
					if (res != null && isObject(res)) {
						this.setData(res);
					}
					resolve();
				})
				.catch((err) => {
					console.error("获取首页数据失败:", err);
					reject(err);
				});
		});
	}

	setData(data: any): void {
		if (isNull(data)) {
			return;
		}

		const homeData = parse<HomeData>(data)!;
		this.data.value = homeData;
		this.healthStatus.value =
			(homeData.healthStatus as HealthStatus) ??
			({ status: 0, sleep: 0, load: 0 } as HealthStatus);
		this.healthCardValues.value =
			(homeData.healthCardValues as HealthCardValues) ??
			({
				heartRate: null,
				restingHeartRate: null,
				oxygen: null,
				hrv: null
			} as HealthCardValues);
		this.boomGoText.value = homeData.boomGoText ?? "";
		this.energyPercentage.value = homeData.energyPercentage ?? 0;
		this.details.value =
			(homeData.details as TrainingDetails) ??
			({ supercompensationTime: "" } as TrainingDetails);
	}

	clear(): void {
		this.data.value = null;
		this.healthStatus.value = { status: 0, sleep: 0, load: 0 } as HealthStatus;
		this.healthCardValues.value = {
			heartRate: null,
			restingHeartRate: null,
			oxygen: null,
			hrv: null
		} as HealthCardValues;
		this.boomGoText.value = "";
		this.energyPercentage.value = 0;
		this.details.value = { supercompensationTime: "" } as TrainingDetails;
	}
}

export const home = new Home();
