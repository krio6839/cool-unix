import type { DateValuePair } from "./common";

export type BodyMetricsApiResponse = {
	currentData: string;
	normalRange: string;
	trendData: DateValuePair[];
	analysisText: string;
	updateTime: string;
};
