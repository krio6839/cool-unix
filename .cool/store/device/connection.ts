import { t } from "../../locale";
import { TARGET_DEVICE_NAME } from "./types";
import { bluetoothDataManager } from "../../bluetooth";
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

export class DeviceConnection {
	private device: Device;

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
				this.device.status.value = "PAIRING";
				this.device.errorMessage.value = "";

				if (this.device.boundDeviceId != "" && this.device.currentDeviceId == "") {
					this.startBluetoothSearch();
				}
			}
		});
		//#endif
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
				this.device.protocol.getDeviceServicesAndCharacteristics(res.deviceId).then(() => {
					console.log("获取设备服务和特征值成功");
					this.device.protocol.subscribeUART();
					this.device.protocol.setLEDStatus("01");
					this.device.protocol.getLEDStatus(500);
					// 自动校准设备 RTC，确保后续 timestamp 是真实 Unix 时间戳
					this.device.protocol.setDeviceTime(Math.floor(Date.now() / 1000));
					// 启动定时数据查询
					this.device.data.startDataQueryTimer();
				});
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

	// 设备搜索
	async startBluetoothSearch() {
		//#ifndef H5
		this.device.devices = [];
		await this.stopBluetoothSearch();
		this.device.status.value = "SEARCHING";
		const ok = await startDiscovery();
		if (!ok) {
			this.device.status.value = "UNPAIRED";
			this.device.errorMessage.value = t("搜索设备失败");
			return;
		}
		console.log("开始搜索目标设备:", TARGET_DEVICE_NAME);
		onDeviceFound((devices) => {
			devices.forEach((foundDevice) => {
				if (foundDevice.name != TARGET_DEVICE_NAME) {
					return;
				}
				console.log("发现目标设备:", foundDevice);
				if (!this.device.devices.some((d) => d.deviceId == foundDevice.deviceId)) {
					this.device.devices.push(foundDevice);
				}
				console.log("当前设备列表:", this.device.devices);
				if (this.device.currentDeviceId != "") return;
				this.connectToDevice(foundDevice.deviceId, foundDevice.name);
			});
		});
		//#endif
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
		await this.stopBluetoothSearch();
		this.device.currentDeviceId = deviceId;
		this.device.currentDeviceName = deviceName ?? "";
		this.device.status.value = "CONNECTED";
		this.device.saveBoundDevice(deviceId);
		bluetoothDataManager.setDeviceInfo(this.device.currentDeviceName, deviceId);
		console.log("设备连接状态:", this.device.status.value);
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
