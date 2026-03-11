// #ifdef H5
import type { EChartsOption } from "echarts";
//@ts-ignore
export type ChartOption = EChartsOption;
// #endif

//#ifndef H5
//@ts-ignore
export type ChartOption = UTSJSONObject;
//#endif

// 图表组件属性类型
export type ChartProps = {
	title?: string;
	option: string;
	height?: number;
	showFooter?: boolean;
};

export type ChartStats = {
	average: number;
	max: number;
	maxIndex: number;
	min: number;
	minIndex: number;
};
