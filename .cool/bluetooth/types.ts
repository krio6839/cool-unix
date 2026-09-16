import type { RealtimeBroadcast } from "./boom-types";

// ==================== 基础数据类型 ====================

/**
 * 睡眠数据（同时作为输入和记录类型）
 * detail 字段为睡眠上传接口使用的每秒状态数字串。
 */
export type SleepData = {
	id?: string;
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getupTime: number;
	detail: string;
	uploaded?: boolean;
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
	ppgAttached: boolean;
	behavior: number;
	activity: number;
	hr: number;
	ppi: number;
	spo2: number;
	bhr: number;
	eventSeq: number;
	hasNewEvent: boolean;
	batteryStatus: number;
	rmssd: number;
	stepsEveryday: number;
	calorieEveryday: number;
	rawHex: string;
	vHex: string;
	deviceId: string;
};

/**
 * 0x50 广播入库输入。
 * 调用方只提供解析结果和原始上下文，数据库字段映射统一由 BluetoothDataManager 维护。
 */
export type StoreRealtimeBroadcastInput = {
	broadcast: RealtimeBroadcast;
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

/** 当前 App 会话内的基准补录与 PPI 上传诊断摘要。 */
export type HistorySessionDiagnostics = {
	/** 基准时间：`[0, baselineSec)` 已全部记账完毕。 */
	baselineSec: number;
	/** 记账右端，同时也是缺口右端。 */
	stableCeilingSec: number;
	/** 当前可读缺口的分组数（含桥接合并）。 */
	gapGroups: number;
	/** 缺口里真正要补的秒数，不含桥接跨过的部分。 */
	gapSeconds: number;
	/** `vital_ready_ranges` 的行数。运行时通常接近 0——建完就被推进消费掉。 */
	readyRanges: number;
	unuploadedCount: number;
	earliestUnuploadedSec: number;
	latestUnuploadedSec: number;
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
