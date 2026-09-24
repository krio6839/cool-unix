/** 连续时间范围，统一采用左闭右开 `[fromSec, toSec)`。 */
export type HistoryTimeRange = { fromSec: number; toSec: number };

/** 创建副本，保证区间工具不会修改调用方传入的对象。 */
function copyRange(range: HistoryTimeRange): HistoryTimeRange {
	return { fromSec: range.fromSec, toSec: range.toSec };
}

/**
 * 归一化区间集合。
 *
 * 输入可以乱序、重叠、首尾相接，并允许包含 `toSec <= fromSec` 的空区间；输出按起点
 * 升序，丢弃空区间，并合并重叠或相邻区间。返回值及其中的对象均为新建，不修改输入。
 */
export function normalizeRanges(items: HistoryTimeRange[]): HistoryTimeRange[] {
	const sorted: HistoryTimeRange[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.toSec <= item.fromSec) continue;
		let position = sorted.length;
		while (position > 0 && sorted[position - 1].fromSec > item.fromSec) position--;
		sorted.splice(position, 0, copyRange(item));
	}
	const result: HistoryTimeRange[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const item = sorted[i];
		if (result.length == 0) {
			result.push(copyRange(item));
			continue;
		}
		const last = result[result.length - 1];
		if (item.fromSec <= last.toSec) {
			if (item.toSec > last.toSec) last.toSec = item.toSec;
		} else result.push(copyRange(item));
	}
	return result;
}

/**
 * 把离散 Unix 秒压缩成连续区间。
 *
 * 只保留 `range` 内的秒，自动去重并排序；每个时间戳代表 `[second, second + 1)`。
 * 输出遵循左闭右开语义且已经归一化，输入数组不会被修改。
 */
export function rangesFromTimestamps(
	range: HistoryTimeRange,
	timestamps: number[]
): HistoryTimeRange[] {
	const seconds: number[] = [];
	for (let i = 0; i < timestamps.length; i++) {
		const value = timestamps[i];
		if (value < range.fromSec || value >= range.toSec || seconds.indexOf(value) >= 0) continue;
		let position = seconds.length;
		while (position > 0 && seconds[position - 1] > value) position--;
		seconds.splice(position, 0, value);
	}
	const result: HistoryTimeRange[] = [];
	for (let i = 0; i < seconds.length; i++) {
		const value = seconds[i];
		const last = result.length == 0 ? null : result[result.length - 1];
		if (last != null && value == last.toSec) last.toSec = value + 1;
		else result.push({ fromSec: value, toSec: value + 1 });
	}
	return result;
}

/**
 * 计算区间差集 `base - removed`。
 *
 * 两侧输入都可以乱序、重叠或包含空区间，函数会先归一化；超出 `base` 的 removed
 * 自动忽略。返回结果按起点升序、互不重叠，不修改任何输入对象。
 */
export function subtractRanges(
	base: HistoryTimeRange[],
	removed: HistoryTimeRange[]
): HistoryTimeRange[] {
	const result: HistoryTimeRange[] = [];
	const normalizedBase = normalizeRanges(base);
	const normalizedRemoved = normalizeRanges(removed);
	for (let i = 0; i < normalizedBase.length; i++) {
		const source = normalizedBase[i];
		let cursor = source.fromSec;
		for (let j = 0; j < normalizedRemoved.length; j++) {
			const cut = normalizedRemoved[j];
			if (cut.toSec <= cursor) continue;
			if (cut.fromSec >= source.toSec) break;
			if (cut.fromSec > cursor)
				result.push({ fromSec: cursor, toSec: Math.min(cut.fromSec, source.toSec) });
			if (cut.toSec > cursor) cursor = cut.toSec;
			if (cursor >= source.toSec) break;
		}
		if (cursor < source.toSec) result.push({ fromSec: cursor, toSec: source.toSec });
	}
	return result;
}

/**
 * 统计区间集合覆盖的唯一秒数。
 *
 * 先归一化再求和，因此重叠和相邻区间不会重复计数，空区间计为 0。
 */
export function countRangeSeconds(ranges: HistoryTimeRange[]): number {
	let total = 0;
	const normalized = normalizeRanges(ranges);
	for (let i = 0; i < normalized.length; i++) total += normalized[i].toSec - normalized[i].fromSec;
	return total;
}
