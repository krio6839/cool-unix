// 蓝牙服务UUID映射表
export const SERVICE_UUID_NAMES: UTSJSONObject = {
	// 常见蓝牙服务
	"00001800-0000-1000-8000-00805f9b34fb": "Generic Access",
	"00001801-0000-1000-8000-00805f9b34fb": "Generic Attribute",
	"0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
	"0000180d-0000-1000-8000-00805f9b34fb": "Heart Rate",
	"0000180f-0000-1000-8000-00805f9b34fb": "Battery Service",
	"00001810-0000-1000-8000-00805f9b34fb": "Blood Pressure",
	"0000181a-0000-1000-8000-00805f9b34fb": "Environmental Sensing",
	"0000181b-0000-1000-8000-00805f9b34fb": "Body Composition",
	"0000181e-0000-1000-8000-00805f9b34fb": "Sports and Fitness",
	"0000181f-0000-1000-8000-00805f9b34fb": "Location and Navigation",
	"6e400001-b5a3-f393-e0a9-e50e24dcca9e": "Nordic UART Service",
	"00001523-1212-efde-1523-785feabcd123": "LED Button Service"
};

// 蓝牙特征UUID映射表
export const CHARACTERISTIC_UUID_NAMES: UTSJSONObject = {
	// Generic Access服务特征
	"00002a00-0000-1000-8000-00805f9b34fb": "Device Name",
	"00002a01-0000-1000-8000-00805f9b34fb": "Appearance",
	"00002a04-0000-1000-8000-00805f9b34fb": "Peripheral Preferred Connection Parameters",

	// Generic Attribute服务特征
	"00002a05-0000-1000-8000-00805f9b34fb": "Service Changed",

	// Device Information服务特征
	"00002a23-0000-1000-8000-00805f9b34fb": "System ID",
	"00002a24-0000-1000-8000-00805f9b34fb": "Model Number String",
	"00002a25-0000-1000-8000-00805f9b34fb": "Serial Number String",
	"00002a26-0000-1000-8000-00805f9b34fb": "Firmware Revision String",
	"00002a27-0000-1000-8000-00805f9b34fb": "Hardware Revision String",
	"00002a28-0000-1000-8000-00805f9b34fb": "Software Revision String",
	"00002a29-0000-1000-8000-00805f9b34fb": "Manufacturer Name String",

	// Heart Rate服务特征
	"00002a37-0000-1000-8000-00805f9b34fb": "Heart Rate Measurement",
	"00002a38-0000-1000-8000-00805f9b34fb": "Body Sensor Location",
	"00002a39-0000-1000-8000-00805f9b34fb": "Heart Rate Control Point",

	// Battery Service服务特征
	"00002a19-0000-1000-8000-00805f9b34fb": "Battery Level",

	// Nordic UART Service特征
	"6e400002-b5a3-f393-e0a9-e50e24dcca9e": "TX Characteristic",
	"6e400003-b5a3-f393-e0a9-e50e24dcca9e": "RX Characteristic",

	// LED Button Service特征
	"00001524-1212-efde-1523-785feabcd123": "LED Characteristic",
	"00001525-1212-efde-1523-785feabcd123": "Button Characteristic"
};

// 获取服务名称
export const getServiceName = (uuid: string): string => {
	const name = SERVICE_UUID_NAMES[uuid.toLowerCase()] as string | null;
	return name != null ? name : "Custom Service";
};

// 获取特征名称
export const getCharacteristicName = (uuid: string): string => {
	const name = CHARACTERISTIC_UUID_NAMES[uuid.toLowerCase()] as string | null;
	return name != null ? name : "Custom Characteristic";
};
