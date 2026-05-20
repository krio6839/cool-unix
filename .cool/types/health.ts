import type { TrendType } from "./home";

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

export type UserInfoData = {
	name: string;
	lastLoginTime: string;
};

export type LoadZoneItem = {
	name: string;
	color?: string;
	percentage: number;
	rightText?: string;
};

export type LoadTrendItem = {
	max: number;
	maxDay: string;
	min: number;
	minDay: string;
	average: number;
};

export type TimeValueItem = {
	time: string;
	value: number;
};

export type SleepTrendItem = {
	max: number;
	maxDay: string;
	min: number;
	minDay: string;
	average: string;
};

export type RecoverySleep = {
	percentage: number;
	duration: string;
};

export type SleepPattern = {
	bedtimes: string[];
	wakeTimes: string[];
	avgBedtime: string;
	avgWakeTime: string;
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
