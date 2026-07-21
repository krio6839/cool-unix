import { bluetoothDataManager, parseCustomAdvData, toRealtimeBroadcast } from "../../bluetooth";
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
const BROADCAST_TIME_SYNC_COOLDOWN_MS = 60 * 1000;
const RECENT_GATT_TIME_SYNC_SUPPRESS_MS = 60 * 1000;

export class DeviceBroadcast {
	private device: Device;
	private broadcastSeq: number = 0;
	private boundBroadcastScanning: boolean = false;
	private lastBoundBroadcastHandledAt: number = 0;
	private lastBoundScanDebugAt: number = 0;
	private timeSyncBusy: boolean = false;
	private lastTimeSyncAttemptAt: number = 0;

	constructor(device: Device) {
		this.device = device;
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
		this.device.realtime.value = r;
		this.storeBroadcastRecordByDevice(deviceId, vHex, vHex, r);
		this.publishDebugInfoByDevice("gatt", deviceId, name, 0, vHex, vHex, r);
		this.checkBroadcastTime(r);
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
			this.device.realtime.value = r;
			const name = d.name ?? d.localName ?? "";
			const rssi = d.RSSI ?? 0;
			this.storeBroadcastRecordByDevice(d.deviceId, hex, vHex, r);
			this.publishDebugInfoByDevice("broadcast", d.deviceId, name, rssi, hex, vHex, r);
			this.checkBroadcastTime(r);
		} else if (this.boundBroadcastScanning == true) {
			console.log(`[BOOM-ADV] 绑定设备广播解析失败: ${d.deviceId}, raw=${hex}, v=${vHex}`);
		}
	}

	private checkBroadcastTime(r: RealtimeBroadcast): void {
		if (this.device.boundDeviceId == "") return;
		if (r.utc <= 0) return;
		const nowSec = Math.floor(Date.now() / 1000);
		let diffSec = nowSec - r.utc;
		if (diffSec < 0) diffSec = 0 - diffSec;
		if (diffSec <= BROADCAST_TIME_DRIFT_SEC) return;
		if (this.hasRecentGoodGattTimestamp(nowSec) == true) return;
		const nowMs = Date.now();
		if (this.timeSyncBusy == true) return;
		if (nowMs - this.lastTimeSyncAttemptAt < BROADCAST_TIME_SYNC_COOLDOWN_MS) return;
		this.lastTimeSyncAttemptAt = nowMs;
		this.syncTimeFromBroadcast(diffSec, r.utc);
	}

	private async syncTimeFromBroadcast(diffSec: number, broadcastUtc: number): Promise<void> {
		if (this.timeSyncBusy == true) return;
		this.timeSyncBusy = true;
		const previousMode = this.device.testMode.value;
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
				console.warn("[BOOM-ADV] 自动校时连接失败，等待下次广播再试");
				return;
			}
			const nowSec = Math.floor(Date.now() / 1000);
			const beforeSeq = this.device.event.boomTimestampSeqValue;
			const sent = await this.device.protocol.setTimestamp(nowSec);
			if (sent == false) {
				console.warn("[BOOM-ADV] 自动校时发送 0x33 失败");
				return;
			}
			await sleepTimeout(300);
			await this.device.protocol.readTimestamp();
			const verified = await this.waitForTimestampResponse(beforeSeq, 3000);
			if (verified == true) {
				console.log(`[BOOM-ADV] 自动校时完成: utc=${nowSec}`);
			} else {
				console.warn("[BOOM-ADV] 自动校时读回超时，等待后续广播确认");
			}
		} catch (e) {
			console.warn("[BOOM-ADV] 自动校时异常:", e);
		} finally {
			if (previousMode == "broadcast") {
				try {
					await this.device.connection.switchToBroadcastMode(false);
				} catch (e) {
					console.warn("[BOOM-ADV] 自动校时后恢复广播失败:", e);
				}
			}
			this.timeSyncBusy = false;
		}
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
			r.status,
			r.ppgAttached,
			r.behavior,
			r.activity,
			r.hr,
			r.ppi,
			Math.round(r.spo2Pct * 10),
			r.bhr,
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
				r.ppi,
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
		return r.utc > 0 ? r.utc : Math.floor(r.receivedAt / 1000);
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
		const summary = `phone=${nowSec} utc=${r.utc} diff=${diff}s status=0x${this.byteToHex(r.status)} bit7=${r.statusReserved} ppg=${r.ppgAttached ? "attached" : "detached"} behavior=${r.behavior}(${r.behaviorLabel}) activity=${r.activity}(${r.activityLabel}) hr=${r.hr}${r.hrValid ? "" : "!"} ppi=${r.ppi}${r.ppiValid ? "" : "!"} hrv=${r.hrvMs}ms spo2=${r.spo2Pct.toFixed(1)}${r.spo2Valid ? "" : "!"} bhr=${r.bhr}${r.bhrValid ? "" : "!"} steps=${r.stepsEveryday} kcal=${r.calorieKcal.toFixed(1)} v=${r.voltageMv}mV/${r.voltageV.toFixed(3)}V`;
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
		if (hex.length == 42) return hex;
		if (hex.length >= 50 && hex.substring(0, 8).toLowerCase() == "50001500") {
			return hex.substring(8, 50);
		}
		if (hex.length > 42) {
			return hex.substring(hex.length - 42);
		}
		return "";
	}
}
