/**
 * 设备主类（新 BOOM 协议精简版）
 *
 * 字段分组：
 * - 基本状态: status / available / discovering / errorMessage
 * - 设备信息: currentDeviceName / devices / currentDeviceId / boundDeviceId
 * - 设备初始化: isDeviceInitialized / currentWearLocation
 * - 0x50 实时数据: realtime
 * - 子管理器: connection / protocol / event
 * - 共享 actionSheet: actionSheetRef
 *
 * 不再有旧协议的 heartRate / bloodOxygen / battery / ppi / dataReadyStatus / rtcTime / sleepData 等字段。
 */

import { ref } from "vue";
import { storage } from "../../utils";
import { t } from "../../locale";
import type { DiagnosticLogLevel } from "../../service/diagnostics";
import { logger } from "../../service/logger";
import { realtime } from "../realtime";
import type { ClActionSheetOptions, ClActionSheetItem } from "@/uni_modules/cool-ui";

import { bluetoothDataManager } from "../../bluetooth";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
import { disconnect, closeAdapter } from "../../bluetooth/kux";
//#endif

import {
	KEY_WEAR_LOCATION,
	KEY_BOUND_DEVICE_ID,
	KEY_BOUND_DEVICE_NAME,
	DEFAULT_WEAR_LOCATION,
	normalizeWearLocation
} from "./types/wear-location";
import { DeviceStatusEnum } from "./types/device-state-types";
import type { DeviceOnlineInfo } from "./types/device-state-types";
import type { BroadcastDebugInfo } from "./types/broadcast-types";
import type { GattTaskName } from "./types/gatt-types";
import type { WearLocation } from "./types/wear-location";
export type {
	DeviceOnlineInfo,
	DeviceOnlineSource,
	DeviceStatus
} from "./types/device-state-types";
export type { BroadcastDebugInfo } from "./types/broadcast-types";
export type { WearLocation, WearLocationOption } from "./types/wear-location";
export {
	DEFAULT_WEAR_LOCATION,
	getWearLocationLabel,
	getWearLocationOptions,
	isValidWearLocation,
	normalizeWearLocation
} from "./types/wear-location";
export { DeviceStatusEnum } from "./types/device-state-types";

import type { RealtimeBroadcast } from "../../bluetooth";
import { DeviceConnection } from "./connection";
import { DeviceProtocol } from "./protocol";
import { EventHandler } from "./event-handler";
import { DeviceHistoryReader } from "./history-reader";
import { DeviceBroadcast } from "./broadcast";
import { DeviceSync } from "./sync";
import { DeviceGattTaskLock } from "./gatt-lock";
import { DeviceGattScheduler } from "./gatt-scheduler";

/* 设备选择 actionSheet 调用参数（对象参数，UTS 不支持内联对象字面量类型） */
export type ShowDevicePickerOptions = {
	onSelect: (deviceId: string, device: DeviceInfo) => void;
	onCancel?: () => void;
	title?: string;
	description?: string;
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

const BROADCAST_ONLINE_WINDOW_MS = 10 * 1000;

export class Device {
	/* ===== 基本状态 ===== */
	status = ref<keyof typeof DeviceStatusEnum>("UNPAIRED");
	stateVersion = ref<number>(0);
	available: boolean = false;
	discovering: boolean = false;
	errorMessage = ref<string>("");
	isDeletingDevice: boolean = false;

	/* ===== 设备信息 ===== */
	currentDeviceName: string = "";
	boundDeviceName: string = "";
	//#ifndef H5
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	boundDeviceId: string = "";
	//#endif
	//#ifdef H5
	//@ts-ignore
	currentDeviceId: string = "C0:BC:D3:A0:EB:2E";
	//@ts-ignore
	boundDeviceId: string = "C0:BC:D3:A0:EB:2E";
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
	readonly gattLock = new DeviceGattTaskLock();

	/* ===== 子管理器 ===== */
	//#ifndef H5
	readonly connection: DeviceConnection;
	readonly protocol: DeviceProtocol;
	readonly event: EventHandler;
	readonly history: DeviceHistoryReader;
	readonly sync: DeviceSync;
	readonly broadcast: DeviceBroadcast;
	readonly scheduler: DeviceGattScheduler;
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
		this.sync = new DeviceSync(this);
		this.broadcast = new DeviceBroadcast(this);
		this.scheduler = new DeviceGattScheduler(this);

		this.connection.onBluetoothAdapterStateChange();
		this.connection.onBLEConnectionStateChange();
		this.event.onCharacteristicValueChange();
		if (this.boundDeviceId != "") {
			this.connection.initBluetoothSafely();
			this.sync.startAutoRepair();
		}
		//#endif
	}

	/* ===== 持久化 ===== */

	beginGattTask(name: GattTaskName): boolean {
		return this.gattLock.begin(name);
	}

	endGattTask(name: GattTaskName): void {
		this.gattLock.end(name);
	}

	isGattTaskBusy(): boolean {
		return this.gattLock.isBusy();
	}

	getGattTaskName(): string {
		return this.gattLock.getName();
	}

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
		const name = storage.get(KEY_BOUND_DEVICE_NAME) as string | null;
		if (this.boundDeviceName == "" && name != null && name != "") {
			this.boundDeviceName = name;
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
	saveBoundDevice(deviceId: string, deviceName: string = ""): void {
		this.boundDeviceId = deviceId;
		if (deviceName != "") {
			this.boundDeviceName = deviceName;
			storage.set(KEY_BOUND_DEVICE_NAME, deviceName, 0);
		}
		storage.set(KEY_BOUND_DEVICE_ID, deviceId, 0);
		this.touchState();
		//#ifndef H5
		this.sync.startAutoRepair();
		//#endif
	}

	saveBoundDeviceName(deviceName: string): void {
		if (deviceName == "") return;
		if (this.boundDeviceName == deviceName) return;
		this.boundDeviceName = deviceName;
		storage.set(KEY_BOUND_DEVICE_NAME, deviceName, 0);
		this.touchState();
	}

	/** 清除绑定设备 ID */
	clearBoundDevice(): void {
		//#ifndef H5
		this.sync.stopAutoRepair();
		//#endif
		this.boundDeviceId = "";
		this.boundDeviceName = "";
		storage.remove(KEY_BOUND_DEVICE_ID);
		storage.remove(KEY_BOUND_DEVICE_NAME);
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

	getDisplayDeviceName(): string {
		if (this.currentDeviceName != "") return this.currentDeviceName;
		if (this.boundDeviceName != "") return this.boundDeviceName;
		if (this.boundDeviceId != "") return this.boundDeviceId;
		return "";
	}

	isOnline(nowMs: number = Date.now()): boolean {
		return this.getOnlineInfo(nowMs).online;
	}

	getOnlineInfo(nowMs: number = Date.now()): DeviceOnlineInfo {
		const deviceName = this.getDisplayDeviceName();
		if (this.status.value == "CONNECTED") {
			return {
				online: true,
				source: "gatt",
				statusText: t("已连接"),
				iconColor: "white",
				iconName: "link",
				deviceName,
				lastSeenAt: nowMs
			} as DeviceOnlineInfo;
		}
		const debug = this.broadcastDebug.value;
		if (
			debug != null &&
			debug.source == "broadcast" &&
			this.boundDeviceId != "" &&
			debug.deviceId == this.boundDeviceId &&
			nowMs - debug.receivedAt <= BROADCAST_ONLINE_WINDOW_MS
		) {
			return {
				online: true,
				source: "broadcast",
				statusText: t("广播中"),
				iconColor: "white",
				iconName: "link",
				deviceName,
				lastSeenAt: debug.receivedAt
			} as DeviceOnlineInfo;
		}
		if (this.status.value == "PAIRING" || this.status.value == "SEARCHING") {
			return {
				online: false,
				source: "searching",
				statusText: t("搜索中"),
				iconColor: "#FBBF24",
				iconName: "search-line",
				deviceName,
				lastSeenAt: 0
			} as DeviceOnlineInfo;
		}
		return {
			online: false,
			source: "offline",
			statusText: t("未配对"),
			iconColor: "#FF5C5C",
			iconName: "forbid-line",
			deviceName,
			lastSeenAt: 0
		} as DeviceOnlineInfo;
	}

	getConnectionStatusText(): string {
		return this.getOnlineInfo().statusText;
	}

	//#ifndef H5
	cacheFoundDevice(found: DeviceInfo, name: string): void {
		const nextDevices = this.devices.slice();
		let index = -1;
		for (let i = 0; i < nextDevices.length; i++) {
			if (nextDevices[i].deviceId == found.deviceId) {
				index = i;
				break;
			}
		}
		let shouldTouch = index < 0;
		if (index >= 0) {
			const old = nextDevices[index];
			if (old.name != name) shouldTouch = true;
			if ((old.localName ?? "") != (found.localName ?? name)) shouldTouch = true;
			if ((old.RSSI ?? 0) != (found.RSSI ?? 0)) shouldTouch = true;
		}
		const item = {
			name,
			localName: found.localName ?? name,
			deviceId: found.deviceId,
			RSSI: found.RSSI ?? 0,
			advertisData: found.advertisData ?? [],
			advertisServiceUUIDs: found.advertisServiceUUIDs ?? [],
			serviceData: found.serviceData,
			connectable: true
		} as DeviceInfo;
		if (index >= 0) {
			nextDevices.splice(index, 1, item);
		} else {
			nextDevices.push(item);
		}
		this.devices = this.sortDevicesByRssiDesc(nextDevices);
		if (shouldTouch == true) {
			this.touchState();
		}
	}

	findCachedDevice(deviceId: string): DeviceInfo | null {
		for (let i = 0; i < this.devices.length; i++) {
			const item = this.devices[i];
			if (item.deviceId == deviceId) return item;
		}
		return null;
	}

	private sortDevicesByRssiDesc(list: DeviceInfo[]): DeviceInfo[] {
		const sorted: DeviceInfo[] = [];
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const itemRssi = item.RSSI ?? -100;
			let inserted = false;
			for (let j = 0; j < sorted.length; j++) {
				const current = sorted[j];
				const currentRssi = current.RSSI ?? -100;
				if (itemRssi > currentRssi) {
					sorted.splice(j, 0, item);
					inserted = true;
					break;
				}
			}
			if (inserted == false) {
				sorted.push(item);
			}
		}
		return sorted;
	}
	//#endif

	/** 清除错误信息 */
	clearError(): void {
		this.errorMessage.value = "";
	}

	setUnpairedError(message: string): void {
		this.status.value = "UNPAIRED";
		this.errorMessage.value = message;
		this.touchState();
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
		const level: DiagnosticLogLevel = direction == "ERR" ? "error" : "info";
		const hexText = hex.length > 220 ? `${hex.substring(0, 220)}...` : hex;
		logger.record(level, "bluetooth", `[${direction}] ${title}`, `${detail}\n${hexText}`);
	}

	/** 清空协议调试日志 */
	clearProtocolLogs(): void {
		this.protocolLogs.value = [];
	}

	/* ===== 资源管理 ===== */

	/** 销毁：停止扫描 → 断开 → 关闭适配器 */
	async destroy(): Promise<void> {
		//#ifndef H5
		this.sync.stop();
		await this.connection.stopBluetoothSearch();
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
			logger.warn("bluetooth", "[ACTION-SHEET] actionSheetRef 未注入,无法弹窗");
			return;
		}
		const { onSelect, onCancel, title, description, list } = options;
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
			description: description ?? "",
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
		this.clearBoundDevice();
		this.realtime.value = null;
		this.errorMessage.value = "";
	}

	//#ifndef H5
	/**
	 * 用户主动删除设备(从设备页底部按钮触发)
	 * - 1. 尽量通过 0x41 通知设备解绑
	 * - 2. 断开 BLE
	 * - 3. 清空历史 DB(心率/睡眠/PPI)
	 * - 4. 清空本地存储(boundDeviceId)
	 * - 注意:wearLocation 保留(用户偏好,与设备无关)
	 */
	async deleteDevice(): Promise<void> {
		logger.info("bluetooth", "[DEVICE] 用户删除设备");
		this.isDeletingDevice = true;
		let remoteUnbindOk = false;
		let remoteUnbindAttempted = false;

		try {
			try {
				remoteUnbindOk = await this.unbindRemoteDevice();
				remoteUnbindAttempted = true;
			} catch (e) {
				logger.warn("bluetooth", "[DEVICE] deleteDevice: 设备解绑异常,继续清理本地:", e);
			}

			// 1. 断开 BLE(删除场景不恢复绑定广播扫描)
			try {
				await this.connection.disconnectGattOnly(false);
			} catch (e) {
				logger.warn(
					"bluetooth",
					"[DEVICE] deleteDevice: disconnectGattOnly 异常,继续清理:",
					e
				);
			}

			// 2. 先清空本地绑定,避免清库期间页面/定时器继续按旧设备发请求
			this.clearAllSavedData();
			realtime.clear();

			// 3. 清空历史 DB(心率/睡眠/PPI 记录)
			try {
				await bluetoothDataManager.clearAllData();
			} catch (e) {
				logger.warn("bluetooth", "[DEVICE] deleteDevice: clearAllData 异常,继续清理:", e);
			}

			// 4. 补充:清错误信息(disconnectDevice 不清,这里兜底)
			this.errorMessage.value = "";
			if (remoteUnbindAttempted == true && remoteUnbindOk == false) {
				logger.warn("bluetooth", "[DEVICE] 设备未确认解绑，本地已删除");
			}
		} finally {
			this.isDeletingDevice = false;
			this.touchState();
		}
	}

	private async unbindRemoteDevice(): Promise<boolean> {
		const boundId = this.boundDeviceId;
		if (boundId == "") return true;
		if (this.currentDeviceId == "") {
			const connected = await this.connection.switchToConnectMode("unbind");
			if (connected == false) {
				logger.warn("bluetooth", "[DEVICE] 解绑前连接设备失败，继续删除本地");
				return false;
			}
		}
		if (this.currentDeviceId == "") {
			logger.warn("bluetooth", "[DEVICE] 解绑前连接设备失败，继续删除本地");
			return false;
		}
		if (this.beginGattTask("unbind") == false) {
			logger.warn(
				"bluetooth",
				`[DEVICE] GATT 通道忙(${this.getGattTaskName()})，跳过远端解绑`
			);
			return false;
		}
		const beforeSeq = this.event.deviceControlSeq.value;
		try {
			const ok = await this.protocol.controlDevice(1);
			if (ok == false) {
				logger.warn("bluetooth", "[DEVICE] 0x41 解绑发送失败，继续删除本地");
				return false;
			}
			return await this.waitForDeviceControlResult(beforeSeq, 1, 3000);
		} finally {
			this.endGattTask("unbind");
		}
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
		logger.warn("bluetooth", "[DEVICE] 等待 0x41 解绑响应超时，继续删除本地");
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
export type {
	DeviceSyncReason,
	DeviceSyncState,
	HistoryGap,
	HistoryGapRepairResult,
	HistoryRepairResult,
	HistorySyncPlan
} from "./sync";
