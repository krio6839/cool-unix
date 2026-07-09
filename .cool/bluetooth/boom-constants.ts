/**
 * 新 BOOM 设备协议常量（来自 状态说明.txt）
 * 设备名：BOOM-XXXX，蓝牙 GATT Service UUID: 75c276c3-8f97-20bc-a143-b354244886d4
 */

/** 新设备 GATT Service UUID（来自状态说明.txt 1.4.2） */
export const BOOM_GATT_SERVICE_UUID = "75c276c3-8f97-20bc-a143-b354244886d4";

/** TLV 命令码（显式类型声明，UTS 不支持 as const）
 * 字段顺序与状态说明.txt 1.4.4 一致
 */
export type BoomCmd = {
	READ_FIRMWARE_VERSION: number; // 读固件版本 0x30
	SET_DEVICE_NUMBER: number; // 设置设备号 0x31
	READ_DEVICE_NUMBER: number; // 读设备号 0x32
	SET_BOOM_TIMESTAMP: number; // 设置时间戳 0x33
	READ_BOOM_TIMESTAMP: number; // 读时间戳 0x34
	SET_BIOMETRIC: number; // 设置生物特征 0x35
	READ_BIOMETRIC: number; // 读生物特征 0x36
	// 1.4.4.8  开始读生命体征数据（每分钟 360B，多帧）
	READ_VITAL_DATA_START: number;
	// 1.4.4.9  继续读生命体征数据
	READ_VITAL_DATA_CONTINUE: number;
	// 1.4.4.10 开始读事件数据
	READ_EVENT_DATA_START: number;
	// 1.4.4.11 继续读事件数据
	READ_EVENT_DATA_CONTINUE: number;
	CONTROL_VIBRATION: number; // 控制振动 0x40
};

export const BOOM_CMD: BoomCmd = {
	READ_FIRMWARE_VERSION: 0x30,
	SET_DEVICE_NUMBER: 0x31,
	READ_DEVICE_NUMBER: 0x32,
	SET_BOOM_TIMESTAMP: 0x33,
	READ_BOOM_TIMESTAMP: 0x34,
	SET_BIOMETRIC: 0x35,
	READ_BIOMETRIC: 0x36,
	READ_VITAL_DATA_START: 0x3A,
	READ_VITAL_DATA_CONTINUE: 0x3B,
	READ_EVENT_DATA_START: 0x3C,
	READ_EVENT_DATA_CONTINUE: 0x3D,
	CONTROL_VIBRATION: 0x40
};

/* ===== 0x3A/0x3B 生命体征数据常量 ===== */

/** 每秒生命体征数据"无效"标记（hr=0xFF 表示该秒无数据） */
export const VITAL_DATA_INVALID = 0xFF;
/** 每秒生命体征数据"空白"标记（hr=0xFE 表示尚未采集） */
export const VITAL_DATA_BLANK = 0xFE;
/** 0x3A/0x3B 请求 V Byte 5：每次只能读 2 或 5 分钟 */
export const VITAL_MINUTES_OPTIONS: number[] = [2, 5];
/** 0x3A 请求 V Byte 4：方向（0=向前，1=向后） */
export const VITAL_DIRECTION_FORWARD: number = 0;
export const VITAL_DIRECTION_BACKWARD: number = 1;

/* ===== 0x3C/0x3D 事件数据常量 ===== */

/** Log_Data_t 有效数据 flag（2.1.4 文档） */
export const LOG_DATA_FLAG = 0xA5;
/** 0x3C 请求 V Byte 0：查询类型
 * 0=ALL（按 sn 范围）
 * 1=BY_TIME（按时间范围）
 */
export const EVENT_QUERY_TYPE_ALL: number = 0;
export const EVENT_QUERY_TYPE_BY_TIME: number = 1;

/* ===== DataIdentifier 多帧协议（1.3.2） ===== */

/** DataIdentifier bit9-13：4 位序列号上限（0~15，即最多 16 帧） */
export const MAX_MULTI_FRAME_COUNT = 16;
/** 多帧重组 buffer 上限（1KB，文档注释推荐值） */
export const MAX_RECV_BUF_BYTES = 1024;
/** mock 自动切帧时单帧 payload 字节数（按文档 DI 头 2B + payload 512B 上限，留 240B 余量） */
export const DEFAULT_MAX_FRAME_PAYLOAD_BYTES = 240;

/* ===== LogEventType 枚举（2.1.4.1）===== */

/** LogEventType 数值定义（UTS 不支持 enum 与 as const，用 const 对象 + type 表达） */
export type LogEventTypeMap = {
	Text: number;
	Reset: number;
	SetTime: number;
	FormatDS: number;
	SflashErase: number;
	RemoteCmd: number;
	Wear: number;
	SetDeviceSn: number;
	SleepResult: number;
	Sedentary: number;
	SetBiometricInfo: number;
	NUMS: number;
};

export const LOG_EVENT_TYPE: LogEventTypeMap = {
	Text: 0, // 重要 log 记录事件
	Reset: 1, // 设备重启时间
	SetTime: 2, // 设置设备时间时间
	FormatDS: 3, // 格式化存储区事件
	SflashErase: 4, // 重要扇区擦除事件
	RemoteCmd: 5, // 执行远程命令事件
	Wear: 6, // PPG 佩戴事件
	SetDeviceSn: 7, // 改变设备编号
	SleepResult: 8, // 睡眠结果事件
	Sedentary: 9, // 久坐事件
	SetBiometricInfo: 10, // 改变生物信息
	NUMS: 11 // 枚举数量
};

export type LogEventTypeValue = number;

/** LogEventType UI 中文名（与 LOG_EVENT_TYPE 数值顺序一一对应） */
export const LOG_EVENT_NAMES: string[] = [
	"重要日志", // 0 Text
	"设备重启", // 1 Reset
	"设置时间", // 2 SetTime
	"格式化存储", // 3 FormatDS
	"扇区擦除", // 4 SflashErase
	"远程命令", // 5 RemoteCmd
	"PPG佩戴", // 6 Wear
	"设置设备号", // 7 SetDeviceSn
	"睡眠结果", // 8 SleepResult
	"久坐事件", // 9 Sedentary
	"设置生物信息", // 10 SetBiometricInfo
	"未知" // 11 NUMS（占位）
];

/** 设备编号最大字符数（仅数字/字母，最长 29 位） */
export const DEVICE_NUMBER_MAX_LEN = 29;

/** PPG 佩戴位置名（仅 UI 文案，顺序与状态说明.txt 2.1.1 一致） */
export const PPG_POSITION_LIST: Array<string> = [
	"手腕",
	"前臂",
	"上臂",
	"头部",
	"膝盖下方",
	"大腿",
	"身体"
];
