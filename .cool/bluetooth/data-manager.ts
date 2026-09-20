/**
 * 蓝牙数据管理类
 *
 * **只负责数据库读写**：建表、增删查改、清理。上传编排（批循环、退避、定时器、
 * 设备身份）在 `upload.ts`，两者是单向依赖：`upload.ts` 读这里的方法，这里不
 * 认识上传。判定与基准时间在 `history/baseline.ts`。
 */
import { bluetoothDatabase } from "./database";
import { historyBaseline, BASELINE_SCHEMA } from "./history/baseline";
import { logger } from "../service/logger";
import type { SelectSqlResult } from "@/uni_modules/meibao-Sqlite";
import type {
	SleepData,
	PpiData,
	HeartRateRecord,
	RealtimeBroadcastRecord,
	StoreRealtimeBroadcastInput,
	UploadTableStats,
	HistorySessionDiagnostics
} from "./types";

/**
 * 单次查询待上传 PPI 的取数上限（约 5 分钟的数据）。
 * 上传侧一轮会反复调用它直到排空，所以这里只管「一次取多少」，不管「一轮传几批」。
 */
const PPI_UPLOAD_PAGE_SIZE = 300;

/**
 * 蓝牙数据管理器类
 * 提供数据存储、查询等功能
 */
export class BluetoothDataManager {
	private databaseReady: Promise<boolean>;

	/**
	 * 构造函数
	 * 初始化数据库
	 */
	constructor() {
		this.databaseReady = this.initDatabase();
	}

	/**
	 * 初始化数据库
	 */
	private async initDatabase(): Promise<boolean> {
		const opened = await bluetoothDatabase.open();
		if (opened == false) return false;
		// 基准时间跨冷启动保留。数据库重开或 App 重启都不能让已记账的时间重新变成缺口；
		// 产品在重新绑定时由 clearAllData() 一并清除。
		try {
			if ((await bluetoothDatabase.transaction(BASELINE_SCHEMA)) == false) return false;
			await historyBaseline.initializeIfMissing(Math.floor(Date.now() / 1000));
			return true;
		} catch (error) {
			logger.error("bluetooth", "[BOOM-DATA] 初始化基准时间表失败", error);
			return false;
		}
	}

	private async ensureDatabaseReady(): Promise<boolean> {
		const ready = await this.databaseReady;
		if (ready == true && bluetoothDatabase.getIsOpen() == true) {
			return true;
		}
		this.databaseReady = this.initDatabase();
		return await this.databaseReady;
	}

	private async execute(sql: string): Promise<boolean> {
		const ready = await this.ensureDatabaseReady();
		if (ready == false) return false;
		return bluetoothDatabase.execute(sql);
	}

	private async query(sql: string): Promise<SelectSqlResult | null> {
		const ready = await this.ensureDatabaseReady();
		if (ready == false) return null;
		return bluetoothDatabase.query(sql);
	}

	/**
	 * 批量存储历史心率血氧数据到 ppi_data 表
	 * 将多条记录拼接为单条 INSERT OR IGNORE SQL，
	 * 将 N 次 SQLite execute 减为 1 次，显著降低调度开销。
	 * @param records 历史心率记录数组
	 * @returns 是否插入成功（false 表示数据库错误；重复 id 由 INSERT OR IGNORE 静默跳过）
	 */
	async storeHistoricalHeartRateRecordsBatch(records: Array<HeartRateRecord>): Promise<boolean> {
		if (records.length == 0) {
			return true;
		}
		const values = records
			.map(
				(r) =>
					`('${r.timestamp}', ${r.timestamp}, ${r.heartRate}, ${r.bloodOxygen}, ${r.ppi}, 0)`
			)
			.join(",");
		const sql = `INSERT OR IGNORE INTO ppi_data (id, timestamp, hr, spo2, ppi, uploaded) VALUES ${values}`;
		return this.execute(sql);
	}
	async storeBroadcastSleepActivity(timestamp: number, activity: number): Promise<boolean> {
		if (timestamp <= 0 || activity < 0 || activity > 7) return false;
		return this.execute(
			"INSERT OR REPLACE INTO sleep_status_data (timestamp, activity) VALUES (" +
				timestamp +
				", " +
				activity +
				")"
		);
	}

	async getSleepActivitiesBetween(
		startSec: number,
		endSec: number
	): Promise<Map<number, number>> {
		const activities = new Map<number, number>();
		if (endSec <= startSec) return activities;
		const result = await this.query(
			"SELECT timestamp, activity FROM sleep_status_data WHERE timestamp >= " +
				startSec +
				" AND timestamp < " +
				endSec +
				" ORDER BY timestamp ASC"
		);
		if (result == null) return activities;
		for (let i = 0; i < result.rows.length; i++) {
			activities.set(
				parseInt(result.rows[i][0] as string),
				parseInt(result.rows[i][1] as string)
			);
		}
		return activities;
	}

	async storeBroadcastPpiData(
		timestamp: number,
		hr: number,
		spo2: number,
		ppi: number
	): Promise<boolean> {
		// 0 是设备返回的有效原始值；广播时间已在调用方校验，不能据此丢弃上传秒。
		if (timestamp <= 0) return false;
		const sql = `INSERT OR IGNORE INTO ppi_data (id, timestamp, hr, spo2, ppi, uploaded) VALUES ('${timestamp}', ${timestamp}, ${hr}, ${spo2}, ${ppi}, 0)`;
		return this.execute(sql);
	}

	/**
	 * 存储 0x50 广播实时数据（本地首页展示使用，不上传）
	 */
	async storeRealtimeBroadcast(
		input: StoreRealtimeBroadcastInput
	): Promise<RealtimeBroadcastRecord | null> {
		const record = this.makeRealtimeBroadcastRecord(input);
		const ok = await this.storeRealtimeBroadcastRecord(record);
		if (ok == true) return record;
		return null;
	}

	private makeRealtimeBroadcastRecord(
		input: StoreRealtimeBroadcastInput
	): RealtimeBroadcastRecord {
		const r = input.broadcast;
		return {
			id: `${r.receivedAt}-${r.utc}`,
			timestamp: r.utc,
			receivedAt: r.receivedAt,
			utc: r.utc,
			voltageMv: r.voltageMv,
			ppgAttached: r.ppgAttached,
			behavior: r.behavior,
			activity: r.activity,
			hr: r.hr,
			ppi: r.ppi,
			spo2: Math.round(r.spo2Pct * 10),
			bhr: r.bhr,
			eventSeq: r.eventSeq,
			hasNewEvent: r.hasNewEvent,
			batteryStatus: r.batteryStatus,
			rmssd: r.hrvMs,
			stepsEveryday: r.stepsEveryday,
			calorieEveryday: r.calorieEveryday,
			rawHex: input.rawHex,
			vHex: input.vHex,
			deviceId: input.deviceId
		} as RealtimeBroadcastRecord;
	}

	private async storeRealtimeBroadcastRecord(record: RealtimeBroadcastRecord): Promise<boolean> {
		const rawHex = this.escapeSqlText(record.rawHex);
		const vHex = this.escapeSqlText(record.vHex);
		const deviceId = this.escapeSqlText(record.deviceId);
		const ppgAttached = record.ppgAttached == true ? 1 : 0;
		const hasNewEvent = record.hasNewEvent == true ? 1 : 0;
		const sql =
			"INSERT OR REPLACE INTO realtime_broadcast_data " +
			"(id, timestamp, received_at, utc, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id) VALUES " +
			`('${record.id}', ${record.timestamp}, ${record.receivedAt}, ${record.utc}, ${record.voltageMv}, ${ppgAttached}, ${record.behavior}, ${record.activity}, ${record.hr}, ${record.ppi}, ${record.spo2}, ${record.bhr}, ${record.eventSeq}, ${hasNewEvent}, ${record.batteryStatus}, ${record.rmssd}, ${record.stepsEveryday}, ${record.calorieEveryday}, '${rawHex}', '${vHex}', '${deviceId}')`;
		return this.execute(sql);
	}

	/**
	 * 获取最后一条 0x50 广播实时数据
	 */
	async getLatestRealtimeBroadcastRecord(): Promise<RealtimeBroadcastRecord | null> {
		const sql =
			"SELECT id, timestamp, received_at, utc, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id FROM realtime_broadcast_data ORDER BY received_at DESC LIMIT 1";
		const result = await this.query(sql);
		if (result == null || result.rows.length == 0) {
			return null;
		}
		return this.parseRealtimeBroadcastRow(result.rows[0]);
	}

	private escapeSqlText(value: string): string {
		return value.split("'").join("''");
	}

	private parsePpiDataRow(row: Array<string>): PpiData {
		return {
			id: row[0] as string,
			timestamp: parseInt(row[1] as string),
			hr: parseInt(row[2] as string),
			spo2: parseInt(row[3] as string),
			ppi: parseInt(row[4] as string),
			uploaded: parseInt(row[5] as string) == 1
		} as PpiData;
	}

	private parseRealtimeBroadcastRow(row: Array<string>): RealtimeBroadcastRecord {
		return {
			id: row[0] as string,
			timestamp: parseInt(row[1] as string),
			receivedAt: parseInt(row[2] as string),
			utc: parseInt(row[3] as string),
			voltageMv: parseInt(row[4] as string),
			ppgAttached: parseInt(row[5] as string) == 1,
			behavior: parseInt(row[6] as string),
			activity: parseInt(row[7] as string),
			hr: parseInt(row[8] as string),
			ppi: parseInt(row[9] as string),
			spo2: parseInt(row[10] as string),
			bhr: parseInt(row[11] as string),
			eventSeq: parseInt(row[12] as string),
			hasNewEvent: parseInt(row[13] as string) == 1,
			batteryStatus: parseInt(row[14] as string),
			rmssd: parseInt(row[15] as string),
			stepsEveryday: parseInt(row[16] as string),
			calorieEveryday: parseInt(row[17] as string),
			rawHex: row[18] as string,
			vHex: row[19] as string,
			deviceId: row[20] as string
		} as RealtimeBroadcastRecord;
	}

	private parseSleepDataRow(row: Array<string>): SleepData {
		return {
			id: row[0] as string,
			reportTimestamp: parseInt(row[1] as string),
			bedtime: parseInt(row[2] as string),
			sleepTime: parseInt(row[3] as string),
			wakeTime: parseInt(row[4] as string),
			getupTime: parseInt(row[5] as string),
			detail: (row[6] ?? "") as string,
			uploaded: parseInt(row[7] as string) == 1
		} as SleepData;
	}

	private async queryCount(sql: string): Promise<number> {
		const result = await this.query(sql);
		if (result == null || result.rows.length == 0) {
			return 0;
		}
		return parseInt(result.rows[0][0] as string);
	}

	private async queryTimestamp(sql: string): Promise<number> {
		const result = await this.query(sql);
		if (result == null || result.rows.length == 0 || result.rows[0][0] == null) {
			return 0;
		}
		return parseInt(result.rows[0][0] as string);
	}

	async getUploadTableStats(): Promise<UploadTableStats[]> {
		const stats: UploadTableStats[] = [];
		stats.push(
			await this.getUploadStatsForTable("ppi_data", "timestamp"),
			await this.getUploadStatsForTable("sleep_data", "report_timestamp")
		);
		return stats;
	}

	/** 供本地测试页排查“未读取、未落库、未上传”三个阶段。 */
	async getHistorySessionDiagnostics(): Promise<HistorySessionDiagnostics> {
		const baseline = await historyBaseline.getBaseline();
		const nowSec = Math.floor(Date.now() / 1000);
		const ceiling = historyBaseline.stableCeiling(nowSec);
		const gaps = await historyBaseline.listRepairGaps(nowSec);
		const readyRanges = await historyBaseline.listReadyRanges();
		return {
			baselineSec: baseline,
			stableCeilingSec: ceiling,
			gapGroups: gaps.length,
			gapSeconds: historyBaseline.sumRepairSeconds(gaps),
			readyRanges: readyRanges.length,
			unuploadedCount: await this.getUnuploadedPpiCount(),
			earliestUnuploadedSec: await this.queryTimestamp(
				"SELECT MIN(timestamp) FROM ppi_data WHERE uploaded = 0"
			),
			latestUnuploadedSec: await this.queryTimestamp(
				"SELECT MAX(timestamp) FROM ppi_data WHERE uploaded = 0"
			)
		} as HistorySessionDiagnostics;
	}

	private async getUploadStatsForTable(
		tableName: string,
		timestampColumn: string
	): Promise<UploadTableStats> {
		const total = await this.queryCount("SELECT COUNT(*) FROM " + tableName);
		const uploaded = await this.queryCount(
			"SELECT COUNT(*) FROM " + tableName + " WHERE uploaded = 1"
		);
		const unuploaded = await this.queryCount(
			"SELECT COUNT(*) FROM " + tableName + " WHERE uploaded = 0"
		);
		const earliestTimestamp = await this.queryTimestamp(
			"SELECT MIN(" + timestampColumn + ") FROM " + tableName
		);
		const latestTimestamp = await this.queryTimestamp(
			"SELECT MAX(" + timestampColumn + ") FROM " + tableName
		);
		const latestUploadedTimestamp = await this.queryTimestamp(
			"SELECT MAX(" + timestampColumn + ") FROM " + tableName + " WHERE uploaded = 1"
		);
		const latestUnuploadedTimestamp = await this.queryTimestamp(
			"SELECT MAX(" + timestampColumn + ") FROM " + tableName + " WHERE uploaded = 0"
		);
		return {
			tableName,
			total,
			uploaded,
			unuploaded,
			earliestTimestamp,
			latestTimestamp,
			latestUploadedTimestamp,
			latestUnuploadedTimestamp
		} as UploadTableStats;
	}

	/**
	 * 获取PPI数据总数
	 * @returns ppi_data表中的总记录数
	 */
	async getPpiDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM ppi_data");
	}

	/**
	 * 获取 0x50 广播实时数据总数
	 */
	async getRealtimeBroadcastDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM realtime_broadcast_data");
	}

	/**
	 * 获取最近 N 条 0x50 广播实时数据
	 */
	async getRecentRealtimeBroadcastRecords(limit: number): Promise<RealtimeBroadcastRecord[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		const sql =
			"SELECT id, timestamp, received_at, utc, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id FROM realtime_broadcast_data ORDER BY received_at DESC LIMIT " +
			safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}

		const records: RealtimeBroadcastRecord[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			records.push(this.parseRealtimeBroadcastRow(result.rows[i]));
		}
		return records;
	}

	/**
	 * 获取最后一条 PPI 历史数据
	 */
	async getLatestPpiData(): Promise<PpiData | null> {
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data ORDER BY timestamp DESC LIMIT 1";
		const result = await this.query(sql);
		if (result == null || result.rows.length == 0) {
			return null;
		}
		const row = result.rows[0];
		return this.parsePpiDataRow(row);
	}

	/**
	 * 获取最近 N 条 PPI 历史数据
	 */
	async getRecentPpiData(limit: number): Promise<PpiData[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data ORDER BY timestamp DESC LIMIT " +
			safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}

		const dataList: PpiData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			dataList.push(this.parsePpiDataRow(result.rows[i]));
		}
		return dataList;
	}

	async getRecentPpiDataByUploadStatus(limit: number, uploaded: boolean): Promise<PpiData[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		const uploadedValue = uploaded == true ? 1 : 0;
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data WHERE uploaded = " +
			uploadedValue.toString() +
			" ORDER BY timestamp DESC LIMIT " +
			safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}

		const dataList: PpiData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			dataList.push(this.parsePpiDataRow(result.rows[i]));
		}
		return dataList;
	}

	/**
	 * 取一批待上传的 PPI 数据（最早的在前）。
	 * @param maxTimestamp 只取不晚于该时间戳的记录（上传时的本轮窗口上界）；null 表示不设上界
	 */
	async getUnuploadedPpiData(maxTimestamp: number | null = null): Promise<PpiData[]> {
		let where = "uploaded = 0";
		if (maxTimestamp != null) where += " AND timestamp <= " + maxTimestamp.toString();
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data WHERE " +
			where +
			" ORDER BY timestamp ASC LIMIT " +
			PPI_UPLOAD_PAGE_SIZE;
		const result = await this.query(sql);

		if (result == null) {
			throw new Error("读取待上传 PPI 数据失败");
		}

		const dataList: PpiData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			dataList.push(this.parsePpiDataRow(result.rows[i]));
		}
		return dataList;
	}

	async getUnuploadedPpiCount(): Promise<number> {
		const result = await this.query("SELECT COUNT(*) FROM ppi_data WHERE uploaded = 0");
		if (result == null || result.rows.length == 0) throw new Error("读取待上传 PPI 数量失败");
		return parseInt(result.rows[0][0] as string);
	}

	/** 本轮上传窗口内的剩余数量：只统计不晚于 cutoff 的记录。 */
	async getUnuploadedPpiCountUpTo(cutoff: number): Promise<number> {
		const result = await this.query(
			"SELECT COUNT(*) FROM ppi_data WHERE uploaded = 0 AND timestamp <= " + cutoff.toString()
		);
		if (result == null || result.rows.length == 0) throw new Error("读取待上传 PPI 数量失败");
		return parseInt(result.rows[0][0] as string);
	}

	/** 已落库的最新秒，用作上传的窗口上界。 */
	async getLatestPpiTimestamp(): Promise<number> {
		return this.queryTimestamp("SELECT MAX(timestamp) FROM ppi_data");
	}

	/**
	 * 标记PPI数据为已上传
	 * @param ids 数据ID数组
	 */
	async markPpiDataAsUploaded(ids: string[]): Promise<boolean> {
		if (ids.length == 0) {
			return true;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE ppi_data SET uploaded = 1 WHERE id IN (${idList})`;
		return await this.execute(sql);
	}

	/** 仅清理已上传且超出本地 30 天审计窗口的 PPI；未上传行必须保留。 */
	async pruneUploadedPpiBefore(boundarySec: number): Promise<number> {
		const ready = await this.ensureDatabaseReady();
		if (ready == false) throw new Error("数据库未就绪，不能清理旧 PPI 数据");
		const countResult = await bluetoothDatabase.query(
			`SELECT COUNT(*) FROM ppi_data WHERE uploaded=1 AND timestamp<${boundarySec}`
		);
		if (countResult == null || countResult.rows.length == 0)
			throw new Error("读取待清理 PPI 数量失败");
		const count = parseInt(countResult.rows[0][0] as string);
		if (count == 0) return 0;
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM ppi_data WHERE uploaded=1 AND timestamp<${boundarySec}`
			)) == false
		)
			throw new Error("清理旧 PPI 数据失败");
		logger.info("bluetooth", `[BOOM-DATA] 清理已上传 PPI: before=${boundarySec}, count=${count}`);
		return count;
	}

	/**
	 * 清空所有数据（包括睡眠数据、PPI数据、广播数据）
	 */
	async clearAllData(): Promise<void> {
		logger.info("bluetooth", "清空所有数据库数据");
		const ready = await this.ensureDatabaseReady();
		if (ready == false) {
			logger.error("bluetooth", "[BOOM-DATA] 数据库未就绪，不能清空旧设备数据");
			throw new Error("数据库未就绪，不能清空旧设备数据");
		}
		const cleared = await bluetoothDatabase.transaction([
			"DELETE FROM sleep_data",
			"DELETE FROM ppi_data",
			"DELETE FROM sleep_status_data",
			"DELETE FROM realtime_broadcast_data",
			"DELETE FROM vital_ready_ranges",
			"DELETE FROM vital_sync_state"
		]);
		if (cleared == false) {
			logger.error("bluetooth", "[BOOM-DATA] 清空旧设备数据失败");
			throw new Error("清空旧设备数据失败");
		}
		logger.info("bluetooth", "数据库数据清空完成");
	}

	/** 显式清空当前绑定的基准时间与已记账区间，不影响已经保存和待上传的每秒数据。 */
	async clearHistorySession(): Promise<void> {
		try {
			if ((await this.clearHistorySessionRaw()) == false)
				throw new Error("清空基准补录进度失败");
		} catch (error) {
			logger.error("bluetooth", "[BOOM-DATA] 清空基准补录进度失败", error);
			throw error;
		}
		logger.info("bluetooth", "已清空当前绑定的基准补录进度");
	}

	private async clearHistorySessionRaw(): Promise<boolean> {
		if ((await bluetoothDatabase.execute("DELETE FROM vital_ready_ranges")) == false)
			throw new Error("清空已记账区间失败");
		if ((await bluetoothDatabase.execute("DELETE FROM vital_sync_state")) == false)
			throw new Error("清空基准时间失败");
		return true;
	}

	/**
	 * 存储睡眠数据
	 * 用 INSERT OR IGNORE 防御性去重：相同 reportTimestamp 已存在则静默跳过；
	 * 配合 fetchAllSleepData 断点续传后，从源头避免重复存储与 uploaded 状态被重置。
	 *
	 * 返回是否真的写进去了：`INSERT OR IGNORE` 会把约束冲突（例如旧表残留的
	 * NOT NULL 列）当成"可忽略"而不报错，只看 execute 的返回值会把"一行都没写"
	 * 当成成功。调用方必须按这个返回值计数，否则日志里 saved 会涨而库是空的。
	 * @param sleepData 睡眠数据
	 * @returns 行是否落入库中
	 */
	async storeSleepData(sleepData: SleepData): Promise<boolean> {
		const { reportTimestamp, bedtime, sleepTime, wakeTime, getupTime, detail } = sleepData;
		const sleepId = reportTimestamp.toString();
		const safeDetail = this.escapeSqlText(detail);
		const sleepSql = `INSERT OR IGNORE INTO sleep_data
			(id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, detail, uploaded)
			VALUES ('${sleepId}', ${reportTimestamp}, ${bedtime}, ${sleepTime}, ${wakeTime}, ${getupTime}, '${safeDetail}', 0)`;
		const ok = await this.execute(sleepSql);
		if (ok == false) {
			logger.error("bluetooth", `[BOOM] 睡眠数据写入失败: report_timestamp=${reportTimestamp}`);
		}
		return ok;
	}

	/**
	 * 获取未上传的睡眠数据
	 * @returns 未上传的睡眠数据数组
	 */
	async getUnuploadedSleepData(): Promise<SleepData[]> {
		const sql =
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, detail FROM sleep_data WHERE uploaded = 0";
		const result = await this.query(sql);

		if (result == null) {
			throw new Error("读取待上传睡眠数据失败");
		}

		const sleepDataList: SleepData[] = [];

		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			sleepDataList.push({
				id: row[0],
				reportTimestamp: parseInt(row[1] as string),
				bedtime: parseInt(row[2] as string),
				sleepTime: parseInt(row[3] as string),
				wakeTime: parseInt(row[4] as string),
				getupTime: parseInt(row[5] as string),
				detail: (row[6] ?? "") as string,
				uploaded: false
			});
		}

		return sleepDataList;
	}

	async getSleepDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM sleep_data");
	}

	async getRecentSleepData(limit: number, uploaded: boolean | null): Promise<SleepData[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		let sql =
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, detail, uploaded FROM sleep_data";
		if (uploaded != null) {
			sql += uploaded == true ? " WHERE uploaded = 1" : " WHERE uploaded = 0";
		}
		sql += " ORDER BY report_timestamp DESC LIMIT " + safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}

		const sleepDataList: SleepData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			sleepDataList.push(this.parseSleepDataRow(result.rows[i]));
		}
		return sleepDataList;
	}

	/**
	 * 标记睡眠数据为已上传
	 * @param ids 睡眠数据ID数组
	 */
	async markSleepAsUploaded(ids: string[]): Promise<boolean> {
		if (ids.length == 0) {
			return true;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE sleep_data SET uploaded = 1 WHERE id IN (${idList})`;
		return await this.execute(sql);
	}
}

/**
 * 蓝牙数据管理器实例
 */
export const bluetoothDataManager = new BluetoothDataManager();
