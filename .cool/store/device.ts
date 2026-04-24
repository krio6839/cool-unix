import { ref } from "vue";
import { storage } from "../utils";
import { t } from "../locale";

// 蓝牙相关导入
import {
	HEART_RATE_SERVICE_UUID,
	BATTERY_SERVICE_UUID,
	UART_SERVICE_UUID,
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

// 数据管理导入
import { bluetoothDataManager } from "../utils/bluetooth-data-manager";

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

export type WearLocation = "大臂部" | "下胸部" | "腰部";

const KEY_WEAR_LOCATION = "device_wear_location";
const KEY_LAST_DEVICE_ID = "last_device_id";

const TARGET_DEVICE_NAME = "BOOM1";

export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;

export class Device {
	// 基本状态属性
	status = ref<DeviceStatus>("UNPAIRED");
	available: boolean = false;
	discovering: boolean = false;
	errorMessage = ref<string>("");

	// 设备信息
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	lastConnectedDeviceId: string = "";

	// 蓝牙相关
	kuxBluetooth: IBluetooth;
	services: Array<GetBLEDeviceServicesSuccessService> = [];
	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();
	uartWriteCharacteristicId: string = "";

	// 设备状态
	currentWearLocation: WearLocation = "大臂部";
	_isCharging: boolean = false;
	_deviceOn: boolean = false;

	// 健康数据
	heartRate = ref(0);
	bloodOxygen = ref(0);
	battery = ref(0);
	ppi = ref(0);

	// 重连相关属性
	reconnectAttempts = 0;
	maxReconnectAttempts = 5;
	reconnectInterval = 2000;
	isReconnecting = false;

	constructor() {
		this.loadSavedData();

		//#ifndef H5
		const kuxBluetooth: IBluetooth = useKuxBluetooth({
			needLocation: true,
			accessBackgroundLocation: false
		} as InitConfig);
		this.kuxBluetooth = kuxBluetooth;
		this.onBluetoothAdapterStateChange();
		this.onBLEConnectionStateChange();

		// 监听特征值变化事件
		this.onCharacteristicValueChange();
		this.onReadCharacteristicValue();

		this.initBluetooth();
		//#endif
	}

	// 数据持久化相关
	loadSavedData(): void {
		const savedLocation = storage.get(KEY_WEAR_LOCATION) as WearLocation | null;
		if (savedLocation != null) {
			this.currentWearLocation = savedLocation;
		}

		const savedDeviceId = storage.get(KEY_LAST_DEVICE_ID) as string | null;
		if (savedDeviceId != null && savedDeviceId != "") {
			this.lastConnectedDeviceId = savedDeviceId;
		}
	}

	saveWearLocation(location: WearLocation): void {
		this.currentWearLocation = location;
		storage.set(KEY_WEAR_LOCATION, location, 0);
	}

	saveLastConnectedDevice(deviceId: string): void {
		this.lastConnectedDeviceId = deviceId;
		storage.set(KEY_LAST_DEVICE_ID, deviceId, 0);
	}

	clearLastConnectedDevice(): void {
		this.lastConnectedDeviceId = "";
		storage.remove(KEY_LAST_DEVICE_ID);
	}

	// 状态管理
	setCharging(charging: boolean): void {
		this._isCharging = charging;
	}

	getPaired(): boolean {
		return this.currentDeviceId != "";
	}

	clearError(): void {
		console.log("清除错误信息");
		this.errorMessage.value = "";
	}

	resetReconnectState(): void {
		this.reconnectAttempts = 0;
		this.isReconnecting = false;
	}

	handleBluetoothError(errCode: number, errMsg: string): void {
		console.log(`蓝牙错误 ${errCode}:`, errMsg);

		switch (errCode) {
			case -1:
				break;
			default:
				this.errorMessage.value = errMsg ?? t("蓝牙错误");
				this.status.value = "UNPAIRED";
				break;
		}
	}

	// 蓝牙初始化
	async initBluetooth(): Promise<any> {
		console.log("开始初始化蓝牙");
		this.clearError();

		return new Promise<any>((resolve, reject) => {
			this.kuxBluetooth.openBluetoothAdapter({
				success: (res) => {
					console.log("openBluetoothAdapter success:", res);
					resolve(res);
				},
				fail: (err) => {
					this.handleBluetoothError(err.errCode, err.errMsg);
					reject(err);
				}
			});
		});
	}

	onBluetoothAdapterStateChange(): void {
		console.log("开始监听蓝牙适配器状态变化");
		this.kuxBluetooth.onBluetoothAdapterStateChange((res) => {
			console.log("蓝牙适配器状态变化:", res);
			this.discovering = res.discovering;
			if (this.available == res.available) return;
			this.available = res.available;
			if (!res.available) {
				console.log("蓝牙已关闭");
				this.status.value = "UNPAIRED";
				this.errorMessage.value = t("蓝牙未开启");
			} else {
				console.log("蓝牙已开启");
				this.status.value = "PAIRING";
				this.errorMessage.value = "";

				if (this.lastConnectedDeviceId != "" && this.currentDeviceId == "") {
					this.startBluetoothSearch();
				}
			}
		});
	}

	onBLEConnectionStateChange(): void {
		this.kuxBluetooth.onBLEConnectionStateChange((res) => {
			console.log("蓝牙连接状态变化:", res);
			if (res.connected) {
				console.log("设备已连接:", res.deviceId);
				this.getDeviceServicesAndCharacteristics(res.deviceId).then(() => {
					this.getLEDStatus(500);
					this.setLEDStatus("01");
				});
				this.resetReconnectState();
			} else {
				if (res.deviceId == this.currentDeviceId) {
					console.log("设备已断开:", res.deviceId);
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					this.reconnect();
				}
			}
		});
	}

	// 设备搜索
	async startBluetoothSearch() {
		this.devices = [];
		await this.stopBluetoothSearch();
		this.status.value = "SEARCHING";
		this.kuxBluetooth.startBluetoothDevicesDiscovery({
			success: (res) => {
				console.log("开始搜索目标设备:", TARGET_DEVICE_NAME);
				this.kuxBluetooth.onBluetoothDeviceFound((devices) => {
					devices.forEach((device) => {
						if (device.name != TARGET_DEVICE_NAME) {
							return;
						}
						console.log("发现目标设备:", device);
						if (!this.devices.some((d) => d.deviceId == device.deviceId)) {
							this.devices.push(device);
						}
						console.log("当前设备列表:", this.devices);
						// console.log("lastConnectedDeviceId:", this.lastConnectedDeviceId);
						this.connectToDevice(device.deviceId);
					});
				});
			},
			fail: (e) => this.handleBluetoothError(e.errCode, e.errMsg)
		});
	}

	stopBluetoothSearch(): Promise<boolean> {
		this.kuxBluetooth.offBluetoothDeviceFound();
		// if (!this.discovering) {
		// 	console.log("当前不在搜索状态，无需停止");
		// 	return Promise.resolve(true);
		// }
		return new Promise((resolve, reject) => {
			this.kuxBluetooth.stopBluetoothDevicesDiscovery({
				success: () => resolve(true),
				fail: (err) => {
					console.log("停止搜索失败:", err);
					resolve(false);
				}
			});
		});
	}

	// 设备连接
	connectToDevice(deviceId: string) {
		this.kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res) => {
				console.log("连接设备成功:", res);
				this.stopBluetoothSearch();
				this.currentDeviceId = deviceId;
				this.status.value = "CONNECTED";
				this.saveLastConnectedDevice(deviceId);
				console.log("设备连接状态:", this.status.value);
			},
			fail: (err) => this.handleBluetoothError(err.errCode, err.errMsg)
		});
	}

	disconnectDevice() {
		if (this.currentDeviceId != "") {
			this.stopBluetoothSearch();
			this.disableAllNotifications();

			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId,
				success: (res) => {
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					this.services = [];
					this.characteristics.clear();
					this.uartWriteCharacteristicId = "";
					this.resetReconnectState();
				},
				fail: (err) => {
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					this.services = [];
					this.characteristics.clear();
					this.uartWriteCharacteristicId = "";
					this.resetReconnectState();
				}
			});
		} else {
			this.status.value = "UNPAIRED";
			this.services = [];
			this.characteristics.clear();
			this.uartWriteCharacteristicId = "";
			this.resetReconnectState();
		}
	}

	// 服务和特征值
	async getDeviceServicesAndCharacteristics(deviceId: string): Promise<void> {
		const maxRetries = 10;
		let retryInterval = 300;
		const maxRetryInterval = 3000;

		for (let i = 0; i < maxRetries; i++) {
			try {
				const services = await this.tryGetServices(deviceId);
				this.services = services;

				const characteristicsResults = await Promise.all(
					services.map((service: GetBLEDeviceServicesSuccessService) =>
						this.getCharacteristicsForService(deviceId, service.uuid)
					)
				);

				services.forEach((service: GetBLEDeviceServicesSuccessService, index: number) => {
					const characteristics = characteristicsResults[index];
					this.characteristics.set(service.uuid, characteristics);

					if (service.uuid.toLowerCase() == UART_SERVICE_UUID) {
						const writeChar = characteristics.find(
							(c: BLEDeviceCharacteristic) => c.properties.write
						);
						if (writeChar != null) {
							this.uartWriteCharacteristicId = writeChar.uuid;
						}
					}
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
					resolve([]);
				}
			});
		});
	}

	// 特征值操作
	enableNotify(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.kuxBluetooth.notifyBLECharacteristicValueChange({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				state: true,
				type: "notification",
				success: () => resolve(true),
				fail: () => resolve(false)
			});
		});
	}

	disableNotify(serviceId: string, characteristicId: string): void {
		this.kuxBluetooth.notifyBLECharacteristicValueChange({
			deviceId: this.currentDeviceId,
			serviceId,
			characteristicId,
			state: false,
			type: "notification",
			success: () => {},
			fail: () => {}
		});
	}

	disableAllNotifications() {
		this.disableNotify(HEART_RATE_SERVICE_UUID, HEART_RATE_CHARACTERISTIC_UUID);
	}

	readCharacteristic(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			this.kuxBluetooth.readBLECharacteristicValue({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				success: () => resolve(true),
				fail: () => resolve(false)
			});
		});
	}

	writeCharacteristic(
		serviceId: string,
		characteristicId: string,
		value: string,
		writeType: "write" | "writeNoResponse" = "write"
	): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			const buffer = hexStringToArrayBuffer(value);

			this.kuxBluetooth.writeBLECharacteristicValue({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				value: buffer,
				writeType,
				success: () => resolve(true),
				fail: () => resolve(false)
			});
		});
	}

	// 设备功能
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

		await this.writeCharacteristic(
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID,
			val
		);
		this.getLEDStatus(500);
	}

	sendCommand(val: string): Promise<boolean> {
		if (this.uartWriteCharacteristicId == "") {
			return Promise.resolve(false);
		}

		return this.writeCharacteristic(UART_SERVICE_UUID, this.uartWriteCharacteristicId, val);
	}

	// 事件处理
	onCharacteristicValueChange(): void {
		this.kuxBluetooth.onBLECharacteristicValueChange((res) => {
			const hexString = arrayBufferToHexString(res.value);
			const hexData = hexString;
			const serviceId = res.serviceId.toLowerCase();

			if (serviceId == HEART_RATE_SERVICE_UUID) {
				const [heartRate, ppi] = parseHeartRateData(hexData);
				this.heartRate.value = heartRate;
				this.ppi.value = ppi;
				// 存储心率数据
				bluetoothDataManager.storeData("heartRate", heartRate);
			} else if (serviceId == LED_BUTTON_SERVICE_UUID) {
				const bloodOxygen = parseBloodOxygenData(hexData);
				this.bloodOxygen.value = bloodOxygen;
				// 存储血氧数据
				bluetoothDataManager.storeData("bloodOxygen", bloodOxygen);
			} else if (serviceId == BATTERY_SERVICE_UUID) {
				const battery = parseBatteryData(hexData);
				this.battery.value = battery;
				// 存储电池数据
				bluetoothDataManager.storeData("battery", battery);
			}
		});
	}

	onReadCharacteristicValue(): void {
		this.kuxBluetooth.onReadBLECharacteristicValue((res) => {
			const buffer = res.value as ArrayBuffer | null;
			if (buffer == null) return;
			const hexString = arrayBufferToHexString(buffer);
			console.log("十六进制数据 hexString:", hexString);
			if (res.characteristicId == LED_BUTTON_CHARACTERISTIC_UUID) {
				this._deviceOn = hexString == "01";
			}
		});
	}

	// 重连机制
	reconnect(): void {
		console.log("开始重连设备");
		if (this.isReconnecting) {
			console.log("正在重连中，跳过");
			return;
		}
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.log("重连次数达到上限，停止重连");
			return;
		}

		if (this.lastConnectedDeviceId == "") {
			console.log("没有上次连接的设备ID，无法重连");
			return;
		}

		this.isReconnecting = true;
		this.reconnectAttempts++;

		const currentInterval = this.reconnectInterval * this.reconnectAttempts;

		console.log(`开始第 ${this.reconnectAttempts} 次重连，间隔 ${currentInterval}ms`);

		setTimeout(() => {
			console.log("执行重连操作");
			this.connectToDevice(this.lastConnectedDeviceId);
			this.isReconnecting = false;
			console.log("重连操作完成");
		}, currentInterval);
	}

	// 资源管理
	destroy() {
		//#ifndef H5
		this.stopBluetoothSearch();
		if (this.currentDeviceId != "") {
			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId
			});
		}
		this.kuxBluetooth.closeBluetoothAdapter({
			success: (res) => {},
			fail: (err) => {}
		});
		//#endif
		// 销毁数据管理器
		bluetoothDataManager.destroy();
	}

	clear() {}
}

export const device = new Device();
