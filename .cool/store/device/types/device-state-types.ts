export type ConnectModeReason = "scheduler" | "unbind";

export type DeviceOnlineSource = "gatt" | "broadcast" | "searching" | "offline";
export type ScanPurpose = "none" | "pairing" | "boundBroadcast";

export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;

export type DeviceOnlineInfo = {
	online: boolean;
	source: DeviceOnlineSource;
	statusText: string;
	iconColor: string;
	iconName: string;
	deviceName: string;
	lastSeenAt: number;
};
