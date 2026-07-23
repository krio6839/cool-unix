import { bluetoothDataManager, parseCustomAdvData, toRealtimeBroadcast } from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";
import { sleepTimeout } from "../../utils";
import { realtime } from "../realtime";
import { TARGET_DEVICE_NAME_PREFIX } from "./types";
import type { Device } from "./index";
import type { BroadcastDebugInfo } from "./types";
import { logger } from "../../service/logger";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

const BOUND_BROADCAST_MIN_INTERVAL_MS = 1000;
const BROADCAST_TIME_DRIFT_SEC = 10;
const BROADCAST_TIME_SYNC_DRIFT_SEC = 60;
const BROADCAST_TIME_SYNC_COOLDOWN_MS = 60 * 1000;
const RECENT_GATT_TIME_SYNC_SUPPRESS_MS = 60 * 1000;
const STALE_BROADCAST_REPEAT_THRESHOLD = 3;
const STALE_BROADCAST_SCAN_RESTART_COOLDOWN_MS = 20 * 1000;
const BOUND_BROADCAST_SCAN_NO_CALLBACK_MS = 12 * 1000;

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
	private lastTimeSyncOkAt: number = 0;
	private lastBroadcastUtc: number = 0;
	private lastBroadcastVHex: string = "";
	private staleBroadcastRepeatCount: number = 0;
	private lastBroadcastScanRestartAt: number = 0;
	private broadcastScanRestartBusy: boolean = false;
	private boundBroadcastScanGeneration: number = 0;

	constructor(device: Device) {
		this.device = device;
		this.hydrateLatestEventSeq();
	}

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
			this.lastBoundBroadcastHandledAt = 0;
			this.lastBoundScanCallbackAt = 0;
			this.lastBoundScanDebugAt = 0;
			this.resetStaleBroadcastTracking();
			this.watchBoundBroadcastScan(this.boundBroadcastScanGeneration);
		}
	}

	markScanStopped(): void {
		this.boundBroadcastScanning = false;
		this.boundBroadcastScanGeneration = this.boundBroadcastScanGeneration + 1;
		this.lastBoundBroadcastHandledAt = 0;
		this.lastBoundScanCallbackAt = 0;
		this.lastBoundScanDebugAt = 0;
		this.resetStaleBroadcastTracking();
	}

	handleFoundDevice(d: DeviceInfo): void {
		//#ifndef H5
		const name = d.name ?? d.localName ?? "";
		const isCurrentDevice = d.deviceId == this.device.currentDeviceId;
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
		const deviceId =
			this.device.currentDeviceId != ""
				? this.device.currentDeviceId
				: this.device.boundDeviceId;
		const name = this.device.getDisplayDeviceName();
		if (this.handleInvalidBroadcastTime("gatt", deviceId, name, 0, vHex, vHex, r) == true) {
			return;
		}
		this.acceptBroadcastRecord("gatt", deviceId, name, 0, vHex, vHex, r);
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

	private markBoundScanCallback(): void {
		if (this.boundBroadcastScanning == false) return;
		this.lastBoundScanCallbackAt = Date.now();
	}

	private watchBoundBroadcastScan(generation: number): void {
		this.watchBoundBroadcastScanAsync(generation);
	}

	private async watchBoundBroadcastScanAsync(generation: number): Promise<void> {
		await sleepTimeout(BOUND_BROADCAST_SCAN_NO_CALLBACK_MS);
		if (this.boundBroadcastScanning == false) return;
		if (generation != this.boundBroadcastScanGeneration) return;
		if (this.lastBoundScanCallbackAt > 0) return;
		if (this.lastBoundBroadcastHandledAt > 0) return;
		logger.warn(
			"bluetooth",
			`[BOOM-ADV] 绑定广播扫描 ${BOUND_BROADCAST_SCAN_NO_CALLBACK_MS}ms 内无任何回调，重启扫描`
		);
		this.restartBoundBroadcastScan("no scan callback");
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
			const name = d.name ?? d.localName ?? "";
			const rssi = d.RSSI ?? 0;
			if (this.handleStaleScannerBroadcast(d.deviceId, name, rssi, hex, vHex, r) == true) {
				return;
			}
			if (
				this.handleInvalidBroadcastTime(
					"broadcast",
					d.deviceId,
					name,
					rssi,
					hex,
					vHex,
					r
				) == true
			) {
				return;
			}
			this.acceptBroadcastRecord("broadcast", d.deviceId, name, rssi, hex, vHex, r);
		} else if (this.boundBroadcastScanning == true) {
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 绑定设备广播解析失败: ${d.deviceId}, raw=${hex}, v=${vHex}`
			);
		}
	}

	private acceptBroadcastRecord(
		source: "broadcast" | "gatt",
		deviceId: string,
		name: string,
		rssi: number,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): void {
		this.markBroadcastEventNotice(deviceId, r);
		this.device.realtime.value = r;
		this.storeBroadcastRecordByDevice(deviceId, rawHex, vHex, r);
		this.publishDebugInfoByDevice(source, deviceId, name, rssi, rawHex, vHex, r);
	}

	private handleStaleScannerBroadcast(
		deviceId: string,
		name: string,
		rssi: number,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): boolean {
		if (this.isBroadcastUtcUsable(r) == true) {
			this.lastBroadcastUtc = r.utc;
			this.lastBroadcastVHex = vHex;
			this.staleBroadcastRepeatCount = 0;
			return false;
		}
		if (this.lastBroadcastUtc <= 0) return false;
		if (r.utc > this.lastBroadcastUtc) return false;
		if (vHex != this.lastBroadcastVHex) return false;
		this.staleBroadcastRepeatCount = this.staleBroadcastRepeatCount + 1;
		if (this.staleBroadcastRepeatCount < STALE_BROADCAST_REPEAT_THRESHOLD) return false;
		this.publishDebugInfoByDevice("broadcast", deviceId, name, rssi, rawHex, vHex, r);
		const diffSec = this.getBroadcastUtcDiffSec(r);
		logger.warn(
			"bluetooth",
			`[BOOM-ADV] 检测到扫描缓存广播，丢弃并重启广播扫描: device=${deviceId}, repeat=${this.staleBroadcastRepeatCount}, lastUtc=${this.lastBroadcastUtc}, utc=${r.utc}, diff=${diffSec}s`
		);
		this.restartBoundBroadcastScan("stale packet");
		return true;
	}

	private restartBoundBroadcastScan(reason: string): void {
		const now = Date.now();
		if (now - this.lastBroadcastScanRestartAt < STALE_BROADCAST_SCAN_RESTART_COOLDOWN_MS) {
			return;
		}
		if (this.broadcastScanRestartBusy == true) return;
		this.lastBroadcastScanRestartAt = now;
		this.broadcastScanRestartBusy = true;
		this.restartBoundBroadcastScanAsync(reason);
	}

	private async restartBoundBroadcastScanAsync(reason: string): Promise<void> {
		try {
			await this.device.connection.restartBoundBroadcastScan(reason);
		} catch (e) {
			logger.warn("bluetooth", "[BOOM-ADV] 重启广播扫描失败:", e);
		} finally {
			this.resetStaleBroadcastTracking();
			this.broadcastScanRestartBusy = false;
		}
	}

	private resetStaleBroadcastTracking(): void {
		this.lastBroadcastUtc = 0;
		this.lastBroadcastVHex = "";
		this.staleBroadcastRepeatCount = 0;
	}

	private handleInvalidBroadcastTime(
		source: "broadcast" | "gatt",
		deviceId: string,
		name: string,
		rssi: number,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): boolean {
		if (this.isBroadcastUtcUsable(r) == true) return false;
		this.publishDebugInfoByDevice(source, deviceId, name, rssi, rawHex, vHex, r);
		const diffSec = this.getBroadcastUtcDiffSec(r);
		if (diffSec >= BROADCAST_TIME_SYNC_DRIFT_SEC) {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播 UTC 不可信，丢弃本条数据并尝试校时: device=${deviceId}, diff=${diffSec}s, utc=${r.utc}`
			);
			this.requestTimeSyncFromBroadcast(diffSec, r.utc);
		} else {
			logger.warn(
				"bluetooth",
				`[BOOM-ADV] 广播 UTC 轻微滞后，丢弃本条缓存数据: device=${deviceId}, diff=${diffSec}s, utc=${r.utc}`
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
			`[BOOM-EVENT] 广播提示有新事件，准备读取: device=${deviceId}, eventSeq=${previousSeq}->${eventSeq}`
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
		deviceIdValue: string,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): Promise<void> {
		const id = `${r.receivedAt}-${r.utc}`;
		const ok = await bluetoothDataManager.storeRealtimeBroadcastRecord(
			id,
			this.getBroadcastTimestamp(r),
			r.receivedAt,
			r.utc,
			r.voltageMv,
			r.ppgAttached,
			r.behavior,
			r.activity,
			r.hr,
			r.ppi,
			Math.round(r.spo2Pct * 10),
			r.bhr,
			r.eventSeq,
			r.hasNewEvent,
			r.batteryStatus,
			r.hrvMs,
			r.stepsEveryday,
			r.calorieEveryday,
			rawHex,
			vHex,
			deviceIdValue
		);
		if (ok == true) {
			realtime.setBroadcastValues(
				r.hr,
				r.bhr,
				Math.round(r.spo2Pct * 10),
				r.hrvMs,
				r.stepsEveryday,
				r.calorieEveryday,
				r.receivedAt
			);
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

	private publishDebugInfoByDevice(
		source: "broadcast" | "gatt",
		deviceId: string,
		name: string,
		rssi: number,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): void {
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
			source,
			deviceId,
			name,
			rssi,
			rawHex,
			vHex,
			utc: r.utc,
			diffSec: diff,
			summary,
			receivedAt: r.receivedAt
		};
		this.device.broadcastDebug.value = info;
		if (source == "broadcast") {
			if (info.seq <= 5 || info.seq % 30 == 0 || r.hasNewEvent == true) {
				logger.info(
					"bluetooth",
					`[BOOM-ADV] 收到广播 #${info.seq}`,
					`${summary}\nraw=${rawHex}\nv=${vHex}`
				);
			}
		}
	}

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
