import { bluetoothDatabase } from "../database";
import type { HistoryTimeRange } from "./coverage";

export const HISTORY_PPI_RETENTION_SEC = 30 * 24 * 60 * 60;

/**
 * 本地 PPI 覆盖查询。
 *
 * 这里**只碰 `ppi_data`**。「设备已确认」的那一半由 `vital_ready_ranges` 承担，
 * 直接通过 `historyBaseline.listReadyRanges()` 读取——本文件不再提供转发方法，
 * 因为那会引入 `baseline.ts` ⇄ `coverage-service.ts` 的循环导入。
 */
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
}

export const historyCoverage = new HistoryCoverageService();
