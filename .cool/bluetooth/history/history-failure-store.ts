import { bluetoothDatabase } from "../database";

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

const ABANDON_FAILURE_COUNT = 3;

export type HistoryFailureRecord = {
	fromSec: number;
	toSec: number;
	failureCount: number;
	lastFailureSec: number;
	abandoned: boolean;
	abandonedAtSec: number;
};

/** 只持久化历史页失败状态；不连接设备，也不修改 baseline/ready range。 */
export class HistoryFailureStore {
	async get(fromSec: number, toSec: number): Promise<HistoryFailureRecord | null> {
		const result = await bluetoothDatabase.query(
			`SELECT from_sec,to_sec,timeout_count,last_timeout_sec,abandoned,abandoned_at_sec
			 FROM vital_history_failures WHERE from_sec=${Math.floor(fromSec)} AND to_sec=${Math.floor(toSec)}`
		);
		if (result == null) throw new Error("读取历史失败记录失败");
		if (result.rows.length == 0) return null;
		return this.fromRow(result.rows[0]);
	}

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

	async clearRange(fromSec: number, toSec: number): Promise<void> {
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM vital_history_failures WHERE from_sec=${Math.floor(fromSec)} AND to_sec=${Math.floor(toSec)}`
			)) == false
		)
			throw new Error("清除历史失败记录失败");
	}

	async clearWithin(fromSec: number, toSec: number): Promise<void> {
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM vital_history_failures WHERE from_sec>=${Math.floor(fromSec)} AND to_sec<=${Math.floor(toSec)}`
			)) == false
		)
			throw new Error("清除历史窗口失败记录失败");
	}

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

export const historyFailureStore = new HistoryFailureStore();
