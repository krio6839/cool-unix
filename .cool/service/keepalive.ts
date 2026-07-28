import { bluetoothDataManager } from "../bluetooth/data-manager";
import { useStore } from "../store";
import { logger } from "./logger";

//#ifdef APP-ANDROID
import * as TKeepAlive from "@/uni_modules/t-keepalive-api";
//#endif

const KEEP_ALIVE_MIN_TICK_INTERVAL_MS = 60 * 1000;
let keepAliveStarted = false;
let keepAliveTicking = false;
let keepAliveScanChecking = false;
let lastKeepAliveTickAt = 0;

export type KeepAliveTickReason = "launch" | "show" | "hide" | "service";

export function startKeepAliveService(): void {
	//#ifdef APP-ANDROID
	if (keepAliveStarted == true) {
		return;
	}
	keepAliveStarted = true;
	TKeepAlive.start(() => {
		runKeepAliveTick("service");
	});
	logger.info("keepalive", "Android 保活服务已启动");
	//#endif
}

export function runKeepAliveTick(reason: KeepAliveTickReason): void {
	//#ifdef APP-ANDROID
	runKeepAliveTickAsync(reason);
	//#endif
}

async function runKeepAliveTickAsync(reason: KeepAliveTickReason): Promise<void> {
	if (keepAliveTicking == true) {
		logger.info("keepalive", "保活任务仍在执行，跳过本轮", reason);
		runKeepAliveBroadcastScanOnly(reason);
		return;
	}

	const now = Date.now();
	if (reason == "service" && now - lastKeepAliveTickAt < KEEP_ALIVE_MIN_TICK_INTERVAL_MS) {
		return;
	}

	keepAliveTicking = true;
	lastKeepAliveTickAt = now;
	try {
		const { device } = useStore();
		if (device.boundDeviceId != "") {
			bluetoothDataManager.setDeviceInfo(device.getDisplayDeviceName(), device.boundDeviceId);
			await maintainBoundBroadcastScanFromKeepAlive(reason);
			device.sync.startAutoRepair();
		}
		await bluetoothDataManager.uploadData();
		logger.info("keepalive", "保活任务完成", reason);
	} catch (e) {
		logger.warn("keepalive", "保活任务失败", reason, e);
	} finally {
		keepAliveTicking = false;
	}
}

function runKeepAliveBroadcastScanOnly(reason: KeepAliveTickReason): void {
	if (keepAliveScanChecking == true) return;
	keepAliveScanChecking = true;
	runKeepAliveBroadcastScanOnlyAsync(reason)
		.catch((e) => {
			logger.warn("keepalive", "保活扫描兜底失败", reason, e);
		})
		.finally(() => {
			keepAliveScanChecking = false;
		});
}

async function runKeepAliveBroadcastScanOnlyAsync(reason: KeepAliveTickReason): Promise<void> {
	const { device } = useStore();
	if (device.boundDeviceId == "") return;
	bluetoothDataManager.setDeviceInfo(device.getDisplayDeviceName(), device.boundDeviceId);
	await maintainBoundBroadcastScanFromKeepAlive(reason);
}

async function maintainBoundBroadcastScanFromKeepAlive(reason: KeepAliveTickReason): Promise<void> {
	const { device } = useStore();
	if (device.boundDeviceId == "") return;
	// 保活 tick 不发 GATT 命令，但要在后台持续维护绑定广播扫描。
	try {
		await device.connection.maintainBoundBroadcastScan(`keepalive ${reason}`);
	} catch (e) {
		logger.warn("keepalive", "保活绑定广播扫描维护失败", reason, e);
	}
}

export function requestKeepAlivePermissions(): void {
	//#ifdef APP-ANDROID
	TKeepAlive.requestBatteryOptimizationPermission();
	TKeepAlive.requestExactAlarmPermission();
	TKeepAlive.showAutoStartGuide();
	//#endif
}
