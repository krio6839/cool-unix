/**
 * 新 BOOM 设备协议常量（来自 状态说明.txt）
 * 设备名：BOOM-XXXX，蓝牙 GATT Service UUID: 75c276c3-8f97-20bc-a143-b354244886d4
 */

/** 新设备 GATT Service UUID（来自状态说明.txt 1.4.2） */
export const BOOM_GATT_SERVICE_UUID = "75c276c3-8f97-20bc-a143-b354244886d4";

/**
 * TLV 命令码（显式类型声明，UTS 不支持 as const）
 * 字段顺序与状态说明.txt 1.4.4 一致
 */
export type BoomCmd = {
	READ_FIRMWARE_VERSION: number; //读固件版本
	SET_DEVICE_NUMBER: number; //设置设备号
	READ_DEVICE_NUMBER: number; //读设备号
	SET_BOOM_TIMESTAMP: number; //设置时间戳
	READ_BOOM_TIMESTAMP: number; //读时间戳
	SET_BIOMETRIC: number; //设置生物特征
	READ_BIOMETRIC: number; //读生物特征
	CONTROL_VIBRATION: number; //控制振动
};

export const BOOM_CMD: BoomCmd = {
	READ_FIRMWARE_VERSION: 0x30,
	SET_DEVICE_NUMBER: 0x31,
	READ_DEVICE_NUMBER: 0x32,
	SET_BOOM_TIMESTAMP: 0x33,
	READ_BOOM_TIMESTAMP: 0x34,
	SET_BIOMETRIC: 0x35,
	READ_BIOMETRIC: 0x36,
	CONTROL_VIBRATION: 0x40
};

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
