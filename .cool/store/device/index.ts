import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";

import type { DataReadyStatus, SleepData } from "../../bluetooth";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
import { disconnect, closeAdapter } from "../../bluetooth/kux";
//#endif

import { DeviceStatusEnum, KEY_WEAR_LOCATION, KEY_LAST_DEVICE_ID } from "./types";
import type { WearLocation } from "./types";
export type { WearLocation, DeviceStatus } from "./types";
export { DeviceStatusEnum } from "./types";

import { DeviceConnection } from "./connection";
import { DeviceProtocol } from "./protocol";
import { DataFetcher } from "./data-fetcher";
import { EventHandler } from "./event-handler";

export class Device {
	// 基本状态属性
	status = ref<keyof typeof DeviceStatusEnum>("UNPAIRED");
	available: boolean = false;
	discovering: boolean = false;
	errorMessage = ref<string>("");

	// 设备信息
	//#ifndef H5
	devices: DeviceInfo[] = [];
	//#endif
	currentDeviceId: string = "";
	currentDeviceName: string = "";
	lastConnectedDeviceId: string = "";

	// 设备初始化状态标志，防止重复初始化
	isDeviceInitialized = false;

	// 设备状态
	currentWearLocation: WearLocation = "大臂部";
	_deviceOn: boolean = false;

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

	// 子管理器
	//#ifndef H5
	readonly connection: DeviceConnection;
	readonly protocol: DeviceProtocol;
	readonly data: DataFetcher;
	readonly event: EventHandler;
	//#endif

	constructor() {
		this.loadSavedData();

		//#ifndef H5
		this.connection = new DeviceConnection(this);
		this.protocol = new DeviceProtocol(this);
		this.data = new DataFetcher(this);
		this.event = new EventHandler(this);

		this.connection.onBluetoothAdapterStateChange();
		this.connection.onBLEConnectionStateChange();
		this.event.onCharacteristicValueChange();
		this.event.onReadCharacteristicValue();
		this.connection.initBluetooth();
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

	// 资源管理
	destroy() {
		//#ifndef H5
		this.connection.stopBluetoothSearch();
		if (this.currentDeviceId != "") {
			disconnect(this.currentDeviceId);
		}
		closeAdapter();
		this.data.destroy();
		//#endif
	}

	clear() {
		console.log("清除设备相关数据");
		//#ifndef H5
		this.data.stopDataQueryTimer();
		this.connection._resetConnectionState();
		//#endif
		this.lastConnectedDeviceId = "";
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
		this._deviceOn = false;
		this.errorMessage.value = "";
		this.clearLastConnectedDevice();
	}
}

export const device = new Device();
