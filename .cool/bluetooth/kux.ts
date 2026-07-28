//#ifdef H5
type UniError = any;

//#endif

//#ifndef H5
//@ts-ignore
import { useKuxBluetooth } from "@/uni_modules/kux-bluetooth";
import { logger } from "../service/logger";
import { getErrorMessage } from "../utils";

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
	accessBackgroundLocation: true
};

// 模块级单例:整个项目共用一个 IBluetooth 实例；扫描栈异常时允许重建 native manager。
//@ts-ignore
let kx = useKuxBluetooth(DEFAULT_CONFIG) as IBluetooth;

export function recreateKuxBluetooth(reason: string = ""): void {
	//@ts-ignore
	kx = useKuxBluetooth(DEFAULT_CONFIG) as IBluetooth;
	logger.warn("bluetooth", `[BLE] kux 实例已重建${reason == "" ? "" : ": " + reason}`);
}

export function handleBluetoothError(err: UniError): boolean {
	logger.info("bluetooth", `蓝牙错误 ${err.errCode}: ${err.errMsg}`);

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
					resolve({
						errCode: err.errCode,
						errMsg: err.errMsg
					} as OpenBluetoothAdapterSuccess);
					return;
				}
				reject(getErrorMessage(err, "openBluetoothAdapter failed"));
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
export function startDiscovery(deviceId: string = ""): Promise<boolean> {
	return new Promise((resolve) => {
		logger.info(
			"bluetooth",
			"[SCAN] startDiscovery 请求",
			deviceId == "" ? "" : `deviceId=${deviceId}`
		);
		kx.startBluetoothDevicesDiscovery({
			deviceId,
			allowDuplicatesKey: true,
			powerLevel: "high",
			success: (res: ApiCommonSuccessCallback) => {
				logger.info("bluetooth", "[SCAN] startDiscovery 成功");
				resolve(true);
			},
			fail: (err: UniError) => {
				logger.warn("bluetooth", "[SCAN] startDiscovery 失败:", err);
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
			fail: (err: any) => reject(getErrorMessage(err, "getBLEDeviceServices failed"))
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
		logger.info("bluetooth", "[BLE] read 请求:", charId);
		kx.readBLECharacteristicValue({
			deviceId,
			serviceId,
			characteristicId: charId,
			success: (_res: ApiCommonSuccessCallback) => {
				logger.info("bluetooth", "[BLE] read 成功:", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				logger.warn("bluetooth", "[BLE] read 失败:", charId, _err);
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
		logger.info("bluetooth", "写入特征值", charId);
		kx.writeBLECharacteristicValue({
			deviceId,
			serviceId,
			characteristicId: charId,
			value,
			writeType,
			success: (_res: ApiCommonSuccessCallback) => {
				logger.info("bluetooth", "[BLE] write 成功", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				logger.warn("bluetooth", "[BLE] write 失败", `${charId}, ${_err}`);
				reject(getErrorMessage(_err, "writeBLECharacteristicValue failed"));
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
			logger.info("bluetooth", "[BLE] notify 关闭:", charId);
			kx.notifyBLECharacteristicValueChange({
				deviceId,
				serviceId,
				characteristicId: charId,
				state: false,
				type,
				success: (_res: ApiCommonSuccessCallback) => {
					logger.info("bluetooth", "[BLE] notify 关闭成功:", charId);
					resolve(true);
				},
				fail: (_err: any) => {
					logger.warn("bluetooth", "[BLE] notify 关闭失败:", charId, _err);
					resolve(false);
				}
			});
		});
	}
	return new Promise((resolve) => {
		logger.info("bluetooth", "[BLE] notify 启用", charId);
		kx.notifyBLECharacteristicValueChange({
			deviceId,
			serviceId,
			characteristicId: charId,
			state: true,
			type,
			success: (_res: ApiCommonSuccessCallback) => {
				logger.info("bluetooth", "[BLE] notify 启用成功", charId);
				resolve(true);
			},
			fail: (_err: any) => {
				logger.warn("bluetooth", "[BLE] notify 启用失败", `${charId}, ${_err}`);
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
