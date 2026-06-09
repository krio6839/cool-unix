import { ref } from "vue";
import { PageWaiter, loadResumeCount, sleepTimeout, storage } from "../utils";
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
	convertNumberToHexString,
	convertNumberToHexStringLSB,
	SleepResponseAssembler
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
/** 已保存到 ppi_data 的条数（断点续传用；0 表示未抓取过） */
const KEY_PPI_SAVED_COUNT = "ppi_data_saved_count";
/** 已保存到 sleep_data 的条数（断点续传用；0 表示未抓取过） */
const KEY_SLEEP_SAVED_COUNT = "sleep_data_saved_count";

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
	// lastConnectedDeviceId: string = "C6:21:DB:55:81:6D";
	lastConnectedDeviceId: string = "";

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

	// 分页等待器：心率分页 / 睡眠分页各持一个，复用同一原语
	private _heartRatePageWaiter: PageWaiter = new PageWaiter();
	private _sleepPageWaiter: PageWaiter = new PageWaiter();
	// 睡眠响应装配器：封装"头部识别 + 状态累积 + 超时 reset"状态机
	private _sleepAssembler: SleepResponseAssembler = new SleepResponseAssembler();

	// 定时轮询相关
	private _dataQueryTimer: number = 0;
	private _isQueryingData = false;
	private _dataQueryInterval = 30000; // 30秒查询一次

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
						// 启动定时数据查询
						this.startDataQueryTimer();
					}, 500);
				});
				this.resetReconnectState();
			} else {
				if (res.deviceId == this.currentDeviceId) {
					console.log("设备已断开:", res.deviceId);
					this.status.value = "UNPAIRED";
					this.currentDeviceId = "";
					// 停止定时查询
					this.stopDataQueryTimer();
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
			this.stopDataQueryTimer();
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

	setLEDStatus(val: string): Promise<boolean> {
		return this.writeCharacteristic(
			LED_BUTTON_SERVICE_UUID,
			LED_BUTTON_CHARACTERISTIC_UUID,
			val
		);
	}

	readBloodOxygen(): Promise<boolean> {
		return this.readCharacteristic(LED_BUTTON_SERVICE_UUID, BLOOD_OXYGEN_CHARACTERISTIC_UUID);
	}

	subscribeBloodOxygen(): Promise<boolean> {
		return this.enableNotify(LED_BUTTON_SERVICE_UUID, BLOOD_OXYGEN_CHARACTERISTIC_UUID);
	}

	subscribeHeartRate(): Promise<boolean> {
		return this.enableNotify(HEART_RATE_SERVICE_UUID, HEART_RATE_CHARACTERISTIC_UUID);
	}
	// subscribeBattery(): void {
	// 	this.enableNotify(BATTERY_SERVICE_UUID, BATTERY_CHARACTERISTIC_UUID);
	// }

	subscribeUART(): Promise<boolean> {
		return this.enableNotify(UART_SERVICE_UUID, UART_RX_CHARACTERISTIC_UUID);
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

	/**
	 * 启动定时数据查询
	 * 连接成功后自动调用，循环查询数据就绪状态并按需获取历史数据
	 */
	startDataQueryTimer(): void {
		if (this._dataQueryTimer != 0) {
			console.log("[DATA_QUERY] 定时查询已在运行");
			return;
		}

		console.log("[DATA_QUERY] 启动定时数据查询，间隔", this._dataQueryInterval, "ms");
		this.queryDataStatusWithFetch();
		// 使用 setInterval 确保固定间隔执行
		// @ts-ignore
		this._dataQueryTimer = setInterval(() => {
			if (this._isQueryingData) {
				console.log("[DATA_QUERY] 上一次查询尚未完成，跳过本次");
				return;
			}
			this.queryDataStatusWithFetch();
		}, this._dataQueryInterval);
	}

	/**
	 * 停止定时数据查询
	 */
	stopDataQueryTimer(): void {
		if (this._dataQueryTimer != 0) {
			clearInterval(this._dataQueryTimer);
			this._dataQueryTimer = 0;
			console.log("[DATA_QUERY] 停止定时数据查询");
		}
	}

	/**
	 * 查询数据状态并按需获取历史数据
	 * 等待响应后根据 heartRateCount 和 sleepCount 判断是否需要获取数据
	 */
	async queryDataStatusWithFetch(): Promise<void> {
		if (this._isQueryingData) {
			return;
		}
		this._isQueryingData = true;
		console.log("[DATA_QUERY] 开始查询数据状态");

		try {
			// 发送查询命令
			await this.queryDataReadyStatus();

			// 等待响应更新（通过 onCharacteristicValueChange 异步更新 dataReadyStatus）
			// 短暂等待让响应有机会到达
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), 500);
			});

			const status = this.dataReadyStatus.value;
			console.log("[DATA_QUERY] 数据状态:", status);

			// 按需获取历史数据
			if (status.heartRateCount > 0) {
				console.log("[DATA_QUERY] 发现心率血氧历史数据，开始获取...");
				await this.fetchAllHistoricalHeartRateData();
			}

			if (status.sleepCount > 0) {
				console.log("[DATA_QUERY] 发现睡眠数据，开始获取...");
				await this.fetchAllSleepData();
			}
		} finally {
			this._isQueryingData = false;
		}
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
	 * 存储历史心率血氧记录到数据库（批量 INSERT）
	 * @param records 历史心率记录数组
	 */
	private async storeHistoricalRecords(records: Array<HeartRateRecord>): Promise<void> {
		try {
			if (records.length > 0) {
				await bluetoothDataManager.storeHistoricalHeartRateRecordsBatch(records);
			}
		} catch (e) {
			console.error("[STORE] 批量存储历史心率记录失败:", e);
		}
	}

	/**
	 * 自动获取所有历史心率血氧数据（支持断点续传）
	 * 根据 dataReadyStatus.heartRateCount 自动遍历获取；
	 * 通过 KEY_PPI_SAVED_COUNT 持久化已保存条数，避免重复抓取；
	 * 如果设备历史被清空（已保存 > 设备总条数），自动清空 ppi_data 后重抓。
	 */
	async fetchAllHistoricalHeartRateData(): Promise<void> {
		const status = this.dataReadyStatus.value;
		if (status.heartRateCount <= 0) {
			console.log("没有历史心率血氧数据");
			return;
		}

		// 断点续传：校验已保存条数（跨平台类型守卫、边界重置、是否完成均在工具内）
		const { savedCount, isComplete } = loadResumeCount(
			KEY_PPI_SAVED_COUNT,
			status.heartRateCount
		);
		if (isComplete) {
			console.log("已全部保存，无需抓取");
			return;
		}

		if (savedCount > 0) {
			console.log(`[FETCH] 断点续传：已保存 ${savedCount} 条，从第 ${savedCount} 条继续`);
		} else {
			console.log("[FETCH] 首次抓取，从头开始");
		}

		const startIndex = savedCount;
		this._heartRatePageWaiter.reset();

		// 计算总页数（每页16条）
		const remainingCount = status.heartRateCount - startIndex;
		const pageCount = Math.ceil(remainingCount / 16);
		// 单页响应的最长等待时间（兜底）
		const PAGE_RESPONSE_TIMEOUT_MS = 3000;
		console.log(
			"开始获取历史心率血氧数据，总共",
			status.heartRateCount,
			"条，已保存",
			startIndex,
			"条，剩余",
			remainingCount,
			"条，共",
			pageCount,
			"页"
		);

		for (let i = 0; i < pageCount; i++) {
			// 从 startIndex 对应的 page 开始累加，保证 recordIndex 与已保存数据严格连续
			const page = Math.floor(startIndex / 16) + i;
			const recordIndex = page * 16;
			console.log("获取第", page, "页，索引从", recordIndex, "开始");

			await this.getHistoricalHeartRateData(recordIndex);

			// 等待响应到达；超过超时时间则视为本页无响应，继续下一页
			const timeout = await this._heartRatePageWaiter.wait(PAGE_RESPONSE_TIMEOUT_MS);
			if (timeout == true) {
				console.log(`第 ${page} 页响应超时（${PAGE_RESPONSE_TIMEOUT_MS}ms），继续下一页`);
				continue;
			}

			// 同步存储本批记录并推进进度计数（storeHistoricalRecords 内部 await 批量 INSERT）
			// 注意：本页响应已到达，"全 f"标志已由 onCharacteristicValueChange 同步设置
			if (this._heartRatePageWaiter.isAllEmpty()) {
				console.log(`第 ${page} 页响应为全 f，无更多数据，提前结束获取`);
				break;
			}
		}

		// 全部完成后落盘"已保存条数"；异常退出时保持原 savedCount，下次进入续传
		storage.set(KEY_PPI_SAVED_COUNT, status.heartRateCount, 0);
		console.log(`[FETCH] 完成，ppi_data 已保存条数 = ${status.heartRateCount}`);
	}

	/**
	 * 自动获取所有睡眠数据（支持断点续传）
	 * 根据 dataReadyStatus.sleepCount 自动遍历获取；
	 * 通过 KEY_SLEEP_SAVED_COUNT 持久化已保存条数，避免重复抓取；
	 * 如果设备历史被清空（已保存 > 设备总条数），自动重置计数。
	 * 两层超时：装配器内部 3000ms（头部已收但状态包丢失）+ 外部 waiter 5000ms（极端情况兜底）
	 */
	async fetchAllSleepData(): Promise<void> {
		const status = this.dataReadyStatus.value;
		if (status.sleepCount <= 0) {
			console.log("没有睡眠数据");
			return;
		}

		// 断点续传：校验已保存条数（跨平台类型守卫、边界重置、是否完成均在工具内）
		const { savedCount, isComplete } = loadResumeCount(
			KEY_SLEEP_SAVED_COUNT,
			status.sleepCount
		);
		if (isComplete) {
			console.log("睡眠数据已全部保存，无需抓取");
			return;
		}

		if (savedCount > 0) {
			console.log(`[FETCH] 断点续传：已保存 ${savedCount} 条，从第 ${savedCount} 条继续`);
		} else {
			console.log("[FETCH] 首次抓取，从头开始");
		}

		this._sleepPageWaiter.reset();
		this._sleepAssembler.reset();
		// 兜底 timeout：极端情况（设备未回头部）下保护循环不卡死
		// 正常情况由装配器内部 timer（3000ms）触发 reset
		const SLEEP_RESPONSE_TIMEOUT_MS = 5000;
		console.log("开始获取睡眠数据，总共", status.sleepCount, "条，已保存", savedCount, "条");

		// 每条睡眠单独 read/write，索引与已保存数据严格连续
		for (let i = savedCount; i < status.sleepCount; i++) {
			console.log("获取第", i, "条睡眠数据");
			await this.getSleepData(i);

			// 等待响应到达；超过超时时间则视为本条无响应
			const timeout = await this._sleepPageWaiter.wait(SLEEP_RESPONSE_TIMEOUT_MS);
			if (timeout == true) {
				console.log(`第 ${i} 条睡眠数据响应超时（${SLEEP_RESPONSE_TIMEOUT_MS}ms）`);
				this._sleepAssembler.reset();
				// 单条超时则中断本次循环，下次进入续传（避免半包数据"插队"已上传数据）
				break;
			}
			// 每条成功后推进进度计数（落盘保证下次进入即从此位置继续）
			storage.set(KEY_SLEEP_SAVED_COUNT, i + 1, 0);
		}
		console.log(`[FETCH] 睡眠数据获取完成，已保存 ${storage.get(KEY_SLEEP_SAVED_COUNT)} 条`);
	}

	// 事件处理
	onCharacteristicValueChange(): void {
		this.kuxBluetooth.onBLECharacteristicValueChange((res) => {
			const hexData = arrayBufferToHexString(res.value);
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
					// 先打印日志和通知等待者（确保不因为异步存储而错过）
					console.log("历史心率数据:", records);
					// 通知 fetchAllHistoricalHeartRateData 本页响应已到（先触发，再异步存储）
					this._heartRatePageWaiter.onNotify();
					// 当解析后无任何记录（说明原始数据为"全 f"），标记后续无数据
					if (records.length == 0) {
						this._heartRatePageWaiter.markAllEmpty();
						console.log("本次响应为全 f，无有效数据，标记停止获取");
					}
					// 批量存储历史心率血氧数据
					// 注：onCharacteristicValueChange 是 BLE 同步回调，await 批量 INSERT 不会阻塞 BLE 接收
					this.storeHistoricalRecords(records);
				} else if (hexData.length == 48) {
					// 睡眠数据头部（24 字节）—— 最明确的入口
					const sleep = this._sleepAssembler.push(hexData);
					if (sleep == null) {
						console.log("[SLEEP] 头部已接收，等待状态数据");
					} else {
						this._onSleepAssembled(sleep);
					}
				} else if (this._sleepAssembler.isAssembling()) {
					// 后续状态字节流（包大小不固定）—— 合并到已识别头部
					const sleep = this._sleepAssembler.push(hexData);
					if (sleep == null) {
						console.log("[SLEEP] 状态数据累积中");
					} else {
						this._onSleepAssembled(sleep);
					}
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

	/**
	 * 睡眠响应装配完成后的统一处理：合法性校验 + 存储 + 通知 waiter
	 * 提取为私有方法避免在 UART 分支中重复 4 处
	 */
	private _onSleepAssembled(sleep: SleepData): void {
		if (sleep.bedtime == 0 && sleep.recordCount == 0) {
			console.error("[SLEEP] 数据不合法，跳过存储，释放 waiter");
		} else {
			this.sleepData.value = sleep;
			console.log("睡眠数据:", sleep);
			bluetoothDataManager.storeSleepData(sleep);
		}
		this._sleepPageWaiter.onNotify();
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
		// 销毁睡眠响应装配器（清理 timer 句柄）
		this._sleepAssembler.destroy();
		// 销毁数据管理器
		bluetoothDataManager.destroy();
	}

	clear() {
		console.log("清除设备相关数据");
		this.stopDataQueryTimer();
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
