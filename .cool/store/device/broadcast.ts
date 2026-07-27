import { bluetoothDataManager, parseCustomAdvData, toRealtimeBroadcast } from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";
import { sleepTimeout } from "../../utils";
import { realtime } from "../realtime";
import { TARGET_DEVICE_NAME_PREFIX } from "./types/wear-location";
import type { Device } from "./index";
import type { BroadcastDebugInfo, BroadcastPacketContext } from "./types/broadcast-types";
import { logger } from "../../service/logger";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

const BOUND_BROADCAST_MIN_INTERVAL_MS = 1000;
const BROADCAST_TIME_DRIFT_SEC = 10;
const BROADCAST_TIME_SYNC_DRIFT_SEC = 60;
const BROADCAST_TIME_SYNC_COOLDOWN_MS = 60 * 1000;
const RECENT_GATT_TIME_SYNC_SUPPRESS_MS = 60 * 1000;
const EVENT_SYNC_DEBOUNCE_MS = 30 * 1000;
const STALE_BROADCAST_REPEAT_THRESHOLD = 3;
const STALE_BROADCAST_SCAN_RESTART_COOLDOWN_MS = 20 * 1000;
const BROADCAST_HARD_RECOVERY_RESTART_THRESHOLD = 3;
const BROADCAST_HARD_RECOVERY_COOLDOWN_MS = 60 * 1000;
const BOUND_BROADCAST_SCAN_NO_CALLBACK_MS = 12 * 1000;
const BOUND_BROADCAST_SCAN_STALE_MS = 18 * 1000;
const BROADCAST_RECOVERY_ERROR_TEXT =
	"未收到设备广播，请确认设备在附近、电量充足且系统蓝牙权限正常";

export class DeviceBroadcast {
	private device: Device;
	private broadcastSeq: number = 0;
	private boundBroadcastScanning: boolean = false;
	private lastBoundBroadcastHandledAt: number = 0;
	private lastBoundScanCallbackAt: number = 0;
	private lastBoundScanDebugAt: number = 0;
	private lastTimeSyncAttemptAt: number = 0;
	private lastEventSeqByDevice = new Map<string, number>();
	private seenEventSeqByDevice = new Map<string, boolean>();
	private pendingEventSyncTimer: number = 0;
	private pendingEventSyncDeviceId: string = "";
	private pendingEventSeq: number = 0;
	private pendingPreviousEventSeq: number = 0;
	private lastTimeSyncOkAt: number = 0;
	private lastBroadcastUtc: number = 0;
	private lastBroadcastVHex: string = "";
	private staleBroadcastRepeatCount: number = 0;
	private lastBroadcastScanRestartAt: number = 0;
	private consecutiveBroadcastRestartCount: number = 0;
	private lastBroadcastHardRecoveryAt: number = 0;
	private hardRecoveryPendingValidation: boolean = false;
	private broadcastScanRestartBusy: boolean = false;
	private boundBroadcastScanGeneration: number = 0;

	constructor(device: Device) {
		this.device = device;
		this.hydrateLatestEventSeq();
	}

	/* ===== 初始化 / 外部入口 ===== */

	private async hydrateLatestEventSeq(): Promise<void> {
		try {
			const record = await bluetoothDataManager.getLatestRealtimeBroadcastRecord();
			if (record == null || record.deviceId == "") return;
			this.lastEventSeqByDevice.set(record.deviceId, record.eventSeq);
			this.seenEventSeqByDevice.set(record.deviceId, true);
			logger.info(
				"bluetooth",
				`[BOOM-EVENT] 已恢复最近事件序号: device=${record.deviceId}, eventSeq=${record.eventSeq}`
			);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-EVENT] 恢复最近事件序号失败:", e);
		}
	}

	setBoundBroadcastScanning(scanning: boolean): void {
		this.boundBroadcastScanning = scanning;
		this.boundBroadcastScanGeneration = this.boundBroadcastScanGeneration + 1;
		if (scanning == true) {
			this.resetBoundScanWindow();
			this.resetStaleBroadcastTracking();
			this.watchBoundBroadcastScan(this.boundBroadcastScanGeneration);
		}
	}

	markScanStopped(): void {
		this.boundBroadcastScanning = false;
		this.boundBroadcastScanGeneration = this.boundBroadcastScanGeneration + 1;
		this.resetBoundScanWindow();
		this.resetStaleBroadcastTracking();
	}

	handleFoundDevice(d: DeviceInfo): void {
		//#ifndef H5
		const boundId = this.device.boundDeviceId;
		const currentId = this.device.currentDeviceId;
		if (boundId == "" && currentId == "") return;
		if (boundId != "" && d.deviceId != boundId && d.deviceId != currentId) return;
		const name = d.name ?? d.localName ?? "";
		const isCurrentDevice = d.deviceId == currentId;
		const isBoomDevice = name.startsWith(TARGET_DEVICE_NAME_PREFIX);
		if (isCurrentDevice == false && isBoomDevice == false) {
			return;
		}
		this.tryParseBroadcast(d);
		//#endif
	}

	handleBoundDeviceFound(d: DeviceInfo): void {
		//#ifndef H5
		if (this.device.boundDeviceId == "") return;
		if (d.deviceId != this.device.boundDeviceId) return;
		this.markBoundScanCallback();
		const name = d.name ?? d.localName ?? "";
		this.device.saveBoundDeviceName(name);
		this.device.cacheFoundDevice(d, name);
		if (name != "") {
			bluetoothDataManager.setDeviceInfo(name, this.device.boundDeviceId);
		}
		const now = Date.now();
		if (now - this.lastBoundBroadcastHandledAt < BOUND_BROADCAST_MIN_INTERVAL_MS) return;
		this.lastBoundBroadcastHandledAt = now;
		this.tryParseBroadcast(d);
		//#endif
	}

	handleGattBroadcastData(vHex: string): void {
		const parsed = parseCustomAdvData(vHex);
		if (parsed == null) {
			logger.info("bluetooth", `[BOOM-ADV] GATT 0x50 解析失败: v=${vHex}`);
			return;
		}
		const r: RealtimeBroadcast = toRealtimeBroadcast(parsed);
		const ctx = this.makeGattPacketContext(vHex);
		if (this.handleInvalidBroadcastTime(ctx, r) == true) {
			return;
		}
		this.acceptBroadcastRecord(ctx, r);
	}

	handleBoundDeviceList(devices: DeviceInfo[]): void {
		//#ifndef H5
		if (this.device.boundDeviceId == "") return;
		this.markBoundScanCallback();
		let bound: DeviceInfo | null = null;
		for (let i = 0; i < devices.length; i++) {
			const item = devices[i];
			if (item.deviceId == this.device.boundDeviceId) {
				bound = item;
			}
		}
		if (bound == null) {
			this.logBoundScanMiss(devices);
			return;
		}
		this.handleBoundDeviceFound(bound);
		//#endif
	}

	/* ===== 绑定广播扫描监控 ===== */

	private markBoundScanCallback(): void {
		if (this.boundBroadcastScanning == false) return;
		this.lastBoundScanCallbackAt = Date.now();
	}

	private resetBoundScanWindow(): void {
		this.lastBoundBroadcastHandledAt = 0;
		this.lastBoundScanCallbackAt = 0;
		this.lastBoundScanDebugAt = 0;
	}

	private watchBoundBroadcastScan(generation: number): void {
		this.watchBoundBroadcastScanAsync(generation);
	}

	private async watchBoundBroadcastScanAsync(generation: number): Promise<void> {
		await sleepTimeout(BOUND_BROADCAST_SCAN_NO_CALLBACK_MS);
		if (this.boundBroadcastScanning == false) return;
		if (generation != this.boundBroadcastScanGeneration) return;
		const latestAt =
			this.lastBoundScanCallbackAt > this.lastBoundBroadcastHandledAt
				? this.lastBoundScanCallbackAt
				: this.lastBoundBroadcastHandledAt;
		const now = Date.now();
		if (latestAt == 0) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 绑定广播扫描 ${BOUND_BROADCAST_SCAN_NO_CALLBACK_MS}ms 内无任何回调，重启扫描`
			);
			this.restartBoundBroadcastScan("no scan callback");
			return;
		}
		if (now - latestAt >= BOUND_BROADCAST_SCAN_STALE_MS) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 绑定广播扫描 ${BOUND_BROADCAST_SCAN_STALE_MS}ms 未收到绑定设备回调，自动恢复广播`
			);
			this.restartBoundBroadcastScan("bound scan stale");
			return;
		}
		this.watchBoundBroadcastScan(generation);
	}

	private logBoundScanMiss(devices: DeviceInfo[]): void {
		if (this.boundBroadcastScanning == false) return;
		const now = Date.now();
		if (now - this.lastBoundScanDebugAt < 2000) return;
		this.lastBoundScanDebugAt = now;

		const samples: string[] = [];
		const max = devices.length < 5 ? devices.length : 5;
		for (let i = 0; i < max; i++) {
			const item = devices[i];
			const name = item.name ?? item.localName ?? "";
			const rssi = item.RSSI ?? 0;
			const ad = item.advertisData ?? [];
			samples.push(`${item.deviceId}/${name}/rssi=${rssi}/ad=${ad.length}`);
		}
		logger.info(
			"bluetooth",
			`[BOOM-ADV] 广播扫描未匹配绑定设备: bound=${this.device.boundDeviceId}, count=${devices.length}, samples=${samples.join(" | ")}`
		);
	}

	/* ===== 广播解析主流程 ===== */

	private tryParseBroadcast(d: DeviceInfo): void {
		const ad = d.advertisData ?? null;
		if (ad == null || ad.length <= 0) {
			if (this.boundBroadcastScanning == true) {
				logger.info(
					"bluetooth",
					`[BOOM-ADV] 绑定设备广播无 manufacturerData: ${d.deviceId}`
				);
			}
			return;
		}
		const hex = this.bytesToHex(ad);
		const vHex = this.extractCustomAdvVHex(hex);
		if (vHex == "") {
			if (this.boundBroadcastScanning == true) {
				logger.info(
					"bluetooth",
					`[BOOM-ADV] 绑定设备 manufacturerData 长度不匹配: ${d.deviceId}, raw=${hex}`
				);
			}
			return;
		}
		const parsed = parseCustomAdvData(vHex);
		if (parsed != null) {
			const r: RealtimeBroadcast = toRealtimeBroadcast(parsed);
			const ctx = this.makeBroadcastPacketContext(d, hex, vHex);
			if (this.handleStaleScannerBroadcast(ctx, r) == true) {
				return;
			}
			if (this.handleInvalidBroadcastTime(ctx, r) == true) {
				return;
			}
			this.acceptBroadcastRecord(ctx, r);
		} else if (this.boundBroadcastScanning == true) {
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 绑定设备广播解析失败: ${d.deviceId}, raw=${hex}, v=${vHex}`
			);
		}
	}

	/* ===== 单条广播上下文 ===== */

	private makeGattPacketContext(vHex: string): BroadcastPacketContext {
		const deviceId =
			this.device.currentDeviceId != ""
				? this.device.currentDeviceId
				: this.device.boundDeviceId;
		return {
			source: "gatt",
			deviceId,
			name: this.device.getDisplayDeviceName(),
			rssi: 0,
			rawHex: vHex,
			vHex
		} as BroadcastPacketContext;
	}

	private makeBroadcastPacketContext(
		d: DeviceInfo,
		rawHex: string,
		vHex: string
	): BroadcastPacketContext {
		return {
			source: "broadcast",
			deviceId: d.deviceId,
			name: d.name ?? d.localName ?? "",
			rssi: d.RSSI ?? 0,
			rawHex,
			vHex
		} as BroadcastPacketContext;
	}

	private acceptBroadcastRecord(ctx: BroadcastPacketContext, r: RealtimeBroadcast): void {
		if (this.isBoundBroadcastRecord(ctx) == true) {
			this.markBroadcastRecoveryOk();
		}
		this.markBroadcastEventNotice(ctx.deviceId, r);
		this.device.realtime.value = r;
		this.storeBroadcastRecordByDevice(ctx, r);
		this.publishDebugInfoByDevice(ctx, r);
	}

	private isBoundBroadcastRecord(ctx: BroadcastPacketContext): boolean {
		return (
			ctx.source == "broadcast" &&
			this.device.boundDeviceId != "" &&
			ctx.deviceId == this.device.boundDeviceId
		);
	}

	/* ===== 缓存广播识别 / 扫描恢复 ===== */

	private handleStaleScannerBroadcast(
		ctx: BroadcastPacketContext,
		r: RealtimeBroadcast
	): boolean {
		if (this.isBroadcastUtcUsable(r) == true) {
			this.lastBroadcastUtc = r.utc;
			this.lastBroadcastVHex = ctx.vHex;
			this.staleBroadcastRepeatCount = 0;
			return false;
		}
		if (this.lastBroadcastUtc <= 0) return false;
		if (r.utc > this.lastBroadcastUtc) return false;
		if (ctx.vHex != this.lastBroadcastVHex) return false;
		this.staleBroadcastRepeatCount = this.staleBroadcastRepeatCount + 1;
		if (this.staleBroadcastRepeatCount < STALE_BROADCAST_REPEAT_THRESHOLD) return false;
		this.publishDebugInfoByDevice(ctx, r);
		const diffSec = this.getBroadcastUtcDiffSec(r);
		logger.warn(
			"bluetooth",
			`[BOOM-ADV] 检测到扫描缓存广播，丢弃并重启广播扫描: device=${ctx.deviceId}, repeat=${this.staleBroadcastRepeatCount}, lastUtc=${this.lastBroadcastUtc}, utc=${r.utc}, diff=${diffSec}s`
		);
		this.restartBoundBroadcastScan("stale packet");
		return true;
	}

	private restartBoundBroadcastScan(reason: string): void {
		const now = Date.now();
		// 缓存包可能高频重复，保留冷却；扫描无回调/绑定设备无回调本身已有 12s/18s 监控间隔，不再节流，
		// 否则第二轮恢复会被 20s 冷却吞掉，watcher 也不会继续挂上。
		const shouldThrottle = reason == "stale packet";
		if (
			shouldThrottle == true &&
			now - this.lastBroadcastScanRestartAt < STALE_BROADCAST_SCAN_RESTART_COOLDOWN_MS
		) {
			this.watchBoundBroadcastScan(this.boundBroadcastScanGeneration);
			return;
		}
		if (this.broadcastScanRestartBusy == true) {
			this.watchBoundBroadcastScan(this.boundBroadcastScanGeneration);
			return;
		}
		this.lastBroadcastScanRestartAt = now;
		this.broadcastScanRestartBusy = true;
		this.restartBoundBroadcastScanAsync(reason);
	}

	private async restartBoundBroadcastScanAsync(reason: string): Promise<void> {
		const hardRecover = this.shouldUseHardBroadcastRecovery(reason);
		try {
			await this.device.connection.restartBoundBroadcastScan(reason, hardRecover);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-ADV] 重启广播扫描失败:", e);
		} finally {
			this.resetStaleBroadcastTracking();
			this.broadcastScanRestartBusy = false;
		}
	}

	private shouldUseHardBroadcastRecovery(reason: string): boolean {
		this.consecutiveBroadcastRestartCount = this.consecutiveBroadcastRestartCount + 1;
		if (this.hardRecoveryPendingValidation == true) {
			this.reportBroadcastUnavailableAfterHardRecovery(reason);
		}
		if (this.consecutiveBroadcastRestartCount < BROADCAST_HARD_RECOVERY_RESTART_THRESHOLD) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播恢复尝试: count=${this.consecutiveBroadcastRestartCount}/${BROADCAST_HARD_RECOVERY_RESTART_THRESHOLD}, reason=${reason}`
			);
			return false;
		}
		const now = Date.now();
		if (now - this.lastBroadcastHardRecoveryAt < BROADCAST_HARD_RECOVERY_COOLDOWN_MS) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播硬恢复冷却中，先轻量重启: count=${this.consecutiveBroadcastRestartCount}, reason=${reason}`
			);
			return false;
		}
		this.consecutiveBroadcastRestartCount = 0;
		this.lastBroadcastHardRecoveryAt = now;
		this.hardRecoveryPendingValidation = true;
		logger.warn(
			"bluetooth",
			`[BOOM-ADV] 连续未收到有效绑定广播，升级重建扫描栈: reason=${reason}`
		);
		return true;
	}

	private reportBroadcastUnavailableAfterHardRecovery(reason: string): void {
		if (this.device.errorMessage.value != BROADCAST_RECOVERY_ERROR_TEXT) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 重建扫描栈后仍未收到有效绑定广播: reason=${reason}`
			);
		}
		this.device.errorMessage.value = BROADCAST_RECOVERY_ERROR_TEXT;
		this.device.touchState();
	}

	private markBroadcastRecoveryOk(): void {
		if (
			this.consecutiveBroadcastRestartCount > 0 ||
			this.hardRecoveryPendingValidation == true
		) {
			logger.info("bluetooth", "[BOOM-ADV] 已重新收到有效绑定广播，清除广播恢复状态");
		}
		this.consecutiveBroadcastRestartCount = 0;
		this.hardRecoveryPendingValidation = false;
		if (this.device.errorMessage.value == BROADCAST_RECOVERY_ERROR_TEXT) {
			this.device.errorMessage.value = "";
			this.device.touchState();
		}
	}

	private resetStaleBroadcastTracking(): void {
		this.lastBroadcastUtc = 0;
		this.lastBroadcastVHex = "";
		this.staleBroadcastRepeatCount = 0;
	}

	/* ===== 时间校验 / 事件通知 ===== */

	private handleInvalidBroadcastTime(ctx: BroadcastPacketContext, r: RealtimeBroadcast): boolean {
		if (this.isBroadcastUtcUsable(r) == true) return false;
		this.publishDebugInfoByDevice(ctx, r);
		const diffSec = this.getBroadcastUtcDiffSec(r);
		if (diffSec >= BROADCAST_TIME_SYNC_DRIFT_SEC) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播 UTC 不可信，丢弃本条数据并尝试校时: device=${ctx.deviceId}, diff=${diffSec}s, utc=${r.utc}`
			);
			this.requestTimeSyncFromBroadcast(diffSec, r.utc);
		} else {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播 UTC 轻微滞后，丢弃本条缓存数据: device=${ctx.deviceId}, diff=${diffSec}s, utc=${r.utc}`
			);
		}
		return true;
	}

	private markBroadcastEventNotice(deviceId: string, r: RealtimeBroadcast): void {
		if (deviceId == "") return;
		const hasPreviousSeq = this.seenEventSeqByDevice.get(deviceId) == true;
		let previousSeq = 0;
		if (hasPreviousSeq == true) {
			const value = this.lastEventSeqByDevice.get(deviceId);
			if (value != null) previousSeq = value;
		}
		r.hasNewEvent = hasPreviousSeq == true && previousSeq != r.eventSeq;
		this.lastEventSeqByDevice.set(deviceId, r.eventSeq);
		this.seenEventSeqByDevice.set(deviceId, true);
		if (r.hasNewEvent == true) {
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 事件序号变化: device=${deviceId}, eventSeq=${previousSeq}->${r.eventSeq}`
			);
			this.requestEventSync(deviceId, previousSeq, r.eventSeq);
		}
	}

	private requestEventSync(deviceId: string, previousSeq: number, eventSeq: number): void {
		logger.info(
			"bluetooth",
			`[BOOM-EVENT] 广播提示有新事件，等待静默后读取: device=${deviceId}, eventSeq=${previousSeq}->${eventSeq}`
		);
		this.pendingEventSyncDeviceId = deviceId;
		this.pendingPreviousEventSeq = previousSeq;
		this.pendingEventSeq = eventSeq;
		if (this.pendingEventSyncTimer != 0) {
			clearTimeout(this.pendingEventSyncTimer);
			this.pendingEventSyncTimer = 0;
		}
		// 事件序号可能在佩戴/断开/读取事件后短时间连续跳变，静默合并后只连接一次。
		// @ts-ignore setTimeout 在 UTS 不同平台返回类型不一,这里用 number 容器
		this.pendingEventSyncTimer = setTimeout(() => {
			this.pendingEventSyncTimer = 0;
			this.flushPendingEventSync();
		}, EVENT_SYNC_DEBOUNCE_MS);
	}

	private flushPendingEventSync(): void {
		const deviceId = this.pendingEventSyncDeviceId;
		const previousSeq = this.pendingPreviousEventSeq;
		const eventSeq = this.pendingEventSeq;
		this.pendingEventSyncDeviceId = "";
		this.pendingPreviousEventSeq = 0;
		this.pendingEventSeq = 0;
		if (deviceId == "" || this.device.boundDeviceId == "") return;
		if (deviceId != this.device.boundDeviceId) return;
		logger.info(
			"bluetooth",
			`[BOOM-EVENT] 事件序号静默完成，入队读取: device=${deviceId}, eventSeq=${previousSeq}->${eventSeq}`
		);
		this.device.scheduler.enqueueReadEvent(deviceId, eventSeq);
	}

	private requestTimeSyncFromBroadcast(diffSec: number, broadcastUtc: number): void {
		if (this.device.boundDeviceId == "") return;
		const nowSec = Math.floor(Date.now() / 1000);
		if (this.hasRecentGoodGattTimestamp(nowSec) == true) return;
		const nowMs = Date.now();
		if (nowMs - this.lastTimeSyncAttemptAt < BROADCAST_TIME_SYNC_COOLDOWN_MS) return;
		this.lastTimeSyncAttemptAt = nowMs;
		this.device.scheduler.enqueueTimeSync(diffSec, broadcastUtc);
	}

	markTimeSyncOk(): void {
		this.lastTimeSyncOkAt = Date.now();
	}

	markBoundDeviceUnavailable(): void {
		logger.warn(
			"bluetooth",
			"[BOOM-ADV] 绑定设备广播时间异常且校时失败，已停止自动使用并提示用户"
		);
		this.device.connection.stopBluetoothSearch();
		this.device.sync.stopAutoRepair();
		this.device.realtime.value = null;
		this.device.broadcastDebug.value = null;
		realtime.clear();
		this.device.setUnpairedError("设备时间异常且自动校时失败，请检查设备后恢复广播扫描");
	}

	/* ===== 入库 / 实时值 / 调试日志 ===== */

	private hasRecentGoodGattTimestamp(nowSec: number): boolean {
		const boomSec = this.device.event.boomTimestamp.value;
		if (boomSec <= 0) return false;
		let diffSec = nowSec - boomSec;
		if (diffSec < 0) diffSec = 0 - diffSec;
		if (diffSec > BROADCAST_TIME_DRIFT_SEC) return false;
		const lastNotifyAt = this.device.event.lastNotifyAtValue;
		if (lastNotifyAt <= 0) return false;
		return Date.now() - lastNotifyAt < RECENT_GATT_TIME_SYNC_SUPPRESS_MS;
	}

	private async storeBroadcastRecordByDevice(
		ctx: BroadcastPacketContext,
		r: RealtimeBroadcast
	): Promise<void> {
		const record = await bluetoothDataManager.storeRealtimeBroadcast({
			broadcast: r,
			rawHex: ctx.rawHex,
			vHex: ctx.vHex,
			deviceId: ctx.deviceId
		});
		if (record != null) {
			realtime.setBroadcastRecord(record);
			await this.storeBroadcastPpiData(r);
		}
	}

	private async storeBroadcastPpiData(r: RealtimeBroadcast): Promise<void> {
		const timestamp = this.getBroadcastTimestamp(r);
		const hr = r.hrValid ? r.hr : 0;
		const spo2 = r.spo2Valid ? Math.round(r.spo2Pct * 10) : 0;
		const ppi = r.ppiValid ? r.ppi : 0;
		const ok = await bluetoothDataManager.storeBroadcastPpiData(timestamp, hr, spo2, ppi);
		if (ok == true) {
			await bluetoothDataManager.requestPpiUpload();
		}
	}

	private getBroadcastTimestamp(r: RealtimeBroadcast): number {
		return r.utc;
	}

	private isBroadcastUtcUsable(r: RealtimeBroadcast): boolean {
		if (r.utc <= 0) return false;
		return this.getBroadcastUtcDiffSec(r) <= BROADCAST_TIME_DRIFT_SEC;
	}

	private getBroadcastUtcDiffSec(r: RealtimeBroadcast): number {
		const receivedSec = Math.floor(r.receivedAt / 1000);
		let diffSec = receivedSec - r.utc;
		if (diffSec < 0) diffSec = 0 - diffSec;
		return diffSec;
	}

	private publishDebugInfoByDevice(ctx: BroadcastPacketContext, r: RealtimeBroadcast): void {
		this.broadcastSeq = this.broadcastSeq + 1;
		const nowSec = Math.floor(Date.now() / 1000);
		let diff = nowSec - r.utc;
		if (diff < 0) diff = 0 - diff;
		const rmssdText = r.rmssdValid
			? `${r.rmssd.toFixed(2)}ms(hrv=${r.hrvMs})`
			: `${r.rmssd.toFixed(2)}!`;
		const summary = `phone=${nowSec} utc=${r.utc} diff=${diff}s timeValid=${this.isBroadcastUtcUsable(r)} eventSeq=${r.eventSeq} newEvent=${r.hasNewEvent} battery=${r.batteryStatus}(${r.batteryStatusLabel}) ppg=${r.ppgAttached ? "attached" : "detached"} behavior=${r.behavior}(${r.behaviorLabel}) activity=${r.activity}(${r.activityLabel}) hr=${r.hr}${r.hrValid ? "" : "!"} ppi=${r.ppi}${r.ppiValid ? "" : "!"} rmssd=${rmssdText} spo2=${r.spo2Pct.toFixed(1)}${r.spo2Valid ? "" : "!"} bhr=${r.bhr}${r.bhrValid ? "" : "!"} steps=${r.stepsEveryday} kcal=${r.calorieKcal.toFixed(1)} v=${r.voltageMv}mV/${r.voltageV.toFixed(3)}V`;
		const info: BroadcastDebugInfo = {
			seq: this.broadcastSeq,
			source: ctx.source,
			deviceId: ctx.deviceId,
			name: ctx.name,
			rssi: ctx.rssi,
			rawHex: ctx.rawHex,
			vHex: ctx.vHex,
			utc: r.utc,
			diffSec: diff,
			summary,
			receivedAt: r.receivedAt
		};
		this.device.broadcastDebug.value = info;
		if (ctx.source == "broadcast") {
			if (info.seq <= 5 || info.seq % 30 == 0 || r.hasNewEvent == true) {
				logger.info(
					"bluetooth",
					`[BOOM-ADV] 收到广播 #${info.seq}`,
					`${summary}\nraw=${ctx.rawHex}\nv=${ctx.vHex}`
				);
			}
		}
	}

	/* ===== 小工具 ===== */

	private bytesToHex(bytes: number[]): string {
		let hex = "";
		for (let i = 0; i < bytes.length; i++) {
			hex += this.byteToHex(bytes[i]);
		}
		return hex;
	}

	private byteToHex(value: number): string {
		const item = (value & 0xff).toString(16);
		return item.length == 1 ? "0" + item : item;
	}

	private extractCustomAdvVHex(hex: string): string {
		if (hex.length == 48) return hex;
		if (hex.length >= 56 && hex.substring(0, 8).toLowerCase() == "50001800") {
			return hex.substring(8, 56);
		}
		if (hex.length > 48) {
			return hex.substring(hex.length - 48);
		}
		return "";
	}
}
