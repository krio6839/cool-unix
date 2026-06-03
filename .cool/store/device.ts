import { ref } from "vue";
import { sleepTimeout, storage } from "../utils";
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
	hexStringToArrayBuffer,
	UART_TX_CHARACTERISTIC_UUID,
	UART_RX_CHARACTERISTIC_UUID,
	parseDataReadyStatus,
	parseRTCResponse,
	parseHistoricalHeartRateData,
	parseSleepData,
	convertNumberToHexString,
	convertNumberToHexStringLSB
} from "../bluetooth";

import type { HeartRateRecord, DataReadyStatus, SleepData } from "../bluetooth";

// 数据管理导入
import { bluetoothDataManager } from "../bluetooth";

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
	currentDeviceName: string = "";
	// lastConnectedDeviceId: string = "FC:0E:57:D8:D8:F9";
	lastConnectedDeviceId: string = "C6:21:DB:55:81:6D";

	// 设备初始化状态标志，防止重复初始化
	isDeviceInitialized = false;

	// 蓝牙相关
	kuxBluetooth: IBluetooth;
	services: Array<GetBLEDeviceServicesSuccessService> = [];
	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

	// 设备状态
	currentWearLocation: WearLocation = "大臂部";
	_isCharging: boolean = false;
	_deviceOn: boolean = false;

	// 标记本次分页获取过程中是否已收到"全 f"响应（说明后续无有效数据）
	private _heartRateResponseAllEmpty: boolean = false;

	// 当前页响应的 resolver（由 BLE 回调在解析到 256 字符 hex 时调用）
	private _heartRatePageResolver: (() => void) | null = null;

	// 健康数据
	heartRate = ref(0);
	bloodOxygen = ref(0);
	battery = ref(0);
	ppi = ref(0);

	// 历史数据
	dataReadyStatus = ref<DataReadyStatus>({
		heartRateCount: 0,
		sleepCount: 0
	});
	rtcTime = ref<number>(0);
	sleepData = ref<SleepData | null>(null);

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
		if (this.lastConnectedDeviceId == "" && savedDeviceId != null && savedDeviceId != "") {
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
				// 防止重复初始化
				if (this.isDeviceInitialized) {
					console.log("设备已初始化，跳过");
					return;
				}
				this.isDeviceInitialized = true;
				console.log("设备已连接:", res.deviceId);
				this.getDeviceServicesAndCharacteristics(res.deviceId).then(() => {
					console.log("获取设备服务和特征值成功");
					this.setLEDStatus("01");
					setTimeout(() => {
						this.getLEDStatus();
						// this.subscribeHeartRate();
						// this.subscribeBloodOxygen();
						// this.subscribeBattery();
						this.subscribeUART();
						// 自动校准设备 RTC，确保后续 timestamp 是真实 Unix 时间戳
						this.setDeviceTime(Math.floor(Date.now() / 1000));
					}, 500);
				});
				this.resetReconnectState();
			} else {
				if (res.deviceId == this.currentDeviceId) {
					console.log("设备已断开:", res.deviceId);
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					// 重置初始化状态，允许下次重连时重新初始化
					this.isDeviceInitialized = false;
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
						if (this.currentDeviceId != "") return;
						this.connectToDevice(device.deviceId, device.name);
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
	connectToDevice(deviceId: string, deviceName?: string) {
		this.kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res) => {
				console.log("连接设备成功:", res);
				this.stopBluetoothSearch();
				this.currentDeviceId = deviceId;
				this.currentDeviceName = deviceName ?? "";
				this.status.value = "CONNECTED";
				this.saveLastConnectedDevice(deviceId);
				bluetoothDataManager.setDeviceInfo(this.currentDeviceName, deviceId);
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
					this.currentDeviceName = "";
					this.services = [];
					this.characteristics.clear();
					this.resetReconnectState();
					bluetoothDataManager.clearDeviceInfo();
				},
				fail: (err) => {
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					this.currentDeviceName = "";
					this.services = [];
					this.characteristics.clear();
					this.resetReconnectState();
					bluetoothDataManager.clearDeviceInfo();
				}
			});
		} else {
			this.status.value = "UNPAIRED";
			this.currentDeviceId = "";
			this.currentDeviceName = "";
			this.services = [];
			this.characteristics.clear();
			this.resetReconnectState();
			bluetoothDataManager.clearDeviceInfo();
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
					resolve(res.services ?? []);
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
					resolve(res.characteristics ?? []);
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
			console.log("写入特征值:", serviceId, characteristicId, value, writeType);
			// console.log("写入特征值:", value, buffer);
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

	subscribeBloodOxygen(): void {
		this.enableNotify(LED_BUTTON_SERVICE_UUID, BLOOD_OXYGEN_CHARACTERISTIC_UUID);
	}

	subscribeHeartRate(): void {
		this.enableNotify(HEART_RATE_SERVICE_UUID, HEART_RATE_CHARACTERISTIC_UUID);
	}
	// subscribeBattery(): void {
	// 	this.enableNotify(BATTERY_SERVICE_UUID, BATTERY_CHARACTERISTIC_UUID);
	// }

	subscribeUART(): void {
		this.enableNotify(UART_SERVICE_UUID, UART_RX_CHARACTERISTIC_UUID);
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
		return this.writeCharacteristic(UART_SERVICE_UUID, UART_TX_CHARACTERISTIC_UUID, val);
	}

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

	/**
	 * 存储历史心率血氧记录到数据库
	 * @param records 历史心率记录数组
	 */
	private async storeHistoricalRecords(records: Array<HeartRateRecord>): Promise<void> {
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			await bluetoothDataManager.storeHistoricalHeartRateRecord(
				record.timestamp,
				record.heartRate,
				record.bloodOxygen,
				record.ppi
			);
		}
	}

	/**
	 * 自动获取所有历史心率血氧数据
	 * 根据 dataReadyStatus.heartRateCount 自动遍历获取
	 */
	async fetchAllHistoricalHeartRateData(): Promise<void> {
		const status = this.dataReadyStatus.value;
		if (status.heartRateCount <= 0) {
			console.log("没有历史心率血氧数据");
			return;
		}

		// 重置"全 f"响应标记
		this._heartRateResponseAllEmpty = false;

		// 计算总页数（每页16条）
		const pageCount = Math.ceil(status.heartRateCount / 16);
		// 单页响应的最长等待时间（兜底）
		const PAGE_RESPONSE_TIMEOUT_MS = 3000;
		console.log(
			"开始获取历史心率血氧数据，总共",
			status.heartRateCount,
			"条，共",
			pageCount,
			"页"
		);

		for (let page = 0; page < pageCount; page++) {
			const recordIndex = page * 16;
			console.log("获取第", page, "页，索引从", recordIndex, "开始");

			// 准备一个待 resolve 的 Promise，等回调通知"本页响应已到达"
			// 使用 Promise<boolean> 便于 Promise.race 推断 T；true=超时，false=收到响应
			this._heartRatePageResolver = null;
			const responsePromise = new Promise<boolean>((resolve) => {
				// 包装为 0 参箭头函数以匹配 _heartRatePageResolver 的 Function0<Unit>? 字段类型
				this._heartRatePageResolver = () => {
					resolve(false);
				};
			});

			await this.getHistoricalHeartRateData(recordIndex);

			// 等待响应到达；超过超时时间则视为本页无响应，继续下一页
			const timeoutPromise = new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(true), PAGE_RESPONSE_TIMEOUT_MS);
			});
			const result = await Promise.race([responsePromise, timeoutPromise]);
			if (result == true) {
				// 清空 resolver，避免迟到的响应误触发
				this._heartRatePageResolver = null;
				console.log(`第 ${page} 页响应超时（${PAGE_RESPONSE_TIMEOUT_MS}ms），继续下一页`);
				continue;
			}

			// 如果本次响应为"全 f"，说明后续无数据，提前结束
			if (this._heartRateResponseAllEmpty) {
				console.log(`第 ${page} 页响应为全 f，无更多数据，提前结束获取`);
				break;
			}
		}
	}

	/**
	 * 自动获取所有睡眠数据
	 * 根据 dataReadyStatus.sleepCount 自动遍历获取
	 */
	async fetchAllSleepData(): Promise<void> {
		const status = this.dataReadyStatus.value;
		if (status.sleepCount <= 0) {
			console.log("没有睡眠数据");
			return;
		}

		console.log("开始获取睡眠数据，总共", status.sleepCount, "条");
		for (let i = 0; i < status.sleepCount; i++) {
			console.log("获取第", i, "条睡眠数据");
			await this.getSleepData(i);
			// 等待数据返回（通过 onCharacteristicValueChange 接收）
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), 500);
			});
		}
		console.log("睡眠数据获取完成");
	}

	// 事件处理
	onCharacteristicValueChange(): void {
		this.kuxBluetooth.onBLECharacteristicValueChange((res) => {
			const hexString = arrayBufferToHexString(res.value);
			const hexData = hexString;
			const serviceId = res.serviceId.toLowerCase();
			const characteristicId = res.characteristicId.toLowerCase();
			console.log("响应数据:", hexData, serviceId, characteristicId);

			if (serviceId == HEART_RATE_SERVICE_UUID) {
				const [heartRate, ppi] = parseHeartRateData(hexData);
				this.heartRate.value = heartRate;
				this.ppi.value = ppi;
				// 实时数据暂不存储（storeData 已禁用）
				// bluetoothDataManager.storeData("heartRate", heartRate, ppi);
			} else if (serviceId == LED_BUTTON_SERVICE_UUID) {
				const bloodOxygen = parseBloodOxygenData(hexData);
				this.bloodOxygen.value = bloodOxygen;
				// 实时数据暂不存储（storeData 已禁用）
				// bluetoothDataManager.storeData("bloodOxygen", bloodOxygen, null);
			} else if (serviceId == BATTERY_SERVICE_UUID) {
				const battery = parseBatteryData(hexData);
				this.battery.value = battery;
				// 实时数据暂不存储（storeData 已禁用）
				// bluetoothDataManager.storeData("battery", battery, null);
			} else if (serviceId == UART_SERVICE_UUID) {
				if (hexData.indexOf("2c") != -1 && hexData.length < 48) {
					const status = parseDataReadyStatus(hexData);
					this.dataReadyStatus.value = status;
					console.log("数据就绪状态:", status);
				} else if (hexData.indexOf("525443") != -1 || hexData.indexOf("RTC") != -1) {
					const rtc = parseRTCResponse(hexData);
					this.rtcTime.value = rtc;
					console.log("RTC时间:", rtc);
				} else if (hexData.length == 256) {
					// 心率数据：16组×8字节=128字节=256 hex chars（恰好256）
					const records = parseHistoricalHeartRateData(hexData);
					// 先打印日志和触发 resolver（确保不因为异步存储而错过）
					console.log("历史心率数据:", records);
					// 通知 fetchAllHistoricalHeartRateData 本页响应已到（先触发，再异步存储）
					const resolver = this._heartRatePageResolver;
					this._heartRatePageResolver = null;
					if (resolver != null) {
						resolver();
					}
					// 当解析后无任何记录（说明原始数据为"全 f"），标记后续无数据
					if (records.length == 0) {
						this._heartRateResponseAllEmpty = true;
						console.log("本次响应为全 f，无有效数据，标记停止获取");
					}
					// 存储历史心率血氧数据（异步，不阻塞 resolver）
					this.storeHistoricalRecords(records);
				} else if (hexData.length >= 48) {
					// 睡眠数据：24字节头+N字节状态（可变长度）
					const sleep = parseSleepData(hexData);
					this.sleepData.value = sleep;
					console.log("睡眠数据:", sleep);
					// 存储历史睡眠数据
					bluetoothDataManager.storeSleepData(sleep);
				}
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
				console.log("_deviceOn", this._deviceOn);
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
			this.connectToDevice(this.lastConnectedDeviceId, "");
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

	clear() {
		console.log("清除设备相关数据");
		this.status.value = "UNPAIRED";
		this.currentDeviceId = "";
		this.currentDeviceName = "";
		this.lastConnectedDeviceId = "";
		this.services = [];
		this.characteristics.clear();
		this.heartRate.value = 0;
		this.bloodOxygen.value = 0;
		this.battery.value = 0;
		this.ppi.value = 0;
		this.sleepData.value = null;
		this.dataReadyStatus.value = {
			heartRateCount: 0,
			sleepCount: 0
		} as DataReadyStatus;
		this.rtcTime.value = 0;
		this._isCharging = false;
		this._deviceOn = false;
		this.errorMessage.value = "";
		this.clearLastConnectedDevice();
		bluetoothDataManager.clearDeviceInfo();
	}
}

export const device = new Device();
