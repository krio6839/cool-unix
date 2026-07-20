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
 * 睡眠数据（同时作为输入和记录类型）
 * detail 字段由 SleepResponseAssembler 装配时按 (signed_status + 2) 规则生成，
 * 数据库仅存 detail 字符串，不再有独立的 sleep_status 表。
 */
export type SleepData = {
	id?: string;
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getupTime: number;
	recordCount: number;
	detail: string;
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
 * 0x50 广播实时数据记录（本地首页展示使用，不参与 PPI 上传）
 */
export type RealtimeBroadcastRecord = {
	id: string;
	timestamp: number;
	receivedAt: number;
	utc: number;
	voltageMv: number;
	status: number;
	ppgAttached: boolean;
	behavior: number;
	activity: number;
	hr: number;
	ppi: number;
	spo2: number;
	bhr: number;
	stepsEveryday: number;
	calorieEveryday: number;
	rawHex: string;
	vHex: string;
	deviceId: string;
};

/**
 * 本地上传状态统计
 */
export type UploadTableStats = {
	tableName: string;
	total: number;
	uploaded: number;
	unuploaded: number;
	earliestTimestamp: number;
	latestTimestamp: number;
	latestUploadedTimestamp: number;
	latestUnuploadedTimestamp: number;
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
