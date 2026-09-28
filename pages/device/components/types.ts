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
	/** 常驻基准行：`B` / 记账上限 / 落后量。起点晚于 `B` 会触发「只落库不记账」。 */
	baselineInfo: string;
	busy: boolean;
	exportCount: number;
};
/** 补录只按时间端点走，不再有任务 id：端点是推算出来的，没有可寻址的行。 */
export type HistoryRepairPayload = { fromSec: number; toSec: number };
export type HistoryRepairPopupProps = {
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
	busy: boolean;
};
export type VitalPopupPayload = { startSec: string; direction: number; minutes: number };
export type EventProtocolPopupProps = {
	eventHeader: string;
	eventCount: string;
	eventItems: string;
	hasData: boolean;
	autoDetail: string;
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
export type DataDiagnosticsPopupProps = { diagnosticLogs?: string[] };
