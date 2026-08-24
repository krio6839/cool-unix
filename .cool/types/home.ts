export type TrendType = "up" | "down";

export type HealthStatus = {
	status: number;
	sleep: number;
	load: number;
};

export type HealthCardValues = {
	heartRate?: number | null;
	restingHeartRate?: number | null;
	oxygen?: number | null;
	hrv?: number | null;
};

export type FeatureSummary = {
	rmssdMean: number;
	rmssdStd: number;
	ppiSampleCount: number;
	sleepSampleCount: number;
};

export type Scoring = {
	base_weight: number;
	dynamic_adjustment: number;
	sleep_score: number;
	base_score: number;
	deduction: number;
	bonus: number;
	sleep_weight: number;
	sleep_percent: number;
	status: number;
};

export type TrainingDetails = {
	supercompensationTime: string;
	suggestion?: string;
	duration?: string;
	target?: string;
	featureSummary?: FeatureSummary;
	scoring?: Scoring;
};

export type HomeData = {
	healthStatus: HealthStatus;
	boomGoText: string;
	energyPercentage: number;
	healthCardValues: HealthCardValues;
	dataComplete?: boolean;
	details: TrainingDetails;
};
