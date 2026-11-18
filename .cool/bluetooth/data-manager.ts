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
	RealtimeBroadcastRecord,
	StoreBroadcastSecondInput,
	UploadTableStats,
	HistorySessionDiagnostics
} from "./types";

/**
 * 单次查询待上传 PPI 的取数上限（约 5 分钟的数据）。
 * 上传侧一轮会反复调用它直到排空，所以这里只管「一次取多少」，不管「一轮传几批」。
 */
const PPI_UPLOAD_PAGE_SIZE = 300;

/**
 * 睡眠链路的取数列（顺序即 `parseSleepDataRow` 的下标）。
 *
 * 上传报文需要六个统计值齐全。这件事由表结构的 NOT NULL 保证，所以这里只列列名，
 * 不再拼一套「统计值齐全」的查询条件：结构变了就重建表，库里的行一定发得出去。
 * 两处查询共用同一份列名，否则改一处漏一处就会出现「查出来的行发不出去」。
 */
const SLEEP_COLUMNS =
	"report_timestamp, sleep_onset_time, awake_time, light_sleep_period, deep_sleep_period, other_sleep_period, heart_rate_rest, uploaded";

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
		// 基准时间跨冷启动保留。数据库重开或 App 重启都不能让已记账的时间重新变成未记账；
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
	 * 写一整秒的广播数据。
	 *
	 * 广播到达时整行落库设备给的**原始值**：不按生理范围过滤、不换算单位，页面要用的时候
	 * 自己判断哪个值可用。`received_at` 记手机接收毫秒，同时兼作「这一行来自实时广播」的
	 * 标记——补录行是 0，所以「取最近一条有效广播」要靠它过滤，否则会取到一条只有四个
	 * 字段的补录行。
	 *
	 * 同一秒只写一次：主键是秒，`INSERT OR IGNORE` 让先到的那行赢。补录滞后于实时广播，
	 * 正常情况下广播行先落库，补录那一秒被忽略，这正是想要的。
	 */
	async storeBroadcastSecond(
		input: StoreBroadcastSecondInput
	): Promise<RealtimeBroadcastRecord | null> {
		const r = input.broadcast;
		const timestamp = r.utc;
		// 0 是设备返回的有效原始值；广播时间已在调用方校验，不能据此丢弃上传秒。
		if (timestamp <= 0) return null;
		if ((await this.ensureDatabaseReady()) == false) return null;
		const rawHex = this.escapeSqlText(input.rawHex);
		const vHex = this.escapeSqlText(input.vHex);
		const deviceId = this.escapeSqlText(input.deviceId);
		const ppgAttached = r.ppgAttached == true ? 1 : 0;
		const hasNewEvent = r.hasNewEvent == true ? 1 : 0;
		const sql =
			"INSERT OR IGNORE INTO broadcast_data " +
			"(id, timestamp, received_at, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id, uploaded) VALUES " +
			`('${timestamp}', ${timestamp}, ${r.receivedAt}, ${r.voltageMv}, ${ppgAttached}, ${r.behavior}, ${r.activity}, ${r.hr}, ${r.ppi}, ${r.spo2}, ${r.bhr}, ${r.eventSeq}, ${hasNewEvent}, ${r.batteryStatus}, ${r.hrvMs}, ${r.stepsEveryday}, ${r.calorieEveryday}, '${rawHex}', '${vHex}', '${deviceId}', 0)`;
		if ((await this.execute(sql)) == false) return null;
		// 写成功就直接用内存里的这一帧返回，不再读回：同一行刚写过，读回来的是同一个值。
		return this.buildBroadcastRecord(input);
	}

	private buildBroadcastRecord(input: StoreBroadcastSecondInput): RealtimeBroadcastRecord {
		const r = input.broadcast;
		return {
			id: `${r.utc}`,
			timestamp: r.utc,
			receivedAt: r.receivedAt,
			utc: r.utc,
			voltageMv: r.voltageMv,
			ppgAttached: r.ppgAttached,
			behavior: r.behavior,
			activity: r.activity,
			hr: r.hr,
			ppi: r.ppi,
			spo2: r.spo2,
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

	/**
	 * 最近一条实时广播行。
	 *
	 * 首页四张卡、冷启动恢复 `eventSeq`、诊断弹窗都读它。`received_at > 0` 排除补录行
	 * （补录补的是刚过去的秒，时间戳可能比最后一条广播更晚，不过滤就会取到一条缺字段的行）。
	 */
	async getLatestBroadcastSecond(): Promise<RealtimeBroadcastRecord | null> {
		const sql =
			"SELECT id, timestamp, received_at, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id FROM broadcast_data WHERE received_at > 0 ORDER BY timestamp DESC LIMIT 1";
		const result = await this.query(sql);
		if (result == null || result.rows.length == 0) {
			return null;
		}
		return this.parseBroadcastRow(result.rows[0]);
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
			activity: parseInt(row[5] as string),
			uploaded: parseInt(row[6] as string) == 1
		} as PpiData;
	}

	/** `broadcast_data` 的一行 → 展示用记录。没有单独的 `utc` 列：`timestamp` 就是设备秒。 */
	private parseBroadcastRow(row: Array<string>): RealtimeBroadcastRecord {
		const timestamp = parseInt(row[1] as string);
		return {
			id: row[0] as string,
			timestamp,
			receivedAt: parseInt(row[2] as string),
			utc: timestamp,
			voltageMv: parseInt(row[3] as string),
			ppgAttached: parseInt(row[4] as string) == 1,
			behavior: parseInt(row[5] as string),
			activity: parseInt(row[6] as string),
			hr: parseInt(row[7] as string),
			ppi: parseInt(row[8] as string),
			spo2: parseInt(row[9] as string),
			bhr: parseInt(row[10] as string),
			eventSeq: parseInt(row[11] as string),
			hasNewEvent: parseInt(row[12] as string) == 1,
			batteryStatus: parseInt(row[13] as string),
			rmssd: parseInt(row[14] as string),
			stepsEveryday: parseInt(row[15] as string),
			calorieEveryday: parseInt(row[16] as string),
			rawHex: row[17] as string,
			vHex: row[18] as string,
			deviceId: row[19] as string
		} as RealtimeBroadcastRecord;
	}

	/** `sleep_data` 行 → `SleepData`（列顺序见 `SLEEP_COLUMNS`）。 */
	private parseSleepDataRow(row: Array<string>): SleepData {
		return {
			reportTimestamp: parseInt(row[0] as string),
			sleepOnsetTime: parseInt(row[1] as string),
			awakeTime: parseInt(row[2] as string),
			lightSleepPeriod: parseInt(row[3] as string),
			deepSleepPeriod: parseInt(row[4] as string),
			otherSleepPeriod: parseInt(row[5] as string),
			heartRateRest: parseInt(row[6] as string),
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
			await this.getUploadStatsForTable("broadcast_data", "timestamp"),
			await this.getUploadStatsForTable("sleep_data", "report_timestamp")
		);
		return stats;
	}

	/** 供本地测试页排查“未读取、未落库、未上传”三个阶段。 */
	async getHistorySessionDiagnostics(): Promise<HistorySessionDiagnostics> {
		const baseline = await historyBaseline.getBaseline();
		const nowSec = Math.floor(Date.now() / 1000);
		const ceiling = historyBaseline.stableCeiling(nowSec);
		return {
			baselineSec: baseline,
			stableCeilingSec: ceiling,
			behindSeconds: Math.max(0, ceiling - baseline),
			classifiedUntilSec: await historyBaseline.getClassifiedUntil(),
			unuploadedCount: await this.getUnuploadedPpiCount(),
			earliestUnuploadedSec: await this.queryTimestamp(
				"SELECT MIN(timestamp) FROM broadcast_data WHERE uploaded = 0"
			),
			latestUnuploadedSec: await this.queryTimestamp(
				"SELECT MAX(timestamp) FROM broadcast_data WHERE uploaded = 0"
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
	 * 每秒数据总行数（广播行 + 补录行）。
	 */
	async getBroadcastDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM broadcast_data");
	}

	/**
	 * 最近 N 条实时广播行，诊断弹窗用。
	 *
	 * `received_at > 0` 排除补录行：诊断要看的是一条完整广播，补录行只有四个字段。
	 */
	async getRecentBroadcastRecords(limit: number): Promise<RealtimeBroadcastRecord[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		const sql =
			"SELECT id, timestamp, received_at, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id FROM broadcast_data WHERE received_at > 0 ORDER BY timestamp DESC LIMIT " +
			safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}

		const records: RealtimeBroadcastRecord[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			records.push(this.parseBroadcastRow(result.rows[i]));
		}
		return records;
	}

	/**
	 * 获取最后一条 PPI 历史数据
	 */
	async getLatestPpiData(): Promise<PpiData | null> {
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, activity, uploaded FROM broadcast_data ORDER BY timestamp DESC LIMIT 1";
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
			"SELECT id, timestamp, hr, spo2, ppi, activity, uploaded FROM broadcast_data ORDER BY timestamp DESC LIMIT " +
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
			"SELECT id, timestamp, hr, spo2, ppi, activity, uploaded FROM broadcast_data WHERE uploaded = " +
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
			"SELECT id, timestamp, hr, spo2, ppi, activity, uploaded FROM broadcast_data WHERE " +
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
		const result = await this.query("SELECT COUNT(*) FROM broadcast_data WHERE uploaded = 0");
		if (result == null || result.rows.length == 0) throw new Error("读取待上传 PPI 数量失败");
		return parseInt(result.rows[0][0] as string);
	}

	/** 本轮上传窗口内的剩余数量：只统计不晚于 cutoff 的记录。 */
	async getUnuploadedPpiCountUpTo(cutoff: number): Promise<number> {
		const result = await this.query(
			"SELECT COUNT(*) FROM broadcast_data WHERE uploaded = 0 AND timestamp <= " + cutoff.toString()
		);
		if (result == null || result.rows.length == 0) throw new Error("读取待上传 PPI 数量失败");
		return parseInt(result.rows[0][0] as string);
	}

	/** 已落库的最新秒，用作上传的窗口上界。 */
	async getLatestPpiTimestamp(): Promise<number> {
		return this.queryTimestamp("SELECT MAX(timestamp) FROM broadcast_data");
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
		const sql = `UPDATE broadcast_data SET uploaded = 1 WHERE id IN (${idList})`;
		return await this.execute(sql);
	}

	/** 仅清理已上传且超出本地 30 天审计窗口的 PPI；未上传行必须保留。 */
	async pruneUploadedPpiBefore(boundarySec: number): Promise<number> {
		const ready = await this.ensureDatabaseReady();
		if (ready == false) throw new Error("数据库未就绪，不能清理旧 PPI 数据");
		const countResult = await bluetoothDatabase.query(
			`SELECT COUNT(*) FROM broadcast_data WHERE uploaded=1 AND timestamp<${boundarySec}`
		);
		if (countResult == null || countResult.rows.length == 0)
			throw new Error("读取待清理 PPI 数量失败");
		const count = parseInt(countResult.rows[0][0] as string);
		if (count == 0) return 0;
		if (
			(await bluetoothDatabase.execute(
				`DELETE FROM broadcast_data WHERE uploaded=1 AND timestamp<${boundarySec}`
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
			"DELETE FROM broadcast_data",
			"DELETE FROM vital_sync_state"
		]);
		if (cleared == false) {
			logger.error("bluetooth", "[BOOM-DATA] 清空旧设备数据失败");
			throw new Error("清空旧设备数据失败");
		}
		logger.info("bluetooth", "数据库数据清空完成");
	}

	/** 显式清空当前绑定的基准与分类进度，不影响已经保存和待上传的每秒数据。 */
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
		if ((await bluetoothDatabase.execute("DELETE FROM vital_sync_state")) == false)
			throw new Error("清空基准时间失败");
		return true;
	}

	/**
	 * 存储睡眠事件
	 * 用 INSERT OR IGNORE 按主键幂等去重，重复事件不会重置 uploaded。
	 * @param sleepData 设备事件给出的六个统计值
	 * @returns SQL 是否执行成功
	 */
	async storeSleepData(sleepData: SleepData): Promise<boolean> {
		const reportTimestamp = sleepData.reportTimestamp;
		const sleepSql = `INSERT OR IGNORE INTO sleep_data
			(report_timestamp, sleep_onset_time, awake_time, light_sleep_period, deep_sleep_period, other_sleep_period, heart_rate_rest)
			VALUES (${reportTimestamp}, ${sleepData.sleepOnsetTime}, ${sleepData.awakeTime}, ${sleepData.lightSleepPeriod}, ${sleepData.deepSleepPeriod}, ${sleepData.otherSleepPeriod}, ${sleepData.heartRateRest})`;
		const ok = await this.execute(sleepSql);
		if (ok == false) {
			logger.error("bluetooth", `[BOOM] 睡眠数据写入失败: report_timestamp=${reportTimestamp}`);
		}
		return ok;
	}

	/**
	 * 获取未上传的睡眠事件
	 * @returns 未上传的睡眠事件数组（按时间升序不影响组装，主键即时刻）
	 */
	async getUnuploadedSleepData(): Promise<SleepData[]> {
		const sql = "SELECT " + SLEEP_COLUMNS + " FROM sleep_data WHERE uploaded = 0";
		const result = await this.query(sql);

		if (result == null) {
			throw new Error("读取待上传睡眠数据失败");
		}

		return this.parseSleepDataRows(result.rows);
	}

	async getSleepDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM sleep_data");
	}

	/** 待上传条数走单条 COUNT，不把行拉回来（与 `getUnuploadedSleepData()` 同口径）。 */
	async getUnuploadedSleepDataCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM sleep_data WHERE uploaded = 0");
	}

	/**
	 * 最近的睡眠事件（诊断与重传用）。
	 * @param uploaded `true` 已上传 / `false` 未上传 / `null` 不限
	 */
	async getRecentSleepData(limit: number, uploaded: boolean | null): Promise<SleepData[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		let sql = "SELECT " + SLEEP_COLUMNS + " FROM sleep_data";
		if (uploaded != null) {
			sql += uploaded == true ? " WHERE uploaded = 1" : " WHERE uploaded = 0";
		}
		sql += " ORDER BY report_timestamp DESC LIMIT " + safeLimit.toString();
		const result = await this.query(sql);
		if (result == null) {
			return [];
		}
		return this.parseSleepDataRows(result.rows);
	}

	/** 查询结果逐行转成 `SleepData`。 */
	private parseSleepDataRows(rows: Array<Array<string>>): SleepData[] {
		const sleepDataList: SleepData[] = [];
		for (let i = 0; i < rows.length; i++) {
			sleepDataList.push(this.parseSleepDataRow(rows[i]));
		}
		return sleepDataList;
	}

	/**
	 * 标记睡眠事件为已上传。
	 * 主键就是 `report_timestamp`，所以按时间戳标记，不需要再翻译成 id。
	 * @param timestamps 事件的 reportTimestamp 秒数数组
	 */
	async markSleepAsUploadedByTimestamps(timestamps: number[]): Promise<boolean> {
		if (timestamps.length == 0) {
			return true;
		}

		const sql =
			"UPDATE sleep_data SET uploaded = 1 WHERE report_timestamp IN (" +
			timestamps.join(",") +
			")";
		return await this.execute(sql);
	}
}

/**
 * 蓝牙数据管理器实例
 */
export const bluetoothDataManager = new BluetoothDataManager();
