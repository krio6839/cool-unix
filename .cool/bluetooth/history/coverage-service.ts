import { bluetoothDatabase } from "../database";
import {
	analyzeLocalCoverage,
	type HistoryTimeRange,
	type LocalCoverageSnapshot
} from "./coverage";

export const HISTORY_PPI_RETENTION_SEC = 30 * 24 * 60 * 60;

class HistoryCoverageService {
	retentionStartSec(nowSec: number): number {
		return Math.max(1, nowSec - HISTORY_PPI_RETENTION_SEC);
	}

	async getPpiTimestamps(range: HistoryTimeRange): Promise<number[]> {
		if (range.toSec <= range.fromSec) return [];
		const result = await bluetoothDatabase.query(
			`SELECT timestamp FROM ppi_data WHERE timestamp>=${range.fromSec} AND timestamp<${range.toSec} ORDER BY timestamp ASC`
		);
		if (result == null) throw new Error("读取本地 PPI 覆盖失败");
		const values: number[] = [];
		for (let i = 0; i < result.rows.length; i++) values.push(parseInt(result.rows[i][0] as string));
		return values;
	}

	async getCheckedRanges(range: HistoryTimeRange): Promise<HistoryTimeRange[]> {
		if (range.toSec <= range.fromSec) return [];
		const result = await bluetoothDatabase.query(
			`SELECT from_sec,to_sec FROM vital_history_ranges WHERE from_sec<${range.toSec} AND to_sec>${range.fromSec} ORDER BY from_sec ASC`
		);
		if (result == null) throw new Error("读取历史确认范围失败");
		const values: HistoryTimeRange[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			values.push({
				fromSec: parseInt(result.rows[i][0] as string),
				toSec: parseInt(result.rows[i][1] as string)
			});
		}
		return values;
	}

	async inspect(range: HistoryTimeRange): Promise<LocalCoverageSnapshot> {
		const timestamps = await this.getPpiTimestamps(range);
		const checkedRanges = await this.getCheckedRanges(range);
		return analyzeLocalCoverage(range, timestamps, checkedRanges);
	}
}

export const historyCoverage = new HistoryCoverageService();
