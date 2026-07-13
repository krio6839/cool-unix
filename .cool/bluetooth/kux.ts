//#ifdef H5
type UniError = any;

//#endif

//#ifndef H5
//@ts-ignore
import { useKuxBluetooth } from "@/uni_modules/kux-bluetooth";

import type {
	IBluetooth,
	InitConfig,
	DeviceInfo,
	GetBLEDeviceServicesSuccess,
	GetBLEDeviceServicesSuccessService,
	GetBLEDeviceCharacteristicsSuccess,
	BLEDeviceCharacteristic,
	OpenBluetoothAdapterSuccess,
	StartBluetoothDevicesDiscoveryOptions,
	CreateBLEConnectionOptions,
	ApiCommonSuccessCallback,
	OnBluetoothAdapterStateChangeCallback,
	OnBLEConnectionStateChangeCallback,
	OnBluetoothDeviceFoundCallback,
	OnBLECharacteristicValueChangeCallback,
	OnReadBLECharacteristicValueCallback
	//@ts-ignore
} from "@/uni_modules/kux-bluetooth/utssdk/interface";

// 业务层需要用到的类型,从这里统一 re-export
export type { DeviceInfo, GetBLEDeviceServicesSuccessService, BLEDeviceCharacteristic };

const DEFAULT_CONFIG: InitConfig = {
	needLocation: true,
	accessBackgroundLocation: false
};

// 模块级单例:整个项目共用一个 IBluetooth 实例
//@ts-ignore
const kx = useKuxBluetooth(DEFAULT_CONFIG) as IBluetooth;

export function handleBluetoothError(err: UniError): boolean {
	console.log(`蓝牙错误 ${err.errCode}: ${err.errMsg}`);

	switch (err.errCode) {
		case -1:
			return true;
		default:
			return false;
	}
}

// ====== 适配器 ======
export function openAdapter(): Promise<OpenBluetoothAdapterSuccess> {
	return new Promise((resolve, reject) => {
		kx.openBluetoothAdapter({
			success: (res: OpenBluetoothAdapterSuccess) => resolve(res),
			fail: (err: UniError) => {
				const status = handleBluetoothError(err);
				if (status) {
					reject(err);
				}
			}
		});
	});
}

export function closeAdapter(): Promise<boolean> {
	return new Promise((resolve) => {
		kx.closeBluetoothAdapter({
			success: (_res: ApiCommonSuccessCallback) => resolve(true),
			fail: (_err: any) => resolve(false)
		});
	});
}

// ====== 扫描 ======
export function startDiscovery(): Promise<boolean> {
	return new Promise((resolve) => {
		console.log("[SCAN] startDiscovery 请求");
		kx.startBluetoothDevicesDiscovery({
			// powerLevel: "high",
			success: (res: ApiCommonSuccessCallback) => {
				console.log("[SCAN] startDiscovery 成功");
				resolve(true);
			},
			fail: (err: UniError) => {
				console.warn("[SCAN] startDiscovery 失败:", err);
				const status = handleBluetoothError(err);
				resolve(status);
			}
		} as StartBluetoothDevicesDiscoveryOptions);
	});
}

export function stopDiscovery(): Promise<boolean> {
	return new Promise((resolve) => {
		kx.stopBluetoothDevicesDiscovery({
			success: (_res: ApiCommonSuccessCallback) => resolve(true),
			fail: (_err: UniError) => resolve(false)
		});
	});
}

export function onDeviceFound(cb: OnBluetoothDeviceFoundCallback): void {
	kx.onBluetoothDeviceFound(cb);
}

export function offDeviceFound(): void {
	kx.offBluetoothDeviceFound();
}

// ====== 连接 ======
export function connect(deviceId: string, timeout?: number): Promise<boolean> {
	return new Promise((resolve) => {
		kx.createBLEConnection({
			deviceId,
			timeout,
			success: (_res: ApiCommonSuccessCallback) => resolve(true),
			fail: (err: UniError) => {
				const status = handleBluetoothError(err);
				resolve(status);
			}
		} as CreateBLEConnectionOptions);
	});
}

export function disconnect(deviceId: string): Promise<boolean> {
	return new Promise((resolve) => {
		kx.closeBLEConnection({
			deviceId,
			success: (_res: ApiCommonSuccessCallback) => resolve(true),
			fail: (_err: any) => resolve(false)
		});
	});
}

export function onConnectionStateChange(cb: OnBLEConnectionStateChangeCallback): void {
	kx.onBLEConnectionStateChange(cb);
}

// ====== 服务 / 特征 ======
export function getServices(deviceId: string): Promise<GetBLEDeviceServicesSuccessService[]> {
	return new Promise((resolve, reject) => {
		kx.getBLEDeviceServices({
			deviceId,
			success: (res: GetBLEDeviceServicesSuccess) => resolve(res.services ?? []),
			fail: (err: any) => reject(err)
		});
	});
}

export function getCharacteristics(
	deviceId: string,
	serviceId: string
): Promise<BLEDeviceCharacteristic[]> {
	return new Promise((resolve) => {
		kx.getBLEDeviceCharacteristics({
			deviceId,
			serviceId,
			success: (res: GetBLEDeviceCharacteristicsSuccess) =>
				resolve(res.characteristics ?? []),
			fail: (_err: any) => resolve([])
		});
	});
}

// ====== 特征操作 ======
export function readCharacteristic(
	deviceId: string,
	serviceId: string,
	charId: string
): Promise<boolean> {
	return new Promise((resolve) => {
		console.log("[BLE] read 请求:", charId);
		kx.readBLECharacteristicValue({
			deviceId,
			serviceId,
			characteristicId: charId,
			success: (_res: ApiCommonSuccessCallback) => {
				console.log("[BLE] read 成功:", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				console.warn("[BLE] read 失败:", charId, _err);
				resolve(false);
			}
		});
	});
}

export function writeCharacteristic(
	deviceId: string,
	serviceId: string,
	charId: string,
	value: ArrayBuffer,
	writeType: "write" | "writeNoResponse" = "write"
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		console.log("写入特征值:", charId, value);
		kx.writeBLECharacteristicValue({
			deviceId,
			serviceId,
			characteristicId: charId,
			value,
			writeType,
			success: (_res: ApiCommonSuccessCallback) => {
				console.log("[BLE] write 成功:", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				console.warn("[BLE] write 失败:", charId, _err);
				reject(false);
			}
		});
	});
}

/**
 * notify/indicate 启用或停用
 * state=true 时返回 Promise(等回调)
 * state=false 时 fire-and-forget(不返回,跟原 device.ts disableNotify 行为一致)
 */
export function notifyCharacteristic(
	deviceId: string,
	serviceId: string,
	charId: string,
	state: boolean,
	type: "notification" | "indication" = "notification"
): Promise<boolean> {
	if (state == false) {
		return new Promise((resolve) => {
			console.log("[BLE] notify 关闭:", charId);
			kx.notifyBLECharacteristicValueChange({
				deviceId,
				serviceId,
				characteristicId: charId,
				state: false,
				type,
				success: (_res: ApiCommonSuccessCallback) => {
					console.log("[BLE] notify 关闭成功:", charId);
					resolve(true);
				},
				fail: (_err: any) => {
					console.warn("[BLE] notify 关闭失败:", charId, _err);
					resolve(false);
				}
			});
		});
	}
	return new Promise((resolve) => {
		console.log("[BLE] notify 启用:", charId);
		kx.notifyBLECharacteristicValueChange({
			deviceId,
			serviceId,
			characteristicId: charId,
			state: true,
			type,
			success: (_res: ApiCommonSuccessCallback) => {
				console.log("[BLE] notify 启用成功:", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				console.warn("[BLE] notify 启用失败:", charId, _err);
				resolve(false);
			}
		});
	});
}

// ====== 事件订阅(透传) ======
export function onAdapterStateChange(cb: OnBluetoothAdapterStateChangeCallback): void {
	kx.onBluetoothAdapterStateChange(cb);
}

export function onCharacteristicValueChange(cb: OnBLECharacteristicValueChangeCallback): void {
	kx.onBLECharacteristicValueChange(cb);
}

export function onReadCharacteristicValue(cb: OnReadBLECharacteristicValueCallback): void {
	kx.onReadBLECharacteristicValue(cb);
}
//#endif
