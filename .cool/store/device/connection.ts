/**
 * BOOM 设备连接管理
 *
 * 职责：
 * - 蓝牙适配器初始化、状态监听
 * - 设备扫描：设备名前缀匹配 "BOOM-"
 * - 绑定设备广播解析 → realtime_broadcast_data，本轮状态同步到 device.realtime
 * - GATT 临时直连 + 配对扫描（首次配对）
 * - 连接成功后的 GATT 流程（services 发现 → notify 启用）
 */

import { t } from "../../locale";
import { TARGET_DEVICE_NAME_PREFIX } from "./types/wear-location";
import type { ConnectModeReason, ScanPurpose } from "./types/device-state-types";
import { BOOM_GATT_SERVICE_UUID, bluetoothDataManager } from "../../bluetooth";

//#ifndef H5
import {
	openAdapter,
	closeAdapter,
	startDiscovery,
	stopDiscovery,
	onDeviceFound,
	offDeviceFound,
	recreateKuxBluetooth,
	connect,
	disconnect,
	onConnectionStateChange,
	onAdapterStateChange
} from "../../bluetooth/kux";
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

import type { Device, ShowDevicePickerOptions } from "./index";
import { sleepTimeout } from "@/.cool/utils";
import { logger } from "../../service/logger";

export class DeviceConnection {
	private device: Device;

	/* ===== 直连 / 扫描配置 ===== */
	/** 绑定设备临时 GATT 直连最多等 8 秒；更长会让队列任务和广播恢复显得卡顿。 */
	private static readonly DIRECT_CONNECT_TIMEOUT_MS = 8000;
	/** 停止扫描/断开后给系统 BLE 栈一点释放时间，再重新启动绑定广播扫描。 */
	private static readonly BOUND_BROADCAST_RESTART_DELAY_MS = 600;
	/** startDiscovery 系统异常时才重建适配器，15 秒内只允许一次，避免恢复逻辑自身打架。 */
	private static readonly SCAN_HARD_RECOVERY_COOLDOWN_MS = 15000;
	/** 首次配对扫描窗口：期间发现设备会先弹窗，扫描继续累计到 30 秒。 */
	private static readonly PAIRING_SCAN_TIMEOUT_MS = 30000;
	private _isInitializingBluetooth: boolean = false;
	private _initBluetoothPromise: Promise<void> | null = null;
	private _isInitializingConnectedDevice: boolean = false;
	private _initializeConnectedDevicePromise: Promise<boolean> | null = null;
	private _scanPurpose: ScanPurpose = "none";
	private _isSearching: boolean = false;
	private _adapterStateListening: boolean = false;
	private _connectionStateListening: boolean = false;
	private _adapterResetting: boolean = false;
	private _scanHardRecovering: boolean = false;
	private _lastScanHardRecoverAt: number = 0;
	private _pairingScanTimer: number = 0;
	private _broadcastScanRecoverTimer: number = 0;
	private _pairingPickerVisible: boolean = false;
	private _ignoreConnectionStateChange: boolean = false;
	private _isSwitchingToBroadcastMode: boolean = false;

	constructor(device: Device) {
		this.device = device;
	}

	/* ===== 蓝牙适配器初始化 ===== */

	/** 打开蓝牙适配器 */
	async initBluetooth(): Promise<void> {
		if (this._isInitializingBluetooth == true) {
			if (this._initBluetoothPromise != null) {
				return await this._initBluetoothPromise;
			}
			return;
		}
		this._isInitializingBluetooth = true;
		const promise = this.runInitBluetooth();
		this._initBluetoothPromise = promise;
		try {
			await promise;
		} finally {
			this._isInitializingBluetooth = false;
			this._initBluetoothPromise = null;
		}
	}

	private async runInitBluetooth(): Promise<void> {
		logger.info("bluetooth", "开始初始化蓝牙");
		this.device.clearError();
		//#ifndef H5
		await openAdapter();
		if (this.device.boundDeviceId != "" && this.device.currentDeviceId == "") {
			await this.startBoundBroadcastScan();
		}
		//#endif
	}

	initBluetoothSafely(): void {
		this.initBluetooth().catch((e) => {
			logger.error("bluetooth", "[BOOM] 初始化蓝牙失败:", e);
		});
	}

	/** 订阅蓝牙适配器开关变化 */
	onBluetoothAdapterStateChange(force: boolean = false): void {
		//#ifndef H5
		if (this._adapterStateListening == true && force == false) return;
		this._adapterStateListening = true;
		logger.info("bluetooth", "开始监听蓝牙适配器状态变化");
		onAdapterStateChange((res) => {
			logger.info(
				"bluetooth",
				"蓝牙适配器状态变化",
				`available=${res.available}, discovering=${res.discovering}`
			);
			this.device.discovering = res.discovering;
			if (this.device.available == res.available) return;
			this.device.available = res.available;
			this.device.touchState();
			if (res.available == false) {
				// 蓝牙关闭：清理状态
				logger.warn("bluetooth", "蓝牙已关闭");
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("蓝牙未开启");
			} else {
				// 蓝牙开启：只自动恢复已绑定设备的广播扫描；未绑定时等待用户主动开始配对
				logger.info("bluetooth", "蓝牙已开启");
				if (this._adapterResetting == true) {
					logger.info("bluetooth", "[SCAN] 适配器重置中，跳过状态回调自动扫描");
					this.device.errorMessage.value = "";
					return;
				}
				if (this.device.boundDeviceId == "") {
					this.device.status.value = "UNPAIRED";
					this.device.touchState();
				} else if (this.device.isDeletingDevice == true) {
					logger.info("bluetooth", "[DEVICE] 删除设备中，跳过蓝牙开启后的自动扫描");
				} else if (this.device.currentDeviceId == "") {
					this.startBoundBroadcastScanSafely("adapter available");
				}
				this.device.errorMessage.value = "";
			}
		});
		//#endif
	}

	async switchToBroadcastMode(readRecentVital: boolean = true): Promise<boolean> {
		if (this._isSwitchingToBroadcastMode == true) {
			logger.info("bluetooth", "[BOOM] 正在切换广播模式，跳过重复请求");
			return true;
		}
		this._isSwitchingToBroadcastMode = true;
		try {
			await this.disconnectCurrentGatt(readRecentVital, 350);
			await sleepTimeout(120);
			return await this.startBoundBroadcastScan();
		} finally {
			this._ignoreConnectionStateChange = false;
			this._isSwitchingToBroadcastMode = false;
		}
	}

	async disconnectGattOnly(readRecentVital: boolean = true): Promise<void> {
		await this.disconnectCurrentGatt(readRecentVital, 350);
	}

	/** GATT 任务结束统一出口：先补最近历史，再静默断开，最后回到广播主流程。 */
	private async disconnectCurrentGatt(readRecentVital: boolean, settleMs: number): Promise<void> {
		try {
			await this.stopBluetoothSearch();
			if (readRecentVital == true) {
				await this.readRecentVitalBeforeDisconnect();
			}
			await this.disconnectCurrentDeviceSilently(settleMs);
			this._resetConnectionState();
		} finally {
			this._ignoreConnectionStateChange = false;
		}
	}

	/** 主动断开时忽略系统连接回调，避免回调里把广播恢复/重连流程抢跑。 */
	private async disconnectCurrentDeviceSilently(settleMs: number): Promise<void> {
		//#ifndef H5
		if (this.device.currentDeviceId == "") return;
		this._ignoreConnectionStateChange = true;
		await disconnect(this.device.currentDeviceId);
		if (settleMs > 0) {
			await sleepTimeout(settleMs);
		}
		//#endif
	}

	/** 断开前用 0x3A 补最近窗口，弥补 GATT 任务期间收不到广播造成的秒级缺口。 */
	private async readRecentVitalBeforeDisconnect(): Promise<void> {
		if (this.device.currentDeviceId == "") return;
		if (this.device.status.value != "CONNECTED") return;
		if (this.isProtocolReady() == false) return;
		try {
			const result = await this.device.history.readRecentVitalWindow();
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 断开前补最近2分钟: status=${result.status}, pages=${result.pages}, saved=${result.savedRecords}, upload=${result.uploadOk}`
			);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-HISTORY] 断开前补最近2分钟失败:", e);
		}
	}

	private async startBoundBroadcastScan(): Promise<boolean> {
		if (this.device.isDeletingDevice == true) {
			logger.info("bluetooth", "[SCAN] 删除设备中，跳过绑定广播扫描");
			return false;
		}
		if (this._isSearching == true && this._scanPurpose == "boundBroadcast") {
			logger.info("bluetooth", "[SCAN] 绑定广播扫描已在进行,跳过重复启动");
			return true;
		}
		await this.stopBluetoothSearch();
		if (this.device.boundDeviceId == "") return false;
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		const deviceName = this.device.getDisplayDeviceName();
		bluetoothDataManager.setDeviceInfo(deviceName, this.device.boundDeviceId);
		const ok = await this.startScan("boundBroadcast");
		if (ok == true) {
			this.device.touchState();
		}
		return ok;
	}

	private startBoundBroadcastScanSafely(reason: string): void {
		this.startBoundBroadcastScan().catch((e) => {
			logger.error("bluetooth", `[SCAN] 恢复绑定广播扫描失败: ${reason}`, e);
		});
	}

	private recoverBoundBroadcastAfterDisconnectDeferred(reason: string): void {
		if (this._broadcastScanRecoverTimer != 0) return;
		// 断连回调可能和 Vue 当前 UI flush 同帧发生，延后状态重置/恢复扫描可降低框架队列并发风险。
		// @ts-ignore setTimeout 在 UTS 不同平台返回类型不一,这里用 number 容器
		this._broadcastScanRecoverTimer = setTimeout(() => {
			this._broadcastScanRecoverTimer = 0;
			this._resetConnectionState();
			this.startBoundBroadcastScanSafely(reason);
		}, 250);
	}

	async restartBoundBroadcastScan(reason: string, hardRecover: boolean): Promise<boolean> {
		logger.warn("bluetooth", `[SCAN] 重启绑定广播扫描: ${reason}, hardRecover=${hardRecover}`);
		await this.stopBluetoothSearch();
		if (hardRecover == true) {
			await this.resetAdapterBeforeBroadcastScan(reason);
		}
		await sleepTimeout(DeviceConnection.BOUND_BROADCAST_RESTART_DELAY_MS);
		return await this.startBoundBroadcastScan();
	}

	/** 广播扫描连续异常时由 broadcast 模块决定是否升级到适配器重建。 */
	private async resetAdapterBeforeBroadcastScan(reason: string): Promise<void> {
		//#ifndef H5
		try {
			this._adapterResetting = true;
			logger.warn("bluetooth", `[SCAN] 重建蓝牙扫描栈: ${reason}`);
			await closeAdapter();
			recreateKuxBluetooth(reason);
			this._adapterStateListening = false;
			this._connectionStateListening = false;
			this.device.event.resetKuxListener();
			this.onBluetoothAdapterStateChange(true);
			this.onBLEConnectionStateChange(true);
			this.device.event.onCharacteristicValueChange(true);
			await sleepTimeout(500);
			await openAdapter();
			this.device.available = true;
			this.device.discovering = false;
			this.device.touchState();
		} catch (e) {
			logger.warn("bluetooth", "[SCAN] 重建蓝牙扫描栈失败:", e);
		} finally {
			this._adapterResetting = false;
		}
		//#endif
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
	 * - pairing: 首次配对，展示所有 BOOM 设备
	 * - boundBroadcast: 已绑定设备广播扫描，只解析绑定设备 0x50
	 */
	startPairingScan(): Promise<boolean> {
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		return this.startScan("pairing");
	}

	private async startScan(purpose: ScanPurpose): Promise<boolean> {
		if (purpose == "none") return false;
		logger.info("bluetooth", "[SCAN] 开始扫描", `purpose=${purpose}`);
		//#ifndef H5
		if (this._isSearching == true) {
			if (this._scanPurpose == purpose) {
				logger.info("bluetooth", "[SCAN] 当前扫描已在进行,跳过");
				return true;
			}
			await this.stopBluetoothSearch();
		}
		this._isSearching = true;
		this._scanPurpose = purpose;
		this.device.broadcast.setBoundBroadcastScanning(purpose == "boundBroadcast");

		try {
			if (purpose != "boundBroadcast") {
				// 搜索前清空旧设备列表,避免残留
				this.device.devices = [];
				this._pairingPickerVisible = false;
			}

			offDeviceFound();
			onDeviceFound((devices) => {
				this.handleScannedDevices(devices);
			});

			const scanDeviceId = this.getScanFilterDeviceId(purpose);
			// 内部 1 次自动 retry,规避 kux 库的 `if (this.scanning)` 并发守护
			let ok = await startDiscovery(scanDeviceId);
			if (ok == false) {
				logger.warn("bluetooth", "[SCAN] startDiscovery 返回 false,500ms 后重试一次");
				await sleepTimeout(500);
				ok = await startDiscovery(scanDeviceId);
			}
			if (ok == false) {
				ok = await this.hardRecoverAndStartScan(purpose, "startDiscovery failed");
			}
			if (ok == false) {
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("搜索设备失败,请检查蓝牙和位置权限");
				this.markScanIdle();
				offDeviceFound();
				logger.error("bluetooth", "[SCAN] 扫描启动失败", `purpose=${purpose}`);
				return false;
			}
			logger.info("bluetooth", "[SCAN] 扫描已启动", `purpose=${purpose}`);
			if (purpose != "boundBroadcast") {
				this._schedulePairingScanTimeout();
			}

			return true;
		} catch (e) {
			this.markScanIdle();
			offDeviceFound();
			logger.error("bluetooth", "[SCAN] 扫描异常", `${e}`);
			throw e;
		}
		//#endif
		return false;
	}

	private async hardRecoverAndStartScan(purpose: ScanPurpose, reason: string): Promise<boolean> {
		//#ifndef H5
		if (this._scanHardRecovering == true) return false;
		const now = Date.now();
		if (
			this._lastScanHardRecoverAt > 0 &&
			now - this._lastScanHardRecoverAt < DeviceConnection.SCAN_HARD_RECOVERY_COOLDOWN_MS
		) {
			logger.warn("bluetooth", `[SCAN] 硬恢复冷却中，跳过: purpose=${purpose}`);
			return false;
		}
		this._scanHardRecovering = true;
		this._lastScanHardRecoverAt = now;
		try {
			logger.warn("bluetooth", `[SCAN] 扫描启动失败，执行硬恢复: ${reason}`);
			this._clearPairingScanTimeout();
			await stopDiscovery();
			offDeviceFound();
			this._isSearching = false;
			this._scanPurpose = "none";
			this.device.broadcast.markScanStopped();
			await this.resetAdapterBeforeBroadcastScan(reason);
			await sleepTimeout(DeviceConnection.BOUND_BROADCAST_RESTART_DELAY_MS);

			this._isSearching = true;
			this._scanPurpose = purpose;
			this.device.broadcast.setBoundBroadcastScanning(purpose == "boundBroadcast");
			offDeviceFound();
			onDeviceFound((devices) => {
				this.handleScannedDevices(devices);
			});
			const ok = await startDiscovery(this.getScanFilterDeviceId(purpose));
			if (ok == true) {
				logger.info("bluetooth", `[SCAN] 硬恢复后扫描已启动,purpose=${purpose}`);
				return true;
			}
			this.markScanIdle();
			offDeviceFound();
			return false;
		} finally {
			this._scanHardRecovering = false;
		}
		//#endif
		return false;
	}

	private getScanFilterDeviceId(purpose: ScanPurpose): string {
		if (purpose != "boundBroadcast") return "";
		return this.device.boundDeviceId;
	}

	private handleScannedDevices(devices: DeviceInfo[]): void {
		//#ifndef H5
		if (this._scanPurpose == "boundBroadcast") {
			this.device.broadcast.handleBoundDeviceList(devices);
			return;
		}

		// 累计所有匹配设备,不去重(去重在 _handleFoundDevice 内部用 deviceId 判断)
		devices.forEach((d) => {
			// Nordic 设备的广播包经常只设 localName,不设 GAP name
			// 优先用 name,fallback 到 localName
			const name = d.name ?? d.localName ?? "";
			if (name.startsWith(TARGET_DEVICE_NAME_PREFIX)) {
				this._handleFoundDevice(d, name);
			}
		});
		//#endif
	}

	/**
	 * 处理已发现的目标 BOOM 设备:入列表 + 按 RSSI 排序(信号最强在最前)。
	 * 配对扫描首次发现目标设备就弹列表，扫描继续跑到超时/用户选择/用户取消。
	 */
	private _handleFoundDevice(found: DeviceInfo, name: string): void {
		logger.info(
			"bluetooth",
			"[SCAN] 发现目标设备",
			`${name}/${found.deviceId}/RSSI=${found.RSSI}`
		);
		const beforeCount = this.device.devices.length;
		this.device.cacheFoundDevice(found, name);
		logger.info("bluetooth", "[SCAN] 当前 BOOM 设备列表长度:", this.device.devices.length);
		if (this._scanPurpose == "pairing" && this.device.devices.length > 0) {
			this.showPairingPickerDuringScan();
		}
		if (this._pairingPickerVisible == true && beforeCount != this.device.devices.length) {
			logger.info(
				"bluetooth",
				`[SCAN] 配对扫描继续累计设备: count=${this.device.devices.length}`
			);
		}
	}

	private showPairingPickerDuringScan(): void {
		if (this._pairingPickerVisible == true) return;
		logger.info("bluetooth", "[SCAN] 首次发现目标设备,立即弹窗并继续扫描");
		this._pairingPickerVisible = true;
		this.openPairingDevicePicker();
	}

	private openPairingDevicePicker(): void {
		const pickerOptions: ShowDevicePickerOptions = {
			description: t("搜索仍在继续，连接或取消会停止搜索；超时后会显示最终列表"),
			onSelect: (deviceId: string, _device: DeviceInfo) => {
				logger.info("bluetooth", `[SCAN] 用户选择连接: ${deviceId}`);
				this.connectToFoundDevice(deviceId);
			},
			onCancel: () => {
				logger.info("bluetooth", "[SCAN] 用户取消,停止配对扫描并降级为未配对");
				this.cancelPairingScan();
			}
		};
		this.device.showDevicePicker(pickerOptions);
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
	 * - pairing mode:0 个 → 提示"未找到设备";≥1 个 → 弹设备选择 actionSheet
	 */
	private async _handlePairingScanTimeout(): Promise<void> {
		const mode = this._scanPurpose;
		const count = this.device.devices.length;
		logger.info("bluetooth", `[SCAN] 配对扫描结束,mode=${mode},共发现 ${count} 个目标设备`);
		await this.stopBluetoothSearch();

		// === 配对 mode:0/1/2+ 标准流程 ===
		if (count == 0) {
			this.device.status.value = "UNPAIRED";
			this.device.errorMessage.value = t("未找到设备,请确认设备已开机且在范围内");
			return;
		}

		this.device.status.value = "PAIRING";
		this.device.touchState();
		if (this._pairingPickerVisible == true) {
			logger.info("bluetooth", `[SCAN] 扫描超时，刷新最终设备列表: ${count}`);
			this.openPairingDevicePicker();
			return;
		}
		logger.info("bluetooth", `[SCAN] 扫描超时发现 ${count} 个设备,补弹窗让用户选择`);
		this._pairingPickerVisible = true;
		this.openPairingDevicePicker();
	}

	/** 停止扫描 + 清理定时器 */
	async stopBluetoothSearch(): Promise<void> {
		//#ifndef H5
		this._clearPairingScanTimeout();
		await stopDiscovery();
		offDeviceFound();
		this.markScanIdle();
		//#endif
	}

	/** 底层扫描生命周期只在 connection 收口，页面和 broadcast 不直接改扫描状态。 */
	private markScanIdle(): void {
		this._isSearching = false;
		this._scanPurpose = "none";
		this.device.broadcast.markScanStopped();
	}

	private cancelPairingScan(): void {
		this.stopBluetoothSearch().catch((e) => {
			logger.warn("bluetooth", "[SCAN] 用户取消时停止扫描失败:", e);
		});
		this._pairingPickerVisible = false;
		this.device.devices = [];
		this.device.status.value = "UNPAIRED";
		this.device.errorMessage.value = t("已取消,请重新配对");
		this.device.touchState();
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
		logger.info("bluetooth", "[BOOM] 开始连接设备", `${deviceId}, timeout=${timeoutMs}`);
		//#ifndef H5
		const ok = await connect(deviceId, timeoutMs);
		if (ok == false) {
			logger.error("bluetooth", "[BOOM] 连接设备失败", deviceId);
			return false;
		}
		logger.info("bluetooth", "连接设备成功", deviceId);
		//#endif
		await this._markConnected(deviceId, deviceName);
		const initialized = await this._initializeConnectedDevice(deviceId);
		if (initialized == false || this.isProtocolReady() == false) {
			logger.error("bluetooth", "[BOOM] 连接初始化未完成", deviceId);
			//#ifndef H5
			this._ignoreConnectionStateChange = true;
			await disconnect(deviceId);
			this._ignoreConnectionStateChange = false;
			//#endif
			this._resetConnectionState();
			return false;
		}
		logger.info("bluetooth", "设备连接状态", this.device.status.value);
		return true;
	}

	/** 从广播模式临时切到 GATT 连接模式：只直连绑定设备，失败后恢复广播 */
	async switchToConnectMode(reason: ConnectModeReason): Promise<boolean> {
		const boundId = this.device.boundDeviceId;
		logger.info("bluetooth", `[BOOM] 切换连接模式: reason=${reason}, bound=${boundId}`);
		if (boundId == "") return false;
		await this.stopBluetoothSearch();
		if (this.device.currentDeviceId != "") {
			logger.info(
				"bluetooth",
				`[BOOM] 已有连接，重新校验 GATT 通道: ${this.device.currentDeviceId}`
			);
			const initialized = await this._initializeConnectedDevice(this.device.currentDeviceId);
			if (initialized == true && this.isProtocolReady() == true) return true;
			logger.warn("bluetooth", "[BOOM] 现有连接 GATT 不可用，断开后重新连接");
			await this.disconnectStaleConnection();
		}

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
		logger.info("bluetooth", "[BOOM] 连接模式直连绑定设备:", connectId);
		const ok = await this.connectToDeviceWithTimeout(
			connectId,
			connectName,
			DeviceConnection.DIRECT_CONNECT_TIMEOUT_MS
		);
		if (ok == true) {
			return true;
		}
		logger.warn("bluetooth", "[BOOM] 连接模式直连失败，任务本轮结束并恢复广播");
		this._resetConnectionState();
		await this.startBoundBroadcastScan();
		return false;
		//#endif

		return false;
	}

	private async disconnectStaleConnection(): Promise<void> {
		try {
			await this.disconnectCurrentDeviceSilently(0);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM] 断开失效 GATT 连接失败:", e);
		} finally {
			this._ignoreConnectionStateChange = false;
		}
		this._resetConnectionState();
	}

	private async _initializeConnectedDevice(deviceId: string): Promise<boolean> {
		if (this._isInitializingConnectedDevice == true) {
			if (this._initializeConnectedDevicePromise != null) {
				return await this._initializeConnectedDevicePromise;
			}
			return this.isProtocolReady();
		}
		this._isInitializingConnectedDevice = true;
		this.device.isDeviceInitialized = false;
		const promise = this.runConnectedDeviceInitialization(deviceId);
		this._initializeConnectedDevicePromise = promise;
		const result = await promise;
		return result;
	}

	private async runConnectedDeviceInitialization(deviceId: string): Promise<boolean> {
		try {
			await this.afterConnected(deviceId);
			const ready = this.isProtocolReady();
			this.device.isDeviceInitialized = ready;
			this.device.touchState();
			return ready;
		} catch (e) {
			logger.error("bluetooth", "[BOOM] 连接后初始化失败:", e);
			this.device.isDeviceInitialized = false;
			this.device.touchState();
			return false;
		} finally {
			this._isInitializingConnectedDevice = false;
			this._initializeConnectedDevicePromise = null;
		}
	}

	private isProtocolReady(): boolean {
		return (
			this.device.currentDeviceId != "" &&
			this.device.protocol.writeCharUuid != "" &&
			this.device.protocol.notifyCharUuid != ""
		);
	}

	/**
	 * 连接成功后的 BOOM GATT 流程：
	 * 1. 获取 services + characteristics，校验是否含 BOOM GATT Service
	 * 2. 启用 notify
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
			logger.info(
				"bluetooth",
				"获取设备服务和特征值成功",
				`services=${this.device.protocol.services.length}, write=${this.device.protocol.writeCharUuid}, notify=${this.device.protocol.notifyCharUuid}`
			);

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
				logger.error("bluetooth", "非 BOOM 设备，请检查", deviceId);
				return;
			}

			await this.device.protocol.enableNotify();
			await sleepTimeout(200);

			this.device.status.value = "CONNECTED";
			this.device.touchState();
		} catch (e) {
			logger.error("bluetooth", "[BOOM] afterConnected 流程异常", `${e}`);
			throw e;
		}
	}

	/** 订阅 GATT 连接状态变化 */
	onBLEConnectionStateChange(force: boolean = false): void {
		//#ifndef H5
		if (this._connectionStateListening == true && force == false) return;
		this._connectionStateListening = true;
		onConnectionStateChange((res) => {
			logger.info("bluetooth", "蓝牙连接状态变化:", res);
			if (res.connected) {
				if (this.shouldIgnoreConnectedCallback(res.deviceId) == true) {
					logger.info("bluetooth", "[BOOM] 广播模式忽略连接状态回调:", res.deviceId);
					if (this.shouldDisconnectIgnoredConnectedCallback(res.deviceId) == true) {
						this.disconnectIgnoredBroadcastConnection(res.deviceId);
					}
					return;
				}
				if (
					this.device.isDeviceInitialized &&
					this.device.protocol.writeCharUuid != "" &&
					this.device.protocol.notifyCharUuid != ""
				) {
					logger.info("bluetooth", "设备已初始化，跳过");
					return;
				}
				logger.info("bluetooth", "连接状态回调: 已连接", res.deviceId);
				this.initializeConnectedDeviceSafely(res.deviceId);
			} else {
				if (res.deviceId == this.device.currentDeviceId) {
					logger.warn("bluetooth", "连接状态回调: 已断开", res.deviceId);
					if (
						this._ignoreConnectionStateChange == true ||
						this._isSwitchingToBroadcastMode == true ||
						this.device.isDeletingDevice == true
					) {
						if (this.device.isDeletingDevice == true) {
							logger.info(
								"bluetooth",
								"[DEVICE] 删除设备中，跳过断开后的自动恢复扫描"
							);
						} else {
							logger.info("bluetooth", "[BOOM] 本次断开由主动流程触发，等待恢复广播");
						}
						return;
					}
					this.recoverBoundBroadcastAfterDisconnectDeferred("connection disconnected");
				}
			}
		});
		//#endif
	}

	private initializeConnectedDeviceSafely(deviceId: string): void {
		this._initializeConnectedDevice(deviceId).catch((e) => {
			logger.error("bluetooth", "[BOOM] 连接状态回调初始化设备失败:", e);
		});
	}

	private shouldIgnoreConnectedCallback(deviceId: string): boolean {
		if (this.device.isGattTaskBusy() == true) return false;
		return (
			this._isSwitchingToBroadcastMode == true ||
			this._ignoreConnectionStateChange == true ||
			this._scanPurpose == "boundBroadcast"
		);
	}

	private shouldDisconnectIgnoredConnectedCallback(deviceId: string): boolean {
		if (this._isSwitchingToBroadcastMode == true && this.device.currentDeviceId == deviceId) {
			return false;
		}
		if (this._ignoreConnectionStateChange == true && this.device.currentDeviceId == deviceId) {
			return false;
		}
		return true;
	}

	private async disconnectIgnoredBroadcastConnection(deviceId: string): Promise<void> {
		//#ifndef H5
		try {
			await disconnect(deviceId);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM] 广播模式断开残留连接失败:", e);
		}
		//#endif
	}

	/**
	 * 用户从设备列表（actionSheet）点选某个设备后，启动连接
	 */
	public connectToFoundDevice(deviceId: string): void {
		const found = this.device.findCachedDevice(deviceId);
		if (found == null) {
			logger.warn("bluetooth", "[SCAN] 设备列表中找不到 deviceId:", deviceId);
			return;
		}
		const displayName = found.name ?? found.localName ?? "";
		this._pairingPickerVisible = false;
		this.stopBluetoothSearch()
			.catch((e) => {
				logger.warn("bluetooth", "[SCAN] 用户选择连接时停止扫描失败:", e);
			})
			.finally(() => {
				this.connectToDevice(deviceId, displayName);
			});
	}

	/** 主动断开当前设备 */
	async disconnectDevice(readRecentVital: boolean = true): Promise<void> {
		await this.switchToBroadcastMode(readRecentVital);
	}

	/** 内部：清空连接相关字段 */
	_resetConnectionState(): void {
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
		this.device.touchState();
	}

	/** 弹设备选择 actionSheet（直接复用 Device 实例方法） */
	showDevicePicker(options: ShowDevicePickerOptions): void {
		this.device.showDevicePicker(options);
	}
}
