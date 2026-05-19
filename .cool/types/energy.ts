import type { TimeValuePair, DateValuePair } from "./common";

export type EnergyStatusApiResponse = {
	totalEnergy: number;
	energyProgress: number;
	totalCharge: number;
	totalConsume: number;
	energyChartData: TimeValuePair[];
};

export type EnergyTrendApiResponse = DateValuePair[];
