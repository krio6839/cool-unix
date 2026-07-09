/**
 * BOOM 设备连接管理
 *
 * 职责：
 * - 蓝牙适配器初始化、状态监听
 * - 设备扫描：设备名前缀匹配 "BOOM-"
 * - 已连接设备 / 当前通信设备的 0x50 广播解析 → device.realtime
 * - 静默直连（重连）+ 配对扫描（首次配对 / 直连失败后降级）
 * - 连接成功后的 GATT 流程（services 发现 → notify 启用 → 0x30 读固件 → 0x33 写时戳）
 *
 * 未来扩展：睡眠 / 血氧历史数据可能也走 0x50 广播通道，
 * 详见 connection.ts:_tryParseBroadcast 与 boom-parser.parseCustomAdvExtended。
 */

import { t } from "../../locale";
import { TARGET_DEVICE_NAME_PREFIX } from "./types";
import { BOOM_GATT_SERVICE_UUID, parseCustomAdvData, toRealtimeBroadcast } from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";

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

/** 设备页面路由路径（保留以备将来跳转） */
const PAGE_DEVICE = "/pages/device/index";

export class DeviceConnection {
	private device: Device;

	/* ===== 静默直连（重连）配置 ===== */
	private static readonly RECONNECT_RETRY_COUNT = 3; // 最多重试次数
	private static readonly RECONNECT_RETRY_INTERVAL_MS = 3000; // 每次间隔
	private static readonly DIRECT_CONNECT_TIMEOUT_MS = 8000; // 单次直连超时
	private _isSilentReconnecting: boolean = false;
	private _reconnectAttempts: number = 0;

	/* ===== 配对页扫描配置 ===== */
	private static readonly PAIRING_SCAN_TIMEOUT_MS = 30000; // 扫描总时长
	private _scanMode: "pairing" | "reconnect" = "pairing";
	private _isSearching: boolean = false;
	private _pairingScanTimer: number = 0;

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
			if (res.available == false) {
				// 蓝牙关闭：清理状态
				console.log("蓝牙已关闭");
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("蓝牙未开启");
			} else {
				// 蓝牙开启：自动恢复（已绑定→静默直连，未绑定→配对扫描）
				console.log("蓝牙已开启");
				if (this.device.boundDeviceId == "") {
					this.device.status.value = "PAIRING";
					this.startBluetoothSearch("pairing");
				}
				this.device.errorMessage.value = "";

				if (this.device.boundDeviceId != "" && this.device.currentDeviceId == "") {
					this._silentReconnect();
				}
			}
		});
		//#endif
	}

	/* ===== 静默直连（重连）===== */

	/**
	 * 静默直连已绑定设备
	 * 失败 RECONNECT_RETRY_COUNT 次后降级为后台配对扫描
	 */
	private async _silentReconnect(): Promise<void> {
		if (this._isSilentReconnecting) {
			console.log("[RECONNECT] 静默重连已在进行,跳过");
			return;
		}
		if (this.device.boundDeviceId == "" || this.device.currentDeviceId != "") {
			return;
		}
		this._isSilentReconnecting = true;
		this._reconnectAttempts = 0;

		try {
			while (this._reconnectAttempts < DeviceConnection.RECONNECT_RETRY_COUNT) {
				if (this.device.currentDeviceId != "") break;
				this._reconnectAttempts++;
				console.log(
					`[RECONNECT] 静默直连第 ${this._reconnectAttempts} 次,设备:`,
					this.device.boundDeviceId
				);

				const ok = await connect(
					this.device.boundDeviceId,
					DeviceConnection.DIRECT_CONNECT_TIMEOUT_MS
				);
				if (ok == true) {
					console.log("[RECONNECT] 静默直连成功");
					await this._markConnected(this.device.boundDeviceId, "");
					this._reconnectAttempts = 0;
					return;
				}

				await sleepTimeout(DeviceConnection.RECONNECT_RETRY_INTERVAL_MS);
			}

			// 3 次都失败 → 启动配对扫描(后台)
			console.warn(
				`[RECONNECT] 静默直连 ${DeviceConnection.RECONNECT_RETRY_COUNT} 次都失败,启动配对扫描(后台)`
			);
			this._startPairingScan();
		} finally {
			this._isSilentReconnecting = false;
		}
	}

	private _startPairingScan(): void {
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		this.startBluetoothSearch("reconnect");
	}

	/** 标记已连接：刷新状态 + 持久化绑定 */
	private async _markConnected(deviceId: string, deviceName: string): Promise<void> {
		await this.stopBluetoothSearch();
		this.device.currentDeviceId = deviceId;
		this.device.currentDeviceName = deviceName;
		this.device.status.value = "CONNECTED";
		this.device.saveBoundDevice(deviceId);
	}

	/* ===== 设备扫描 ===== */

	/**
	 * 启动扫描
	 * - 设备名前缀匹配 "BOOM-"
	 * - 0x50 广播数据从 Manufacturer Specific Data 字段解析 → 写入 device.realtime
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
				return;
			}
			console.log("[SCAN] 开始搜索 BOOM-* 设备,mode:", mode);
			this._schedulePairingScanTimeout();

			onDeviceFound((list) => {
				console.log("发现设备:", list);
				if (list == null) return;
				for (let i = 0; i < list.length; i++) {
					const d = list[i];
					if (d == null) continue;
					// 优先用 name,fallback 到 localName(BLE 设备 GAP name 常为空)
					const name = d.name ?? d.localName ?? "";
					const deviceId = d.deviceId ?? "";
					if (deviceId == "") continue;

					// 命中 BOOM-XXXX 才入列
					if (name.startsWith(TARGET_DEVICE_NAME_PREFIX)) {
						this._handleFoundDevice(d, name);
					}

					// 已绑定的设备（或当前正在通信的设备）出现 0x50 广播 → 解析实时数据
					// if (deviceId == this.device.currentDeviceId) {
					// 	this._tryParseBroadcast(d);
					// }
				}
			});
		} finally {
			this._isSearching = false;
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
		if (!this.device.devices.some((d) => d.deviceId == found.deviceId)) {
			// DeviceInfo 必填 8 字段全填齐
			this.device.devices.push({
				name,
				localName: found.localName ?? name, // BOOM 设备 localName 通常 == name
				deviceId: found.deviceId,
				RSSI: found.RSSI ?? 0,
				advertisData: [],
				advertisServiceUUIDs: [],
				serviceData: null,
				connectable: true
			} as DeviceInfo);
		}
		// 按 RSSI 降序排序(信号最强在最前)
		this.device.devices.sort((a, b) => (b.RSSI ?? -100) - (a.RSSI ?? -100));
		console.log("[SCAN] 当前 BOOM 设备列表长度:", this.device.devices.length);
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
			const bound = this.device.devices.find((d) => d.deviceId == this.device.boundDeviceId);
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

	/**
	 * 从扫描结果中提取 Manufacturer Specific Data → 解析 0x50 实时广播
	 * 优先 manufacturerData（uni-app x 标准字段），兜底用 number[] → hex
	 * 未来扩展：睡眠/血氧历史数据可能也走此通道（见 parseCustomAdvExtended）
	 */
	// private _tryParseBroadcast(d: DeviceInfo): void {
	// 	// 优先 manufacturerData（标准字段）
	// 	let mfgData: string = d.manufacturerData ?? "";
	// 	// 兜底：advertisData 是 number[]，转 hex 字符串
	// 	if (mfgData == "") {
	// 		const ad = d.advertisData ?? null;
	// 		if (ad != null && ad.length > 0) {
	// 			mfgData = ad.map((b: number) => (b & 0xff).toString(16).padStart(2, "0")).join("");
	// 		}
	// 	}
	// 	if (mfgData == "") return;
	// 	const parsed = parseCustomAdvData(mfgData);
	// 	if (parsed != null) {
	// 		const r: RealtimeBroadcast = toRealtimeBroadcast(parsed);
	// 		this.device.realtime.value = r;
	// 	}
	// }

	/** 停止扫描 + 清理定时器 */
	stopBluetoothSearch(): void {
		//#ifndef H5
		this._clearPairingScanTimeout();
		if (this._isSearching) {
			stopDiscovery();
			offDeviceFound();
			this._isSearching = false;
		}
		//#endif
	}

	/* ===== 连接 / 断开 ===== */

	/**
	 * 连接设备
	 * @param deviceId 蓝牙 deviceId
	 * @param deviceName 可选 UI 展示名
	 */
	async connectToDevice(deviceId: string, deviceName?: string): Promise<void> {
		this.device.status.value = "SEARCHING";
		//#ifndef H5
		const ok = await connect(deviceId, 100000);
		if (ok == false) {
			this.device.status.value = "PAIRING";
			return;
		}
		console.log("连接设备成功:", deviceId);
		//#endif
		await this._markConnected(deviceId, deviceName ?? "");
		console.log("设备连接状态:", this.device.status.value);
	}

	/**
	 * 连接成功后的 BOOM GATT 流程：
	 * 1. 获取 services + characteristics，校验是否含 BOOM GATT Service
	 * 2. 启用 notify
	 * 3. 读固件版本（0x30）→ 写时戳（0x33）→ 读回时戳（0x34）
	 */
	private async afterConnected(deviceId: string): Promise<void> {
		try {
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
			await this.device.protocol.readTimestamp();

			this.device.status.value = "CONNECTED";
		} catch (e) {
			console.error("[BOOM] afterConnected 流程异常:", e);
			throw e;
		}
	}

	/** 订阅 GATT 连接状态变化 */
	onBLEConnectionStateChange(): void {
		//#ifndef H5
		onConnectionStateChange((res) => {
			console.log("蓝牙连接状态变化:", res);
			if (res.connected) {
				if (this.device.isDeviceInitialized) {
					console.log("设备已初始化，跳过");
					return;
				}
				this.device.isDeviceInitialized = true;
				console.log("设备已连接:", res.deviceId);
				this.afterConnected(res.deviceId);
				this.device.resetReconnectState();
			} else {
				if (res.deviceId == this.device.currentDeviceId) {
					console.log("设备已断开:", res.deviceId);
					this.device.status.value = "UNPAIRED";
					this.device.currentDeviceId = "";
					this.device.isDeviceInitialized = false;
					this.reconnect();
				}
			}
		});
		//#endif
	}

	/**
	 * 用户从设备列表（actionSheet）点选某个设备后，启动连接
	 */
	public connectToFoundDevice(deviceId: string): void {
		const found = this.device.devices.find((d) => d.deviceId == deviceId);
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

	/** 内部：清空连接相关字段 */
	_resetConnectionState(): void {
		this.device.status.value = "UNPAIRED";
		this.device.currentDeviceId = "";
		this.device.currentDeviceName = "";
		this.device.protocol.services = [];
		this.device.protocol.characteristics.clear();
		this.device.realtime.value = null;
		this.device.resetReconnectState();
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
			console.log("执行重连操作");
			this.connectToDevice(this.device.boundDeviceId, "");
			this.device.isReconnecting = false;
			console.log("重连操作完成");
		}, currentInterval);
	}

	/** 弹设备选择 actionSheet（直接复用 Device 实例方法） */
	showDevicePicker(options: ShowDevicePickerOptions): void {
		this.device.showDevicePicker(options);
	}
}
