/**
 * 新 BOOM 设备协议数据类型定义
 * 字节布局严格遵循状态说明.txt 1.4.4 与 2.1 节
 */

/** 协议数值类型：运行时仍为 number，便于 UTS 编译与跨端序列化 */
export type PpgPositionValue = number;
export type VitalDirectionValue = number;
export type VitalMinutesValue = number;
export type EventQueryTypeValue = number;
export type LogEventTypeValue = number;

/** PPG 佩戴位置选项（value 对应协议 UINT8） */
export type PpgPositionOption = {
	label: string;
	value: PpgPositionValue;
};

/** 固件版本（0x30 响应 V，3B） */
export type FirmwareVersion = {
	major: number;
	minor: number;
	revision: number;
};

/** 生物识别数据（0x35/0x36 V，8B packed LE）— 状态说明.txt 2.1.1 */
export type VitalBiometric = {
	gender: number; // 0  UINT8  0=男 1=女
	weight: number; // 1-2 UINT16 LE  ×100 (kg)
	height: number; // 3-4 UINT16 LE  ×100 (cm)
	age: number; // 5  UINT8
	ppgPosition: PpgPositionValue; // 6  UINT8  0..6（见 PPG_POSITION_OPTIONS）
	bhr: number; // 7  UINT8  28..240
};

/** 震动马达控制参数（0x40 请求 V） */
export type VibrationSpec = {
	loops: number; // 循环次数（Byte 0）
	count: number; // 震动次数（Byte 1，最大 10）
	onOffMs: number[]; // [震动ms, 静默ms, ... 震动ms]，长度 = count*2-1
};

/** 震动马达响应（0x40 响应 V，1B） */
export type VibrationResult = { code: number }; // 0=成功，其它=失败原因

/** 解析后的 TLVC 帧（来自 boom-codec.decodeTlvc） */
export type TlvcFrame = {
	t: number; // 2B 命令码
	l: number; // 2B V 字段字节数
	v: string; // V 字段 hex 字符串
	c: number; // 2B CRC-16（已校验）
};

/** 0x50 自定义广播数据 raw（21B packed LE）— 状态说明.txt 2.1.2 */
export type CustomAdvData = {
	utc: number; // 0~3   UINT32 LE  秒
	voltage: number; // 4~5   INT16  LE  电池电压 mV
	status: number; // 6     UINT8
	//   bit6: PPG 佩戴 (0/1)
	//   bit5-3: 行为类型 (0=休息 1=日常 2=步行 3=跑步 4=骑行 5=有氧 6=其他运动 7=保留)
	//   bit2-0: 活动状态 (0=深睡 1=浅睡 2=其他睡眠 3=精神放松 4=活动量低 5=活动量高 6=精神兴奋 7=身体压力)
	hr: number; // 7     UINT8  bpm
	ppi: number; // 8~9   UINT16 LE  ms
	spo2: number; // 10~11 UINT16 LE  ×10（950=95.0%）
	bhr: number; // 12    UINT8  静息心率/Basal heart rate
	stepsEveryday: number; // 13~16 UINT32 LE  当日步数
	calorieEveryday: number; // 17~20 UINT32 LE  当日运动卡路里 ×100
};

/** 0x50 解析后用于 UI 展示的扁平实时数据 */
export type RealtimeBroadcast = {
	receivedAt: number; // 本地接收时间 ms
	utc: number;
	voltageMv: number; // mV
	voltageV: number;
	status: number;
	statusReserved: number;
	ppgAttached: boolean;
	behavior: number; // 0..6
	behaviorLabel: string;
	activity: number; // 0..7
	activityLabel: string;
	hr: number;
	hrValid: boolean;
	ppi: number;
	ppiValid: boolean;
	spo2Pct: number; // 950 → 95.0
	spo2Valid: boolean;
	bhr: number;
	bhrValid: boolean;
	hrvMs: number;
	stepsEveryday: number;
	calorieEveryday: number;
	calorieKcal: number;
	stepsValid: boolean;
	calorieValid: boolean;
};

/** 0x41 控制设备响应（Byte0=控制代码，Byte1=结果，0=成功） */
export type DeviceControlResult = {
	code: number;
	result: number;
};

/** status 字节解码结果（来自 decodeAdvStatus） */
export type AdvStatus = {
	reserved: number;
	ppgAttached: boolean;
	behavior: number;
	behaviorLabel: string;
	activity: number;
	activityLabel: string;
};

/* ==================== 0x3A/0x3B 生命体征数据类型（1.4.4.8/1.4.4.9 + 2.1.3） ==================== */

/**
 * 每秒生命体征数据（6B packed LE）— 状态说明.txt 2.1.3
 * - hr=0x00/0xFF 表示无效，0xFE 表示空白
 */
export type VitalDataPerSecond = {
	hr: number; // 0     UINT8  bpm（0x00/0xFF=无效 0xFE=空白）
	status: number; // 1     UINT8  bit5-3 行为类型, bit2-0 活动状态
	pitch: number; // 2     UINT8  步频（0-255）
	acc: number; // 3     UINT8  加速度幅值
	ppi: number; // 4-5   UINT16 LE  脉波间期 ms（0=无效）
	/** 是否有效（hr 不为 0x00、0xFE、0xFF） */
	valid: boolean;
};

/** 0x3A 请求 V（6B）：4B 时戳 + 1B 方向 + 1B 分钟数 */
export type VitalDataQueryRequest = {
	startSec: number;
	direction: VitalDirectionValue; // 0=向前 1=向后
	minutes: VitalMinutesValue; // 只能是 2 或 5
};

/** RMSSD/SDNN 单分钟统计（8B：4B RMSSD float LE + 4B SDNN float LE）
 * 全 FF 标记为无效（rmssd/sdnn 都置 NaN）
 */
export type RmssdSdnnPair = {
	rmssd: number;
	sdnn: number;
	valid: boolean;
};

/** 0x3A/0x3B 响应 V（变长）
 * 格式: 4B startSec + 1B direction + 1B n + n*8B RMSSD/SDNN + n*60*6B vital data
 */
export type VitalDataQueryResponse = {
	startSec: number;
	direction: number;
	n: number; // 返回分钟数（可能 < 请求分钟数）
	rmssdSdnn: RmssdSdnnPair[]; // n 项
	vitalData: VitalDataPerSecond[]; // n*60 项
};

/* ==================== 0x3C/0x3D 事件数据类型（1.4.4.10/1.4.4.11 + 2.1.4） ==================== */

/** 0x3C 请求 V（10B）：1B 固定 0 + 1B type + 4B start + 4B end */
export type EventDataQuery = {
	type: EventQueryTypeValue; // Byte 1：0=ALL 1=BY_TIME
	startSec: number;
	endSec: number;
};

/** 0x3C 响应 V（17B）：事件头（最早/最晚 sn+ts） */
export type EventDataHeaderResponse = {
	type: number; // Byte 0
	earliestSn: number; // Byte 1-4
	earliestSec: number; // Byte 5-8
	latestSn: number; // Byte 9-12
	latestSec: number; // Byte 13-16
};

/** DS_Data_Header_t（10B packed）— 状态说明.txt 2.1.4 */
export type LogDataHeader = {
	flag: number; // 0     UINT8  0xA5=有效
	flag2: number; // 1     UINT8  保留
	crc8: number; // 2     UINT8
	payloadLen: number; // 3     UINT8
	sn: number; // 4-5   UINT16 LE  reset 后自增序号
	globalSn: number; // 6-9   UINT32 LE  全局自增序号
};

/**
 * Log_Data_t（变长）— 状态说明.txt 2.1.4
 * - header(10B) + ts(4B) + tick(4B) + eventType(1B) + dataLen(1B) + eventData(dataLen B)
 * - eventData 按 eventType 解析后填入 parsedEvent（UTSJSONObject 表达）
 */
export type LogDataItem = {
	header: LogDataHeader;
	ts: number; // 时间戳
	tick: number; // (GetTick() / 1000)
	eventType: LogEventTypeValue; // 类型（LogEventType 数值）
	dataLen: number; // 数据长度
	eventDataHex: string; // 原始 hex（兜底展示）
	parsedEvent: EventDataParsed; // 按 eventType 解析后的结构化对象
};

export type EventDataParsed = UTSJSONObject;

/* ===== eventData 子类型（2.1.4.2.x）===== */

/** 2.1.4.2.1 Text/RemoteCmd/SetDeviceSn：eventData = ASCII 字符串 */
export type EventDataText = {
	text: string;
};

/** 2.1.4.2.2 Reset：eventData = 4B LE 数值（重启原因） */
export type EventDataReset = {
	value: number;
};

/** 2.1.4.2.3 SetTime：eventData = 2 个 4B LE（设置前时戳 + 设置后时戳） */
export type EventDataSetTime = {
	oldSec: number;
	newSec: number;
};

/** 2.1.4.2.4 FormatDS：eventData = 4B LE（擦除扇区地址） */
export type EventDataFormatDS = {
	address: number;
};

/** 2.1.4.2.5 Wear：eventData = 2 个 1B（改变前状态 + 改变后状态） */
export type EventDataWear = {
	before: number; // 0=未佩戴 1=佩戴
	after: number;
};

/** 2.1.4.2.6 SleepResult：eventData = 22B packed LE vital_sleep_result_t */
export type EventDataSleepResult = {
	sleepOnsetSec: number; // 距当前秒数
	awakeSec: number; // 距当前秒数
	lightSleepSec: number; // 浅度睡眠时长
	deepSleepSec: number; // 深度睡眠时长
	otherSleepSec: number; // 其他睡眠时长
	restHr: number; // 静息心率 bpm
};

/** 2.1.4.2.7 Sedentary：eventData = 2B LE（久坐阈值秒数） */
export type EventDataSedentary = {
	thresholdSec: number;
};
