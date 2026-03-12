// 健康项目类型
export type HealthItem = {
	label: string;
	value: string | number;
	onClick?: () => void;
};

export type CanvasConfig = {
	backgroundColor?: string;
	startColor?: string;
	endColor?: string;
	dotColor?: string;
};

export type EnergyItem = {
	label: string;
	value: number;
};

export type MetricItem = {
	label: string;
	value: string;
	iconPath: string;
	activeIconPath: string;
};

export type TsbReferenceItem = {
	range: string;
	status: string;
};

export * from "./chart";
