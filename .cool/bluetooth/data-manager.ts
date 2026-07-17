/**
 * 蓝牙数据管理类
 * 负责蓝牙数据的存储、管理和上传
 */
import { parse, storage } from "../index";
import { bluetoothDatabase } from "./database";
import { request } from "../service";
import { dayUts } from "../utils/day";
import { UPLOAD_INTERVAL, MAX_DATA_AGE, UPLOAD_PPI_URL, UPLOAD_SLEEP_URL } from "./constants";
import type {
	BluetoothData,
	BluetoothDataType,
	SleepData,
	PpiUploadRequest,
	SleepUploadRequest,
	SleepUploadDataItem,
	HeartRateDataMap,
	PpiDataItem,
	PpiData,
	HeartRateRecord,
	RealtimeBroadcastRecord
} from "./types";

/**
 * 蓝牙数据管理器类
 * 提供数据存储、查询、上传等功能
 */
export class BluetoothDataManager {
	/** 定时上传定时器 */
	private uploadTimer: number | null = null;

	/** 是否正在上传中 */
	private isUploading: boolean = false;

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
	 * 生成唯一ID
	 * @returns 唯一ID字符串
	 */
	private generateId(): string {
		return Date.now().toString();
	}

	/**
	 * 存储蓝牙数据（实时数据）
	 * @param type 数据类型（心率/血氧/电池/PPI）
	 * @param value 测量值
	 * @param ppi 心率变异性（可选，仅心率数据有）
	 * @param timestamp 时间戳（可选，默认当前时间）
	 */
	async storeData(
		type: BluetoothDataType,
		value: number,
		ppi: number | null = null,
		timestamp?: number
	): Promise<void> {
		// 实时数据暂不存储，只记录日志
		// TODO: 未来启用实时数据存储时取消此注释
		// console.log("实时数据（暂不存储）:", { type, value, ppi });
		// return;

		const id = this.generateId();
		const ts = timestamp ?? Date.now();

		console.log("存储数据:", { id, ts, type, value, ppi });

		let sql = `INSERT INTO bluetooth_data (id, timestamp, type, value, uploaded`;
		let values = `VALUES ('${id}', ${ts}, '${type}', ${value}, 0`;

		if (ppi != null) {
			sql += `, ppi`;
			values += `, ${ppi}`;
		}

		sql += `) ${values})`;
		console.log("INSERT SQL:", sql);

		await bluetoothDatabase.execute(sql);
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

	/**
	 * 存储 0x50 广播实时数据（本地首页展示使用，不上传）
	 */
	async storeRealtimeBroadcastRecord(
		id: string,
		timestamp: number,
		receivedAt: number,
		utc: number,
		voltageMv: number,
		status: number,
		ppgAttachedValue: boolean,
		behavior: number,
		activity: number,
		hr: number,
		ppi: number,
		spo2: number,
		bhr: number,
		rawHexValue: string,
		vHexValue: string,
		deviceIdValue: string
	): Promise<boolean> {
		const rawHex = this.escapeSqlText(rawHexValue);
		const vHex = this.escapeSqlText(vHexValue);
		const deviceId = this.escapeSqlText(deviceIdValue);
		const ppgAttached = ppgAttachedValue == true ? 1 : 0;
		const sql =
			"INSERT OR REPLACE INTO realtime_broadcast_data " +
			"(id, timestamp, received_at, utc, voltage_mv, status, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, raw_hex, v_hex, device_id) VALUES " +
			`('${id}', ${timestamp}, ${receivedAt}, ${utc}, ${voltageMv}, ${status}, ${ppgAttached}, ${behavior}, ${activity}, ${hr}, ${ppi}, ${spo2}, ${bhr}, '${rawHex}', '${vHex}', '${deviceId}')`;
		return bluetoothDatabase.execute(sql);
	}

	/**
	 * 获取最后一条 0x50 广播实时数据
	 */
	async getLatestRealtimeBroadcastRecord(): Promise<RealtimeBroadcastRecord | null> {
		const sql =
			"SELECT id, timestamp, received_at, utc, voltage_mv, status, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, raw_hex, v_hex, device_id FROM realtime_broadcast_data ORDER BY received_at DESC LIMIT 1";
		const result = await bluetoothDatabase.query(sql);
		if (result == null || result.rows.length == 0) {
			return null;
		}
		const row = result.rows[0];
		return {
			id: row[0] as string,
			timestamp: parseInt(row[1] as string),
			receivedAt: parseInt(row[2] as string),
			utc: parseInt(row[3] as string),
			voltageMv: parseInt(row[4] as string),
			status: parseInt(row[5] as string),
			ppgAttached: parseInt(row[6] as string) == 1,
			behavior: parseInt(row[7] as string),
			activity: parseInt(row[8] as string),
			hr: parseInt(row[9] as string),
			ppi: parseInt(row[10] as string),
			spo2: parseInt(row[11] as string),
			bhr: parseInt(row[12] as string),
			rawHex: row[13] as string,
			vHex: row[14] as string,
			deviceId: row[15] as string
		} as RealtimeBroadcastRecord;
	}

	private escapeSqlText(value: string): string {
		return value.split("'").join("''");
	}

	/**
	 * 获取所有蓝牙数据
	 * @returns 蓝牙数据数组
	 */
	async getAllData(): Promise<BluetoothData[]> {
		const sql =
			"SELECT id, timestamp, type, value, ppi, uploaded FROM bluetooth_data ORDER BY timestamp DESC";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		const dataList: BluetoothData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			console.log("查询到数据:", row);
			dataList.push({
				id: row[0],
				timestamp: parseInt(row[1]),
				type: row[2] as BluetoothDataType,
				value: parseFloat(row[3]),
				ppi: row[4] != null ? parseInt(row[4]) : null,
				uploaded: row[5] == "1"
			} as BluetoothData);
		}
		return dataList;
	}

	/**
	 * 获取未上传的蓝牙数据
	 * @returns 未上传的蓝牙数据数组
	 */
	async getUnuploadedData(): Promise<BluetoothData[]> {
		const sql =
			"SELECT id, timestamp, type, value, ppi, uploaded FROM bluetooth_data WHERE uploaded = 0 ORDER BY timestamp ASC";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		const dataList: BluetoothData[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			const data = {
				id: row[0] as string,
				timestamp: parseInt(row[1] as string),
				type: row[2] as BluetoothDataType,
				value: parseFloat(row[3]),
				ppi: row[4] != null ? parseInt(row[4] as string) : 0,
				uploaded: false
			} as BluetoothData;
			console.log("查询到数据:", i, data);
			dataList.push(data);
		}
		return dataList;
	}

	/**
	 * 获取PPI数据总数
	 * @returns ppi_data表中的总记录数
	 */
	async getPpiDataCount(): Promise<number> {
		const sql = "SELECT COUNT(*) FROM ppi_data";
		const result = await bluetoothDatabase.query(sql);

		if (result == null || result.rows.length == 0) {
			return 0;
		}

		return parseInt(result.rows[0][0] as string);
	}

	/**
	 * 获取 0x50 广播实时数据总数
	 */
	async getRealtimeBroadcastDataCount(): Promise<number> {
		const sql = "SELECT COUNT(*) FROM realtime_broadcast_data";
		const result = await bluetoothDatabase.query(sql);

		if (result == null || result.rows.length == 0) {
			return 0;
		}

		return parseInt(result.rows[0][0] as string);
	}

	/**
	 * 获取最近 N 条 0x50 广播实时数据
	 */
	async getRecentRealtimeBroadcastRecords(limit: number): Promise<RealtimeBroadcastRecord[]> {
		const safeLimit = limit <= 0 ? 10 : limit;
		const sql =
			"SELECT id, timestamp, received_at, utc, voltage_mv, status, ppg_attached, behavior, activity, hr, ppi, spo2, bhr, raw_hex, v_hex, device_id FROM realtime_broadcast_data ORDER BY received_at DESC LIMIT " +
			safeLimit.toString();
		const result = await bluetoothDatabase.query(sql);
		if (result == null) {
			return [];
		}

		const records: RealtimeBroadcastRecord[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			records.push({
				id: row[0] as string,
				timestamp: parseInt(row[1] as string),
				receivedAt: parseInt(row[2] as string),
				utc: parseInt(row[3] as string),
				voltageMv: parseInt(row[4] as string),
				status: parseInt(row[5] as string),
				ppgAttached: parseInt(row[6] as string) == 1,
				behavior: parseInt(row[7] as string),
				activity: parseInt(row[8] as string),
				hr: parseInt(row[9] as string),
				ppi: parseInt(row[10] as string),
				spo2: parseInt(row[11] as string),
				bhr: parseInt(row[12] as string),
				rawHex: row[13] as string,
				vHex: row[14] as string,
				deviceId: row[15] as string
			} as RealtimeBroadcastRecord);
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
		return {
			id: row[0] as string,
			timestamp: parseInt(row[1] as string),
			hr: parseInt(row[2] as string),
			spo2: parseInt(row[3] as string),
			ppi: parseInt(row[4] as string),
			uploaded: parseInt(row[5] as string) == 1
		} as PpiData;
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
			const row = result.rows[i];
			dataList.push({
				id: row[0] as string,
				timestamp: parseInt(row[1] as string),
				hr: parseInt(row[2] as string),
				spo2: parseInt(row[3] as string),
				ppi: parseInt(row[4] as string),
				uploaded: parseInt(row[5] as string) == 1
			} as PpiData);
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
			const row = result.rows[i];
			const data: PpiData = {
				id: row[0] as string,
				timestamp: parseInt(row[1] as string),
				hr: parseInt(row[2] as string),
				spo2: parseInt(row[3] as string),
				ppi: parseInt(row[4] as string),
				uploaded: false
			};
			// console.log("查询到PPI数据:", i, data);
			dataList.push(data);
		}
		return dataList;
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
	 * 标记蓝牙数据为已上传
	 * @param ids 数据ID数组
	 */
	async markAsUploaded(ids: string[]): Promise<void> {
		if (ids.length == 0) {
			return;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE bluetooth_data SET uploaded = 1 WHERE id IN (${idList})`;
		await bluetoothDatabase.execute(sql);
	}

	/**
	 * 清理过期的已上传数据
	 */
	async cleanupOldData(): Promise<void> {
		const now = Date.now();
		const cutoffTime = now - MAX_DATA_AGE;

		const sql = `DELETE FROM bluetooth_data WHERE uploaded = 1 AND CAST(timestamp AS INTEGER) < ${cutoffTime}`;
		await bluetoothDatabase.execute(sql);
	}

	/**
	 * 清空所有数据（包括蓝牙数据、睡眠数据、PPI数据）
	 */
	async clearAllData(): Promise<void> {
		console.log("清空所有数据库数据");
		await bluetoothDatabase.execute("DELETE FROM bluetooth_data");
		await bluetoothDatabase.execute("DELETE FROM sleep_data");
		await bluetoothDatabase.execute("DELETE FROM ppi_data");
		await bluetoothDatabase.execute("DELETE FROM realtime_broadcast_data");
		console.log("数据库数据清空完成");
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
		const sleepSql = `INSERT OR IGNORE INTO sleep_data
			(id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, detail, uploaded)
			VALUES ('${sleepId}', ${reportTimestamp}, ${bedtime}, ${sleepTime}, ${wakeTime}, ${getupTime}, ${recordCount}, '${detail}', 0)`;
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
			console.log("正在上传中，跳过PPI上传");
			return false;
		}

		const unuploadedData = await this.getUnuploadedPpiData();
		console.log("未上传的PPI数据数量:", unuploadedData.length, "全部数据:", unuploadedData);
		if (unuploadedData.length == 0) {
			return true;
		}

		console.log("当前设备信息:", { deviceName: this.deviceName, address: this.deviceAddress });
		if (this.deviceAddress == "") {
			console.log("设备未连接，跳过PPI上传");
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
					spo2: item.spo2,
					ppi: item.ppi
				});
			}

			const requestData: PpiUploadRequest = {
				device: this.deviceName,
				address: this.deviceAddress,
				timezone: "08:00",
				datas
			};

			console.log("上传PPI数据:", JSON.stringify(requestData));

			const response = await request({
				url: UPLOAD_PPI_URL,
				method: "POST",
				data: requestData,
				header: {
					"Content-Type": "application/json"
				}
			});

			console.log("PPI上传响应:", response);

			const uploadedIds: string[] = [];
			for (let i = 0; i < unuploadedData.length; i++) {
				uploadedIds.push(unuploadedData[i].id);
			}
			await this.markPpiDataAsUploaded(uploadedIds);
			await this.cleanupOldData();

			console.log("PPI上传成功");
			return true;
		} catch (error) {
			console.error("PPI上传失败:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	/**
	 * 合并心率数据到映射表
	 */
	private mergeHeartRateData(
		ppiData: BluetoothData[],
		timestampMap: Map<number, HeartRateDataMap>
	): void {
		for (let i = 0; i < ppiData.length; i++) {
			const item = ppiData[i];
			let existing = timestampMap.get(item.timestamp);
			if (existing == null) {
				existing = { hr: 0, spo2: 0, ppi: 0 };
			}
			const newData: HeartRateDataMap = {
				hr: item.value,
				spo2: existing.spo2,
				ppi: item.ppi ?? 0
			};
			timestampMap.set(item.timestamp, newData);
		}
	}

	/**
	 * 合并血氧数据到映射表
	 */
	private mergeBloodOxygenData(
		bloodOxygenData: BluetoothData[],
		timestampMap: Map<number, HeartRateDataMap>
	): void {
		for (let i = 0; i < bloodOxygenData.length; i++) {
			const item = bloodOxygenData[i];
			let existing = timestampMap.get(item.timestamp);
			if (existing == null) {
				existing = { hr: 0, spo2: 0, ppi: 0 };
			}
			const newData: HeartRateDataMap = {
				hr: existing.hr,
				spo2: item.value,
				ppi: existing.ppi
			};
			timestampMap.set(item.timestamp, newData);
		}
	}

	/**
	 * 构建上传数据数组
	 */
	private buildUploadDatas(
		timestampMap: Map<number, HeartRateDataMap>,
		datas: PpiDataItem[]
	): void {
		const keys: number[] = [];
		timestampMap.forEach((_value, key) => {
			keys.push(key);
		});
		for (let i = 0; i < keys.length; i++) {
			const timestamp = keys[i];
			const values = timestampMap.get(timestamp);
			if (values != null) {
				const ppiItem: PpiDataItem = {
					time: this.formatTimestamp(timestamp),
					hr: values.hr,
					spo2: values.spo2,
					ppi: values.ppi
				};
				datas.push(ppiItem);
			}
		}
	}

	/**
	 * 上传睡眠数据
	 * @returns 是否上传成功
	 */
	async uploadSleepData(): Promise<boolean> {
		if (this.isUploading == true) {
			console.log("正在上传中，跳过睡眠数据上传");
			return false;
		}

		const unuploadedSleepData = await this.getUnuploadedSleepData();
		console.log("未上传的睡眠数据数量:", unuploadedSleepData.length);
		if (unuploadedSleepData.length == 0) {
			return true;
		}

		console.log("当前设备信息:", { deviceName: this.deviceName, address: this.deviceAddress });
		if (this.deviceAddress == "") {
			console.log("设备未连接，跳过睡眠数据上传");
			return false;
		}

		this.isUploading = true;

		try {
			const sleepData = unuploadedSleepData[0];

			const dataItem = this.buildSleepUploadItem(sleepData);
			const datas: SleepUploadDataItem[] = [dataItem];

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

			console.log("上传睡眠数据:", JSON.stringify(requestData));

			const response = await request({
				url: UPLOAD_SLEEP_URL,
				method: "POST",
				data: requestData,
				header: {
					"Content-Type": "application/json"
				}
			});

			console.log("睡眠数据上传响应:", response);

			const uploadedIds: string[] = [];
			for (let i = 0; i < unuploadedSleepData.length; i++) {
				uploadedIds.push(unuploadedSleepData[i].id!);
			}
			await this.markSleepAsUploaded(uploadedIds);

			console.log("睡眠数据上传成功");
			return true;
		} catch (error) {
			console.error("睡眠数据上传失败:", error);
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

	/**
	 * 上传所有数据（PPI数据和睡眠数据）
	 * @returns 是否上传成功
	 */
	async uploadData(): Promise<boolean> {
		await this.uploadPpiData();
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
