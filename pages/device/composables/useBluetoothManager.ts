// #ifndef H5
import { ref, onUnmounted, shallowRef } from "vue";
import { useUi } from "@/uni_modules/cool-ui";
import { t } from "@/.cool";
// @ts-ignore
import { useKuxBluetooth } from "@/uni_modules/kux-bluetooth";
// @ts-ignore
import {
	InitConfig,
	DeviceInfo,
	OnBLEConnectionStateChangeCallbackRes,
	IBluetooth,
	GetBluetoothAdapterStateSuccess
} from "@/uni_modules/kux-bluetooth/utssdk/interface";

// 设备数据类型
type DeviceData = {
	status: string;
	sleep: number;
	load: number;
	recoveryAdvice: string;
	recoveryTime: string;
};

// 健康数据类型
type HealthData = {
	heartRate: number | null;
	restingHeartRate: number | null;
	bloodOxygen: number | null;
	heartRateVariability: number | null;
};

export function useBluetoothManager() {
	const ui = useUi();
	const searching = ref(false);
	// 使用 shallowRef 减少响应式开销
	const deviceList = shallowRef<DeviceInfo[]>([]);
	const bluetoothEnabled = ref(true);
	const deviceData = ref<DeviceData>({
		status: "正常",
		sleep: 7.5,
		load: 65,
		recoveryAdvice: "建议进行5分钟轻度拉伸",
		recoveryTime: "30分钟"
	});
	const healthData = ref<HealthData>({
		heartRate: null,
		restingHeartRate: null,
		bloodOxygen: null,
		heartRateVariability: null
	});
	const lastUpdated = ref("--");
	const kuxBluetooth: IBluetooth = useKuxBluetooth({
		/**
		 * 是否请求地理位置权限，可选参数
		 */
		needLocation: false,
		/**
		 * 是否需要在后台访问位置信息，可选参数
		 */
		accessBackgroundLocation: false
	} as InitConfig);

	// 存储定时器ID
	let searchTimer: number | null = null;
	let stopSearchTimer: number | null = null;

	// 检查蓝牙状态
	const checkBluetoothStatus = async () => {
		return new Promise<boolean>((resolve) => {
			kuxBluetooth.getBluetoothAdapterState({
				success: (res: GetBluetoothAdapterStateSuccess) => {
					// 减少控制台输出，提高性能
					bluetoothEnabled.value = res.available;
					resolve(res.available);
				},
				fail: (err: any) => {
					// 减少控制台输出，提高性能
					bluetoothEnabled.value = false;
					resolve(false);
				}
			});
		});
	};

	// 打开蓝牙适配器
	const openAdapter = async () => {
		return new Promise<boolean>((resolve) => {
			kuxBluetooth.openBluetoothAdapter({
				success: (res: any) => {
					// 减少控制台输出，提高性能
					resolve(true);
				},
				fail: (err: any) => {
					// 减少控制台输出，提高性能
					ui.showToast({ message: t("蓝牙初始化失败"), type: "error" });
					resolve(false);
				}
			});
		});
	};

	// 开始搜索设备
	const startSearch = async () => {
		// 清理之前的定时器
		if (searchTimer) {
			clearInterval(searchTimer);
			searchTimer = null;
		}
		if (stopSearchTimer) {
			clearTimeout(stopSearchTimer);
			stopSearchTimer = null;
		}

		// 初始化蓝牙
		const adapterOpened = await openAdapter();
		if (!adapterOpened) {
			return;
		}

		// 开始搜索
		searching.value = true;
		deviceList.value = [];
		kuxBluetooth.startBluetoothDevicesDiscovery({
			success: (res: any) => {
				// 减少控制台输出，提高性能
			},
			fail: (err: any) => {
				// 减少控制台输出，提高性能
				ui.showToast({ message: t("搜索失败"), type: "error" });
				searching.value = false;
			}
		});

		// 每2秒更新一次设备列表，减少DOM更新频率
		searchTimer = setInterval(() => {
			kuxBluetooth.getBluetoothDevices({
				success: (res: any) => {
					// 显式类型转换
					const devices = (res as UTSJSONObject).devices as DeviceInfo[];
					// 只在设备列表发生变化时更新，减少不必要的渲染
					if (
						devices.length !== deviceList.value.length ||
						JSON.stringify(devices) !== JSON.stringify(deviceList.value)
					) {
						deviceList.value = devices;
					}
				},
				fail: (err: any) => {
					// 减少控制台输出，提高性能
				}
			});
		}, 2000) as unknown as number;

		// 10秒后停止搜索
		stopSearchTimer = setTimeout(() => {
			if (searchTimer) {
				clearInterval(searchTimer);
				searchTimer = null;
			}
			searching.value = false;
			kuxBluetooth.stopBluetoothDevicesDiscovery({
				success: (res: any) => {
					// 减少控制台输出，提高性能
				}
			});
			if (deviceList.value.length == 0) {
				ui.showToast({ message: t("未找到设备"), type: "warn" });
			}
		}, 10000) as unknown as number;
	};

	// 连接设备
	const connectDevice = async (deviceId: string, onSuccess?: () => void) => {
		kuxBluetooth.createBLEConnection({
			deviceId,
			success: (res: any) => {
				// 减少控制台输出，提高性能
				ui.showToast({ message: t("配对成功"), type: "success" });
				// 停止搜索
				kuxBluetooth.stopBluetoothDevicesDiscovery({
					success: (res: any) => {
						// 减少控制台输出，提高性能
					}
				});
				// 调用成功回调
				if (onSuccess) {
					onSuccess();
				}
			},
			fail: (err: any) => {
				// 减少控制台输出，提高性能
				ui.showToast({ message: t("配对失败"), type: "error" });
			}
		});
	};

	// 设置连接状态回调
	const setupConnectionCallback = () => {
		// 监听蓝牙连接状态变化
		kuxBluetooth.onBLEConnectionStateChange((res: OnBLEConnectionStateChangeCallbackRes) => {
			// 减少控制台输出，提高性能
			if (!res.connected) {
				ui.showToast({ message: t("连接已断开"), type: "warn" });
			}
		});

		// 监听蓝牙适配器状态变化（新增于插件 1.1.0 版本）
		kuxBluetooth.onBluetoothAdapterStateChange((res: any) => {
			// 减少控制台输出，提高性能
			const state = res as GetBluetoothAdapterStateSuccess;
			bluetoothEnabled.value = state.available;
			if (!state.available) {
				ui.showToast({ message: t("蓝牙已关闭"), type: "warn" });
			}
		});
	};

	// 停止搜索
	const stopSearch = () => {
		if (kuxBluetooth == null) return;

		// 清理定时器
		if (searchTimer) {
			clearInterval(searchTimer);
			searchTimer = null;
		}
		if (stopSearchTimer) {
			clearTimeout(stopSearchTimer);
			stopSearchTimer = null;
		}

		kuxBluetooth.stopBluetoothDevicesDiscovery({
			success: (res: any) => {
				// 减少控制台输出，提高性能
			}
		});
		// 移除设备发现监听器
		kuxBluetooth.offBluetoothDeviceFound();
	};

	// 清理
	onUnmounted(() => {
		stopSearch();
	});

	// 模拟获取设备数据
	const fetchDeviceData = () => {
		// 这里应该是通过蓝牙获取真实数据，现在使用模拟数据
		const load = Math.random() * 40 + 40; // 40-80%
		let recoveryAdvice = "";
		let recoveryTime = "";

		if (load < 50) {
			recoveryAdvice = "建议进行5分钟轻度拉伸";
			recoveryTime = "15分钟";
		} else if (load < 70) {
			recoveryAdvice = "建议进行10分钟中度恢复训练";
			recoveryTime = "30分钟";
		} else {
			recoveryAdvice = "建议进行15分钟深度放松训练";
			recoveryTime = "45分钟";
		}

		deviceData.value = {
			status: "正常",
			sleep: Math.random() * 2 + 6, // 6-8小时
			load: load,
			recoveryAdvice: recoveryAdvice,
			recoveryTime: recoveryTime
		};
	};

	// 模拟获取健康数据
	const fetchHealthData = () => {
		// 这里应该是通过蓝牙获取真实数据，现在使用模拟数据
		healthData.value = {
			heartRate: Math.floor(Math.random() * 40) + 60, // 60-100
			restingHeartRate: Math.floor(Math.random() * 20) + 50, // 50-70
			bloodOxygen: Math.floor(Math.random() * 5) + 95, // 95-100
			heartRateVariability: Math.floor(Math.random() * 40) + 20 // 20-60
		};
		// 更新最后更新时间
		const now = new Date();
		const hours = String(now.getHours()).padStart(2, "0");
		const minutes = String(now.getMinutes()).padStart(2, "0");
		const seconds = String(now.getSeconds()).padStart(2, "0");
		lastUpdated.value = `${hours}:${minutes}:${seconds}`;
	};

	return {
		searching,
		deviceList,
		bluetoothEnabled,
		deviceData,
		healthData,
		lastUpdated,
		kuxBluetooth,
		checkBluetoothStatus,
		startSearch,
		connectDevice,
		stopSearch,
		setupConnectionCallback,
		fetchDeviceData,
		fetchHealthData
	};
}
// #endif
