import { t } from "../../locale";
import { TARGET_DEVICE_NAME } from "./types";
import { bluetoothDataManager, type DeviceInfo } from "../../bluetooth";
import type { DataReadyStatus } from "../../bluetooth";

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
//#endif

import type { Device } from "./index";
import { sleepTimeout } from "@/.cool/utils";
import { router } from "@/.cool";

// 设备页面路由路径
const PAGE_DEVICE = "/pages/device/index";

export class DeviceConnection {
	private device: Device;

	// 静默直连配置(已绑定设备时 App 启动/蓝牙开启后静默重连)
	private static readonly RECONNECT_RETRY_COUNT = 3;
	private static readonly RECONNECT_RETRY_INTERVAL_MS = 3000;
	private static readonly DIRECT_CONNECT_TIMEOUT_MS = 8000;
	private _isSilentReconnecting: boolean = false;
	private _reconnectAttempts: number = 0;

	// 配对页扫描配置
	private static readonly PAIRING_SCAN_TIMEOUT_MS = 30000;
	// 扫描模式:pairing=配对(0/1/2+ 处理);reconnect=重连(只连 boundDeviceId)
	private _scanMode: "pairing" | "reconnect" = "pairing";
	private _isSearching: boolean = false;
	private _pairingScanTimer: number = 0;

	constructor(device: Device) {
		this.device = device;
	}

	// 蓝牙初始化
	async initBluetooth(): Promise<void> {
		console.log("开始初始化蓝牙");
		this.device.clearError();
		//#ifndef H5
		await openAdapter();
		//#endif
	}

	onBluetoothAdapterStateChange(): void {
		//#ifndef H5
		console.log("开始监听蓝牙适配器状态变化");
		onAdapterStateChange((res) => {
			console.log("蓝牙适配器状态变化:", res);
			this.device.discovering = res.discovering;
			if (this.device.available == res.available) return;
			this.device.available = res.available;
			if (!res.available) {
				console.log("蓝牙已关闭");
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("蓝牙未开启");
			} else {
				console.log("蓝牙已开启");
				// 静默:已绑定设备时不做任何状态变化,直接后台静默直连
				// 首次进入(boundDeviceId == "")才显示 PAIRING
				if (this.device.boundDeviceId == "") {
					this.device.status.value = "PAIRING";
				}
				this.device.errorMessage.value = "";

				if (this.device.boundDeviceId != "" && this.device.currentDeviceId == "") {
					this._silentReconnect();
				}
			}
		});
		//#endif
	}

	/**
	 * 静默直连已绑定设备(只在 onBluetoothAdapterStateChange 中调用)
	 * - 完全静默:不设 SEARCHING 状态、不弹 errorMessage、不写 storage
	 * - 失败 3 次后才降级为未配对(此时配对页面才接管 UI)
	 * - 用户打开 App 应该自动连接好设备
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
				if (ok) {
					console.log("[RECONNECT] 静默直连成功");
					await this._markConnected(this.device.boundDeviceId, "");
					this._reconnectAttempts = 0;
					return;
				}

				await sleepTimeout(DeviceConnection.RECONNECT_RETRY_INTERVAL_MS);
			}

			// 3 次都失败 → 启动配对扫描(不跳转;若扫描最终失败再跳转)
			console.warn(
				`[RECONNECT] 静默直连 ${DeviceConnection.RECONNECT_RETRY_COUNT} 次都失败,启动配对扫描(后台)`
			);
			this._startPairingScan();
		} finally {
			this._isSilentReconnecting = false;
		}
	}

	/**
	 * 启动配对扫描(不跳转)
	 * - 适用于:用户停留在任意页面,后台静默直连失败时
	 * - 行为:设 SEARCHING 状态 + 启动扫描(reconnect mode:只连 boundDeviceId)
	 * - 不跳转,让扫描在后台跑;若扫描期间找到绑定设备,自动连上
	 * - 若扫描 30s 超时未找到绑定设备,_handlePairingScanTimeout 会提示错误
	 */
	private _startPairingScan(): void {
		// 先把状态设好,设备页 onLoad 时 UI 就是 SEARCHING,不会闪 UNPAIRED
		this.device.status.value = "SEARCHING";
		this.device.errorMessage.value = "";
		// 启动扫描(异步,不 await — 扫描可以后台跑)
		// mode=reconnect:只连 boundDeviceId,不连其他设备
		this.startBluetoothSearch("reconnect");
	}

	/**
	 * 跳转设备页(原 retry 流程使用,现已被 _handlePairingScanTimeout 取代 — 保留以备将来需要)
	 * - 不再被任何方法调用,保留避免破坏可能的引用关系
	 */
	private _redirectToPairingPage(): void {
		this.device.status.value = "UNPAIRED";
		this.device.errorMessage.value = t("未找到设备,请确认设备已开机且在范围内");
		router.push({
			path: PAGE_DEVICE,
			mode: "reLaunch"
		});
	}

	/**
	 * 标记设备已连接(停止扫描 + 更新 store + 保存绑定 + 设置数据管理器)
	 * 供 _silentReconnect 和 connectToDevice 复用
	 */
	private async _markConnected(deviceId: string, deviceName: string): Promise<void> {
		await this.stopBluetoothSearch();
		this.device.currentDeviceId = deviceId;
		this.device.currentDeviceName = deviceName;
		this.device.status.value = "CONNECTED";
		this.device.saveBoundDevice(deviceId);
		bluetoothDataManager.setDeviceInfo(deviceName, deviceId);
	}

	async afterConnected(deviceId: string) {
		try {
			await this.device.protocol.getDeviceServicesAndCharacteristics(deviceId);
			console.log("获取设备服务和特征值成功");
			await this.device.protocol.subscribeUART();
			await sleepTimeout(200);
			const ledOk = await this.device.protocol.setLEDStatus("01");
			if (!ledOk) {
				console.warn("[DEVICE] 启动 PPG 写入失败（kux 库返回 false）");
			} else {
				// 直接乐观更新本地状态,避免被错误的初始 _deviceOn=false 误导。
				this.device._deviceOn = true;
				console.log("[DEVICE] 启动 PPG 写入成功,_deviceOn=true");
			}

			// 给设备 200ms 处理 LED 启动命令
			await sleepTimeout(200);

			// setDeviceTime 写入 + 等待 RTC 响应
			const now = Math.floor(Date.now() / 1000);
			const beforeRtc = this.device.rtcTime.value; // 记录写入前的 RTC
			const rtcWriteOk = await this.device.protocol.setDeviceTime(now);
			if (!rtcWriteOk) {
				console.warn("[DEVICE] setDeviceTime 写入失败（kux 库返回 false）");
			}

			// 等 500ms 看 RTC 响应（应该是 RTC:新时间戳 文本）
			await sleepTimeout(500);
			if (this.device.rtcTime.value == beforeRtc || this.device.rtcTime.value == 0) {
				console.warn(
					`[DEVICE] setDeviceTime 后 RTC 未变化（仍为 ${this.device.rtcTime.value}），重试一次`
				);
				const retry = await this.device.protocol.setDeviceTime(
					Math.floor(Date.now() / 1000)
				);
				console.log("[DEVICE] setDeviceTime 重试写入:", retry);
				await sleepTimeout(500);
			}
			console.log("[DEVICE] 当前 RTC:", this.device.rtcTime.value);

			// 启动定时数据查询
			this.device.data.startDataQueryTimer();
		} catch (e) {
			console.error("[DEVICE] afterConnected 流程异常:", e);
			throw e;
		}
	}

	onBLEConnectionStateChange(): void {
		console.log("开始监听蓝牙连接状态变化");
		//#ifndef H5
		onConnectionStateChange((res) => {
			console.log("蓝牙连接状态变化:", res);
			if (res.connected) {
				// 防止重复初始化
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
					// 停止定时查询
					this.device.data.stopDataQueryTimer();
					// 重置初始化状态，允许下次重连时重新初始化
					this.device.isDeviceInitialized = false;
					this.reconnect();
				}
			}
		});
		//#endif
	}

	/**
	 * 启动配对页扫描(只在 enterPairingMode 中调用,UI 上可显示 SEARCHING 状态)
	 * - 设备名匹配用 name || localName fallback(Nordic 设备只广播 localName 时也能匹配)
	 * - 30s 未找到 → _handlePairingScanTimeout 按数量 + mode 分支
	 * - 防重入:同一时间只能有一个扫描在跑
	 * @param mode pairing=配对(0/1/2+ 处理);reconnect=重连(只连 boundDeviceId)
	 */
	async startBluetoothSearch(mode: "pairing" | "reconnect" = "pairing") {
		//#ifndef H5
		if (this._isSearching) {
			console.log("[SCAN] 搜索已在进行,跳过");
			return;
		}
		this._isSearching = true;
		this._scanMode = mode;

		try {
			this.device.devices = [];
			await this.stopBluetoothSearch();
			this.device.status.value = "SEARCHING";

			// 内部 1 次自动 retry,规避 kux 库的 `if (this.scanning)` 并发守护
			let ok = await startDiscovery();
			if (!ok) {
				console.warn("[SCAN] startDiscovery 返回 false,500ms 后重试一次");
				await sleepTimeout(500);
				ok = await startDiscovery();
			}
			if (!ok) {
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("搜索设备失败,请检查蓝牙和位置权限");
				return;
			}
			console.log("开始搜索目标设备:", TARGET_DEVICE_NAME, "mode:", mode);
			this._schedulePairingScanTimeout();

			onDeviceFound((devices) => {
				// 累计所有匹配设备,不去重(去重在 _handleFoundDevice 内部用 deviceId 判断)
				devices
					.filter((d) => {
						// Nordic 设备的广播包经常只设 localName,不设 GAP name
						// 优先用 name,fallback 到 localName
						const name = d.name ?? d.localName ?? "";
						return name == TARGET_DEVICE_NAME;
					})
					.forEach((d) => {
						this._handleFoundDevice(d);
					});
			});
		} finally {
			this._isSearching = false;
		}
		//#endif
	}

	/**
	 * 处理已发现的目标设备:只入列表 + 按 RSSI 排序 + 不连接
	 * - 找到 N 个都入列表,等扫描周期结束后统一处理
	 * - 连接由 _handlePairingScanTimeout 根据 _scanMode + devices.length 决定
	 */
	private _handleFoundDevice(found: DeviceInfo): void {
		console.log("发现目标设备:", found.deviceId);
		if (!this.device.devices.some((d) => d.deviceId == found.deviceId)) {
			this.device.devices.push(found);
		}
		// 按 RSSI 降序排序(信号最强在最前)
		this.device.devices.sort((a, b) => (b.RSSI ?? -100) - (a.RSSI ?? -100));
		console.log("当前设备列表长度:", this.device.devices.length);
	}

	private _schedulePairingScanTimeout(): void {
		this._clearPairingScanTimeout();
		// @ts-ignore setTimeout 在 UTS 不同平台返回类型不一,这里用 number 容器
		this._pairingScanTimer = setTimeout(() => {
			this._handlePairingScanTimeout();
		}, DeviceConnection.PAIRING_SCAN_TIMEOUT_MS);
	}

	private _clearPairingScanTimeout(): void {
		if (this._pairingScanTimer != 0) {
			clearTimeout(this._pairingScanTimer);
			this._pairingScanTimer = 0;
		}
	}

	private async _handlePairingScanTimeout(): Promise<void> {
		const mode = this._scanMode;
		const count = this.device.devices.length;
		console.log(`[SCAN] 配对扫描结束,mode=${mode},共发现 ${count} 个目标设备`);
		await this.stopBluetoothSearch();

		// === 重连 mode:只连 boundDeviceId,绝不连其他设备 ===
		if (mode == "reconnect") {
			const bound = this.device.devices.find((d) => d.deviceId == this.device.boundDeviceId);
			if (bound == null) {
				this._redirectToPairingPage();
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

		if (count == 1) {
			const only = this.device.devices[0];
			const displayName = only.name ?? only.localName ?? "";
			console.log(`[SCAN] 仅 1 个设备,自动连接: ${only.deviceId}`);
			this.device.devices = []; // 清空列表(连接后不需要)
			this.connectToDevice(only.deviceId, displayName);
			return;
		}

		// 2+ 个:直接弹 actionSheet 让用户选择
		// 取消 → status=UNPAIRED + 清空 devices + errorMessage 提示重新配对
		console.log(`[SCAN] 发现 ${count} 个设备,直接弹窗让用户选择`);
		this.device.showDevicePicker(
			(deviceId) => {
				// 选 1 个:连接(connectToFoundDevice 内部会清空 devices)
				console.log(`[SCAN] 用户选择连接: ${deviceId}`);
				this.connectToFoundDevice(deviceId);
			},
			() => {
				// 取消:状态清零
				console.log(`[SCAN] 用户取消,降级为未配对`);
				this.device.devices = [];
				this.device.status.value = "UNPAIRED";
				this.device.errorMessage.value = t("已取消,请重新配对");
			}
		);
	}

	stopBluetoothSearch(): Promise<boolean> {
		//#ifndef H5
		offDeviceFound();
		return stopDiscovery();
		//#endif
		return Promise.resolve(true);
	}

	// 设备连接
	async connectToDevice(deviceId: string, deviceName?: string) {
		//#ifndef H5
		const ok = await connect(deviceId, 100000);
		if (!ok) {
			this.device.status.value = "UNPAIRED";
			this.device.errorMessage.value = t("连接设备失败");
			return;
		}
		console.log("连接设备成功:", deviceId);
		//#endif
		await this._markConnected(deviceId, deviceName ?? "");
		console.log("设备连接状态:", this.device.status.value);
	}

	/**
	 * 用户从设备列表(actionSheet)点选某个设备后,启动连接
	 * - 供 index.uvue 的 onDeviceSelected 调用
	 * - 不做 boundDeviceId 检查(配对 mode 下 boundDeviceId == "",无限制)
	 */
	public connectToFoundDevice(deviceId: string): void {
		const found = this.device.devices.find((d) => d.deviceId == deviceId);
		if (found == null) {
			console.warn("[SCAN] 设备列表中找不到 deviceId:", deviceId);
			return;
		}
		const displayName = found.name ?? found.localName ?? "";
		// this.device.devices = []; // 清空列表(连接后不需要)
		this.connectToDevice(deviceId, displayName);
	}

	async disconnectDevice() {
		this.stopBluetoothSearch();
		this.device.data.stopDataQueryTimer();
		this.device.protocol.disableAllNotifications();

		//#ifndef H5
		if (this.device.currentDeviceId != "") {
			await disconnect(this.device.currentDeviceId);
		}
		//#endif
		this._resetConnectionState();
	}

	// 重置连接相关状态(设备已断开的清理动作)
	_resetConnectionState() {
		this.device.status.value = "UNPAIRED";
		this.device.currentDeviceId = "";
		this.device.currentDeviceName = "";
		this.device.protocol.services = [];
		this.device.protocol.characteristics.clear();
		this.device.resetReconnectState();
		bluetoothDataManager.clearDeviceInfo();
	}

	// 重连机制
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

	// 切换设备：断开当前设备 → 清空数据 → 连接新设备
	async switchDevice(newDeviceId: string, newDeviceName?: string): Promise<void> {
		// 1. 断开当前设备
		await this.disconnectDevice();
		// 2. 清空数据库
		await bluetoothDataManager.clearAllData();
		// 3. 清空所有持久化数据（断点续传计数 + 绑定设备ID）
		this.device.clearAllSavedData();
		// 4. 重置健康数据
		this.device.heartRate.value = 0;
		this.device.bloodOxygen.value = 0;
		this.device.battery.value = 0;
		this.device.ppi.value = 0;
		this.device.sleepData.value = null;
		this.device.dataReadyStatus.value = { heartRateCount: 0, sleepCount: 0 } as DataReadyStatus;
		this.device.rtcTime.value = 0;
		// 5. 连接新设备（connectToDevice 内部会自动保存新的 boundDeviceId）
		await this.connectToDevice(newDeviceId, newDeviceName);
	}
}
