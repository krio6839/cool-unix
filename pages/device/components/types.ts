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

// 配对状态组件属性
export interface PairingStateProps {
	searching: boolean;
	deviceList: Array<DeviceInfo>;
}
