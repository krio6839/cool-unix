// 日期项类型
export type DateItem = {
	week: string;
	date: string;
	timestamp: number;
};

// 打卡状态类型
export type CheckinStatus = {
	morning: boolean;
	noon: boolean;
	evening: boolean;
};

// 日志条目类型
export type LogItem = {
	title: string;
	icon: string;
	iconColor: string;
	isAuto: boolean;
	time: string;
};

// 运动峰值时刻类型
export type PeakMoment = {
	time: string;
	value: number;
};

// 运动数据子项类型
export type SportDataItem = {
	steps: string;
	calories: string;
	distance: string;
	averagePace: string;
};

// 运动数据类型
export type SportData = {
	peakMoments: PeakMoment[];
	data: SportDataItem;
};

// 默认条目类型
export type DefaultItem = {
	id: number;
	name: string;
	value: string | number | boolean;
	type: "drink" | "boolean" | "volume" | "amount";
	icon?: string;
	enabled?: boolean;
};

// 时间范围类型
export type TimeRange = "week" | "month" | "year";

// 标签类型
export type TabType = "behavior" | "sport";
