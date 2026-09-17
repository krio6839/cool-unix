/**
 * 蓝牙数据管理类
 * 负责蓝牙数据的存储、管理和上传
 */
import { bluetoothDatabase } from "./database";
import { historyBaseline, BASELINE_SCHEMA } from "./history/baseline";
import { HISTORY_PPI_RETENTION_SEC } from "./history/coverage-service";
import { request } from "../service";
import { logger } from "../service/logger";
import { dayUts } from "../utils/day";
import { UPLOAD_PPI_URL, UPLOAD_SLEEP_URL } from "./constants";
import type { SelectSqlResult } from "@/uni_modules/meibao-Sqlite";
import type {
	SleepData,
	PpiUploadRequest,
	SleepUploadRequest,
	SleepUploadDataItem,
	PpiDataItem,
	PpiData,
	HeartRateRecord,
	RealtimeBroadcastRecord,
	StoreRealtimeBroadcastInput,
	UploadTableStats,
	HistorySessionDiagnostics
} from "./types";

/**
 * 失败后的退避。失败批保持 `uploaded=0`，但不要随每次触发反复重试——
 * 触发点里有整分钟和 60 秒定时兜底，不退避就会把失败请求打成密集重试。
 */
const UPLOAD_FAILURE_BACKOFF_MS = 60 * 1000;
/** 单个请求最多 300 秒数据，每轮最多 10 批，防止长期占用上传通道。 */
const PPI_UPLOAD_MAX_RECORDS = 300;
const PPI_UPLOAD_MAX_BATCHES = 10;
/** 定时兜底的上传检查间隔。主触发是广播跨整分钟的 `onMinuteCompleted()`，这里只做重试与排空。 */
const UPLOAD_RETRY_INTERVAL_MS = 60 * 1000;

/**
 * 蓝牙数据管理器类
 * 提供数据存储、查询、上传等功能
 */
export class BluetoothDataManager {
	/** 定时上传定时器 */
	private uploadTimer: number | null = null;

	/**
	 * PPI 上传锁。
	 *
	 * 睡眠上传用它自己的锁，不复用这一把：两者写不同接口、不同表，互不冲突，
	 * 而 PPI 一轮最多连发 10 次请求；共用一个锁会让这期间的睡眠上传整段被丢掉。
	 */
	private isUploading: boolean = false;
	/** 睡眠上传锁。 */
	private sleepUploading: boolean = false;
	/** 上一次 PPI 上传失败发生的时刻，用于 `UPLOAD_FAILURE_BACKOFF_MS` 退避。 */
	private lastPpiUploadFailedAt: number = 0;
	private uploadScheduled: boolean = false;
	private databaseReady: Promise<boolean>;

	/** 设备名称 */
	private deviceName: string = "";

	/** 设备蓝牙地址 */
	private deviceAddress: string = "";

	/**
	 * 构造函数
	 * 初始化数据库、启动定时上传、清理旧数据
	 */
	constructor() {
		this.databaseReady = this.initDatabase();
		this.startUploadTimer();
	}

	/**
	 * 设置设备信息
	 * @param deviceId 设备ID
	 * @param address 设备蓝牙地址
	 */
	setDeviceInfo(deviceName: string, address: string): void {
		this.deviceAddress = address;
		this.deviceName = deviceName + "-" + address.split(":").join("");
	}

	clearDeviceInfo(): void {
		this.deviceName = "";
		this.deviceAddress = "";
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

	/**
	 * 获取某个时间窗口内已经落库的 PPI 时间点。
	 *
	 * 这里故意只取 timestamp，而不取整行数据：历史补拉规划只关心“本地有没有这段”，
	 * 不关心当时的 HR/PPI 值。用轻量查询可以让 App 回前台时的 gap scan 更便宜。
	 */
	async getPpiTimestampsBetween(startSec: number, endSec: number): Promise<number[]> {
		if (endSec <= startSec) return [];
		const sql =
			"SELECT timestamp FROM ppi_data WHERE timestamp >= " +
			startSec.toString() +
			" AND timestamp <= " +
			endSec.toString() +
			" ORDER BY timestamp ASC";
		const result = await this.query(sql);
		if (result == null) {
			throw new Error("读取历史补缺时间点失败");
		}
		const timestamps: number[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			timestamps.push(parseInt(result.rows[i][0] as string));
		}
		return timestamps;
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
	 * 获取未上传的PPI数据（从ppi_data表）
	 * @param maxTimestamp 只取不晚于该时间戳的记录（上传时的本轮窗口上界）；null 表示不设上界
	 * @returns 未上传的PPI数据数组
	 */
	async getUnuploadedPpiData(maxTimestamp: number | null = null): Promise<PpiData[]> {
		let where = "uploaded = 0";
		if (maxTimestamp != null) where += " AND timestamp <= " + maxTimestamp.toString();
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data WHERE " +
			where +
			" ORDER BY timestamp ASC LIMIT " +
			PPI_UPLOAD_MAX_RECORDS;
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
	private async getUnuploadedPpiCountUpTo(cutoff: number): Promise<number> {
		const result = await this.query(
			"SELECT COUNT(*) FROM ppi_data WHERE uploaded = 0 AND timestamp <= " + cutoff.toString()
		);
		if (result == null || result.rows.length == 0) throw new Error("读取待上传 PPI 数量失败");
		return parseInt(result.rows[0][0] as string);
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
	 * 获取最近一条睡眠报告。
	 *
	 * 睡眠事件不是每秒连续数据，不能像 PPI 一样做密集 gap scan；
	 * 调度层只用它判断“最近有没有睡眠结果”，再决定是否读一段事件窗口。
	 */
	async getLatestSleepData(): Promise<SleepData | null> {
		const list = await this.getRecentSleepData(1, null);
		if (list.length == 0) return null;
		return list[0];
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

	/**
	 * 格式化时间戳为字符串
	 * @param timestamp 时间戳（毫秒）
	 * @returns 格式化的时间字符串 "YYYY-MM-DD HH:mm:ss"
	 */
	private formatTimestamp(timestamp: number): string {
		return dayUts(timestamp).format("YYYY-MM-DD HH:mm:ss");
	}

	/**
	 * 上传PPI数据（心率、血氧、PPI）
	 * @returns 是否上传成功
	 */
	async uploadPpiData(): Promise<boolean> {
		if (this.isUploading == true) return false;
		// 查询前抢锁，避免广播、定时器和历史补拉同时取出同一批未上传记录。
		this.isUploading = true;
		try {
			const deviceName = this.deviceName;
			const deviceAddress = this.deviceAddress;
			// 冻结本轮的目标窗口。实时广播每秒仍在落库，若每批都按“当前所有未上传”取数，
			// 循环会被新到的实时秒一直喂饱，直到撞上批次上限仍在连发（每批只有 1~2 条）。
			const cutoff = await this.queryTimestamp("SELECT MAX(timestamp) FROM ppi_data");
			for (let batch = 0; batch < PPI_UPLOAD_MAX_BATCHES; batch++) {
				const unuploadedData = await this.getUnuploadedPpiData(cutoff);
				if (unuploadedData.length == 0) return true;
				if (
					deviceAddress == "" ||
					this.deviceAddress != deviceAddress ||
					this.deviceName != deviceName
				) {
					return false;
				}
				const datas: PpiDataItem[] = [];
				const uploadedIds: string[] = [];
				for (let i = 0; i < unuploadedData.length; i++) {
					const item = unuploadedData[i];
					datas.push({
						time: this.formatTimestamp(item.timestamp * 1000),
						hr: item.hr,
						spo2: this.normalizeSpo2ForUpload(item.spo2),
						ppi: item.ppi
					});
					uploadedIds.push(item.id);
				}
				const requestData: PpiUploadRequest = {
					device: deviceName,
					address: deviceAddress,
					timezone: "08:00",
					datas
				};
				logger.info(
					"bluetooth",
					`[BOOM-UPLOAD] 上传PPI数据: batch=${batch + 1}, count=${datas.length}, from=${unuploadedData[0].timestamp}, to=${unuploadedData[unuploadedData.length - 1].timestamp}`
				);
				await request({
					url: UPLOAD_PPI_URL,
					method: "POST",
					data: requestData,
					strictSuccess: true,
					header: { "Content-Type": "application/json" }
				});
				// 请求期间如果切换/清除了设备，不修改当前数据库中的上传标记。
				if (this.deviceAddress != deviceAddress || this.deviceName != deviceName)
					return false;
				if ((await this.markPpiDataAsUploaded(uploadedIds)) == false) {
					throw new Error("PPI上传已确认，但本地上传标记保存失败");
				}
				await this.pruneUploadedPpiBefore(
					Math.floor(Date.now() / 1000) - HISTORY_PPI_RETENTION_SEC
				);
				this.lastPpiUploadFailedAt = 0;
				logger.info("bluetooth", `[BOOM-UPLOAD] PPI上传成功: count=${datas.length}`);
			}
			// 只对本轮窗口内的记录负责；窗口外新到的实时秒留给下一轮，不计入失败判定。
			const remaining = await this.getUnuploadedPpiCountUpTo(cutoff);
			logger.info("bluetooth", `[BOOM-UPLOAD] 本轮批次结束: remaining=${remaining}`);
			return remaining == 0;
		} catch (error) {
			this.lastPpiUploadFailedAt = Date.now();
			logger.error("bluetooth", "PPI上传失败，保留未上传数据:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	/**
	 * 有待传记录、且不处于失败退避时上传。
	 *
	 * 没有条数与间隔阈值：上传节奏由**触发点**决定（整分钟 / 60 秒定时兜底 / 补录落库后），
	 * 不在这里再节流一次。曾经的「攒够 30 条 或 距上次 30 秒」既让实时流成了真正的驱动源，
	 * 又把整分钟触发挡在门外（分钟边界那一刻两条判据都为真），已经删掉。
	 *
	 * true 表示无待传数据或本轮已传完；退避中、通道忙、仍有积压或失败返回 false。
	 */
	private async uploadPpiIfPending(): Promise<boolean> {
		if (this.isUploading == true) return false;
		try {
			const count = await this.getUnuploadedPpiCount();
			if (count == 0) return true;
			if (
				this.lastPpiUploadFailedAt > 0 &&
				Date.now() - this.lastPpiUploadFailedAt < UPLOAD_FAILURE_BACKOFF_MS
			)
				return false;
			return await this.uploadPpiData();
		} catch (error) {
			logger.error("bluetooth", "PPI上传检查失败:", error);
			return false;
		}
	}

	/**
	 * 上传睡眠数据
	 * @returns 是否上传成功
	 */
	async uploadSleepData(): Promise<boolean> {
		try {
			const unuploadedSleepData = await this.getUnuploadedSleepData();
			return await this.uploadSleepRecords(unuploadedSleepData);
		} catch (error) {
			logger.error("bluetooth", "睡眠上传检查失败:", error);
			return false;
		}
	}

	/** 测试用：重新上传最近的已上传睡眠记录，不改变其状态。 */
	async reuploadSleepData(count: number): Promise<number> {
		if (count <= 0) return 0;
		const uploadedSleepData = await this.getRecentSleepData(count, true);
		if (uploadedSleepData.length == 0) return 0;
		const ok = await this.uploadSleepRecords(uploadedSleepData);
		return ok ? uploadedSleepData.length : 0;
	}

	private async uploadSleepRecords(sleepDataList: SleepData[]): Promise<boolean> {
		// 没有待传数据不是失败。这条日志是“睡眠没上传”的第一个分岔：
		// 它出现说明本地压根没有待传记录，问题在事件读取/落库，不在上传。
		if (sleepDataList.length == 0) {
			logger.info("bluetooth", "[BOOM-UPLOAD] 无待上传睡眠数据");
			return true;
		}
		const ids = this.sleepRecordIds(sleepDataList);
		if (this.sleepUploading == true) {
			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠上传跳过: 原因=上一轮睡眠上传未结束, count=${sleepDataList.length}, ids=${ids}`
			);
			return false;
		}
		if (this.deviceAddress == "") {
			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠上传跳过: 原因=设备未连接, count=${sleepDataList.length}, ids=${ids}`
			);
			return false;
		}

		this.sleepUploading = true;
		try {
			const datas: SleepUploadDataItem[] = [];
			for (let i = 0; i < sleepDataList.length; i++) {
				datas.push(await this.buildSleepUploadItem(sleepDataList[i]));
			}
			const requestData: SleepUploadRequest = {
				address: this.deviceAddress,
				datas,
				device: this.deviceName,
				recoverScore: "1.0",
				sleepScore: "1.0",
				time: this.formatTimestamp(Date.now()),
				timezone: "08:00",
				tiredScore: "1.0"
			};

			// 逐秒 detail 有上万字符，整体序列化会写满诊断缓冲区。只记结构与分期统计，
			// 分期全 0 正是“服务端判定没有睡眠数据”的信号，必须一眼可见。
			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 上传睡眠数据: count=${datas.length}, ids=${ids}, ${this.describeSleepDatas(datas)}`
			);
			const response = await request({
				url: UPLOAD_SLEEP_URL,
				strictSuccess: true,
				method: "POST",
				data: requestData,
				header: { "Content-Type": "application/json" }
			});
			logger.info("bluetooth", `[BOOM-UPLOAD] 睡眠数据上传响应: ${response}`);

			if ((await this.markSleepAsUploaded(this.sleepRecordIds(sleepDataList))) == false) {
				throw new Error("睡眠上传已确认，但本地上传标记保存失败");
			}
			logger.info("bluetooth", `[BOOM-UPLOAD] 睡眠数据上传成功: count=${datas.length}`);
			return true;
		} catch (error) {
			// 失败必须带 id 和原因：下一轮能不能补上，取决于这条记录是否还留在待传集合里。
			logger.error(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠数据上传失败: count=${sleepDataList.length}, ids=${ids}`,
				error
			);
			return false;
		} finally {
			this.sleepUploading = false;
		}
	}

	/** 待标记的睡眠记录 id 数组（markSleepAsUploaded 需要数组）。 */
	private sleepRecordIds(sleepDataList: SleepData[]): string[] {
		const ids: string[] = [];
		for (let i = 0; i < sleepDataList.length; i++) {
			if (sleepDataList[i].id != null) ids.push(sleepDataList[i].id!);
		}
		return ids;
	}

	/**
	 * 睡眠上传的可读摘要：时间、逐秒 detail 的长度与分期计数。
	 *
	 * detail 直接取自已构建的请求项，不重复查库。全 0 表示这段窗口没有任何有效
	 * 睡眠分期（服务端据此判定“没有睡眠数据”），所以既打印计数也打印前若干位。
	 */
	private describeSleepDatas(datas: SleepUploadDataItem[]): string {
		const parts: string[] = [];
		for (let i = 0; i < datas.length; i++) {
			const detail = datas[i].detail;
			let deep = 0;
			let light = 0;
			let other = 0;
			let none = 0;
			for (let p = 0; p < detail.length; p++) {
				const ch = detail.charAt(p);
				if (ch == "3") deep++;
				else if (ch == "2") light++;
				else if (ch == "1") other++;
				else none++;
			}
			const head = detail.length > 24 ? `${detail.substring(0, 24)}...` : detail;
			parts.push(
				`[time=${datas[i].time}, 睡眠窗口=${datas[i].bedSec}~${datas[i].wakeSec}(up=${datas[i].upSec},sleep=${datas[i].sleepSec}), detail长度=${detail.length}, 深=${deep}, 浅=${light}, 其他=${other}, 无分期=${none}, detail头=${head}]`
			);
		}
		return parts.join(" ");
	}

	/** 构建睡眠上传数据项 */
	private async buildSleepUploadItem(sleepData: SleepData): Promise<SleepUploadDataItem> {
		return {
			bedSec: sleepData.bedtime,
			detail: await this.buildSleepDetailForUpload(sleepData),
			sleepSec: sleepData.sleepTime,
			time: this.formatTimestamp(sleepData.reportTimestamp * 1000), // 转为毫秒
			upSec: sleepData.getupTime,
			wakeSec: sleepData.wakeTime
		};
	}

	/**
	 * SleepResult 的 bedtime/wakeTime 均是相对 reportTimestamp 的秒数。
	 * 广播接收时已经将每秒 activity 落库，因此上传时只需按该窗口逐秒组装。
	 */
	private async buildSleepDetailForUpload(sleepData: SleepData): Promise<string> {
		const startSec = sleepData.reportTimestamp - sleepData.bedtime;
		const endSec = sleepData.reportTimestamp - sleepData.wakeTime;
		if (startSec <= 0 || endSec <= startSec) return "";
		const activities = await this.getSleepActivitiesBetween(startSec, endSec);
		const detail: string[] = [];
		for (let timestamp = startSec; timestamp < endSec; timestamp++) {
			const activity = activities.get(timestamp);
			if (activity == 0) detail.push("3");
			else if (activity == 1) detail.push("2");
			else if (activity == 2) detail.push("1");
			else detail.push("0");
		}
		return detail.join("");
	}

	private normalizeSpo2ForUpload(spo2: number): number {
		if (spo2 > 100) return Math.round(spo2 / 10);
		return Math.round(spo2);
	}

	/**
	 * 自动上传的**唯一入口**：PPI 与睡眠各走各的锁，都成功才返回 `true`。
	 *
	 * 三个触发点都调它，没有第二个自动上传入口：广播跨整分钟的 `onMinuteCompleted()`、
	 * 60 秒定时兜底、以及历史补录落库后的 `scheduleUpload()`。手动路径（测试页）直接
	 * 调 `uploadPpiData()` / `uploadSleepData()`，不经这里的退避。
	 */
	async uploadData(): Promise<boolean> {
		const ppiOk = await this.uploadPpiIfPending();
		const sleepOk = await this.uploadSleepData();
		return ppiOk && sleepOk;
	}

	/**
	 * 广播 `utc` 跨过整分钟时调用：上传刚走完的那一分钟。
	 *
	 * 上传与合格判定是两件事——判定依据是本地的 `ppi_data`，不是上传结果。
	 * 上传失败时 `uploaded` 保持 0，由重试路径继续消费，不会因为弱网把已经收齐的
	 * 分钟判成待补。所以这里只负责把这一分钟的秒推上去，不参与基准时间推进。
	 */
	async onMinuteCompleted(minuteSec: number): Promise<void> {
		const ok = await this.uploadData();
		logger.info(
			"bluetooth",
			`[BOOM-UPLOAD] 分钟上传: minute=${minuteSec}, ok=${ok}`
		);
	}

	/** 历史落库后独立触发上传，不让网络请求阻塞 GATT 释放和广播恢复。 */
	scheduleUpload(): void {
		if (this.uploadScheduled == true) return;
		this.uploadScheduled = true;
		setTimeout(() => {
			this.uploadScheduled = false;
			this.uploadData()
				.then((ok) => {
					logger.info(
						"bluetooth",
						`[BOOM-UPLOAD] 历史落库后上传检查完成: complete=${ok}`
					);
				})
				.catch((error) => {
					logger.error("bluetooth", "[BOOM-UPLOAD] 历史落库后上传异常:", error);
				});
		}, 0);
	}

	/**
	 * 定时兜底已降级为**重试与排空**：主触发是 `onMinuteCompleted()`，
	 * 这里只为消费 `uploaded=0` 的积压和失败重试。
	 */
	startUploadTimer(): void {
		this.stopUploadTimer();
		//@ts-ignore
		this.uploadTimer = setInterval(() => {
			this.uploadData();
		}, UPLOAD_RETRY_INTERVAL_MS);
	}

	/**
	 * 停止定时上传定时器
	 */
	stopUploadTimer(): void {
		const timer = this.uploadTimer;
		if (timer != null) {
			clearInterval(timer);
			this.uploadTimer = null;
		}
	}

	/**
	 * 销毁管理器
	 * 停止定时器并关闭数据库连接
	 */
	async destroy(): Promise<void> {
		this.stopUploadTimer();
		await bluetoothDatabase.close();
	}
}

/**
 * 蓝牙数据管理器实例
 */
export const bluetoothDataManager = new BluetoothDataManager();
