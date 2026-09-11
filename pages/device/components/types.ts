// 设备组件类型定义

// 设备图标组件属性
export interface DeviceIconProps {
	searching: boolean;
}

// 未配对状态组件属性
export interface UnpairedStateProps {
	bluetoothEnabled: boolean;
}

// 测试页弹窗共享的 UI 边界类型；协议和历史业务类型仍从 .cool 模块引入。
export type HistoryQuickReadPopupProps = {
	status: string;
	pages: number;
	seconds: number;
	days: number;
	busy: boolean;
	exportCount: number;
};
export type HistoryGapRepairPayload = { taskIds: string[] };
export type HistoryGapRepairPopupProps = {
	busy: boolean;
	commandMessage: string;
	revision: number;
};
export type VitalPopupText = {
	summary: string;
	start: string;
	directionMinutes: string;
	valid: string;
	ppi: string;
	status: string;
	rmssdSdnn: string;
	vital: string;
};
export type VitalProtocolPopupProps = {
	vitalText: VitalPopupText;
	hasData: boolean;
	autoDetail: string;
	rawHex: string;
	busy: boolean;
};
export type VitalPopupPayload = { startSec: string; direction: number; minutes: number };
export type EventProtocolPopupProps = {
	eventHeader: string;
	eventCount: string;
	eventItems: string;
	hasData: boolean;
	autoDetail: string;
	rawHex: string;
	busy: boolean;
};
export type EventPopupPayload = {
	type: number;
	startSec: string;
	endSec: string;
	maxCount: string;
};
export type DevicePopupPayload = {
	type: "0x31" | "0x35";
	deviceNumber?: string;
	gender?: number;
	weight?: string;
	height?: string;
	age?: string;
	bhr?: string;
};
export type DeviceControlPopupProps = { busy: boolean; isDisabled: (cmd: string) => boolean };
export type DeviceReadItem = { cmd: string; label: string };
export type DataDiagnosticsPopupProps = { protocolLogs?: string[]; diagnosticLogs?: string[] };
