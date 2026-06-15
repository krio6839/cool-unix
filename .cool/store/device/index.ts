import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";
import { type ClActionSheetOptions, type ClActionSheetItem } from "@/uni_modules/cool-ui";

import type { DataReadyStatus, SleepData } from "../../bluetooth";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
import { disconnect, closeAdapter } from "../../bluetooth/kux";
//#endif

import {
	DeviceStatusEnum,
	KEY_WEAR_LOCATION,
	KEY_BOUND_DEVICE_ID,
	KEY_PPI_SAVED_COUNT,
	KEY_SLEEP_SAVED_COUNT
} from "./types";
import type { WearLocation } from "./types";
export type { WearLocation, DeviceStatus } from "./types";
export { DeviceStatusEnum } from "./types";

import { DeviceConnection } from "./connection";
import { DeviceProtocol } from "./protocol";
import { DataFetcher } from "./data-fetcher";
import { EventHandler } from "./event-handler";

// actionSheet 共享 ref 的最小类型(不直接 import ClActionSheetComponentPublicInstance,避免 UTS 跨文件类型解析问题)
type ClActionSheetComponentPublicInstance = any;

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
	boundDeviceId: string = "";

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

	// 共享 actionSheet 引用(由 pages/device/index.uvue 在 onMounted 注入)
	//#ifndef H5
	actionSheetRef: ClActionSheetComponentPublicInstance | null;
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

		const savedDeviceId = storage.get(KEY_BOUND_DEVICE_ID) as string | null;
		if (this.boundDeviceId == "" && savedDeviceId != null && savedDeviceId != "") {
			this.boundDeviceId = savedDeviceId;
		}
	}

	saveWearLocation(location: WearLocation): void {
		this.currentWearLocation = location;
		storage.set(KEY_WEAR_LOCATION, location, 0);
	}

	saveBoundDevice(deviceId: string): void {
		this.boundDeviceId = deviceId;
		storage.set(KEY_BOUND_DEVICE_ID, deviceId, 0);
	}

	clearBoundDevice(): void {
		this.boundDeviceId = "";
		storage.remove(KEY_BOUND_DEVICE_ID);
	}

	clearAllSavedData(): void {
		storage.remove(KEY_PPI_SAVED_COUNT);
		storage.remove(KEY_SLEEP_SAVED_COUNT);
		this.clearBoundDevice();
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

	//#ifndef H5
	/**
	 * 打开设备选择 actionSheet(共享给所有需要的地方)
	 * - PairingState 的"选择设备"按钮 → index.uvue 处理
	 * - TestPopup 的 testSwitchDevice
	 * - 等等
	 * - actionSheetRef 由 pages/device/index.uvue 在 onMounted 注入
	 */
	openDeviceActionSheet(options: ClActionSheetOptions): void {
		if (this.actionSheetRef == null) {
			console.warn("[ACTION-SHEET] actionSheetRef 未注入,无法弹窗");
			return;
		}
		this.actionSheetRef.open(options);
	}

	/**
	 * 弹设备选择 actionSheet
	 * - 从 deviceStore.devices 当前快照生成选项列表
	 * - 关闭 cl-action-sheet 的默认取消按钮,改为手动加"取消"项
	 *   (这样可以区分"选设备"和"取消",让调用方决定取消行为)
	 * - 供 connection.ts 在 count >= 2 时直接调用,无需 UI 按钮
	 *
	 * @param onSelect 选中设备回调,接收 deviceId
	 * @param onCancel 取消回调(可选,默认无操作)
	 * @param title 弹窗标题,默认"选择要连接的设备"
	 */
	showDevicePicker(
		onSelect: (deviceId: string) => void,
		onCancel?: () => void,
		title: string = t("选择要连接的设备")
	): void {
		if (this.actionSheetRef == null) {
			console.warn("[ACTION-SHEET] actionSheetRef 未注入,无法弹窗");
			return;
		}
		const snapshot = this.devices; // 拍快照,避免弹窗期间 devices 被修改
		if (snapshot.length < 2) {
			console.warn("[PICKER] 设备数量 < 2,无法弹窗");
			return;
		}
		this.actionSheetRef.open({
			title,
			showCancel: false, // 关闭默认取消,手动加
			list: [
				...snapshot.map(
					(d) =>
						({
							label: `${d.name ?? d.localName ?? "BOOM1"} · ${d.RSSI ?? "?"} dBm`,
							callback: () => {
								onSelect(d.deviceId);
							}
						}) as ClActionSheetItem
				),
				{
					label: t("取消"),
					callback: () => {
						onCancel?.();
					}
				} as ClActionSheetItem
			]
		} as ClActionSheetOptions);
	}
	//#endif

	clear() {
		console.log("清除设备相关数据");
		//#ifndef H5
		this.data.stopDataQueryTimer();
		this.connection._resetConnectionState();
		//#endif
		this.boundDeviceId = "";
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
	}
}

export const device = new Device();
