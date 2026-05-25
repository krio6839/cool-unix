// ==================== 基础数据类型 ====================

/**
 * 蓝牙数据类型枚举
 */
export type BluetoothDataType = "heartRate" | "bloodOxygen" | "battery" | "ppi";

/**
 * 蓝牙数据记录
 */
export type BluetoothData = {
	id: string;
	timestamp: number;
	type: BluetoothDataType;
	value: number;
	ppi: number | null;
	uploaded: boolean;
};

/**
 * 睡眠状态
 */
export type SleepStatus = {
	id: string;
	sleepId: string;
	minuteIndex: number;
	status: number; // -2: Deep sleep, -1: Light sleep, 0: REM, 1: WAKE
};

/**
 * 睡眠数据（同时作为输入和记录类型）
 */
export type SleepData = {
	id?: string;
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getupTime: number;
	recordCount: number;
	statuses: SleepStatus[];
	uploaded?: boolean;
};

/**
 * 心率数据映射（用于内部数据处理）
 */
export type HeartRateDataMap = {
	hr: number;
	spo2: number;
	ppi: number;
};

/**
 * PPI数据记录（数据库记录）
 */
export type PpiData = {
	id: string;
	timestamp: number;
	hr: number;
	spo2: number;
	ppi: number;
	uploaded: boolean;
};

/**
 * 心率记录（用于历史数据解析）
 */
export type HeartRateRecord = {
	timestamp: number;
	heartRate: number;
	bloodOxygen: number;
	ppi: number;
};

/**
 * 数据准备状态
 */
export type DataReadyStatus = {
	heartRateCount: number;
	sleepCount: number;
};

// ==================== 上传数据类型 ====================

/**
 * PPI数据项（上传接口使用）
 */
export type PpiDataItem = {
	time: string;
	hr: number;
	spo2: number;
	ppi: number;
};

/**
 * PPI上传请求
 */
export type PpiUploadRequest = {
	device: string;
	address: string;
	timezone: string;
	datas: PpiDataItem[];
};

/**
 * 睡眠上传数据项
 */
export type SleepUploadDataItem = {
	bedSec: number;
	detail: string;
	sleepSec: number;
	time: string;
	upSec: number;
	wakeSec: number;
};

/**
 * 睡眠上传请求
 */
export type SleepUploadRequest = {
	address: string;
	datas: SleepUploadDataItem[];
	device: string;
	recoverScore: string;
	sleepScore: string;
	time: string;
	timezone: string;
	tiredScore: string;
};
