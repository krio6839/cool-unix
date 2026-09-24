import { bluetoothDatabase } from "../database";
import type { HistoryTimeRange } from "./coverage";

/** 本地已上传 PPI 最长保留 30 天；更早数据不再参与分类或历史补录。 */
export const HISTORY_PPI_RETENTION_SEC = 30 * 24 * 60 * 60;

/**
 * 本地 PPI 覆盖查询。
 *
 * 这里**只碰 `ppi_data`**。「设备已确认」的那一半由 `vital_ready_ranges` 承担，
 * 直接通过 `historyBaseline.listReadyRanges()` 读取——本文件不再提供转发方法，
 * 因为那会引入 `baseline.ts` ⇄ `coverage-service.ts` 的循环导入。
 */
class HistoryCoverageService {
	/** 返回保留窗口左端，最小为 Unix 秒 1，避免生成从 1970 年开始的无效区间。 */
	retentionStartSec(nowSec: number): number {
		return Math.max(1, nowSec - HISTORY_PPI_RETENTION_SEC);
	}

	/**
	 * 查询 `[fromSec, toSec)` 内本地已有的 PPI 秒。
	 *
	 * 返回值按时间升序；空区间直接返回空数组。数据库异常必须抛出，不能伪装成
	 * “本地没有数据”，否则分类会制造不存在的历史缺口。
	 */
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

/** PPI 覆盖查询的唯一进程内入口。 */
export const historyCoverage = new HistoryCoverageService();
