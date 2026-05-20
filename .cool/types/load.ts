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
	restingHeartRate: number;
	steps: number;
	calories: number;
	realtimeLoadData: TimeValuePair[];
	loadZones: LoadZones;
	heartRateZoneData: TimeValuePair[];
	heartRateZoneItems: HeartRateZoneItems;
};
