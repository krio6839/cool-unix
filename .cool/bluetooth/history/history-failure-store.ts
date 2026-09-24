import { bluetoothDatabase } from "../database";

/** 精确页失败账本表；主键是左闭右开范围的两个端点。 */
export const HISTORY_FAILURE_SCHEMA: string[] = [
	`CREATE TABLE IF NOT EXISTS vital_history_failures (
		from_sec INTEGER NOT NULL,
		to_sec INTEGER NOT NULL,
		timeout_count INTEGER NOT NULL,
		last_timeout_sec INTEGER NOT NULL,
		abandoned INTEGER NOT NULL DEFAULT 0,
		abandoned_at_sec INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(from_sec,to_sec)
	)`
];

/** 同一精确页连续确认失败三次后放弃；次数达到阈值后不再增长。 */
const ABANDON_FAILURE_COUNT = 3;

/** 一段精确历史页的失败审计记录，范围统一为左闭右开 `[fromSec, toSec)`。 */
export type HistoryFailureRecord = {
	fromSec: number;
	toSec: number;
	failureCount: number;
	lastFailureSec: number;
	abandoned: boolean;
	abandonedAtSec: number;
};

/** 只持久化历史页失败状态；不连接设备，也不修改 baseline/ready range。 */
class HistoryFailureStore {
	/** 按完整主键读取精确页；相交但边界不同的记录不会命中。 */
	private async get(fromSec: number, toSec: number): Promise<HistoryFailureRecord | null> {
		const result = await bluetoothDatabase.query(
			`SELECT from_sec,to_sec,timeout_count,last_timeout_sec,abandoned,abandoned_at_sec
			 FROM vital_history_failures WHERE from_sec=${Math.floor(fromSec)} AND to_sec=${Math.floor(toSec)}`
		);
		if (result == null) throw new Error("读取历史失败记录失败");
		if (result.rows.length == 0) return null;
		return this.fromRow(result.rows[0]);
	}

	/**
	 * 为精确页累计一次已确认失败。
	 *
	 * 调用方只应在历史读取失败且复探活成功后调用；发送失败、解析失败、落库失败和设备
	 * 失活都不属于页级失败。第三次把记录置为 abandoned，并保留第一次放弃时间。
	 */
	async recordFailure(
		fromSec: number,
		toSec: number,
		nowSec: number
	): Promise<HistoryFailureRecord> {
		const from = Math.floor(fromSec);
		const to = Math.floor(toSec);
		if (to <= from) throw new Error("历史失败范围无效");
		const existing = await this.get(from, to);
		const count = Math.min(ABANDON_FAILURE_COUNT, (existing?.failureCount ?? 0) + 1);
		const abandoned = count >= ABANDON_FAILURE_COUNT;
		const abandonedAt = abandoned
			? existing != null && existing.abandonedAtSec > 0
				? existing.abandonedAtSec
				: nowSec
			: 0;
		const saved = await bluetoothDatabase.transaction([
			`DELETE FROM vital_history_failures WHERE from_sec=${from} AND to_sec=${to}`,
			`INSERT INTO vital_history_failures
			 (from_sec,to_sec,timeout_count,last_timeout_sec,abandoned,abandoned_at_sec)
			 VALUES (${from},${to},${count},${Math.floor(nowSec)},${abandoned ? 1 : 0},${Math.floor(abandonedAt)})`
		]);
		if (saved == false) throw new Error("保存历史失败记录失败");
		return {
			fromSec: from,
			toSec: to,
			failureCount: count,
			lastFailureSec: Math.floor(nowSec),
			abandoned,
			abandonedAtSec: Math.floor(abandonedAt)
		} as HistoryFailureRecord;
	}

	/** 列出全部已放弃页，按起点升序，用于启动对账和测试页精确重读。 */
	async listAbandoned(): Promise<HistoryFailureRecord[]> {
		const result = await bluetoothDatabase.query(
			`SELECT from_sec,to_sec,timeout_count,last_timeout_sec,abandoned,abandoned_at_sec
			 FROM vital_history_failures WHERE abandoned=1 ORDER BY from_sec ASC`
		);
		if (result == null) throw new Error("读取已放弃历史范围失败");
		const records: HistoryFailureRecord[] = [];
		for (let i = 0; i < result.rows.length; i++) records.push(this.fromRow(result.rows[i]));
		return records;
	}

	/** 删除边界完全一致的一页记录；成功读取或明确无数据后调用。 */
	async clearRange(fromSec: number, toSec: number): Promise<void> {
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM vital_history_failures WHERE from_sec=${Math.floor(fromSec)} AND to_sec=${Math.floor(toSec)}`
			)) == false
		)
			throw new Error("清除历史失败记录失败");
	}

	/** 删除完整包含在 `[fromSec, toSec)` 内的记录，不影响仅部分相交的页。 */
	async clearWithin(fromSec: number, toSec: number): Promise<void> {
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM vital_history_failures WHERE from_sec>=${Math.floor(fromSec)} AND to_sec<=${Math.floor(toSec)}`
			)) == false
		)
			throw new Error("清除历史窗口失败记录失败");
	}

	/** 把 SQLite 行转换为领域字段；旧列名仅为迁移兼容，不向上层泄漏。 */
	private fromRow(row: unknown[]): HistoryFailureRecord {
		return {
			fromSec: parseInt(row[0] as string),
			toSec: parseInt(row[1] as string),
			// 数据库列沿用旧名，避免为纯语义更名引入一次破坏性迁移。
			failureCount: parseInt(row[2] as string),
			lastFailureSec: parseInt(row[3] as string),
			abandoned: parseInt(row[4] as string) == 1,
			abandonedAtSec: parseInt(row[5] as string)
		} as HistoryFailureRecord;
	}
}

/** 页级失败账本的唯一进程内入口。 */
export const historyFailureStore = new HistoryFailureStore();
