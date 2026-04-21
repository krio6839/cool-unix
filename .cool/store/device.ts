import { ref } from "vue";
import { storage } from "../utils";
import { t } from "../locale";
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
	inited = false;
	status = ref<DeviceStatus>("UNPAIRED");
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	lastConnectedDeviceId: string = "";

	kuxBluetooth: IBluetooth;

	currentWearLocation: WearLocation = "大臂部";

	_isCharging: boolean = false;

	_deviceOn: boolean = false;

	services: Array<GetBLEDeviceServicesSuccessService> = [];

	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

	uartWriteCharacteristicId: string = "";

	heartRate = ref(0);
	bloodOxygen = ref(0);
	battery = ref(0);
	ppi = ref(0);

	reconnectAttempts = 0;
	maxReconnectAttempts = 5;
	reconnectInterval = 2000;
	isReconnecting = false;

	errorMessage = ref<string>("");

	constructor() {
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

	setCharging(charging: boolean): void {
		this._isCharging = charging;
	}

	getPaired(): boolean {
		return this.currentDeviceId != "";
	}

	clearError(): void {
		this.errorMessage.value = "";
	}

	async initBluetooth(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			this.kuxBluetooth.openBluetoothAdapter({
				success: (res) => {
					this.inited = true;

					this.onCharacteristicValueChange();
					this.onReadCharacteristicValue();

					this.kuxBluetooth.onBluetoothAdapterStateChange((res) => {
						if (!res.available) {
							this.status.value = "UNPAIRED";
						} else {
							if (this.lastConnectedDeviceId != "") {
								this.startBluetoothSearch();
							}
						}
					});

					this.kuxBluetooth.onBLEConnectionStateChange((res) => {
						if (res.connected) {
							this.getDeviceServicesAndCharacteristics(res.deviceId).then(() => {
								this.getLEDStatus(500);
							});
							this.resetReconnectState();
						} else {
							if (res.deviceId == this.currentDeviceId) {
								this.status.value = "UNPAIRED";
								this.currentDeviceId = "";
								this.reconnect();
							}
						}
					});

					if (this.lastConnectedDeviceId != "") {
						this.startBluetoothSearch();
					}

					resolve(res);
				},
				fail: (err) => {
					this.errorMessage.value = t("蓝牙初始化失败");
					reject(err);
				}
			});
		});
	}

	startBluetoothSearch() {
		this.devices = [];
		this.stopBluetoothSearch();
		this.status.value = "SEARCHING";
		this.kuxBluetooth.startBluetoothDevicesDiscovery({
			success: (res) => {
				this.kuxBluetooth.onBluetoothDeviceFound((devices) => {
					devices.forEach((device) => {
						if (device.name != TARGET_DEVICE_NAME) {
							return;
						}
						if (!this.devices.some((d) => d.deviceId == device.deviceId)) {
							this.devices.push(device);
						}
						this.connectToDevice(device.deviceId);
					});
				});
			},
			fail: (e) => {
				this.errorMessage.value = t("搜索设备失败");
				this.status.value = "UNPAIRED";
			}
		});
	}

	stopBluetoothSearch() {
		this.kuxBluetooth.stopBluetoothDevicesDiscovery({});
		this.kuxBluetooth.offBluetoothDeviceFound();
	}

	connectToDevice(deviceId: string) {
		this.stopBluetoothSearch();
		this.kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res) => {
				this.currentDeviceId = deviceId;
				this.status.value = "CONNECTED";
				this.saveLastConnectedDevice(deviceId);
			},
			fail: (err) => {
				if (err.errCode == -1) {
					this.currentDeviceId = deviceId;
					this.status.value = "CONNECTED";
					this.saveLastConnectedDevice(deviceId);
				} else {
					this.errorMessage.value = t("连接失败");
					this.status.value = "UNPAIRED";
				}
			}
		});
	}

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

	onCharacteristicValueChange(): void {
		this.kuxBluetooth.onBLECharacteristicValueChange((res) => {
			const hexString = arrayBufferToHexString(res.value);
			const hexData = hexString;
			const serviceId = res.serviceId.toLowerCase();

			if (serviceId == HEART_RATE_SERVICE_UUID) {
				const [heartRate, ppi] = parseHeartRateData(hexData);
				this.heartRate.value = heartRate;
				this.ppi.value = ppi;
			} else if (serviceId == LED_BUTTON_SERVICE_UUID) {
				const bloodOxygen = parseBloodOxygenData(hexData);
				this.bloodOxygen.value = bloodOxygen;
			} else if (serviceId == BATTERY_SERVICE_UUID) {
				const battery = parseBatteryData(hexData);
				this.battery.value = battery;
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

	enableNotify(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.kuxBluetooth.notifyBLECharacteristicValueChange({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				state: true,
				type: "notification",
				success: (res) => {
					resolve(true);
				},
				fail: (err) => {
					resolve(false);
				}
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
			success: (res) => {},
			fail: (err) => {}
		});
	}

	readCharacteristic(serviceId: string, characteristicId: string): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			this.kuxBluetooth.readBLECharacteristicValue({
				deviceId: this.currentDeviceId,
				serviceId,
				characteristicId,
				success: (res) => {
					resolve(true);
				},
				fail: (err) => {
					reject(false);
				}
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
				success: (res) => {
					resolve(true);
				},
				fail: (err) => {
					reject(false);
				}
			});
		});
	}

	sendCommand(val: string): Promise<boolean> {
		if (this.uartWriteCharacteristicId == "") {
			return Promise.resolve(false);
		}

		return this.writeCharacteristic(UART_SERVICE_UUID, this.uartWriteCharacteristicId, val);
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

	disableAllNotifications() {
		this.disableNotify(HEART_RATE_SERVICE_UUID, HEART_RATE_CHARACTERISTIC_UUID);
	}

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
	}

	clearLastConnectedDevice(): void {
		this.lastConnectedDeviceId = "";
		storage.remove(KEY_LAST_DEVICE_ID);
	}

	reconnect(): void {
		if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
			return;
		}

		if (this.lastConnectedDeviceId == "") {
			return;
		}

		this.isReconnecting = true;
		this.reconnectAttempts++;

		const currentInterval = this.reconnectInterval * this.reconnectAttempts;

		setTimeout(() => {
			this.startBluetoothSearch();
			this.isReconnecting = false;
		}, currentInterval);
	}

	resetReconnectState(): void {
		this.reconnectAttempts = 0;
		this.isReconnecting = false;
	}

	clear() {}
}

export const device = new Device();
