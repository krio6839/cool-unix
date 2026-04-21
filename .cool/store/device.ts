import { ref } from "vue";
import { storage } from "../utils";
import { t } from "../locale";
import { useUi } from "@/uni_modules/cool-ui";
import {
	getServiceName,
	getCharacteristicName,
	HEART_RATE_SERVICE_UUID,
	BATTERY_SERVICE_UUID,
	UART_SERVICE_UUID,
	stringToArrayBuffer,
	arrayBufferToHexString,
	parseHeartRateData,
	parseBloodOxygenData,
	parseBatteryData,
	LED_BUTTON_SERVICE_UUID,
	LED_BUTTON_CHARACTERISTIC_UUID,
	BLOOD_OXYGEN_CHARACTERISTIC_UUID,
	HEART_RATE_CHARACTERISTIC_UUID,
	hexStringToArrayBuffer
} from "../utils/bluetooth";

//#ifndef H5
//@ts-ignore
import { useKuxBluetooth } from "@/uni_modules/kux-bluetooth";

import {
	InitConfig,
	DeviceInfo,
	IBluetooth,
	GetBLEDeviceServicesSuccessService,
	BLEDeviceCharacteristic
	//@ts-ignore
} from "@/uni_modules/kux-bluetooth/utssdk/interface";

export type { DeviceInfo };
//#endif

// 佩戴位置类型（3个选项）
export type WearLocation = "大臂部" | "下胸部" | "腰部";

// 存储键名常量
const KEY_WEAR_LOCATION = "device_wear_location";
const KEY_LAST_DEVICE_ID = "last_device_id";

// 目标设备名称常量
const TARGET_DEVICE_NAME = "BOOM1";

// 设备状态枚举
export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;

const ui = useUi();
export class Device {
	inited = false;
	status = ref<DeviceStatus>("UNPAIRED");
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	lastConnectedDeviceId: string = "";

	kuxBluetooth: IBluetooth;

	// 佩戴位置
	currentWearLocation: WearLocation = "大臂部";

	// 充电状态
	_isCharging: boolean = false;

	// 设备开关状态
	_deviceOn: boolean = false;

	// 服务列表
	services: Array<GetBLEDeviceServicesSuccessService> = [];

	// 特征值列表
	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

	// UART 服务可写特征值
	uartWriteCharacteristicId: string = "";

	// 实时数据
	heartRate = ref(0);
	bloodOxygen = ref(0);
	battery = ref(0);
	ppi = ref(0);

	constructor() {
		// 加载保存的数据
		this.loadSavedData();

		//#ifndef H5
		const kuxBluetooth: IBluetooth = useKuxBluetooth({
			needLocation: true,
			accessBackgroundLocation: false
		} as InitConfig);
		this.kuxBluetooth = kuxBluetooth;
		this.initBluetooth();
		//#endif
	}

	// 加载保存的数据
	loadSavedData(): void {
		// 加载佩戴位置
		const savedLocation = storage.get(KEY_WEAR_LOCATION) as WearLocation | null;
		if (savedLocation != null) {
			this.currentWearLocation = savedLocation;
		}

		// 加载上次连接的设备ID
		const savedDeviceId = storage.get(KEY_LAST_DEVICE_ID) as string | null;
		if (savedDeviceId != null && savedDeviceId != "") {
			this.lastConnectedDeviceId = savedDeviceId;
		}
	}

	// 保存佩戴位置
	saveWearLocation(location: WearLocation): void {
		this.currentWearLocation = location;
		storage.set(KEY_WEAR_LOCATION, location, 0);
	}

	// 保存上次连接的设备信息
	saveLastConnectedDevice(deviceId: string): void {
		this.lastConnectedDeviceId = deviceId;
		storage.set(KEY_LAST_DEVICE_ID, deviceId, 0);
	}

	// 设置充电状态
	setCharging(charging: boolean): void {
		this._isCharging = charging;
	}

	getPaired(): boolean {
		return this.currentDeviceId != "";
	}

	async initBluetooth(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			this.kuxBluetooth.openBluetoothAdapter({
				success: (res) => {
					console.log(`初始化蓝牙成功:${res.errMsg}`);
					this.inited = true;

					// 监听特征值变化
					this.onCharacteristicValueChange();
					this.onReadCharacteristicValue();
					this.onWriteCharacteristicValue();

					// 监听蓝牙适配器状态变化
					this.kuxBluetooth.onBluetoothAdapterStateChange((res) => {
						console.log("adapterState changed, now is", res);
						if (!res.available) {
							ui.showToast({ message: t("蓝牙未开启"), type: "error" });
							this.status.value = "UNPAIRED";
						}
					});
					// 监听蓝牙连接状态变化
					this.kuxBluetooth.onBLEConnectionStateChange((res) => {
						console.log(`蓝牙连接状态:`, res);
						if (res.connected) {
							this.getDeviceServicesAndCharacteristics(res.deviceId).then(() => {
								this.getLEDStatus(500);
							});
						} else {
							if (res.deviceId == this.currentDeviceId) {
								this.status.value = "UNPAIRED";
								this.currentDeviceId = "";
								ui.showToast({ message: t("设备已断开"), type: "warn" });
							}
						}
					});
					// 初始化完成后，如果存在连接记录则自动连接
					if (this.lastConnectedDeviceId != "") {
						this.startBluetoothSearch();
					}

					resolve(res);
				},
				fail: (err) => {
					console.log("初始化蓝牙失败，错误码：" + err.errCode);
					ui.showToast({ message: t("蓝牙初始化失败"), type: "error" });
					reject(err);
				}
			});
		});
	}

	// 开始搜索蓝牙设备
	startBluetoothSearch() {
		this.devices = [];
		// 先停止之前的扫描
		this.stopBluetoothSearch();
		this.status.value = "SEARCHING";
		this.kuxBluetooth.startBluetoothDevicesDiscovery({
			success: (res) => {
				console.log("开始搜索目标设备: " + TARGET_DEVICE_NAME);
				// 监听新设备发现
				this.kuxBluetooth.onBluetoothDeviceFound((devices) => {
					devices.forEach((device) => {
						if (device.name != TARGET_DEVICE_NAME) {
							return;
						}
						console.log("发现目标设备:", device);
						// 过滤重复设备
						if (!this.devices.some((d) => d.deviceId == device.deviceId)) {
							this.devices.push(device);
						}
						console.log("当前设备列表:", this.devices);
						console.log("lastConnectedDeviceId:", this.lastConnectedDeviceId);
						this.connectToDevice(device.deviceId);
					});
				});
			},
			fail: (e) => {
				console.log(e);
				console.log("搜索蓝牙设备失败，错误码" + e.errCode);
				ui.showToast({ message: t("搜索设备失败"), type: "error" });
				this.status.value = "UNPAIRED";
			}
		});
	}

	// 停止搜索蓝牙设备
	stopBluetoothSearch() {
		this.kuxBluetooth.stopBluetoothDevicesDiscovery({
			success: (res) => {
				console.log("停止搜索蓝牙设备" + res.errMsg);
			}
		});
		this.kuxBluetooth.offBluetoothDeviceFound();
	}

	// 连接蓝牙设备
	connectToDevice(deviceId: string) {
		this.stopBluetoothSearch();
		this.kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res) => {
				console.log("连接蓝牙成功:" + res.errMsg);
				this.currentDeviceId = deviceId;
				this.status.value = "CONNECTED";
				this.saveLastConnectedDevice(deviceId);
				ui.showToast({ message: t("连接成功"), type: "success" });
			},
			fail: (err) => {
				if (err.errCode == -1) {
					this.currentDeviceId = deviceId;
					this.status.value = "CONNECTED";
					this.saveLastConnectedDevice(deviceId);
				} else {
					console.log("连接低功耗蓝牙失败，错误码：" + err.errCode);
					ui.showToast({ message: t("连接失败"), type: "error" });
					this.status.value = "UNPAIRED";
				}
			}
		});
	}

	// 获取设备服务和特征值
	async getDeviceServicesAndCharacteristics(deviceId: string): Promise<void> {
		const maxRetries = 10;
		let retryInterval = 300;
		const maxRetryInterval = 3000;

		for (let i = 0; i < maxRetries; i++) {
			try {
				const services = await this.tryGetServices(deviceId);
				console.log("获取设备服务成功:", services);
				this.services = services;

				const characteristicsResults = await Promise.all(
					services.map((service: GetBLEDeviceServicesSuccessService) =>
						this.getCharacteristicsForService(deviceId, service.uuid)
					)
				);

				services.forEach((service: GetBLEDeviceServicesSuccessService, index: number) => {
					const characteristics = characteristicsResults[index];
					this.characteristics.set(service.uuid, characteristics);

					const serviceName = getServiceName(service.uuid);
					if (service.uuid.toLowerCase() == UART_SERVICE_UUID) {
						const writeChar = characteristics.find(
							(c: BLEDeviceCharacteristic) => c.properties.write
						);
						if (writeChar != null) {
							this.uartWriteCharacteristicId = writeChar.uuid;
							console.log("保存 UART 可写特征值:", this.uartWriteCharacteristicId);
						}
					}
				});

				return;
			} catch (e) {
				console.log(`获取设备服务尝试 ${i + 1}/${maxRetries} 失败: ${JSON.stringify(e)}`);
			}
			retryInterval = Math.min(retryInterval * 1.5, maxRetryInterval);
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), retryInterval);
			});
		}
		throw new Error("获取设备服务失败：服务未发现");
	}

	tryGetServices(deviceId: string): Promise<GetBLEDeviceServicesSuccessService[]> {
		return new Promise((resolve, reject) => {
			this.kuxBluetooth.getBLEDeviceServices({
				deviceId,
				success: (res) => {
					if (res.services == null) {
						resolve([]);
					} else {
						resolve(res.services);
					}
				},
				fail: (err) => {
					reject(err);
				}
			});
		});
	}

	// 获取特定服务的特征值
	getCharacteristicsForService(
		deviceId: string,
		serviceId: string
	): Promise<BLEDeviceCharacteristic[]> {
		return new Promise((resolve) => {
			this.kuxBluetooth.getBLEDeviceCharacteristics({
				deviceId,
				serviceId,
				success: (res) => {
					if (res.characteristics == null) {
						resolve([]);
					} else {
						resolve(res.characteristics);
					}
				},
				fail: (err) => {
					console.log(`获取服务 ${serviceId} 特征值失败，错误码：` + err.errCode);
					resolve([]);
				}
			});
		});
	}

	getLEDStatus(delay = 0) {
		setTimeout(() => {
			this.readCharacteristic(LED_BUTTON_SERVICE_UUID, LED_BUTTON_CHARACTERISTIC_UUID);
		}, delay);
	}

	readBloodOxygen(): Promise<boolean> {
		return this.readCharacteristic(LED_BUTTON_SERVICE_UUID, BLOOD_OXYGEN_CHARACTERISTIC_UUID);
	}

	subscribeHeartRate(): void {
		this.enableNotify(HEART_RATE_SERVICE_UUID, HEART_RATE_CHARACTERISTIC_UUID);
	}
	setLEDStatus(val: string) {
		this.writeCharacteristic(LED_BUTTON_SERVICE_UUID, LED_BUTTON_CHARACTERISTIC_UUID, val);
	}

	async toggleDeviceStatus() {
		const newState = !this._deviceOn;
		const val = newState ? "01" : "00";

		console.log("切换设备状态:", newState ? "开启" : "关闭");
		await this.writeCharacteristic(
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID,
			val
		);
		this.getLEDStatus(500);
	}

	// 监听特征值变化
	onCharacteristicValueChange(): void {
		console.log("监听特征值变化");
		this.kuxBluetooth.onBLECharacteristicValueChange((res) => {
			console.log("特征值变化:", res);
			const hexString = arrayBufferToHexString(res.value);
			console.log("特征值变化(hex):", hexString);

			const hexData = hexString;
			const serviceId = res.serviceId.toLowerCase();

			console.log(`特征值变化: 服务=${serviceId}, 数据=${hexData}`);

			if (serviceId == HEART_RATE_SERVICE_UUID) {
				const [heartRate, ppi] = parseHeartRateData(hexData);
				this.heartRate.value = heartRate;
				this.ppi.value = ppi;
				console.log(`心率: ${heartRate} BPM, PPI: ${ppi}`);
			} else if (serviceId == LED_BUTTON_SERVICE_UUID) {
				const bloodOxygen = parseBloodOxygenData(hexData);
				this.bloodOxygen.value = bloodOxygen;
				console.log(`血氧: ${bloodOxygen}%`);
			} else if (serviceId == BATTERY_SERVICE_UUID) {
				const battery = parseBatteryData(hexData);
				this.battery.value = battery;
				console.log(`电池: ${battery}%`);
			}
		});
	}

	// 监听写入特征值结果（iOS 无效）
	onWriteCharacteristicValue(): void {
		// this.kuxBluetooth.onWriteBLECharacteristicValue((res) => {
		// 	console.log("写入特征值结果:", res);
		// });
	}

	// 监听读取特征值结果
	onReadCharacteristicValue(): void {
		console.log("监听读取特征值变化");
		this.kuxBluetooth.onReadBLECharacteristicValue((res) => {
			const buffer = res.value as ArrayBuffer | null;
			if (buffer == null) return;
			const hexString = arrayBufferToHexString(buffer);
			console.log("十六进制数据 hexString:", hexString);
			if (res.characteristicId == LED_BUTTON_CHARACTERISTIC_UUID) {
				this._deviceOn = hexString == "01";
				// console.log("设备开关状态:", this._deviceOn ? "开启" : "关闭");
				// if (hexString == "00") {
				// 	this.setLEDStatus("01");
				// }
			}
		});
	}

	// 启用特征值通知
	enableNotify(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.kuxBluetooth.notifyBLECharacteristicValueChange({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				state: true,
				type: "notification",
				success: (res) => {
					console.log("启用通知成功:" + res.errMsg, characteristicId);
					resolve(true);
				},
				fail: (err) => {
					console.log("启用通知失败，错误码：" + err.errCode);
					resolve(false);
				}
			});
		});
	}

	// 禁用特征值通知
	disableNotify(serviceId: string, characteristicId: string): void {
		this.kuxBluetooth.notifyBLECharacteristicValueChange({
			deviceId: this.currentDeviceId,
			serviceId,
			characteristicId,
			state: false,
			type: "notification",
			success: (res) => {
				console.log("禁用通知成功:" + res.errMsg);
			},
			fail: (err) => {
				console.log("禁用通知失败，错误码：" + err.errCode);
			}
		});
	}

	readCharacteristic(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			this.kuxBluetooth.readBLECharacteristicValue({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				success: (res) => {
					console.log("获取特征值成功");
					resolve(true);
				},
				fail: (err) => {
					console.log("读取特征值失败，错误码：" + err.errCode);
					reject(false);
				}
			});
		});
	}

	// 写入特征值
	writeCharacteristic(
		serviceId: string,
		characteristicId: string,
		value: string,
		writeType: "write" | "writeNoResponse" = "write"
	): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			const buffer = hexStringToArrayBuffer(value);
			console.log("写入特征值:", value, buffer, writeType);

			this.kuxBluetooth.writeBLECharacteristicValue({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				value: buffer,
				writeType,
				success: (res) => {
					console.log("写入特征值成功:" + res.errMsg);
					resolve(true);
				},
				fail: (err) => {
					console.log("写入特征值失败，错误码：" + err.errCode);
					reject(false);
				}
			});
		});
	}

	// 发送命令到 UART 服务
	sendCommand(val: string): Promise<boolean> {
		if (this.uartWriteCharacteristicId == "") {
			console.error("UART 特征值未设置");
			return Promise.resolve(false);
		}

		return this.writeCharacteristic(UART_SERVICE_UUID, this.uartWriteCharacteristicId, val);
	}

	// 断开连接
	disconnectDevice() {
		if (this.currentDeviceId != "") {
			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId,
				success: (res) => {
					console.log("断开低功耗蓝牙成功:" + res.errMsg);
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					ui.showToast({ message: t("已断开连接"), type: "warn" });
				},
				fail: (err) => {
					console.log("断开低功耗蓝牙失败，错误码：" + err.errCode);
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					ui.showToast({ message: t("已断开连接"), type: "warn" });
				}
			});
		} else {
			this.status.value = "UNPAIRED";
			ui.showToast({ message: t("已断开连接"), type: "warn" });
		}
	}

	// 清理所有蓝牙事件监听器
	destroy() {
		//#ifndef H5
		this.stopBluetoothSearch();
		if (this.currentDeviceId != "") {
			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId
			});
		}
		this.kuxBluetooth.closeBluetoothAdapter({
			success: (res) => {
				console.log("关闭蓝牙适配器成功:" + res.errMsg);
			},
			fail: (err) => {
				console.log("关闭蓝牙适配器失败，错误码：" + err.errCode);
			}
		});
		//#endif
	}

	// 清除保存的设备信息
	clearLastConnectedDevice(): void {
		this.lastConnectedDeviceId = "";
		storage.remove(KEY_LAST_DEVICE_ID);
	}

	clear() {}
}

export const device = new Device();
