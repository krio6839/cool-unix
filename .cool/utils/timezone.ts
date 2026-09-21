/**
 * App 对外时间的统一格式化入口。
 *
 * 默认固定使用北京时间，避免日志、上传正文和 `timezone` 字段各用一套规则。
 * 本地存储 `boom_timezone_mode=system` 时改为跟随手机时区；删除或写入其他值
 * 都回落到北京时间。
 */

import { storage } from "./storage";

const BEIJING_OFFSET_MINUTES = 8 * 60;
const TIMEZONE_MODE_KEY = "boom_timezone_mode";

export type AppTimezoneMode = "beijing" | "system";

let cachedMode: AppTimezoneMode | null = null;

function pad(value: number, length: number = 2): string {
	return value.toString().padStart(length, "0");
}

export function getAppTimezoneMode(): AppTimezoneMode {
	const current = cachedMode;
	if (current != null) return current;
	try {
		const mode: AppTimezoneMode =
			storage.get(TIMEZONE_MODE_KEY) == "system" ? "system" : "beijing";
		cachedMode = mode;
		return mode;
	} catch (_e) {
		cachedMode = "beijing";
		return "beijing";
	}
}

/** 本地持久化入口；当前不挂设置页，后续 UI 直接复用这一方法。 */
export function setAppTimezoneMode(mode: AppTimezoneMode): void {
	if (mode == "system") storage.set(TIMEZONE_MODE_KEY, mode, 0);
	else storage.remove(TIMEZONE_MODE_KEY);
	cachedMode = mode;
}

function followsSystemTimezone(): boolean {
	return getAppTimezoneMode() == "system";
}

function timezoneOffsetMinutes(timezone: string): number {
	const negative = timezone.startsWith("-");
	const raw = negative ? timezone.substring(1) : timezone;
	const parts = raw.split(":");
	if (parts.length != 2) return BEIJING_OFFSET_MINUTES;
	const hours = parseInt(parts[0]);
	const minutes = parseInt(parts[1]);
	if (isNaN(hours) == true || isNaN(minutes) == true) return BEIJING_OFFSET_MINUTES;
	const value = hours * 60 + minutes;
	return negative ? -value : value;
}

export function formatDateTimeInTimezone(
	timestamp: number,
	timezone: string,
	separator: string = " ",
	includeMilliseconds: boolean = false
): string {
	const date = new Date(timestamp + timezoneOffsetMinutes(timezone) * 60 * 1000);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	const hours = date.getUTCHours();
	const minutes = date.getUTCMinutes();
	const seconds = date.getUTCSeconds();
	const milliseconds = date.getUTCMilliseconds();
	let result = `${year}-${pad(month)}-${pad(day)}`;
	result = `${result}${separator}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
	if (includeMilliseconds == true) result = `${result}.${pad(milliseconds, 3)}`;
	return result;
}

export function formatAppDateTime(
	timestamp: number,
	separator: string = " ",
	includeMilliseconds: boolean = false
): string {
	return formatDateTimeInTimezone(
		timestamp,
		getAppTimezone(timestamp),
		separator,
		includeMilliseconds
	);
}

export function getAppTimezone(timestamp: number = Date.now()): string {
	if (followsSystemTimezone() == false) return "08:00";
	const minutesEast = -new Date(timestamp).getTimezoneOffset();
	const sign = minutesEast < 0 ? "-" : "";
	const absolute = Math.abs(minutesEast);
	return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function formatAppIsoTime(timestamp: number): string {
	const timezone = getAppTimezone(timestamp);
	const sign = timezone.startsWith("-") ? "" : "+";
	return `${formatAppDateTime(timestamp, "T", true)}${sign}${timezone}`;
}

export function formatAppClock(timestamp: number): string {
	return formatAppDateTime(timestamp).substring(11).replace(/:/g, "");
}

export function formatAppDay(timestamp: number): string {
	return formatAppDateTime(timestamp).substring(0, 10).replace(/-/g, "");
}
