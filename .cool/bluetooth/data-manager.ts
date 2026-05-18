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
	SleepStatus,
	PpiUploadRequest,
	SleepUploadRequest,
	SleepUploadDataItem,
	HeartRateDataMap,
	PpiDataItem
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
		this.deviceName = deviceName;
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
		return Date.now().toString(36) + Math.random().toString(36).substring(2);
	}

	/**
	 * 存储蓝牙数据
	 * @param type 数据类型（心率/血氧/电池/PPI）
	 * @param value 测量值
	 * @param ppi 心率变异性（可选，仅心率数据有）
	 */
	async storeData(
		type: BluetoothDataType,
		value: number,
		ppi: number | null = null
	): Promise<void> {
		return;
		const id = this.generateId();
		const timestamp = Date.now();

		console.log("存储数据:", { id, timestamp, type, value, ppi });

		let sql = `INSERT INTO bluetooth_data (id, timestamp, type, value, uploaded`;
		let values = `VALUES ('${id}', ${timestamp}, '${type}', ${value}, 0`;

		if (ppi != null) {
			sql += `, ppi`;
			values += `, ${ppi}`;
		}

		sql += `) ${values})`;
		console.log("INSERT SQL:", sql);

		await bluetoothDatabase.execute(sql);
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
	 * 清空所有数据（包括蓝牙数据、睡眠数据和睡眠状态）
	 */
	async clearAllData(): Promise<void> {
		console.log("清空所有数据库数据");
		await bluetoothDatabase.execute("DELETE FROM bluetooth_data");
		await bluetoothDatabase.execute("DELETE FROM sleep_data");
		await bluetoothDatabase.execute("DELETE FROM sleep_status");
		console.log("数据库数据清空完成");
	}

	/**
	 * 存储睡眠数据
	 * @param sleepData 睡眠数据
	 */
	async storeSleepData(sleepData: SleepData): Promise<void> {
		const sleepId = sleepData.id ?? this.generateId();
		const { reportTimestamp, bedtime, sleepTime, wakeTime, getupTime, recordCount, statuses } =
			sleepData;

		const sleepSql = `INSERT INTO sleep_data (id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count, uploaded) 
			VALUES ('${sleepId}', ${reportTimestamp}, ${bedtime}, ${sleepTime}, ${wakeTime}, ${getupTime}, ${recordCount}, 0)`;
		await bluetoothDatabase.execute(sleepSql);

		for (let i = 0; i < statuses.length; i++) {
			const status = statuses[i];
			const statusId = status.id ?? this.generateId();
			const statusSql = `INSERT INTO sleep_status (id, sleep_id, minute_index, status) 
				VALUES ('${statusId}', '${sleepId}', ${i}, ${status.status})`;
			await bluetoothDatabase.execute(statusSql);
		}
	}

	/**
	 * 获取未上传的睡眠数据
	 * @returns 未上传的睡眠数据数组
	 */
	async getUnuploadedSleepData(): Promise<SleepData[]> {
		const sql =
			"SELECT id, report_timestamp, bedtime, sleep_time, wake_time, getup_time, record_count FROM sleep_data WHERE uploaded = 0";
		const result = await bluetoothDatabase.query(sql);

		if (result == null) {
			return [];
		}

		const sleepDataList: SleepData[] = [];

		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			const sleepId = row[0];

			const statusSql = `SELECT minute_index, status FROM sleep_status WHERE sleep_id = '${sleepId}' ORDER BY minute_index`;
			const statusResult = await bluetoothDatabase.query(statusSql);

			const statuses: SleepStatus[] = [];
			if (statusResult != null) {
				for (let j = 0; j < statusResult.rows.length; j++) {
					const statusRow = statusResult.rows[j];
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

		const unuploadedData = await this.getUnuploadedData();
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
			const ppiData: BluetoothData[] = [];
			const bloodOxygenData: BluetoothData[] = [];
			for (let i = 0; i < unuploadedData.length; i++) {
				const item = unuploadedData[i];
				if (item.type == "heartRate") {
					ppiData.push(item);
				} else if (item.type == "bloodOxygen") {
					bloodOxygenData.push(item);
				}
			}

			const datas: PpiDataItem[] = [];
			const timestampMap: Map<number, HeartRateDataMap> = new Map<number, HeartRateDataMap>();

			this.mergeHeartRateData(ppiData, timestampMap);
			this.mergeBloodOxygenData(bloodOxygenData, timestampMap);
			this.buildUploadDatas(timestampMap, datas);

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
			await this.markAsUploaded(uploadedIds);
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

			const statusDetail = this.buildStatusDetail(sleepData.statuses);
			const dataItem = this.buildSleepUploadItem(sleepData, statusDetail);
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
	 * 构建睡眠状态详情字符串
	 */
	private buildStatusDetail(statuses: SleepStatus[]): string {
		const detailArray: string[] = [];
		for (let i = 0; i < statuses.length; i++) {
			const status = statuses[i].status;
			if (status == -2 || status == 3) {
				detailArray.push("3");
			} else if (status == -1 || status == 2) {
				detailArray.push("2");
			} else if (status == 0 || status == 1) {
				detailArray.push("1");
			} else {
				detailArray.push("0");
			}
		}
		return detailArray.join("");
	}

	/**
	 * 构建睡眠上传数据项
	 */
	private buildSleepUploadItem(sleepData: SleepData, statusDetail: string): SleepUploadDataItem {
		return {
			bedSec: Math.floor((sleepData.bedtime - sleepData.reportTimestamp) / 1000),
			detail: statusDetail,
			sleepSec: Math.floor((sleepData.wakeTime - sleepData.sleepTime) / 1000),
			time: this.formatTimestamp(sleepData.reportTimestamp),
			upSec: Math.floor((sleepData.getupTime - sleepData.wakeTime) / 1000),
			wakeSec:
				Math.floor((sleepData.wakeTime - sleepData.bedtime) / 1000) -
				Math.floor((sleepData.wakeTime - sleepData.sleepTime) / 1000)
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
			// this.uploadData();
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
