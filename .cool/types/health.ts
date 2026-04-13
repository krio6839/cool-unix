export type TrendType = "up" | "down";

export type HealthItem = {
	label: string;
	value: string | number;
	trend?: TrendType;
	onClick?: () => void;
};

export type HealthCardItem = {
	title: string;
	value: number;
	unit: string;
	change: number;
	icon: string;
};

export type HealthStatus = {
	status: number;
	sleep: number;
	load: number;
	statusTrend?: TrendType;
	sleepTrend?: TrendType;
	loadTrend?: TrendType;
};

export type HealthCardValues = {
	heartRate: number;
	restingHeartRate: number;
	oxygen: number;
	hrv: number;
};

export type TrainingDetails = {
	supercompensationTime: string;
	suggestion?: string;
	duration?: string;
	target?: string;
};

export type UserInfoData = {
	name: string;
	lastLoginTime: string;
};

export type TrainingState = {
	key: string;
	userInfo: UserInfoData;
	healthStatus: HealthStatus;
	boomGoText: string;
	energyPercentage: number;
	healthCardValues: HealthCardValues;
	details: TrainingDetails;
};

export type LoadZoneItem = {
	label: string;
	value: string;
};

export type LoadTrendItem = {
	max: number;
	maxDay: string;
	min: number;
	minDay: string;
	average: number;
};

export type HeartRateZoneItem = {
	zone: string;
	percentage: number;
};

export type StatusPageState = {
	key: string;
	totalStatus: number;
	statusProgress: number;
	healthItems: HealthItem[];
	hrvData: number[];
	readinessData: number[];
	totalEnergy: number;
	energyProgress: number;
	energyItems: HealthItem[];
	energyChartData: number[];
	bodyEnergyChartData: number[];
	maxEnergy: number;
	averageEnergyRange: string;
	totalLoad: number;
	loadProgress: number;
	loadItems: HealthItem[];
	realtimeLoadData: number[];
	loadZones: LoadZoneItem[];
	loadTrendData: number[];
	loadTrendInfo: LoadTrendItem;
	exerciseLoadData: number[];
	exerciseLoadTrendInfo: LoadTrendItem;
	sleepPressureData: number[];
	sleepPressureTrendInfo: LoadTrendItem;
	heartRateZoneData: number[];
	heartRateZoneItems: HeartRateZoneItem[];
};

export type ChartDataItem = {
	name: string;
	type: string;
	data: number[];
	itemStyle?: UTSJSONObject;
	lineStyle?: UTSJSONObject;
	areaStyle?: UTSJSONObject;
};

export type ChartAxis = {
	type: string;
	data: string[];
	axisLabel?: UTSJSONObject;
	axisLine?: UTSJSONObject;
};

export type ChartGrid = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	containLabel: boolean;
};

export type ChartTooltip = {
	trigger: string;
	textStyle?: UTSJSONObject;
};

export type ChartYAxis = {
	type: string;
	axisLine?: UTSJSONObject;
	axisLabel?: UTSJSONObject;
	splitLine?: UTSJSONObject;
};
