import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";
import type { ClActionSheetOptions, ClActionSheetItem } from "@/uni_modules/cool-ui";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
import { disconnect, closeAdapter } from "../../bluetooth/kux";
//#endif

import { DeviceStatusEnum, KEY_WEAR_LOCATION, KEY_BOUND_DEVICE_ID } from "./types";
import type { WearLocation } from "./types";
export type { WearLocation, DeviceStatus } from "./types";
export { DeviceStatusEnum } from "./types";

import type { RealtimeBroadcast } from "../../bluetooth";
import { DeviceConnection } from "./connection";
import { DeviceProtocol } from "./protocol";
import { EventHandler } from "./event-handler";
import { MockProvider } from "./mock-provider";

// 设备选择 actionSheet 调用参数(对象参数,UTS 不支持内联对象字面量类型)
export type ShowDevicePickerOptions = {
	onSelect: (deviceId: string, device: DeviceInfo) => void;
	onCancel?: () => void;
	title?: string;
	list?: DeviceInfo[];
};

/**
 * 设备状态类（新 BOOM 协议精简版）
 * - realtime: 0x50 广播解析后的最新实时数据（每秒刷新）
 * - event: 固件版本/设备编号/BOOM 时戳/生物识别/震动结果
 * - 不再有旧协议的 heartRate/bloodOxygen/battery/ppi/dataReadyStatus/rtcTime/sleepData 等字段
 */
export class Device {
	// 基本状态
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

	// 设备初始化状态
	isDeviceInitialized = false;
	currentWearLocation: WearLocation = "大臂部";

	/** 0x50 广播解析后的最新实时数据（每秒刷新，可能为 null） */
	realtime: RealtimeBroadcast | null = null;

	// 重连
	reconnectAttempts = 0;
	maxReconnectAttempts = 5;
	reconnectInterval = 2000;
	isReconnecting = false;

	// 子管理器
	//#ifndef H5
	readonly connection: DeviceConnection;
	readonly protocol: DeviceProtocol;
	readonly event: EventHandler;
	readonly mock: MockProvider;
	//#endif

	/** 是否启用 Mock 模拟（无真实设备时使用） */
	useMock: boolean = false;

	// 共享 actionSheet 引用(由 pages/device/index.uvue 在 onMounted 注入)
	//#ifndef H5
	actionSheetRef: ClActionSheetComponentPublicInstance | null = null;
	//#endif

	constructor() {
		this.loadSavedData();

		// Mock 模拟器（始终初始化，跨平台可用）
		this.mock = new MockProvider(this);

		//#ifndef H5
		this.connection = new DeviceConnection(this);
		this.protocol = new DeviceProtocol(this);
		this.event = new EventHandler(this);

		this.connection.onBluetoothAdapterStateChange();
		this.connection.onBLEConnectionStateChange();
		this.event.onCharacteristicValueChange();
		this.connection.initBluetooth();
		//#endif
	}

	// 持久化
	loadSavedData(): void {
		const saved = storage.get(KEY_WEAR_LOCATION) as WearLocation | null;
		if (saved != null) this.currentWearLocation = saved;

		const id = storage.get(KEY_BOUND_DEVICE_ID) as string | null;
		if (this.boundDeviceId == "" && id != null && id != "") {
			this.boundDeviceId = id;
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
		this.clearBoundDevice();
	}

	// 状态管理
	getPaired(): boolean {
		return this.currentDeviceId != "";
	}

	clearError(): void {
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
		//#endif
	}

	//#ifndef H5
	/**
	 * 弹设备选择 actionSheet
	 * - 未传 list 时,使用 deviceStore.devices 当前快照;传入 list 时使用自定义设备列表
	 * - 关闭 cl-action-sheet 的默认取消按钮,改为手动加"取消"项
	 *   (这样可以区分"选设备"和"取消",让调用方决定取消行为)
	 * - 选中/取消后会自动关闭弹窗,再触发回调
	 * - actionSheetRef 由 pages/device/index.uvue 在 onMounted 注入
	 */
	showDevicePicker(options: ShowDevicePickerOptions): void {
		if (this.actionSheetRef == null) {
			console.warn("[ACTION-SHEET] actionSheetRef 未注入,无法弹窗");
			return;
		}
		const { onSelect, onCancel, title, list } = options;
		const finalTitle: string = title ?? t("选择要连接的设备");
		const snapshot = (list ?? this.devices).slice();
		this.actionSheetRef.open({
			title: finalTitle,
			showCancel: false,
			list: [
				...snapshot.map(
					(d) =>
						({
							label: `${d.name}-${d.deviceId} · ${d.RSSI ?? "?"} dBm`,
							callback: () => {
								this.actionSheetRef?.close();
								onSelect(d.deviceId, d);
							}
						}) as ClActionSheetItem
				),
				{
					label: t("取消"),
					callback: () => {
						this.actionSheetRef?.close();
						onCancel?.();
					}
				} as ClActionSheetItem
			]
		} as ClActionSheetOptions);
	}
	//#endif

	clear(): void {
		//#ifndef H5
		this.connection._resetConnectionState();
		//#endif
		this.boundDeviceId = "";
		this.realtime = null;
		this.errorMessage.value = "";
	}

	//#ifndef H5
	/**
	 * 启动 Mock 模拟（无真实设备时使用）
	 * - 状态置为 CONNECTED，设备名显示为 BOOM-MOCK
	 * - 启用 mock.start() → 每秒推送 0x50 实时广播
	 * - 协议层（protocol.sendTlvc）走 mock 分支，readXxx / setXxx 命令可立即看到 event 字段更新
	 */
	startMock(): void {
		this.useMock = true;
		this.mock.start();
		this.status.value = "CONNECTED";
		this.currentDeviceName = "BOOM-MOCK";
		this.errorMessage.value = "";
	}

	/**
	 * 停止 Mock 模拟
	 */
	stopMock(): void {
		this.useMock = false;
		this.mock.stop();
		this.status.value = "UNPAIRED";
		this.currentDeviceName = "";
		this.realtime = null;
	}
	//#endif
}

export const device = new Device();
