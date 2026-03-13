// 设备组件类型定义

// 设备图标组件属性
export interface DeviceIconProps {
	searching: boolean;
}

// 未配对状态组件属性
export interface UnpairedStateProps {
	bluetoothEnabled: boolean;
}

// 设备信息接口
export interface DeviceInfo {
	deviceId: string;
	name: string | null;
	localName: string | null;
}

// 设备状态枚举
export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;

// 设备页面状态类型
export interface DevicePageState {
	status: DeviceStatus;
	connectedDeviceName: string;
	deviceList: Array<DeviceInfo>;
}
