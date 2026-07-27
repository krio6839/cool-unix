export type BroadcastSource = "broadcast" | "gatt";

export type BroadcastDebugInfo = {
	seq: number;
	source: BroadcastSource;
	deviceId: string;
	name: string;
	rssi: number;
	rawHex: string;
	vHex: string;
	utc: number;
	diffSec: number;
	summary: string;
	receivedAt: number;
};

/** 同一条 0x50 数据在解析、校时、入库、调试日志之间传递的上下文。 */
export type BroadcastPacketContext = {
	source: BroadcastSource;
	deviceId: string;
	name: string;
	rssi: number;
	rawHex: string;
	vHex: string;
};
