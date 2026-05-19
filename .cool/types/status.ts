import type { TimeValuePair, DateValuePair } from "./common";

export type StatusApiResponse = {
	totalStatus: number;
	statusProgress: number;
	hrv: number;
	restingHeartRate: number;
	hrvData: TimeValuePair[];
};
