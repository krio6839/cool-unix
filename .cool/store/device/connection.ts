/**
 * BOOM 设备连接管理
 *
 * 职责：
 * - 蓝牙适配器初始化、状态监听
 * - 设备扫描：设备名前缀匹配 "BOOM-"
 * - 绑定设备广播解析 → realtime_broadcast_data，本轮状态同步到 device.realtime
 * - 静默直连（重连）+ 配对扫描（首次配对 / 直连失败后降级）
 * - 连接成功后的 GATT 流程（services 发现 → notify 启用 → 0x30 读固件 → 0x33 写时戳）
 */

import { t } from "../../locale";
import { TARGET_DEVICE_NAME_PREFIX } from "./types";
import { BOOM_GATT_SERVICE_UUID, bluetoothDataManager } from "../../bluetooth";

//#ifndef H5
import {
	openAdapter,
	startDiscovery,
	stopDiscovery,
	onDeviceFound,
	offDeviceFound,
	connect,
	disconnect,
	onConnectionStateChange,
	onAdapterStateChange
} from "../../bluetooth/kux";
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

import type { Device, ShowDevicePickerOptions } from "./index";
import { sleepTimeout } from "@/.cool/utils";

export class DeviceConnection {
	private device: Device;

	/* ===== 直连 / 扫描配置 ===== */
	private static readonly DIRECT_CONNECT_TIMEOUT_MS = 8000; // 单次直连超时
	private _isInitializingConnectedDevice: boolean = false;
	private static readonly PAIRING_SCAN_TIMEOUT_MS = 30000; // 扫描总时长
	private _scanMode: "pairing" | "reconnect" = "pairing";
	private _isSearching: boolean = false;
	private _isConnectingFoundBoundDevice: boolean = false;
	private _pairingScanTimer: number = 0;
	private _suppressNextReconnect: boolean = false;
	private _isSwitchingToBroadcastMode: boolean = false;
	private _gattBroadcastTimer: number = 0;
	private _isReadingGattBroadcast: boolean = false;

	constructor(device: Device) {
		this.device = device;
	}

	/* ===== 蓝牙适配器初始化 ===== */

	/** 打开蓝牙适配器 */
	async initBluetooth(): Promise<void> {
		console.log("开始初始化蓝牙");
		this.device.clearError();
		//#ifndef H5
		await openAdapter();
		if (this.device.boundDeviceId != "" && this.device.currentDeviceId == "") {
			await this.startBoundBroadcastMode();
		}
		//#endif
	}

	/** 订阅蓝牙适配器开关变化 */
	onBluetoothAdapterStateChange(): void {
		//#ifndef H5
		console.log("开始监听蓝牙适配器状态变化");
		onAdapterStateChange((res) => {
			console.log("蓝牙适配器状态变化:", res);
			this.device.discovering = res.discovering;
			if (this.device.available == res.available) return;
			this.device.available = res.available;
			this.device.touchState();
			if (res.available == false) {
				// 蓝牙关闭：清理状态
				console.log("蓝牙已关闭");
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("蓝牙未开启");
			} else {
				// 蓝牙开启：自动恢复（已绑定→广播扫描，未绑定→配对扫描）
				console.log("蓝牙已开启");
				if (this.device.boundDeviceId == "") {
					this.device.status.value = "PAIRING";
					this.startBluetoothSearch("pairing");
				} else if (this.device.currentDeviceId == "") {
					this.startBoundBroadcastMode();
				}
				this.device.errorMessage.value = "";
			}
		});
		//#endif
	}

	private _startPairingScan(): void {
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		this.startBluetoothSearch("reconnect");
	}

	async startBoundBroadcastMode(): Promise<boolean> {
		this.stopBluetoothSearch();
		this.device.history.stopVitalHistoryPolling();
		await this.device.broadcast.stopRealtimeScan();
		if (this.device.boundDeviceId == "") return false;
		this.device.testMode.value = "broadcast";
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		const ok = await this.device.broadcast.startBoundBroadcastScan();
		if (ok == true) {
			this.device.touchState();
		}
		return ok;
	}

	/** 标记已连接：刷新状态 + 持久化绑定 */
	private async _markConnected(deviceId: string, deviceName: string): Promise<void> {
		await this.stopBluetoothSearch();
		const boundName = this.device.boundDeviceName;
		let displayName = deviceName == "" ? boundName : deviceName;
		if (displayName == "") {
			displayName = deviceId;
		}
		this.device.currentDeviceId = deviceId;
		this.device.currentDeviceName = displayName;
		this.device.status.value = "CONNECTED";
		this.device.saveBoundDevice(deviceId, displayName);
		bluetoothDataManager.setDeviceInfo(displayName, deviceId);
		this.device.touchState();
	}

	/* ===== 设备扫描 ===== */

	/**
	 * 启动扫描
	 * - 设备名前缀匹配 "BOOM-"
	 * - 0x50 广播数据从 Manufacturer Specific Data 字段解析 → 入库并同步本轮状态
	 * @param mode pairing=配对 / reconnect=重连（仅连 boundDeviceId）
	 */
	startBluetoothSearch(mode: "pairing" | "reconnect"): void {
		this._startBluetoothSearchInternal(mode);
	}

	private async _startBluetoothSearchInternal(mode: "pairing" | "reconnect"): Promise<void> {
		console.log("[SCAN] 开始搜索 BOOM-* 设备,mode:", mode);
		//#ifndef H5
		if (this._isSearching == true) {
			console.log("[SCAN] 搜索已在进行,跳过");
			return;
		}
		this._isSearching = true;
		this._isConnectingFoundBoundDevice = false;
		this._scanMode = mode;

		try {
			// 搜索前清空旧设备列表,避免残留
			this.device.devices = [];

			// 内部 1 次自动 retry,规避 kux 库的 `if (this.scanning)` 并发守护
			let ok = await startDiscovery();
			if (ok == false) {
				console.warn("[SCAN] startDiscovery 返回 false,500ms 后重试一次");
				await sleepTimeout(500);
				ok = await startDiscovery();
			}
			if (ok == false) {
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("搜索设备失败,请检查蓝牙和位置权限");
				this._isSearching = false;
				return;
			}
			console.log("[SCAN] 开始搜索 BOOM-* 设备,mode:", mode);
			this._schedulePairingScanTimeout();

			onDeviceFound((devices) => {
				// 累计所有匹配设备,不去重(去重在 _handleFoundDevice 内部用 deviceId 判断)
				devices.forEach((d) => {
					// Nordic 设备的广播包经常只设 localName,不设 GAP name
					// 优先用 name,fallback 到 localName
					const name = d.name ?? d.localName ?? "";
					console.log("[SCAN] 发现设备:", name);
					this.device.broadcast.handleFoundDevice(d);
					if (name.startsWith(TARGET_DEVICE_NAME_PREFIX)) {
						this._handleFoundDevice(d, name);
					}
				});
			});
		} catch (e) {
			this._isSearching = false;
			throw e;
		}
		//#endif
	}

	/**
	 * 处理已发现的目标 BOOM 设备:入列表 + 按 RSSI 排序(信号最强在最前)
	 * 找到 N 个都入列表,等扫描周期结束后统一处理
	 * 连接由 _handlePairingScanTimeout 根据 _scanMode + devices.length 决定
	 */
	private _handleFoundDevice(found: DeviceInfo, name: string): void {
		console.log("[SCAN] 发现目标设备:", found.deviceId);
		this.device.cacheFoundDevice(found, name);
		console.log("[SCAN] 当前 BOOM 设备列表长度:", this.device.devices.length);

		if (this._scanMode == "reconnect" && found.deviceId == this.device.boundDeviceId) {
			this.device.saveBoundDeviceName(name);
			this._connectFoundBoundDevice(found.deviceId, name);
		}
	}

	/** 重连扫描中一旦发现绑定设备,立即停止扫描并直连 */
	private async _connectFoundBoundDevice(deviceId: string, deviceName: string): Promise<void> {
		if (this._isConnectingFoundBoundDevice == true) return;
		if (this.device.currentDeviceId != "") return;

		this._isConnectingFoundBoundDevice = true;
		console.log(`[SCAN] 重连模式发现绑定设备,立即连接: ${deviceId}`);
		await this.stopBluetoothSearch();
		this.device.devices = [];
		try {
			await this.connectToDevice(deviceId, deviceName);
		} finally {
			this._isConnectingFoundBoundDevice = false;
		}
	}

	/** 调度扫描超时定时器 */
	private _schedulePairingScanTimeout(): void {
		this._clearPairingScanTimeout();
		// @ts-ignore setTimeout 在 UTS 不同平台返回类型不一,这里用 number 容器
		this._pairingScanTimer = setTimeout(() => {
			this._handlePairingScanTimeout();
		}, DeviceConnection.PAIRING_SCAN_TIMEOUT_MS);
	}

	/** 清理扫描超时定时器 */
	private _clearPairingScanTimeout(): void {
		if (this._pairingScanTimer != 0) {
			clearTimeout(this._pairingScanTimer);
			this._pairingScanTimer = 0;
		}
	}

	/**
	 * 扫描超时处理
	 * - reconnect mode:只连 boundDeviceId,绝不连其他设备;找不到 → 提示"未找到设备"
	 * - pairing mode:0 个 → 提示"未找到设备";≥1 个 → 弹设备选择 actionSheet
	 */
	private async _handlePairingScanTimeout(): Promise<void> {
		const mode = this._scanMode;
		const count = this.device.devices.length;
		console.log(`[SCAN] 配对扫描结束,mode=${mode},共发现 ${count} 个目标设备`);
		await this.stopBluetoothSearch();

		// === 重连 mode:只连 boundDeviceId,绝不连其他设备 ===
		if (mode == "reconnect") {
			const bound = this.device.findCachedDevice(this.device.boundDeviceId);
			if (bound == null) {
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("未找到设备,请确认设备已开机且在范围内");
				return;
			}
			const displayName = bound.name ?? bound.localName ?? "";
			console.log(`[SCAN] 重连模式,自动连接绑定设备: ${bound.deviceId}`);
			this.device.devices = [];
			this.connectToDevice(bound.deviceId, displayName);
			return;
		}

		// === 配对 mode:0/1/2+ 标准流程 ===
		if (count == 0) {
			this.device.status.value = "UNPAIRED";
			this.device.errorMessage.value = t("未找到设备,请确认设备已开机且在范围内");
			return;
		}

		// 直接弹 actionSheet 让用户选择
		console.log(`[SCAN] 发现 ${count} 个设备,直接弹窗让用户选择`);
		const pickerOptions: ShowDevicePickerOptions = {
			onSelect: (deviceId: string, _device: DeviceInfo) => {
				console.log(`[SCAN] 用户选择连接: ${deviceId}`);
				this.connectToFoundDevice(deviceId);
			},
			onCancel: () => {
				console.log(`[SCAN] 用户取消,降级为未配对`);
				this.device.devices = [];
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("已取消,请重新配对");
			}
		};
		this.device.showDevicePicker(pickerOptions);
	}

	/** 停止扫描 + 清理定时器 */
	stopBluetoothSearch(): void {
		//#ifndef H5
		this._clearPairingScanTimeout();
		stopDiscovery();
		offDeviceFound();
		this._isSearching = false;
		this.device.broadcast.markScanStopped();
		//#endif
	}

	/* ===== 连接 / 断开 ===== */

	/**
	 * 连接设备
	 * @param deviceId 蓝牙 deviceId
	 * @param deviceName 可选 UI 展示名
	 */
	async connectToDevice(deviceId: string, deviceName?: string): Promise<void> {
		const ok = await this.connectToDeviceWithTimeout(deviceId, deviceName ?? "", 100000);
		if (ok == false) {
			this.device.status.value = "PAIRING";
		}
	}

	private async connectToDeviceWithTimeout(
		deviceId: string,
		deviceName: string,
		timeoutMs: number
	): Promise<boolean> {
		this.device.status.value = "SEARCHING";
		//#ifndef H5
		const ok = await connect(deviceId, timeoutMs);
		if (ok == false) {
			return false;
		}
		console.log("连接设备成功:", deviceId);
		//#endif
		await this._markConnected(deviceId, deviceName);
		if (this.device.isDeviceInitialized == false) {
			await this._initializeConnectedDevice(deviceId);
		}
		console.log("设备连接状态:", this.device.status.value);
		return true;
	}

	/** 从广播模式临时切到 GATT 连接模式：先直连绑定设备，失败再扫描重连 */
	async connectBoundDeviceForGatt(): Promise<boolean> {
		const boundId = this.device.boundDeviceId;
		if (boundId == "") return false;
		await this.device.broadcast.stopBoundBroadcastScan();
		await this.device.broadcast.stopRealtimeScan();
		this.stopBluetoothSearch();
		this.device.testMode.value = "connect";
		if (this.device.currentDeviceId != "") return true;

		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";

		//#ifndef H5
		let connectId = boundId;
		let connectName = this.device.getDisplayDeviceName();
		const cached = this.device.findCachedDevice(boundId);
		if (cached != null) {
			connectId = cached.deviceId;
			connectName = cached.name ?? cached.localName ?? connectName;
		}
		console.log("[BOOM] 连接模式直连绑定设备:", connectId);
		const ok = await this.connectToDeviceWithTimeout(
			connectId,
			connectName,
			DeviceConnection.DIRECT_CONNECT_TIMEOUT_MS
		);
		if (ok == true) {
			return true;
		}
		console.warn("[BOOM] 连接模式直连失败，改为扫描绑定设备");
		this.startBluetoothSearch("reconnect");
		//#endif

		return false;
	}

	private async _initializeConnectedDevice(deviceId: string): Promise<void> {
		if (this._isInitializingConnectedDevice == true) return;
		this._isInitializingConnectedDevice = true;
		this.device.isDeviceInitialized = true;
		try {
			await this.afterConnected(deviceId);
		} catch (e) {
			console.error("[BOOM] 连接后初始化失败:", e);
			this.device.isDeviceInitialized = false;
			this.device.touchState();
		} finally {
			this._isInitializingConnectedDevice = false;
		}
	}

	/**
	 * 连接成功后的 BOOM GATT 流程：
	 * 1. 获取 services + characteristics，校验是否含 BOOM GATT Service
	 * 2. 启用 notify
	 * 3. 读固件版本（0x30）→ 写时戳（0x33）→ 读回时戳（0x34）
	 */
	private async afterConnected(deviceId: string): Promise<void> {
		try {
			if (this.device.currentDeviceId != deviceId) {
				this.device.currentDeviceId = deviceId;
				if (this.device.currentDeviceName == "") {
					this.device.currentDeviceName = this.device.getDisplayDeviceName();
				}
				this.device.saveBoundDevice(deviceId, this.device.currentDeviceName);
				bluetoothDataManager.setDeviceInfo(this.device.currentDeviceName, deviceId);
				this.device.touchState();
			}

			await this.device.protocol.getDeviceServicesAndCharacteristics(deviceId);
			console.log("获取设备服务和特征值成功");

			// 校验 BOOM GATT Service
			let hasBoom = false;
			for (let i = 0; i < this.device.protocol.services.length; i++) {
				const s = this.device.protocol.services[i];
				if (s == null) continue;
				if (s.uuid.toLowerCase() == BOOM_GATT_SERVICE_UUID.toLowerCase()) {
					hasBoom = true;
					break;
				}
			}
			if (hasBoom == false) {
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("非 BOOM 设备，请检查");
				return;
			}

			await this.device.protocol.enableNotify();

			// 读固件 → 写时戳 → 读回时戳
			await sleepTimeout(200);
			await this.device.protocol.readFirmwareVersion();
			await sleepTimeout(300);
			await this.device.protocol.setTimestamp(Math.floor(Date.now() / 1000));
			await sleepTimeout(300);
			const beforeTimestampSeq = this.device.event.boomTimestampSeqValue;
			await this.device.protocol.readTimestamp();
			const timestampOk = await this._waitForBoomTimestampResponse(beforeTimestampSeq, 3000);
			if (timestampOk == false) {
				console.warn("[BOOM] 等待读时戳响应超时，延迟后继续启动历史自动补拉");
				await sleepTimeout(2500);
			}

			this.device.status.value = "CONNECTED";
			this.device.touchState();
			this.startGattBroadcastPolling();
		} catch (e) {
			console.error("[BOOM] afterConnected 流程异常:", e);
			throw e;
		}
	}

	private async _waitForBoomTimestampResponse(
		beforeSeq: number,
		timeoutMs: number
	): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.device.event.boomTimestampSeqValue > beforeSeq) {
				console.log(
					`[BOOM] 已收到读时戳响应: t=0x${this.device.event.boomTimestampLastT.toString(16)}, boomTimestamp=${this.device.event.boomTimestamp.value}`
				);
				return true;
			}
			await sleepTimeout(120);
		}
		return false;
	}

	private startGattBroadcastPolling(): void {
		if (this.device.gattBroadcastPollingEnabled.value == false) return;
		this.stopGattBroadcastPolling();
		this.readGattBroadcastOnce();
		// @ts-ignore setInterval 在 UTS 不同平台返回类型不一
		this._gattBroadcastTimer = setInterval(() => {
			this.readGattBroadcastOnce();
		}, 1000);
		console.log("[BOOM-ADV] 已启动 GATT 0x50 轮询");
	}

	private stopGattBroadcastPolling(): void {
		if (this._gattBroadcastTimer != 0) {
			clearInterval(this._gattBroadcastTimer);
			this._gattBroadcastTimer = 0;
			console.log("[BOOM-ADV] 已停止 GATT 0x50 轮询");
		}
		this._isReadingGattBroadcast = false;
	}

	private async readGattBroadcastOnce(): Promise<void> {
		if (this._isReadingGattBroadcast == true) return;
		if (this.device.gattBroadcastPollingEnabled.value == false) return;
		if (this.device.status.value != "CONNECTED") return;
		if (this.device.protocol.writeCharUuid == "") return;
		this._isReadingGattBroadcast = true;
		try {
			const ok = await this.device.protocol.readBroadcastData();
			if (ok == false) {
				console.warn("[BOOM-ADV] GATT 0x50 发送失败");
			}
		} catch (e) {
			console.warn("[BOOM-ADV] GATT 0x50 读取异常:", e);
		} finally {
			this._isReadingGattBroadcast = false;
		}
	}

	setGattBroadcastPollingEnabled(enabled: boolean): void {
		this.device.gattBroadcastPollingEnabled.value = enabled;
		if (enabled == true) {
			this.startGattBroadcastPolling();
		} else {
			this.stopGattBroadcastPolling();
		}
		this.device.touchState();
	}

	/** 订阅 GATT 连接状态变化 */
	onBLEConnectionStateChange(): void {
		//#ifndef H5
		onConnectionStateChange((res) => {
			console.log("蓝牙连接状态变化:", res);
			if (res.connected) {
				if (
					this.device.isDeviceInitialized &&
					this.device.protocol.writeCharUuid != "" &&
					this.device.protocol.notifyCharUuid != ""
				) {
					console.log("设备已初始化，跳过");
					return;
				}
				console.log("设备已连接:", res.deviceId);
				this._initializeConnectedDevice(res.deviceId);
				this.device.resetReconnectState();
			} else {
				if (res.deviceId == this.device.currentDeviceId) {
					console.log("设备已断开:", res.deviceId);
					this.device.status.value = "UNPAIRED";
					this.device.currentDeviceId = "";
					this.device.isDeviceInitialized = false;
					if (
						this._suppressNextReconnect == true ||
						this._isSwitchingToBroadcastMode == true
					) {
						console.log("[BOOM] 本次断开由广播模式触发，跳过自动重连");
						return;
					}
					this.startBoundBroadcastMode();
				}
			}
		});
		//#endif
	}

	/**
	 * 用户从设备列表（actionSheet）点选某个设备后，启动连接
	 */
	public connectToFoundDevice(deviceId: string): void {
		const found = this.device.findCachedDevice(deviceId);
		if (found == null) {
			console.warn("[SCAN] 设备列表中找不到 deviceId:", deviceId);
			return;
		}
		const displayName = found.name ?? found.localName ?? "";
		this.connectToDevice(deviceId, displayName);
	}

	/** 主动断开当前设备 */
	async disconnectDevice(): Promise<void> {
		this.stopBluetoothSearch();
		//#ifndef H5
		if (this.device.currentDeviceId != "") {
			await disconnect(this.device.currentDeviceId);
		}
		//#endif
		this._resetConnectionState();
	}

	/** 切换到广播测试模式时断开 GATT，但保留 boundDeviceId 且不触发自动重连 */
	async disconnectForBroadcastMode(): Promise<void> {
		if (this._isSwitchingToBroadcastMode == true) {
			console.log("[BOOM] 正在切换广播模式，跳过重复请求");
			return;
		}
		this._isSwitchingToBroadcastMode = true;
		try {
			this.stopBluetoothSearch();
			this.stopGattBroadcastPolling();
			this.device.history.stopVitalHistoryPolling();
			await this.device.broadcast.stopRealtimeScan();
			await this.device.broadcast.stopBoundBroadcastScan();
			//#ifndef H5
			if (this.device.currentDeviceId != "") {
				this._suppressNextReconnect = true;
				await disconnect(this.device.currentDeviceId);
				await sleepTimeout(350);
			}
			//#endif
			this._suppressNextReconnect = false;
			this._resetConnectionState();
			await sleepTimeout(120);
			await this.startBoundBroadcastMode();
		} finally {
			this._suppressNextReconnect = false;
			this._isSwitchingToBroadcastMode = false;
		}
	}

	/** 内部：清空连接相关字段 */
	_resetConnectionState(): void {
		this.stopGattBroadcastPolling();
		this.device.broadcast.stopRealtimeScan();
		this.device.broadcast.stopBoundBroadcastScan();
		this.device.history.stopVitalHistoryPolling();
		this.device.status.value = "UNPAIRED";
		this.device.currentDeviceId = "";
		this.device.currentDeviceName = "";
		this.device.isDeviceInitialized = false;
		this.device.protocol.services = [];
		this.device.protocol.characteristics.clear();
		this.device.protocol.writeCharUuid = "";
		this.device.protocol.notifyCharUuid = "";
		this.device.realtime.value = null;
		bluetoothDataManager.clearDeviceInfo();
		this.device.resetReconnectState();
		this.device.touchState();
	}

	/** 内部：重连策略（指数退避，由 device.maxReconnectAttempts 控制次数） */
	reconnect(): void {
		console.log("开始重连设备");
		if (this.device.isReconnecting) {
			console.log("正在重连中，跳过");
			return;
		}
		if (this.device.reconnectAttempts >= this.device.maxReconnectAttempts) {
			console.log("重连次数达到上限，停止重连");
			return;
		}
		if (this.device.boundDeviceId == "") {
			console.log("没有绑定设备ID，无法重连");
			return;
		}

		this.device.isReconnecting = true;
		this.device.reconnectAttempts++;

		const currentInterval = this.device.reconnectInterval * this.device.reconnectAttempts;
		console.log(`开始第 ${this.device.reconnectAttempts} 次重连，间隔 ${currentInterval}ms`);

		setTimeout(() => {
			console.log("执行扫描重连操作");
			this._startPairingScan();
			this.device.isReconnecting = false;
			console.log("重连操作完成");
		}, currentInterval);
	}

	/** 弹设备选择 actionSheet（直接复用 Device 实例方法） */
	showDevicePicker(options: ShowDevicePickerOptions): void {
		this.device.showDevicePicker(options);
	}
}
