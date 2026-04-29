import { parse, storage } from "../index";
import { bluetoothDatabase } from "./database";
import type {
	BluetoothData,
	BluetoothDataType,
	SleepData,
	SleepDataInput,
	SleepStatus
} from "./types";

const UPLOAD_INTERVAL = 10 * 1000; // 10秒上传一次
const MAX_DATA_AGE = 90 * 24 * 60 * 60 * 1000; // 90天

export class BluetoothDataManager {
	private uploadTimer: number | null = null;
	private isUploading: boolean = false;

	constructor() {
		// 初始化数据库
		this.initDatabase();
		this.startUploadTimer();
		this.cleanupOldData();
	}

	// 初始化数据库
	private async initDatabase(): Promise<void> {
		await bluetoothDatabase.open();
	}

	// 生成唯一ID
	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2);
	}

	// 存储蓝牙数据
	async storeData(
		type: BluetoothDataType,
		value: number,
		ppi: number | null = null
	): Promise<void> {
		const id = this.generateId();
		const timestamp = Date.now();

		// 构建 SQL 语句
		let sql = `INSERT INTO bluetooth_data (id, timestamp, type, value, uploaded`;
		let values = `VALUES ('${id}', ${timestamp}, '${type}', ${value}, 0`;

		if (ppi != null) {
			sql += `, ppi`;
			values += `, ${ppi}`;
		}

		sql += `) ${values})`;

		// 执行插入
		await bluetoothDatabase.execute(sql);
	}

	// 获取所有数据
	async getAllData(): Promise<BluetoothData[]> {
		const sql =
			"SELECT id, timestamp, type, value, ppi, uploaded FROM bluetooth_data ORDER BY timestamp DESC";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		return result.rows.map((row) => ({
			id: row[0],
			timestamp: parseInt(row[1]),
			type: row[2] as BluetoothDataType,
			value: parseFloat(row[3]),
			ppi: row[4] != null ? parseInt(row[4]) : null,
			uploaded: row[5] == "1"
		}));
	}

	// 获取未上传的数据
	async getUnuploadedData(): Promise<BluetoothData[]> {
		const sql =
			"SELECT id, timestamp, type, value, ppi, uploaded FROM bluetooth_data WHERE uploaded = 0 ORDER BY timestamp ASC";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}
		console.log("result.rows", result.rows);
		return result.rows.map((row) => ({
			id: row[0],
			timestamp: parseInt(row[1]),
			type: row[2] as BluetoothDataType,
			value: parseFloat(row[3]),
			ppi: row[4] != null ? parseInt(row[4]) : 0,
			uploaded: false
		}));
	}

	// 标记数据为已上传
	async markAsUploaded(ids: string[]): Promise<void> {
		if (ids.length == 0) {
			return;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE bluetooth_data SET uploaded = 1 WHERE id IN (${idList})`;
		await bluetoothDatabase.execute(sql);
	}

	// 清理旧数据
	async cleanupOldData(): Promise<void> {
		const now = Date.now();
		const cutoffTime = now - MAX_DATA_AGE;

		// 只清理已上传且超过时间的数据
		const sql = `DELETE FROM bluetooth_data WHERE uploaded = 1 AND timestamp < ${cutoffTime}`;
		await bluetoothDatabase.execute(sql);
	}

	// 存储睡眠数据
	async storeSleepData(sleepData: SleepDataInput): Promise<void> {
		const sleepId = this.generateId();
		const reportTimestamp = sleepData.reportTimestamp;
		const bedtime = sleepData.bedtime;
		const sleepTime = sleepData.sleepTime;
		const wakeTime = sleepData.wakeTime;
		const getupTime = sleepData.getupTime;
		const recordCount = sleepData.recordCount;

		// 插入睡眠数据
		const sleepSql = `INSERT INTO sleep_data (id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, uploaded) 
			VALUES ('${sleepId}', ${reportTimestamp}, ${bedtime}, ${sleepTime}, ${wakeTime}, ${getupTime}, ${recordCount}, 0)`;
		await bluetoothDatabase.execute(sleepSql);

		// 插入睡眠状态
		for (let i = 0; i < sleepData.statuses.length; i++) {
			const status = sleepData.statuses[i];
			const statusId = this.generateId();
			const statusValue = status.status;
			const statusSql = `INSERT INTO sleep_status (id, sleep_id, minute_index, status) 
				VALUES ('${statusId}', '${sleepId}', ${i}, ${statusValue})`;
			await bluetoothDatabase.execute(statusSql);
		}
	}

	// 获取未上传的睡眠数据
	async getUnuploadedSleepData(): Promise<SleepData[]> {
		const sql =
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count FROM sleep_data WHERE uploaded = 0";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		const sleepDataList: SleepData[] = [];

		for (const row of result.rows) {
			const sleepId = row[0];

			// 获取睡眠状态
			const statusSql = `SELECT minute_index, status FROM sleep_status WHERE sleep_id = '${sleepId}' ORDER BY minute_index`;
			const statusResult = await bluetoothDatabase.query(statusSql);

			const statuses: SleepStatus[] = [];
			if (statusResult != null) {
				for (const statusRow of statusResult.rows) {
					statuses.push({
						id: this.generateId(),
						sleepId,
						minuteIndex: parseInt(statusRow[0]),
						status: parseInt(statusRow[1])
					});
				}
			}

			sleepDataList.push({
				id: sleepId,
				reportTimestamp: parseInt(row[1]),
				bedtime: parseInt(row[2]),
				sleepTime: parseInt(row[3]),
				wakeTime: parseInt(row[4]),
				getupTime: parseInt(row[5]),
				recordCount: parseInt(row[6]),
				statuses,
				uploaded: false
			});
		}

		return sleepDataList;
	}

	// 标记睡眠数据为已上传
	async markSleepAsUploaded(ids: string[]): Promise<void> {
		if (ids.length == 0) {
			return;
		}

		const idList = ids.map((id) => `'${id}'`).join(",");
		const sql = `UPDATE sleep_data SET uploaded = 1 WHERE id IN (${idList})`;
		await bluetoothDatabase.execute(sql);
	}

	// 上传数据
	async uploadData(): Promise<boolean> {
		if (this.isUploading == true) {
			return false;
		}

		const unuploadedData = await this.getUnuploadedData();
		if (unuploadedData.length == 0) {
			return true;
		}

		this.isUploading = true;

		try {
			// 这里实现实际的上传逻辑
			// 模拟上传成功
			console.log("上传蓝牙数据:", unuploadedData);

			// 模拟网络请求延迟
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					resolve();
				}, 1000);
			});

			// 标记为已上传
			const uploadedIds = unuploadedData.map((item) => item.id);
			await this.markAsUploaded(uploadedIds);

			// 清理旧数据
			await this.cleanupOldData();

			console.log("上传成功");
			return true;
		} catch (error) {
			console.error("上传失败:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	// 开始定时上传
	startUploadTimer(): void {
		this.stopUploadTimer();
		//@ts-ignore
		this.uploadTimer = setInterval(() => {
			this.uploadData();
		}, UPLOAD_INTERVAL);
	}

	// 停止定时上传
	stopUploadTimer(): void {
		const timer = this.uploadTimer;
		if (timer != null) {
			clearInterval(timer);
			this.uploadTimer = null;
		}
	}

	// 销毁
	async destroy(): Promise<void> {
		this.stopUploadTimer();
		await bluetoothDatabase.close();
	}
}

export const bluetoothDataManager = new BluetoothDataManager();
