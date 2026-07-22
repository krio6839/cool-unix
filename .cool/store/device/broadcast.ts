import {
	bluetoothDataManager,
	EVENT_QUERY_TYPE_BY_TIME,
	parseCustomAdvData,
	toRealtimeBroadcast
} from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";
import { sleepTimeout } from "../../utils";
import { realtime } from "../realtime";
import { TARGET_DEVICE_NAME_PREFIX } from "./types";
import type { Device } from "./index";
import type { BroadcastDebugInfo } from "./types";

//#ifndef H5
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

const BOUND_BROADCAST_MIN_INTERVAL_MS = 1000;
const BROADCAST_TIME_DRIFT_SEC = 10;
const BROADCAST_TIME_SYNC_DRIFT_SEC = 60;
const BROADCAST_TIME_SYNC_COOLDOWN_MS = 60 * 1000;
const RECENT_GATT_TIME_SYNC_SUPPRESS_MS = 60 * 1000;
const EVENT_SYNC_WINDOW_SECONDS = 24 * 60 * 60;
const EVENT_SYNC_MAX_COUNT = 10;
const EVENT_SYNC_MAX_PAGES = 20;
const EVENT_SYNC_TIMEOUT_MS = 10000;
const EVENT_SYNC_AFTER_CONNECT_DELAY_MS = 800;
const EVENT_SYNC_AFTER_TIME_SYNC_DELAY_MS = 5000;

export class DeviceBroadcast {
	private device: Device;
	private broadcastSeq: number = 0;
	private boundBroadcastScanning: boolean = false;
	private lastBoundBroadcastHandledAt: number = 0;
	private lastBoundScanDebugAt: number = 0;
	private timeSyncBusy: boolean = false;
	private lastTimeSyncAttemptAt: number = 0;
	private lastEventSeqByDevice = new Map<string, number>();
	private seenEventSeqByDevice = new Map<string, boolean>();
	private eventSyncBusy: boolean = false;
	private pendingEventSyncDeviceId: string = "";
	private pendingEventSyncPreviousSeq: number = 0;
	private pendingEventSyncSeq: number = 0;
	private pendingEventDrainBusy: boolean = false;
	private lastTimeSyncOkAt: number = 0;

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
			console.log(
				`[BOOM-EVENT] 已恢复最近事件序号: device=${record.deviceId}, eventSeq=${record.eventSeq}`
			);
		} catch (e) {
			console.warn("[BOOM-EVENT] 恢复最近事件序号失败:", e);
		}
	}

	setBoundBroadcastScanning(scanning: boolean): void {
		this.boundBroadcastScanning = scanning;
		if (scanning == true) {
			this.lastBoundBroadcastHandledAt = 0;
			this.lastBoundScanDebugAt = 0;
		}
	}

	markScanStopped(): void {
		this.boundBroadcastScanning = false;
		this.lastBoundBroadcastHandledAt = 0;
		this.lastBoundScanDebugAt = 0;
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
			console.log(`[BOOM-ADV] GATT 0x50 解析失败: v=${vHex}`);
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
		this.markBroadcastEventNotice(deviceId, r);
		this.device.realtime.value = r;
		this.storeBroadcastRecordByDevice(deviceId, vHex, vHex, r);
		this.publishDebugInfoByDevice("gatt", deviceId, name, 0, vHex, vHex, r);
	}

	handleBoundDeviceList(devices: DeviceInfo[]): void {
		//#ifndef H5
		if (this.device.boundDeviceId == "") return;
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
		console.log(
			`[BOOM-ADV] 广播扫描未匹配绑定设备: bound=${this.device.boundDeviceId}, count=${devices.length}, samples=${samples.join(" | ")}`
		);
	}

	private tryParseBroadcast(d: DeviceInfo): void {
		const ad = d.advertisData ?? null;
		if (ad == null || ad.length <= 0) {
			if (this.boundBroadcastScanning == true) {
				console.log(`[BOOM-ADV] 绑定设备广播无 manufacturerData: ${d.deviceId}`);
			}
			return;
		}
		const hex = this.bytesToHex(ad);
		const vHex = this.extractCustomAdvVHex(hex);
		if (vHex == "") {
			if (this.boundBroadcastScanning == true) {
				console.log(
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
			this.markBroadcastEventNotice(d.deviceId, r);
			this.device.realtime.value = r;
			this.storeBroadcastRecordByDevice(d.deviceId, hex, vHex, r);
			this.publishDebugInfoByDevice("broadcast", d.deviceId, name, rssi, hex, vHex, r);
		} else if (this.boundBroadcastScanning == true) {
			console.log(`[BOOM-ADV] 绑定设备广播解析失败: ${d.deviceId}, raw=${hex}, v=${vHex}`);
		}
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
			console.warn(
				`[BOOM-ADV] 广播 UTC 不可信，丢弃本条数据并尝试校时: device=${deviceId}, diff=${diffSec}s, utc=${r.utc}`
			);
			this.requestTimeSyncFromBroadcast(diffSec, r.utc);
		} else {
			console.warn(
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
			console.log(
				`[BOOM-ADV] 事件序号变化: device=${deviceId}, eventSeq=${previousSeq}->${r.eventSeq}`
			);
			this.requestEventSync(deviceId, previousSeq, r.eventSeq);
		}
	}

	private requestEventSync(deviceId: string, previousSeq: number, eventSeq: number): void {
		console.log(
			`[BOOM-EVENT] 广播提示有新事件，准备读取: device=${deviceId}, eventSeq=${previousSeq}->${eventSeq}`
		);
		if (this.eventSyncBusy == true) {
			this.rememberPendingEventSync(deviceId, previousSeq, eventSeq);
			console.log("[BOOM-EVENT] 事件读取进行中，本次广播提示已暂存");
			return;
		}
		const waitMs = this.getEventSyncTimeSyncWaitMs();
		if (waitMs > 0) {
			this.rememberPendingEventSync(deviceId, previousSeq, eventSeq);
			console.log(`[BOOM-EVENT] 刚完成自动校时，延迟 ${waitMs}ms 后读取事件`);
			this.drainPendingEventSyncLater();
			return;
		}
		this.readEventsFromBroadcastNotice(deviceId, eventSeq);
	}

	private rememberPendingEventSync(
		deviceId: string,
		previousSeq: number,
		eventSeq: number
	): void {
		this.pendingEventSyncDeviceId = deviceId;
		this.pendingEventSyncPreviousSeq = previousSeq;
		this.pendingEventSyncSeq = eventSeq;
	}

	private getEventSyncTimeSyncWaitMs(): number {
		if (this.lastTimeSyncOkAt <= 0) return 0;
		const elapsed = Date.now() - this.lastTimeSyncOkAt;
		if (elapsed >= EVENT_SYNC_AFTER_TIME_SYNC_DELAY_MS) return 0;
		return EVENT_SYNC_AFTER_TIME_SYNC_DELAY_MS - elapsed;
	}

	private async drainPendingEventSyncLater(): Promise<void> {
		if (this.pendingEventDrainBusy == true) return;
		this.pendingEventDrainBusy = true;
		try {
			const waitMs = this.getEventSyncTimeSyncWaitMs();
			if (waitMs > 0) {
				await sleepTimeout(waitMs);
			}
			this.drainPendingEventSyncNow();
		} finally {
			this.pendingEventDrainBusy = false;
		}
	}

	private drainPendingEventSyncNow(): void {
		if (this.eventSyncBusy == true) return;
		if (this.pendingEventSyncDeviceId == "") return;
		const deviceId = this.pendingEventSyncDeviceId;
		const previousSeq = this.pendingEventSyncPreviousSeq;
		const eventSeq = this.pendingEventSyncSeq;
		this.pendingEventSyncDeviceId = "";
		this.pendingEventSyncPreviousSeq = 0;
		this.pendingEventSyncSeq = 0;
		console.log(
			`[BOOM-EVENT] 处理暂存的新事件提示: device=${deviceId}, eventSeq=${previousSeq}->${eventSeq}`
		);
		this.readEventsFromBroadcastNotice(deviceId, eventSeq);
	}

	private async readEventsFromBroadcastNotice(deviceId: string, eventSeq: number): Promise<void> {
		if (this.eventSyncBusy == true) {
			return;
		}
		this.eventSyncBusy = true;
		const previousMode = this.device.testMode.value;
		const endSec = Math.floor(Date.now() / 1000) + 60;
		const startSec = endSec - EVENT_SYNC_WINDOW_SECONDS;
		try {
			const alreadyConnected =
				this.device.currentDeviceId != "" && this.device.status.value == "CONNECTED";
			let connected = alreadyConnected;
			if (connected == false) {
				connected = await this.device.connection.switchToConnectMode();
			}
			if (connected == false) {
				console.warn(
					`[BOOM-EVENT] 新事件读取连接失败: device=${deviceId}, eventSeq=${eventSeq}`
				);
				return;
			}
			if (previousMode == "broadcast") {
				this.device.testMode.value = "broadcast";
			}
			if (alreadyConnected == false) {
				await sleepTimeout(EVENT_SYNC_AFTER_CONNECT_DELAY_MS);
			}
			console.log(
				`[BOOM-EVENT] 开始读取新事件: device=${deviceId}, eventSeq=${eventSeq}, window=${startSec}~${endSec}`
			);
			// 文档要求 status2 高 4 位事件序号变化后“读一次事件”。
			// 这里按时间窗口读取最近事件；readEventDataAuto 内部会自动 0x3C + 0x3D 续读并保存睡眠事件。
			const result = await this.device.history.readEventDataAuto({
				type: EVENT_QUERY_TYPE_BY_TIME,
				startSec,
				endSec,
				maxCount: EVENT_SYNC_MAX_COUNT,
				maxPages: EVENT_SYNC_MAX_PAGES,
				timeoutMs: EVENT_SYNC_TIMEOUT_MS,
				persistSleepData: true,
				uploadAfterSave: true
			});
			console.log(
				`[BOOM-EVENT] 新事件读取完成: status=${result.status}, pages=${result.pages}, items=${result.items.length}, savedSleep=${result.savedSleepRecords}, upload=${result.uploadOk}`
			);
			if (result.items.length > 0) {
				console.log(
					`[BOOM-EVENT] 新事件解析结果:\n${this.device.history.formatEventAutoBrief(result.items, 20)}`
				);
			}
		} catch (e) {
			console.warn("[BOOM-EVENT] 新事件读取异常:", e);
		} finally {
			if (previousMode == "broadcast") {
				try {
					await this.device.connection.switchToBroadcastMode(true);
				} catch (e) {
					console.warn("[BOOM-EVENT] 新事件读取后恢复广播失败:", e);
				}
			}
			this.eventSyncBusy = false;
			this.drainPendingEventSyncNow();
		}
	}

	private requestTimeSyncFromBroadcast(diffSec: number, broadcastUtc: number): void {
		if (this.device.boundDeviceId == "") return;
		const nowSec = Math.floor(Date.now() / 1000);
		if (this.hasRecentGoodGattTimestamp(nowSec) == true) return;
		const nowMs = Date.now();
		if (this.timeSyncBusy == true) return;
		if (this.device.isGattTaskBusy() == true) {
			console.log(
				`[BOOM-ADV] GATT 通道忙(${this.device.getGattTaskName()})，跳过本次自动校时`
			);
			return;
		}
		if (nowMs - this.lastTimeSyncAttemptAt < BROADCAST_TIME_SYNC_COOLDOWN_MS) return;
		this.lastTimeSyncAttemptAt = nowMs;
		this.syncTimeFromBroadcast(diffSec, broadcastUtc);
	}

	private async syncTimeFromBroadcast(diffSec: number, broadcastUtc: number): Promise<boolean> {
		if (this.timeSyncBusy == true) return false;
		if (this.device.beginGattTask("timeSync") == false) return false;
		this.timeSyncBusy = true;
		const previousMode = this.device.testMode.value;
		let ok = false;
		try {
			console.warn(
				`[BOOM-ADV] 广播时间偏差过大，自动校时: diff=${diffSec}s, advUtc=${broadcastUtc}`
			);
			let connected =
				this.device.currentDeviceId != "" && this.device.status.value == "CONNECTED";
			if (connected == false) {
				connected = await this.device.connection.switchToConnectMode();
			}
			if (connected == false) {
				console.warn("[BOOM-ADV] 自动校时连接失败，设备标记为不可用");
				return false;
			}
			const nowSec = Math.floor(Date.now() / 1000);
			const beforeSeq = this.device.event.boomTimestampSeqValue;
			const sent = await this.device.protocol.setTimestamp(nowSec);
			if (sent == false) {
				console.warn("[BOOM-ADV] 自动校时发送 0x33 失败，设备标记为不可用");
				return false;
			}
			await sleepTimeout(300);
			await this.device.protocol.readTimestamp();
			const verified = await this.waitForTimestampResponse(beforeSeq, 3000);
			if (verified == true) {
				console.log(`[BOOM-ADV] 自动校时完成: utc=${nowSec}`);
				ok = true;
				this.lastTimeSyncOkAt = Date.now();
			} else {
				console.warn("[BOOM-ADV] 自动校时读回超时，设备标记为不可用");
			}
			return ok;
		} catch (e) {
			console.warn("[BOOM-ADV] 自动校时异常:", e);
			return false;
		} finally {
			if (previousMode == "broadcast") {
				try {
					await this.device.connection.switchToBroadcastMode(false);
				} catch (e) {
					console.warn("[BOOM-ADV] 自动校时后恢复广播失败:", e);
				}
			}
			this.timeSyncBusy = false;
			this.device.endGattTask("timeSync");
			if (ok == false) {
				this.markBoundDeviceUnavailable();
			}
		}
	}

	private markBoundDeviceUnavailable(): void {
		console.warn("[BOOM-ADV] 绑定设备广播时间异常且校时失败，已停止自动使用并提示用户");
		this.device.connection.stopBluetoothSearch();
		this.device.sync.stopAutoRepair();
		this.device.realtime.value = null;
		this.device.broadcastDebug.value = null;
		realtime.clear();
		this.device.setUnpairedError("设备时间异常且自动校时失败，请检查设备后手动重连");
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

	private async waitForTimestampResponse(beforeSeq: number, timeoutMs: number): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.device.event.boomTimestampSeqValue > beforeSeq) {
				return true;
			}
			await sleepTimeout(120);
		}
		return false;
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
		const summary = `phone=${nowSec} utc=${r.utc} diff=${diff}s timeValid=${this.isBroadcastUtcUsable(r)} eventSeq=${r.eventSeq} newEvent=${r.hasNewEvent} battery=${r.batteryStatus}(${r.batteryStatusLabel}) ppg=${r.ppgAttached ? "attached" : "detached"} behavior=${r.behavior}(${r.behaviorLabel}) activity=${r.activity}(${r.activityLabel}) hr=${r.hr}${r.hrValid ? "" : "!"} ppi=${r.ppi}${r.ppiValid ? "" : "!"} rmssd=${r.hrvMs}${r.rmssdValid ? "ms" : "!"} spo2=${r.spo2Pct.toFixed(1)}${r.spo2Valid ? "" : "!"} bhr=${r.bhr}${r.bhrValid ? "" : "!"} steps=${r.stepsEveryday} kcal=${r.calorieKcal.toFixed(1)} v=${r.voltageMv}mV/${r.voltageV.toFixed(3)}V`;
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
			console.log(`[BOOM-ADV] 收到广播 #${info.seq}: ${summary}, raw=${rawHex}, v=${vHex}`);
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
