/**
 * 新 BOOM 设备协议数据类型定义
 * 字节布局严格遵循状态说明.txt 1.4.4 与 2.1 节
 */

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
	ppgPosition: number; // 6  UINT8  0..6（见 PPG_POSITION_LIST）
	bhr: number; // 7  UINT8  28..240
};

/** 震动马达控制参数（0x40 请求 V） */
export type VibrationSpec = {
	loops: number; // 循环次数（Byte 0）
	count: number; // 震动次数（Byte 1，最大 10）
	onOffMs: number[]; // [震动ms, 静默ms, 震动ms, 静默ms, ...]，长度 = count*2
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

/** 0x50 自定义广播数据 raw（13B packed LE）— 状态说明.txt 2.1.2 */
export type CustomAdvData = {
	utc: number; // 0~3   UINT32 LE  秒
	voltage: number; // 4~5   INT16  LE  电池电压 ×100
	status: number; // 6     UINT8
	//   bit6: PPG 佩戴 (0/1)
	//   bit5-3: 行为类型 (0=休息 1=日常 2=步行 3=跑步 4=骑行 5=有氧 6=其他运动 7=保留)
	//   bit2-0: 活动状态 (0=深睡 1=浅睡 2=其他睡眠 3=精神放松 4=活动量低 5=活动量高 6=精神兴奋 7=身体压力)
	hr: number; // 7     UINT8  bpm
	ppi: number; // 8~9   UINT16 LE  ms
	spo2: number; // 10~11 UINT16 LE  ×10（950=95.0%）
	bhr: number; // 12    UINT8  基础心率
};

/** 0x50 解析后用于 UI 展示的扁平实时数据 */
export type RealtimeBroadcast = {
	receivedAt: number; // 本地接收时间 ms
	utc: number;
	voltageMv: number; // mV
	ppgAttached: boolean;
	behavior: number; // 0..6
	activity: number; // 0..7
	hr: number;
	ppi: number;
	spo2Pct: number; // 950 → 95.0
	bhr: number;
};

/** status 字节解码结果（来自 decodeAdvStatus） */
export type AdvStatus = {
	ppgAttached: boolean;
	behavior: number;
	activity: number;
};
