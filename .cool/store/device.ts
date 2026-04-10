import { ref } from "vue";
import { storage } from "../utils";
import { t } from "../locale";
import { useUi } from "@/uni_modules/cool-ui";

//#ifndef H5
import { useKuxBluetooth } from "@/uni_modules/kux-bluetooth";
import { InitConfig, DeviceInfo, IBluetooth } from "@/uni_modules/kux-bluetooth/utssdk/interface";
//#endif

// 佩戴位置类型（3个选项）
export type WearLocation = "大臂部" | "下胸部" | "腰部";

// 存储键名常量
const KEY_WEAR_LOCATION = "device_wear_location";
const KEY_LAST_DEVICE_ID = "last_device_id";
const KEY_LAST_DEVICE_NAME = "last_device_name";

// 设备状态枚举
export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;

const ui = useUi();
export class Device {
	inited = false;
	status: DeviceStatus = "UNPAIRED";
	devices: DeviceInfo[] = [];
	currentDeviceId: string = "";
	currentDeviceName: string = "";
	kuxBluetooth: IBluetooth;

	// 佩戴位置
	currentWearLocation: WearLocation = "大臂部";

	// 充电状态
	_isCharging: boolean = false;

	// 上次连接的设备信息
	lastConnectedDeviceId: string = "";
	lastConnectedDeviceName: string = "";

	constructor() {
		// 加载保存的数据
		this.loadSavedData();

		//#ifndef H5
		const kuxBluetooth: IBluetooth = useKuxBluetooth({
			needLocation: true,
			accessBackgroundLocation: false
		} as InitConfig);
		this.kuxBluetooth = kuxBluetooth;
		this.initBluetooth();
		//#endif
	}

	// 加载保存的数据
	loadSavedData(): void {
		// 加载佩戴位置
		const savedLocation = storage.get(KEY_WEAR_LOCATION) as WearLocation | null;
		if (savedLocation != null) {
			this.currentWearLocation = savedLocation;
		}

		// 加载上次连接的设备信息
		const savedDeviceId = storage.get(KEY_LAST_DEVICE_ID) as string | null;
		const savedDeviceName = storage.get(KEY_LAST_DEVICE_NAME) as string | null;
		if (savedDeviceId != null && savedDeviceId !== "") {
			this.lastConnectedDeviceId = savedDeviceId;
			this.lastConnectedDeviceName = savedDeviceName ?? "";
		}
	}

	// 保存佩戴位置
	saveWearLocation(location: WearLocation): void {
		this.currentWearLocation = location;
		storage.set(KEY_WEAR_LOCATION, location, 0);
	}

	// 保存上次连接的设备信息
	saveLastConnectedDevice(deviceId: string, deviceName: string): void {
		this.lastConnectedDeviceId = deviceId;
		this.lastConnectedDeviceName = deviceName;
		storage.set(KEY_LAST_DEVICE_ID, deviceId, 0);
		storage.set(KEY_LAST_DEVICE_NAME, deviceName, 0);
	}

	// 设置充电状态
	setCharging(charging: boolean): void {
		this._isCharging = charging;
	}

	getPaired(): boolean {
		return this.currentDeviceId !== "";
	}

	updatePairedStatus(paired: boolean) {
		this.currentDeviceId = "test";
	}

	async initBluetooth(): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			this.kuxBluetooth.openBluetoothAdapter({
				success: (res) => {
					console.log(`初始化蓝牙成功:${res.errMsg}`);
					// 监听蓝牙适配器状态变化
					this.kuxBluetooth.onBluetoothAdapterStateChange((res) => {
						console.log("adapterState changed, now is", res);
						if (!res.available) {
							ui.showToast({ message: t("蓝牙未开启"), type: "error" });
							this.status = "UNPAIRED";
						}
					});
					// 监听蓝牙连接状态变化
					this.kuxBluetooth.onBLEConnectionStateChange((res) => {
						console.log(`蓝牙连接状态:`, res);
						if (!res.connected) {
							if (res.deviceId === this.currentDeviceId) {
								this.status = "UNPAIRED";
								this.currentDeviceId = "";
								ui.showToast({ message: t("设备已断开"), type: "warn" });
							}
						}
					});

					resolve(res);
				},
				fail: (err) => {
					console.log("初始化蓝牙失败，错误码：" + err.errCode);
					ui.showToast({ message: t("蓝牙初始化失败"), type: "error" });
					reject(err);
				}
			});
		});
	}

	// 开始搜索蓝牙设备
	startBluetoothSearch() {
		this.devices = [];
		this.kuxBluetooth.startBluetoothDevicesDiscovery({
			success: (res) => {
				console.log("开始搜索蓝牙设备" + res.errMsg);
				// 监听新设备发现
				this.kuxBluetooth.onBluetoothDeviceFound((devices) => {
					console.log("发现新设备:", devices);
					devices.forEach((device) => {
						// 过滤重复设备
						if (!this.devices.some((d) => d.deviceId === device.deviceId)) {
							this.devices.push(device);
						}
					});
				});
			},
			fail: (e) => {
				console.log(e);
				console.log("搜索蓝牙设备失败，错误码" + e.errCode);
				ui.showToast({ message: t("搜索设备失败"), type: "error" });
				this.status = "UNPAIRED";
			}
		});
	}

	// 停止搜索蓝牙设备
	stopBluetoothSearch() {
		this.kuxBluetooth.stopBluetoothDevicesDiscovery({
			success: (res) => {
				console.log("停止搜索蓝牙设备" + res.errMsg);
			}
		});
		this.kuxBluetooth.offBluetoothDeviceFound();
	}

	// 连接蓝牙设备
	connectToDevice(deviceId: string, deviceName: string) {
		this.stopBluetoothSearch();
		this.kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res) => {
				console.log("连接蓝牙成功:" + res.errMsg);
				this.currentDeviceId = deviceId;
				this.currentDeviceName = deviceName;
				this.status = "CONNECTED";
				this.saveLastConnectedDevice(deviceId, deviceName);
				ui.showToast({ message: t("连接成功"), type: "success" });
			},
			fail: (err) => {
				console.log("连接低功耗蓝牙失败，错误码：" + err.errCode);
				ui.showToast({ message: t("连接失败"), type: "error" });
				this.status = "UNPAIRED";
			}
		});
	}

	// 自动重连上次连接的设备
	async autoReconnect(): Promise<boolean> {
		if (this.lastConnectedDeviceId === "") {
			console.log("没有上次连接的设备信息");
			return false;
		}
		if (!this.inited) {
			try {
				await this.initBluetooth();
			} catch (e) {
				console.log("蓝牙初始化失败，无法自动重连");
				return false;
			}
		}

		return new Promise<boolean>((resolve) => {
			this.kuxBluetooth.createBLEConnection({
				deviceId: this.lastConnectedDeviceId,
				success: (res) => {
					console.log("自动重连成功:" + res.errMsg);
					this.currentDeviceId = this.lastConnectedDeviceId;
					this.currentDeviceName = this.lastConnectedDeviceName;
					this.status = "CONNECTED";
					ui.showToast({ message: t("自动连接成功"), type: "success" });
					resolve(true);
				},
				fail: (err) => {
					console.log("自动重连失败，错误码：" + err.errCode);
					ui.showToast({ message: t("自动连接失败，请重新配对"), type: "warn" });
					this.status = "UNPAIRED";
					resolve(false);
				}
			});
		});
	}

	// 断开连接
	disconnectDevice() {
		if (this.currentDeviceId != "") {
			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId,
				success: (res) => {
					console.log("断开低功耗蓝牙成功:" + res.errMsg);
					this.status = "UNPAIRED";
					this.currentDeviceId = "";
					ui.showToast({ message: t("已断开连接"), type: "warn" });
				},
				fail: (err) => {
					console.log("断开低功耗蓝牙失败，错误码：" + err.errCode);
					this.status = "UNPAIRED";
					this.currentDeviceId = "";
					ui.showToast({ message: t("已断开连接"), type: "warn" });
				}
			});
		} else {
			this.status = "UNPAIRED";
			ui.showToast({ message: t("已断开连接"), type: "warn" });
		}
	}

	// 清理所有蓝牙事件监听器
	destroy() {
		//#ifndef H5
		this.stopBluetoothSearch();
		if (this.currentDeviceId != "") {
			this.kuxBluetooth.closeBLEConnection({
				deviceId: this.currentDeviceId
			});
		}
		this.kuxBluetooth.closeBluetoothAdapter({
			success: (res) => {
				console.log("关闭蓝牙适配器成功:" + res.errMsg);
			},
			fail: (err) => {
				console.log("关闭蓝牙适配器失败，错误码：" + err.errCode);
			}
		});
		//#endif
	}

	// 清除保存的设备信息
	clearLastConnectedDevice(): void {
		this.lastConnectedDeviceId = "";
		this.lastConnectedDeviceName = "";
		storage.remove(KEY_LAST_DEVICE_ID);
		storage.remove(KEY_LAST_DEVICE_NAME);
	}

	clear() {}
}

export const device = new Device();
