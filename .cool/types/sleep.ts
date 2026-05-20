import type { TimeValuePair, DateValuePair } from "./common";

export type SleepStatusApiResponse = {
	totalSleep: number;
	sleepProgress: number;
	sleepDuration: string;
	sleepQuality: number;
	suggestedSleepDuration: string;
	recoverySleepPercentage: number;
	recoverySleepDuration: string;
	avgRecoverySleepPercentage: string;
	avgRecoverySleepDuration: string;
};

export type SleepMetricApiResponse = {
	sleepHeartRateData: TimeValuePair[];
	sleepHrvData: TimeValuePair[];
	sleepOxygenData: TimeValuePair[];
};

export type SleepDateValuePair = {
	date: string;
	value: string;
};

export type SleepModeApiResponse = {
	bedtimes: SleepDateValuePair[];
	wakeTimes: SleepDateValuePair[];
	avgBedtime: string;
	avgWakeTime: string;
};
