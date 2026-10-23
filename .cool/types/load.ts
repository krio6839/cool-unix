import type { TimeValuePair, DateValuePair } from "./common";

export type LoadZonePercentage = {
	percentage: number;
	hours: number;
};

export type LoadZones = {
	overload: LoadZonePercentage;
	warning: LoadZonePercentage;
	normal: LoadZonePercentage;
	excellent: LoadZonePercentage;
};

export type HeartRateZoneItems = {
	zone0: number;
	zone1: number;
	zone2: number;
	zone3: number;
	zone4: number;
	zone5: number;
};

export type LoadStatusApiResponse = {
	totalLoad: number;
	loadProgress: number;
	avgLoad: number;
	// 三项都可能没有数据：0 是合法值（例如刚起床的步数），所以用 null 表示「接口没给」。
	restingHeartRate: number | null;
	steps: number | null;
	calories: number | null;
	realtimeLoadData: TimeValuePair[];
	loadZones: LoadZones;
	heartRateZoneData: TimeValuePair[];
	heartRateZoneItems: HeartRateZoneItems;
};
