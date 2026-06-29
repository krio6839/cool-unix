import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";
import type { ClActionSheetOptions, ClActionSheetItem } from "@/uni_modules/cool-ui";

import { bluetoothDataManager, type DataReadyStatus, type SleepData } from "../../bluetooth";

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

// 设备选择 actionSheet 调用参数(对象参数,UTS 不支持内联对象字面量类型)
export type ShowDevicePickerOptions = {
	onSelect: (deviceId: string, device: DeviceInfo) => void;
	onCancel?: () => void;
	title?: string;
	list?: DeviceInfo[];
};

export class Device {
	// 基本状态属性
	status = ref<keyof typeof DeviceStatusEnum>("UNPAIRED");
	available: boolean = false;
	discovering: boolean = false;
	errorMessage = ref<string>("");

	// 设备信息
	currentDeviceName: string = "";
	//#ifndef H5
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	boundDeviceId: string = "";
	//#endif
	//#ifdef H5
	//@ts-ignore
	currentDeviceId: string = "C6:21:DB:55:81:6D";
	//@ts-ignore
	boundDeviceId: string = "C6:21:DB:55:81:6D";
	//#endif

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
	actionSheetRef: ClActionSheetComponentPublicInstance | null = null;
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
		const savedLocation = storage.get(KEY_WEAR_LOCATION) as string | null;
		if (savedLocation != null) {
			this.currentWearLocation = savedLocation as WearLocation;
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
	 * 弹设备选择 actionSheet
	 * - 未传 list 时,使用 deviceStore.devices 当前快照;传入 list 时使用自定义设备列表
	 * - 关闭 cl-action-sheet 的默认取消按钮,改为手动加"取消"项
	 *   (这样可以区分"选设备"和"取消",让调用方决定取消行为)
	 * - 选中/取消后会自动关闭弹窗,再触发回调
	 * - 供 connection.ts 在 count >= 2 时直接调用,无需 UI 按钮
	 * - actionSheetRef 由 pages/device/index.uvue 在 onMounted 注入
	 *
	 * 参数对象字段:
	 * - onSelect 选中设备回调,接收 deviceId 与完整 device 信息
	 * - onCancel 取消回调(可选,默认无操作)
	 * - title 弹窗标题,默认"选择要连接的设备"
	 * - list 自定义设备列表,默认使用 deviceStore.devices
	 */
	showDevicePicker(options: ShowDevicePickerOptions): void {
		if (this.actionSheetRef == null) {
			console.warn("[ACTION-SHEET] actionSheetRef 未注入,无法弹窗");
			return;
		}
		const { onSelect, onCancel, title, list } = options;
		const finalTitle: string = title ?? t("选择要连接的设备");
		const snapshot = (list ?? this.devices).slice(); // 拍快照,避免弹窗期间被修改

		// UTS:强类型对象字面量,先抽成具名 const
		const deviceItem = (d: DeviceInfo): ClActionSheetItem => ({
			label: `${d.name}-${d.deviceId} · ${d.RSSI ?? "?"} dBm`,
			callback: () => {
				// 先关闭弹窗,再触发回调,避免弹窗挡住后续 UI
				this.actionSheetRef?.close();
				onSelect(d.deviceId, d);
			}
		});
		const cancelItem: ClActionSheetItem = {
			label: t("取消"),
			callback: () => {
				this.actionSheetRef?.close();
				onCancel?.();
			}
		};
		const sheetOptions: ClActionSheetOptions = {
			title: finalTitle,
			showCancel: false, // 关闭默认取消,手动加
			list: [...snapshot.map(deviceItem), cancelItem]
		};
		this.actionSheetRef.open(sheetOptions);
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
		// UTS:抽成具名 const 再赋值,避免内联对象字面量 + as 断言
		const emptyStatus: DataReadyStatus = { heartRateCount: 0, sleepCount: 0 };
		this.dataReadyStatus.value = emptyStatus;
		this.rtcTime.value = 0;
		this._deviceOn = false;
		this.errorMessage.value = "";
	}

	//#ifndef H5
	/**
	 * 用户主动删除设备(从设备页底部按钮触发)
	 * - 1. 断开 BLE
	 * - 2. 清空历史 DB(心率/睡眠/PPI)
	 * - 3. 清空本地存储(boundDeviceId / PPI 计数 / SLEEP 计数)
	 * - 4. 重置实时数据 + 状态回 UNPAIRED
	 * - 注意:wearLocation 保留(用户偏好,与设备无关)
	 */
	async deleteDevice(): Promise<void> {
		console.log("[DEVICE] 用户删除设备");

		// 1. 断开 BLE(在清数据前先断开,避免回调中读到空状态)
		try {
			await this.connection.disconnectDevice();
		} catch (e) {
			console.warn("[DEVICE] deleteDevice: disconnectDevice 异常,继续清理:", e);
		}

		// 2. 清空历史 DB(心率/睡眠/PPI 记录)
		try {
			await bluetoothDataManager.clearAllData();
		} catch (e) {
			console.warn("[DEVICE] deleteDevice: clearAllData 异常,继续清理:", e);
		}

		// 3. 清空本地 storage(boundDeviceId / PPI 计数 / SLEEP 计数)
		this.clearAllSavedData();

		// 4. 重置实时数据 + 状态
		const emptyStatus: DataReadyStatus = { heartRateCount: 0, sleepCount: 0 };
		this.dataReadyStatus.value = emptyStatus;
		this.heartRate.value = 0;
		this.bloodOxygen.value = 0;
		this.battery.value = 0;
		this.ppi.value = 0;
		this.sleepData.value = null;
		this.rtcTime.value = 0;
		this._deviceOn = false;
		this.errorMessage.value = "";
		this.status.value = "UNPAIRED";
		console.log("[DEVICE] deleteDevice 完成,状态:UNPAIRED");
	}
	//#endif
}

export const device = new Device();
