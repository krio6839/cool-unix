import {
	HEART_RATE_SERVICE_UUID,
	UART_SERVICE_UUID,
	LED_BUTTON_SERVICE_UUID,
	LED_BUTTON_CHARACTERISTIC_UUID,
	BLOOD_OXYGEN_CHARACTERISTIC_UUID,
	HEART_RATE_CHARACTERISTIC_UUID,
	hexStringToArrayBuffer,
	UART_TX_CHARACTERISTIC_UUID,
	UART_RX_CHARACTERISTIC_UUID,
	convertNumberToHexString,
	convertNumberToHexStringLSB
} from "../../bluetooth";

//#ifndef H5
import {
	getServices,
	getCharacteristics,
	readCharacteristic,
	writeCharacteristic,
	notifyCharacteristic
} from "../../bluetooth/kux";

import type {
	GetBLEDeviceServicesSuccessService,
	BLEDeviceCharacteristic
} from "../../bluetooth/kux";
//#endif

import type { Device } from "./index";

export class DeviceProtocol {
	private device: Device;

	// 服务和特征值
	services: Array<GetBLEDeviceServicesSuccessService> = [];
	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

	constructor(device: Device) {
		this.device = device;
	}

	async getDeviceServicesAndCharacteristics(deviceId: string): Promise<void> {
		//#ifndef H5
		const maxRetries = 10;
		let retryInterval = 300;
		const maxRetryInterval = 3000;

		for (let i = 0; i < maxRetries; i++) {
			try {
				const services = await getServices(deviceId);
				this.services = services;

				const characteristicsResults = await Promise.all(
					services.map((service: GetBLEDeviceServicesSuccessService) =>
						getCharacteristics(deviceId, service.uuid)
					)
				);

				services.forEach((service: GetBLEDeviceServicesSuccessService, index: number) => {
					const characteristics = characteristicsResults[index];
					this.characteristics.set(service.uuid, characteristics);
				});

				return;
			} catch (e) {
				// 重试获取服务
			}
			retryInterval = Math.min(retryInterval * 1.5, maxRetryInterval);
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), retryInterval);
			});
		}
		throw new Error("获取设备服务失败：服务未发现");
		//#endif
	}

	disableAllNotifications() {
		//#ifndef H5
		notifyCharacteristic(
			this.device.currentDeviceId,
			HEART_RATE_SERVICE_UUID,
			HEART_RATE_CHARACTERISTIC_UUID,
			false,
			"notification"
		);
		//#endif
	}

	// 设备功能
	async getLEDStatus() {
		//#ifndef H5
		return readCharacteristic(
			this.device.currentDeviceId,
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID
		);
		//#endif
	}

	setLEDStatus(val: string): Promise<boolean> {
		//#ifndef H5
		return writeCharacteristic(
			this.device.currentDeviceId,
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID,
			hexStringToArrayBuffer(val),
			"write"
		);
		//#endif
		return Promise.resolve(true);
	}

	readBloodOxygen(): Promise<boolean> {
		//#ifndef H5
		return readCharacteristic(
			this.device.currentDeviceId,
			LED_BUTTON_SERVICE_UUID,
			BLOOD_OXYGEN_CHARACTERISTIC_UUID
		);
		//#endif
		return Promise.resolve(true);
	}

	subscribeHeartRate(): Promise<boolean> {
		//#ifndef H5
		return notifyCharacteristic(
			this.device.currentDeviceId,
			HEART_RATE_SERVICE_UUID,
			HEART_RATE_CHARACTERISTIC_UUID,
			true,
			"notification"
		);
		//#endif
		return Promise.resolve(true);
	}

	subscribeUART(): Promise<boolean> {
		//#ifndef H5
		return notifyCharacteristic(
			this.device.currentDeviceId,
			UART_SERVICE_UUID,
			UART_RX_CHARACTERISTIC_UUID,
			true,
			"notification"
		);
		//#endif
		return Promise.resolve(true);
	}

	async toggleDeviceStatus() {
		const newState = !this.device._deviceOn;
		const val = newState ? "01" : "00";
		//#ifndef H5
		const writeOk = await writeCharacteristic(
			this.device.currentDeviceId,
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID,
			hexStringToArrayBuffer(val),
			"write"
		);
		if (writeOk) {
			// 00001525 特征是 notify-only（不支持 read），iOS 端 kux 库的
			// onReadBLECharacteristicValue 又是空实现，所以 read 回调永远拿不到值。
			// 写入成功 = 状态已切换，直接乐观更新本地状态。
			this.device._deviceOn = newState;
			console.log("[DEVICE] toggleDeviceStatus 写入成功,_deviceOn=", this.device._deviceOn);
		} else {
			console.warn(
				"[DEVICE] toggleDeviceStatus 写入失败,_deviceOn 保持不变:",
				this.device._deviceOn
			);
		}
		//#endif
	}

	sendCommand(val: string): Promise<boolean> {
		//#ifndef H5
		return writeCharacteristic(
			this.device.currentDeviceId,
			UART_SERVICE_UUID,
			UART_TX_CHARACTERISTIC_UUID,
			hexStringToArrayBuffer(val),
			"write"
		);
		//#endif
		return Promise.resolve(true);
	}

	// UART 命令封装
	queryDataReadyStatus(): Promise<boolean> {
		return this.sendCommand("71");
	}

	getDeviceTime(): Promise<boolean> {
		return this.sendCommand("74");
	}

	getHistoricalHeartRateData(recordIndex: number): Promise<boolean> {
		const cmd = "72" + convertNumberToHexStringLSB(recordIndex, 4);
		return this.sendCommand(cmd);
	}

	getSleepData(index: number): Promise<boolean> {
		const cmd = "73" + convertNumberToHexString(index, 1);
		return this.sendCommand(cmd);
	}

	shutdownDevice(): Promise<boolean> {
		return this.sendCommand("65");
	}

	setDeviceTime(timestamp: number): Promise<boolean> {
		const cmd = "75" + convertNumberToHexStringLSB(timestamp, 4);
		return this.sendCommand(cmd);
	}

	endSleepJudgment(): Promise<boolean> {
		return this.sendCommand("7A");
	}
}
