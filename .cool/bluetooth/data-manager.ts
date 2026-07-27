/**
 * 蓝牙数据管理类
 * 负责蓝牙数据的存储、管理和上传
 */
import { bluetoothDatabase } from "./database";
import { request } from "../service";
import { logger } from "../service/logger";
import { dayUts } from "../utils/day";
import { UPLOAD_INTERVAL, UPLOAD_PPI_URL, UPLOAD_SLEEP_URL } from "./constants";
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
	UploadTableStats
} from "./types";

const PPI_UPLOAD_BATCH_SIZE = 30;
const PPI_UPLOAD_MIN_INTERVAL_MS = 30 * 1000;

/**
 * 蓝牙数据管理器类
 * 提供数据存储、查询、上传等功能
 */
export class BluetoothDataManager {
	/** 定时上传定时器 */
	private uploadTimer: number | null = null;

	/** 是否正在上传中 */
	private isUploading: boolean = false;
	private ppiUploadPending: boolean = false;
	private lastPpiUploadAttemptAt: number = 0;

	/** 设备名称 */
	private deviceName: string = "";

	/** 设备蓝牙地址 */
	private deviceAddress: string = "";

	/**
	 * 构造函数
	 * 初始化数据库、启动定时上传、清理旧数据
	 */
	constructor() {
		this.initDatabase();
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
	private async initDatabase(): Promise<void> {
		await bluetoothDatabase.open();
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
		return bluetoothDatabase.execute(sql);
	}

	async storeBroadcastPpiData(
		timestamp: number,
		hr: number,
		spo2: number,
		ppi: number
	): Promise<boolean> {
		if (hr <= 0 && spo2 <= 0 && ppi <= 0) {
			return false;
		}
		const sql = `INSERT OR IGNORE INTO ppi_data (id, timestamp, hr, spo2, ppi, uploaded) VALUES ('${timestamp}', ${timestamp}, ${hr}, ${spo2}, ${ppi}, 0)`;
		return bluetoothDatabase.execute(sql);
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
		return bluetoothDatabase.execute(sql);
	}

	/**
	 * 获取最后一条 0x50 广播实时数据
	 */
	async getLatestRealtimeBroadcastRecord(): Promise<RealtimeBroadcastRecord | null> {
		const sql =
			"SELECT id, timestamp, received_at, utc, voltage_mv, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, event_seq, has_new_event, battery_status, rmssd, steps_everyday, calorie_everyday, raw_hex, v_hex, device_id FROM realtime_broadcast_data ORDER BY received_at DESC LIMIT 1";
		const result = await bluetoothDatabase.query(sql);
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
			recordCount: parseInt(row[6] as string),
			detail: (row[7] ?? "") as string,
			uploaded: parseInt(row[8] as string) == 1
		} as SleepData;
	}

	private async queryCount(sql: string): Promise<number> {
		const result = await bluetoothDatabase.query(sql);
		if (result == null || result.rows.length == 0) {
			return 0;
		}
		return parseInt(result.rows[0][0] as string);
	}

	private async queryTimestamp(sql: string): Promise<number> {
		const result = await bluetoothDatabase.query(sql);
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
		const result = await bluetoothDatabase.query(sql);
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
		const result = await bluetoothDatabase.query(sql);
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
		const result = await bluetoothDatabase.query(sql);
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
		const result = await bluetoothDatabase.query(sql);
		if (result == null) {
			return [];
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
		const result = await bluetoothDatabase.query(sql);
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
	 * @returns 未上传的PPI数据数组
	 */
	async getUnuploadedPpiData(): Promise<PpiData[]> {
		const sql =
			"SELECT id, timestamp, hr, spo2, ppi, uploaded FROM ppi_data WHERE uploaded = 0 ORDER BY timestamp ASC";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		const dataList: PpiData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			dataList.push(this.parsePpiDataRow(result.rows[i]));
		}
		return dataList;
	}

	async getUnuploadedPpiCount(): Promise<number> {
		return this.queryCount("SELECT COUNT(*) FROM ppi_data WHERE uploaded = 0");
	}

	/**
	 * 标记PPI数据为已上传
	 * @param ids 数据ID数组
	 */
	async markPpiDataAsUploaded(ids: string[]): Promise<void> {
		if (ids.length == 0) {
			return;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE ppi_data SET uploaded = 1 WHERE id IN (${idList})`;
		await bluetoothDatabase.execute(sql);
	}

	/**
	 * 清空所有数据（包括睡眠数据、PPI数据、广播数据）
	 */
	async clearAllData(): Promise<void> {
		logger.info("bluetooth", "清空所有数据库数据");
		await bluetoothDatabase.execute("DELETE FROM sleep_data");
		await bluetoothDatabase.execute("DELETE FROM ppi_data");
		await bluetoothDatabase.execute("DELETE FROM realtime_broadcast_data");
		logger.info("bluetooth", "数据库数据清空完成");
	}

	/**
	 * 存储睡眠数据
	 * 用 INSERT OR IGNORE 防御性去重：相同 reportTimestamp 已存在则静默跳过；
	 * 配合 fetchAllSleepData 断点续传后，从源头避免重复存储与 uploaded 状态被重置。
	 * @param sleepData 睡眠数据（detail 已由 SleepResponseAssembler 生成）
	 */
	async storeSleepData(sleepData: SleepData): Promise<void> {
		const { reportTimestamp, bedtime, sleepTime, wakeTime, getupTime, recordCount, detail } =
			sleepData;
		const sleepId = reportTimestamp.toString();
		const safeDetail = this.escapeSqlText(detail);
		const sleepSql = `INSERT OR IGNORE INTO sleep_data
			(id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, detail, uploaded)
			VALUES ('${sleepId}', ${reportTimestamp}, ${bedtime}, ${sleepTime}, ${wakeTime}, ${getupTime}, ${recordCount}, '${safeDetail}', 0)`;
		await bluetoothDatabase.execute(sleepSql);
	}

	/**
	 * 获取未上传的睡眠数据
	 * @returns 未上传的睡眠数据数组
	 */
	async getUnuploadedSleepData(): Promise<SleepData[]> {
		const sql =
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, detail FROM sleep_data WHERE uploaded = 0";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
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
				recordCount: parseInt(row[6] as string),
				detail: (row[7] ?? "") as string,
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
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, detail, uploaded FROM sleep_data";
		if (uploaded != null) {
			sql += uploaded == true ? " WHERE uploaded = 1" : " WHERE uploaded = 0";
		}
		sql += " ORDER BY report_timestamp DESC LIMIT " + safeLimit.toString();
		const result = await bluetoothDatabase.query(sql);
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
	async markSleepAsUploaded(ids: string[]): Promise<void> {
		if (ids.length == 0) {
			return;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE sleep_data SET uploaded = 1 WHERE id IN (${idList})`;
		await bluetoothDatabase.execute(sql);
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
		if (this.isUploading == true) {
			logger.info("bluetooth", "正在上传中，跳过PPI上传");
			return false;
		}

		const unuploadedData = await this.getUnuploadedPpiData();
		logger.info(
			"bluetooth",
			"未上传的PPI数据数量:",
			unuploadedData.length,
			"全部数据:",
			unuploadedData
		);
		if (unuploadedData.length == 0) {
			return true;
		}

		logger.info("bluetooth", "当前设备信息:", {
			deviceName: this.deviceName,
			address: this.deviceAddress
		});
		if (this.deviceAddress == "") {
			logger.info("bluetooth", "设备未连接，跳过PPI上传");
			return false;
		}

		this.isUploading = true;

		try {
			// 直接从 ppi_data 表构建上传数据（每行已包含 hr, spo2, ppi）
			const datas: PpiDataItem[] = [];
			for (let i = 0; i < unuploadedData.length; i++) {
				const item = unuploadedData[i];
				// timestamp 存储的是秒，需要转换为毫秒再格式化
				datas.push({
					time: this.formatTimestamp(item.timestamp * 1000),
					hr: item.hr,
					spo2: this.normalizeSpo2ForUpload(item.spo2),
					ppi: item.ppi
				});
			}

			const requestData: PpiUploadRequest = {
				device: this.deviceName,
				address: this.deviceAddress,
				timezone: "08:00",
				datas
			};

			logger.info("bluetooth", "上传PPI数据:", JSON.stringify(requestData));

			const response = await request({
				url: UPLOAD_PPI_URL,
				method: "POST",
				data: requestData,
				header: {
					"Content-Type": "application/json"
				}
			});

			logger.info("bluetooth", "PPI上传响应:", response);

			const uploadedIds: string[] = [];
			for (let i = 0; i < unuploadedData.length; i++) {
				uploadedIds.push(unuploadedData[i].id);
			}
			await this.markPpiDataAsUploaded(uploadedIds);

			logger.info("bluetooth", "PPI上传成功");
			return true;
		} catch (error) {
			logger.error("bluetooth", "PPI上传失败:", error);
			return false;
		} finally {
			this.isUploading = false;
			if (this.ppiUploadPending == true) {
				this.ppiUploadPending = false;
				setTimeout(() => {
					this.requestPpiUpload();
				}, 0);
			}
		}
	}

	async requestPpiUpload(): Promise<void> {
		if (this.isUploading == true) {
			this.ppiUploadPending = true;
			return;
		}

		const count = await this.getUnuploadedPpiCount();
		if (count == 0) {
			return;
		}

		const now = Date.now();
		if (this.lastPpiUploadAttemptAt == 0) {
			this.lastPpiUploadAttemptAt = now;
			if (count < PPI_UPLOAD_BATCH_SIZE) {
				return;
			}
		}
		const elapsed = now - this.lastPpiUploadAttemptAt;
		if (count < PPI_UPLOAD_BATCH_SIZE && elapsed < PPI_UPLOAD_MIN_INTERVAL_MS) {
			return;
		}

		this.lastPpiUploadAttemptAt = now;
		await this.uploadPpiData();
	}

	/**
	 * 上传睡眠数据
	 * @returns 是否上传成功
	 */
	async uploadSleepData(): Promise<boolean> {
		if (this.isUploading == true) {
			logger.info("bluetooth", "正在上传中，跳过睡眠数据上传");
			return false;
		}

		const unuploadedSleepData = await this.getUnuploadedSleepData();
		logger.info("bluetooth", "未上传的睡眠数据数量:", unuploadedSleepData.length);
		if (unuploadedSleepData.length == 0) {
			return true;
		}

		logger.info("bluetooth", "当前设备信息:", {
			deviceName: this.deviceName,
			address: this.deviceAddress
		});
		if (this.deviceAddress == "") {
			logger.info("bluetooth", "设备未连接，跳过睡眠数据上传");
			return false;
		}

		this.isUploading = true;

		try {
			const datas: SleepUploadDataItem[] = [];
			for (let i = 0; i < unuploadedSleepData.length; i++) {
				datas.push(this.buildSleepUploadItem(unuploadedSleepData[i]));
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

			logger.info("bluetooth", "上传睡眠数据:", JSON.stringify(requestData));

			const response = await request({
				url: UPLOAD_SLEEP_URL,
				method: "POST",
				data: requestData,
				header: {
					"Content-Type": "application/json"
				}
			});

			logger.info("bluetooth", "睡眠数据上传响应:", response);

			const uploadedIds: string[] = [];
			for (let i = 0; i < unuploadedSleepData.length; i++) {
				uploadedIds.push(unuploadedSleepData[i].id!);
			}
			await this.markSleepAsUploaded(uploadedIds);

			logger.info("bluetooth", "睡眠数据上传成功");
			return true;
		} catch (error) {
			logger.error("bluetooth", "睡眠数据上传失败:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	/**
	 * 构建睡眠上传数据项
	 * 数据库 4 个 offset 秒字段直接对应上传 4 个 Sec 字段，不做减法
	 * （用户决策："拿到什么就是什么"）
	 */
	private buildSleepUploadItem(sleepData: SleepData): SleepUploadDataItem {
		return {
			bedSec: sleepData.bedtime,
			detail: sleepData.detail,
			sleepSec: sleepData.sleepTime,
			time: this.formatTimestamp(sleepData.reportTimestamp * 1000), // 转为毫秒
			upSec: sleepData.wakeTime,
			wakeSec: sleepData.getupTime
		};
	}

	private normalizeSpo2ForUpload(spo2: number): number {
		if (spo2 > 100) return Math.round(spo2 / 10);
		return Math.round(spo2);
	}

	/**
	 * 上传所有数据（PPI数据和睡眠数据）
	 * @returns 是否上传成功
	 */
	async uploadData(): Promise<boolean> {
		await this.requestPpiUpload();
		await this.uploadSleepData();
		return true;
	}

	/**
	 * 启动定时上传定时器
	 */
	startUploadTimer(): void {
		this.stopUploadTimer();
		//@ts-ignore
		this.uploadTimer = setInterval(() => {
			this.uploadData();
		}, UPLOAD_INTERVAL);
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
