import type { RealtimeBroadcast } from "./boom-types";

// ==================== 基础数据类型 ====================

/** 睡眠结果事件；旧版已上传审计行的统计字段可能为空。 */
export type SleepData = {
	id?: string;
	reportTimestamp: number;
	sleepOnsetTime: number | null;
	awakeTime: number | null;
	lightSleepPeriod: number | null;
	deepSleepPeriod: number | null;
	otherSleepPeriod: number | null;
	heartRateRest: number | null;
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
	activity: number | null;
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
	activity: number;
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
	activity: number | null;
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
	time: string;
	sleepOnsetTime: number;
	awakeTime: number;
	lightSleepPeriod: number;
	deepSleepPeriod: number;
	otherSleepPeriod: number;
	heartRateRest: number;
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
