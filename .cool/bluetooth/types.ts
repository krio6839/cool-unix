import type { RealtimeBroadcast } from "./boom-types";

// ==================== 基础数据类型 ====================

/**
 * 睡眠事件（协议 2.1.4.2.6）的六个统计值 + 结算时刻，同时也是 `sleep_data` 的一行。
 *
 * 六个统计值要么一起有、要么这条事件本身无效，所以这里不是可空的：
 * 无效事件在 `history-reader.toSleepData` 就被挡掉，不会流到这里；
 * 表结构也是 NOT NULL，残缺行根本进不了库。
 */
export type SleepData = {
	/** 事件结算时刻（设备时钟，秒），也是 `sleep_data` 的主键 */
	reportTimestamp: number;
	/** 入睡时刻：距 `reportTimestamp` 的秒数 */
	sleepOnsetTime: number;
	/** 醒来时刻：距 `reportTimestamp` 的秒数 */
	awakeTime: number;
	lightSleepPeriod: number;
	deepSleepPeriod: number;
	otherSleepPeriod: number;
	heartRateRest: number;
	/** 本地上传状态（`sleep_data.uploaded`）。写库不由它决定，只有读取路径会填。 */
	uploaded?: boolean;
};

/**
 * PPI数据记录（数据库记录），一行 = 设备给的一秒。
 *
 * `behavior` 之后的列只有**实时广播**那一秒才有值：逐秒历史 `0x3A` 的
 * `VitalData_Per_Second` 只有 hr / status / pitch / acc / ppi，设备根本没给
 * bhr / 步数 / 卡路里 / rmssd。缺值是 `null` 而不是 0——0 在这些字段上都是合法值。
 */
export type PpiData = {
	id: string;
	timestamp: number;
	hr: number;
	spo2: number;
	ppi: number;
	activity: number;
	/** 设备 `status` 的 bit5-3（行为类型） */
	behavior: number | null;
	/** 设备 `status` 的 bit6（PPG 佩戴），0/1 */
	ppgAttached: number | null;
	/** 静息心率 bpm */
	bhr: number | null;
	/** 当日累计步数（快照，不是增量） */
	stepsEveryday: number | null;
	/** 当日累计运动卡路里 ×100 kcal（快照，不是增量） */
	calorieEveryday: number | null;
	/** RMSSD ms，设备 float32 原值 */
	rmssd: number | null;
	uploaded: boolean;
};

/**
 * 一帧广播写入 PPI 队列的输入。
 *
 * 与 `RealtimeBroadcast` 分开，是因为这里只要「能进数据库的原始值」：展示用的
 * `xxxValid` 折算值一律不参与落库。
 */
export type BroadcastPpiRecord = {
	timestamp: number;
	hr: number;
	spo2: number;
	ppi: number;
	activity: number;
	behavior: number;
	ppgAttached: number;
	bhr: number;
	stepsEveryday: number;
	calorieEveryday: number;
	/** NaN 在这里被转成 null（设备没算出来时是无效浮点） */
	rmssd: number | null;
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
	/** 记账右端（`stableCeiling`）：这之后的时间尚未稳定，不参与判定。 */
	stableCeilingSec: number;
	/** 还有多少秒没有记账（`stableCeilingSec - baselineSec`），也是连接闸门的输入。 */
	behindSeconds: number;
	/** 分类游标 `C`：已经判定过的右端。`C > B` 说明 `B` 正卡在某段不合格段上。 */
	classifiedUntilSec: number;
	unuploadedCount: number;
	earliestUnuploadedSec: number;
	latestUnuploadedSec: number;
};

// ==================== 上传数据类型 ====================

/**
 * PPI 数据项（上传接口使用），每秒一条，全部取自设备。
 *
 * `activity` 就是设备 `status` 的低 3 位，**睡眠详情由它承担**：
 * 0 深睡 / 1 浅睡 / 2 其他睡眠 / 3 精神放松 / 4 活动量低 / 5 活动量高 / 6 精神兴奋 / 7 身体压力。
 *
 * `behavior` 及之后的字段只有实时广播秒才有值，历史补回来的秒发 `null`：
 * 设备的历史逐秒记录里没有这些列，用 0 顶替会让后端把「没给」读成真实值。
 */
export type PpiDataItem = {
	time: string;
	hr: number;
	/** 设备原始值，×10：950 = 95.0% */
	spo2: number;
	ppi: number;
	activity: number;
	/** 行为类型 0-7，`status` bit5-3 */
	behavior: number | null;
	/** PPG 佩戴 0/1，`status` bit6 */
	ppgAttached: number | null;
	bhr: number | null;
	/** 当日累计步数（快照） */
	steps: number | null;
	/** 当日累计运动卡路里 ×100 kcal（快照） */
	calorie: number | null;
	rmssd: number | null;
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
 * 睡眠上传数据项：`SleepData` 的六个统计值 + 按请求 `timezone` 格式化后的时刻。
 *
 * 睡眠详情（逐秒分期曲线）不在这里，它走 PPI 的 `activity`。
 * 这里只有设备事件给出的「两个时刻（距事件结算时刻的秒数）+ 三个时长 + 静息心率」。
 */
export type SleepUploadDataItem = {
	/** 事件结算时刻（设备时钟），按 `timezone` 格式化 */
	time: string;
	/** 入睡时刻：距 `time` 的秒数 */
	sleepOnsetTime: number;
	/** 醒来时刻：距 `time` 的秒数 */
	awakeTime: number;
	lightSleepPeriod: number;
	deepSleepPeriod: number;
	otherSleepPeriod: number;
	heartRateRest: number;
};

/**
 * 睡眠上传请求：只有路由信息（device/address/timezone）+ 设备事件数据。
 */
export type SleepUploadRequest = {
	address: string;
	datas: SleepUploadDataItem[];
	device: string;
	timezone: string;
};
