// 健康项目类型
export type HealthItem = {
	label: string;
	value: string | number;
	onClick?: () => void;
};

export * from "./chart";
