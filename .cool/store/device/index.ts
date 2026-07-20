/**
 * 设备主类（新 BOOM 协议精简版）
 *
 * 字段分组：
 * - 基本状态: status / available / discovering / errorMessage
 * - 设备信息: currentDeviceName / devices / currentDeviceId / boundDeviceId
 * - 设备初始化: isDeviceInitialized / currentWearLocation
 * - 0x50 实时数据: realtime
 * - 重连: reconnectAttempts / maxReconnectAttempts / reconnectInterval / isReconnecting
 * - 子管理器: connection / protocol / event
 * - 共享 actionSheet: actionSheetRef
 *
 * 不再有旧协议的 heartRate / bloodOxygen / battery / ppi / dataReadyStatus / rtcTime / sleepData 等字段。
 */

import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";
import { realtime } from "../realtime";
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
	DEFAULT_WEAR_LOCATION,
	normalizeWearLocation
} from "./types";
import type { WearLocation } from "./types";
export type { WearLocation, WearLocationOption, DeviceStatus } from "./types";
export {
	DeviceStatusEnum,
	DEFAULT_WEAR_LOCATION,
	getWearLocationLabel,
	getWearLocationOptions,
	isValidWearLocation,
	normalizeWearLocation
} from "./types";

import type { RealtimeBroadcast } from "../../bluetooth";
import { DeviceConnection } from "./connection";
import { DeviceProtocol } from "./protocol";
import { EventHandler } from "./event-handler";
import { DeviceHistoryReader } from "./history-reader";
import { DeviceBroadcast } from "./broadcast";

/* 设备选择 actionSheet 调用参数（对象参数，UTS 不支持内联对象字面量类型） */
export type ShowDevicePickerOptions = {
	onSelect: (deviceId: string, device: DeviceInfo) => void;
	onCancel?: () => void;
	title?: string;
	list?: DeviceInfo[];
};

export type ProtocolLogDirection = "TX" | "RX" | "INFO" | "ERR";

export type ProtocolLogItem = {
	id: number;
	time: string;
	direction: ProtocolLogDirection;
	title: string;
	hex: string;
	detail: string;
};

export type BroadcastDebugInfo = {
	seq: number;
	deviceId: string;
	name: string;
	rssi: number;
	rawHex: string;
	vHex: string;
	utc: number;
	diffSec: number;
	summary: string;
	receivedAt: number;
};

export type DeviceTestMode = "connect" | "broadcast";

export class Device {
	/* ===== 基本状态 ===== */
	status = ref<keyof typeof DeviceStatusEnum>("UNPAIRED");
	stateVersion = ref<number>(0);
	testMode = ref<DeviceTestMode>("connect");
	available: boolean = false;
	discovering: boolean = false;
	errorMessage = ref<string>("");

	/* ===== 设备信息 ===== */
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

	/* ===== 设备初始化状态 ===== */
	isDeviceInitialized = false;
	currentWearLocation: WearLocation = DEFAULT_WEAR_LOCATION;

	/** 0x50 广播解析后的最新实时数据（每秒刷新，可能为 null） */
	realtime = ref<RealtimeBroadcast | null>(null);
	/** 0x50 广播调试信息（raw + 解析摘要） */
	broadcastDebug = ref<BroadcastDebugInfo | null>(null);

	/* ===== 协议调试日志 ===== */
	protocolLogs = ref<ProtocolLogItem[]>([]);
	private _protocolLogId = 0;

	/* ===== 重连 ===== */
	reconnectAttempts = 0;
	maxReconnectAttempts = 5;
	reconnectInterval = 2000;
	isReconnecting = false;

	/* ===== 子管理器 ===== */
	//#ifndef H5
	readonly connection: DeviceConnection;
	readonly protocol: DeviceProtocol;
	readonly event: EventHandler;
	readonly history: DeviceHistoryReader;
	readonly broadcast: DeviceBroadcast;
	//#endif

	/* ===== 共享 actionSheet 引用（由 pages/device/index.uvue 在 onMounted 注入）===== */
	//#ifndef H5
	actionSheetRef: ClActionSheetComponentPublicInstance | null = null;
	//#endif

	constructor() {
		this.loadSavedData();

		//#ifndef H5
		this.connection = new DeviceConnection(this);
		this.protocol = new DeviceProtocol(this);
		this.event = new EventHandler(this);
		this.history = new DeviceHistoryReader(this);
		this.broadcast = new DeviceBroadcast(this);

		this.connection.onBluetoothAdapterStateChange();
		this.connection.onBLEConnectionStateChange();
		this.event.onCharacteristicValueChange();
		this.connection.initBluetooth();
		//#endif
	}

	/* ===== 持久化 ===== */

	/** 启动时从 storage 恢复佩戴位置 + 绑定设备 ID */
	loadSavedData(): void {
		const saved = storage.get(KEY_WEAR_LOCATION);
		if (saved != null) {
			this.currentWearLocation = normalizeWearLocation(saved);
			storage.set(KEY_WEAR_LOCATION, this.currentWearLocation, 0);
		}

		const id = storage.get(KEY_BOUND_DEVICE_ID) as string | null;
		if (this.boundDeviceId == "" && id != null && id != "") {
			this.boundDeviceId = id;
		}
	}

	/** 保存佩戴位置 */
	saveWearLocation(location: WearLocation): void {
		const normalized = normalizeWearLocation(location);
		this.currentWearLocation = normalized;
		storage.set(KEY_WEAR_LOCATION, normalized, 0);
		this.touchState();
	}

	/** 持久化绑定设备 ID */
	saveBoundDevice(deviceId: string): void {
		this.boundDeviceId = deviceId;
		storage.set(KEY_BOUND_DEVICE_ID, deviceId, 0);
		this.touchState();
	}

	/** 清除绑定设备 ID */
	clearBoundDevice(): void {
		this.boundDeviceId = "";
		storage.remove(KEY_BOUND_DEVICE_ID);
		this.touchState();
	}

	/** 清除所有持久化数据（保留接口，备用） */
	clearAllSavedData(): void {
		this.clearBoundDevice();
	}

	/* ===== 状态管理 ===== */

	/** 普通字段变更后触发页面 / computed 重新计算 */
	touchState(): void {
		this.stateVersion.value++;
	}

	/** 是否已配对（currentDeviceId 非空） */
	getPaired(): boolean {
		return this.currentDeviceId != "";
	}

	/** 清除错误信息 */
	clearError(): void {
		this.errorMessage.value = "";
	}

	/** 追加协议调试日志，最多保留最近 80 条 */
	addProtocolLog(
		direction: ProtocolLogDirection,
		title: string,
		hex: string = "",
		detail: string = ""
	): void {
		this._protocolLogId++;
		const now = new Date();
		const item: ProtocolLogItem = {
			id: this._protocolLogId,
			time: now.toLocaleTimeString(),
			direction,
			title,
			hex,
			detail
		};
		const next = [item].concat(this.protocolLogs.value);
		this.protocolLogs.value = next.slice(0, 80);
	}

	/** 清空协议调试日志 */
	clearProtocolLogs(): void {
		this.protocolLogs.value = [];
	}

	/** 重置重连状态（重连成功后 / 主动重置时调用） */
	resetReconnectState(): void {
		this.reconnectAttempts = 0;
		this.isReconnecting = false;
	}

	/* ===== 资源管理 ===== */

	/** 销毁：停止扫描 → 断开 → 关闭适配器 */
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
	 * - 未传 list 时，使用 deviceStore.devices 当前快照；传入 list 时使用自定义设备列表
	 * - 关闭 cl-action-sheet 的默认取消按钮，改为手动加"取消"项
	 *   （这样可以区分"选设备"和"取消"，让调用方决定取消行为）
	 * - 选中/取消后会自动关闭弹窗，再触发回调
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
		// UTS:强类型对象字面量,先抽成具名 const
		const deviceItem = (d: DeviceInfo): ClActionSheetItem => ({
			label: `${d.name}-${d.deviceId} · ${d.RSSI ?? "?"} dBm`,
			callback: () => {
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
			showCancel: false,
			list: [...snapshot.map(deviceItem), cancelItem]
		};
		this.actionSheetRef.open(sheetOptions);
	}
	//#endif

	/** 清除设备数据（绑定 ID + 实时数据 + 错误） */
	clear(): void {
		//#ifndef H5
		this.connection._resetConnectionState();
		//#endif
		this.boundDeviceId = "";
		this.realtime.value = null;
		this.errorMessage.value = "";
	}

	//#ifndef H5
	/**
	 * 用户主动删除设备(从设备页底部按钮触发)
	 * - 1. 断开 BLE(disconnectDevice 内部会重置状态:status=UNPAIRED, realtime=null, currentDeviceId="")
	 * - 2. 清空历史 DB(心率/睡眠/PPI)
	 * - 3. 清空本地存储(boundDeviceId)
	 * - 注意:wearLocation 保留(用户偏好,与设备无关)
	 */
	async deleteDevice(): Promise<void> {
		console.log("[DEVICE] 用户删除设备");
		let remoteUnbindOk = false;
		let remoteUnbindAttempted = false;

		try {
			remoteUnbindOk = await this.unbindRemoteDevice();
			remoteUnbindAttempted = true;
		} catch (e) {
			console.warn("[DEVICE] deleteDevice: 设备解绑异常,继续清理本地:", e);
		}

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

		// 3. 清空本地 storage(boundDeviceId)
		this.clearAllSavedData();
		realtime.clear();

		// 4. 补充:清错误信息(disconnectDevice 不清,这里兜底)
		this.errorMessage.value = "";
		if (remoteUnbindAttempted == true && remoteUnbindOk == false) {
			console.warn("[DEVICE] 设备未确认解绑，本地已删除");
		}
	}

	private async unbindRemoteDevice(): Promise<boolean> {
		const boundId = this.boundDeviceId;
		if (boundId == "") return true;
		await this.broadcast.stopBoundBroadcastScan();
		await this.broadcast.stopRealtimeScan();
		if (this.currentDeviceId == "") {
			await this.connection.connectToDevice(boundId, this.currentDeviceName);
		}
		if (this.currentDeviceId == "") {
			console.warn("[DEVICE] 解绑前连接设备失败，继续删除本地");
			return false;
		}
		const beforeSeq = this.event.deviceControlSeq.value;
		const ok = await this.protocol.controlDevice(1);
		if (ok == false) {
			console.warn("[DEVICE] 0x41 解绑发送失败，继续删除本地");
			return false;
		}
		return await this.waitForDeviceControlResult(beforeSeq, 1, 3000);
	}

	private async waitForDeviceControlResult(
		beforeSeq: number,
		code: number,
		timeoutMs: number
	): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.event.deviceControlSeq.value > beforeSeq) {
				const result = this.event.lastDeviceControl.value;
				if (result != null && result.code == code && result.result == 0) {
					return true;
				}
				return false;
			}
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					resolve();
				}, 120);
			});
		}
		console.warn("[DEVICE] 等待 0x41 解绑响应超时，继续删除本地");
		return false;
	}
	//#endif
}

/** 全局单例 */
export const device = new Device();

/* 重新导出蓝牙模块的类型，方便上层（page/uvue）import type 使用 */
export type { VitalBiometric, VibrationSpec, RealtimeBroadcast } from "../../bluetooth";
export type {
	EventAutoReadOptions,
	EventAutoReadResult,
	HistoryReadProgress,
	VitalAutoReadOptions,
	VitalAutoReadResult
} from "./history-reader";
