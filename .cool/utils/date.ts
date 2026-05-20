import { dayUts } from "../utils/day";
import type { DateRange } from "../types";

type Time = Date | string | number | null;

// 格式化当前日期
export function formatDate(date: Time, format: string = "YYYY-MM-DD") {
	return dayUts(date).format(format);
}

export function getDateRange(days: number): DateRange {
	const endDate = dayUts().format("YYYY-MM-DD");
	const startDate = dayUts().subtract(days, "day").format("YYYY-MM-DD");
	return { startDate, endDate };
}
