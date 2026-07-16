import { parseCustomAdvData, toRealtimeBroadcast } from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";
import { TARGET_DEVICE_NAME_PREFIX } from "./types";
import type { Device } from "./index";
import type { BroadcastDebugInfo } from "./index";

//#ifndef H5
import { startDiscovery, stopDiscovery, onDeviceFound, offDeviceFound } from "../../bluetooth/kux";
import type { DeviceInfo } from "../../bluetooth/kux";
//#endif

const BROADCAST_TIME_DRIFT_SEC = 10;
const BROADCAST_TIME_SYNC_COOLDOWN_MS = 60000;
const BOUND_BROADCAST_MIN_INTERVAL_MS = 1000;

export class DeviceBroadcast {
	private device: Device;
	private isScanning: boolean = false;
	private isTimeSyncing: boolean = false;
	private lastTimeSyncAt: number = 0;
	private lastBroadcastUtc: number = 0;
	private broadcastSeq: number = 0;
	private boundBroadcastScanning: boolean = false;
	private lastBoundBroadcastHandledAt: number = 0;

	constructor(device: Device) {
		this.device = device;
	}

	async startRealtimeScan(): Promise<void> {
		//#ifndef H5
		if (this.isScanning == true) return;
		if (this.device.currentDeviceId == "") return;
		this.isScanning = true;
		const ok = await startDiscovery();
		if (ok == false) {
			console.warn("[BOOM-ADV] 实时广播扫描启动失败");
			this.isScanning = false;
			return;
		}
		console.log("[BOOM-ADV] 已启动连接后实时广播扫描");
		onDeviceFound((devices) => {
			devices.forEach((d) => {
				this.handleFoundDevice(d);
			});
		});
		//#endif
	}

	async stopRealtimeScan(): Promise<void> {
		//#ifndef H5
		if (this.isScanning == false) return;
		this.isScanning = false;
		this.boundBroadcastScanning = false;
		await stopDiscovery();
		offDeviceFound();
		console.log("[BOOM-ADV] 已停止连接后实时广播扫描");
		//#endif
	}

	async startBoundBroadcastScan(): Promise<boolean> {
		//#ifndef H5
		if (this.boundBroadcastScanning == true) return true;
		if (this.device.boundDeviceId == "") {
			console.warn("[BOOM-ADV] 未绑定设备，无法启动绑定设备广播扫描");
			return false;
		}
		this.isScanning = true;
		this.boundBroadcastScanning = true;
		this.lastBoundBroadcastHandledAt = 0;
		const ok = await startDiscovery();
		if (ok == false) {
			console.warn("[BOOM-ADV] 绑定设备广播扫描启动失败");
			this.isScanning = false;
			this.boundBroadcastScanning = false;
			return false;
		}
		console.log(`[BOOM-ADV] 已启动绑定设备广播扫描: ${this.device.boundDeviceId}`);
		onDeviceFound((devices) => {
			this.handleBoundDeviceList(devices);
		});
		return true;
		//#endif
		//#ifdef H5
		return false;
		//#endif
	}

	async stopBoundBroadcastScan(): Promise<void> {
		//#ifndef H5
		if (this.boundBroadcastScanning == false) return;
		this.boundBroadcastScanning = false;
		this.isScanning = false;
		this.lastBoundBroadcastHandledAt = 0;
		await stopDiscovery();
		offDeviceFound();
		console.log("[BOOM-ADV] 已停止绑定设备广播扫描");
		//#endif
	}

	markScanStopped(): void {
		this.isScanning = false;
		this.boundBroadcastScanning = false;
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
		const now = Date.now();
		if (now - this.lastBoundBroadcastHandledAt < BOUND_BROADCAST_MIN_INTERVAL_MS) return;
		this.lastBoundBroadcastHandledAt = now;
		this.tryParseBroadcast(d);
		//#endif
	}

	private handleBoundDeviceList(devices: DeviceInfo[]): void {
		//#ifndef H5
		if (this.device.boundDeviceId == "") return;
		let bound: DeviceInfo | null = null;
		for (let i = 0; i < devices.length; i++) {
			const item = devices[i];
			if (item.deviceId == this.device.boundDeviceId) {
				bound = item;
			}
		}
		if (bound == null) return;
		this.handleBoundDeviceFound(bound);
		//#endif
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
			this.publishDebugInfo(d, hex, vHex, r);
			this.checkBroadcastTimestamp(r);
		} else if (this.boundBroadcastScanning == true) {
			console.log(`[BOOM-ADV] 绑定设备广播解析失败: ${d.deviceId}, raw=${hex}, v=${vHex}`);
		}
	}

	private publishDebugInfo(
		d: DeviceInfo,
		rawHex: string,
		vHex: string,
		r: RealtimeBroadcast
	): void {
		this.broadcastSeq = this.broadcastSeq + 1;
		const nowSec = Math.floor(Date.now() / 1000);
		let diff = nowSec - r.utc;
		if (diff < 0) diff = 0 - diff;
		const name = d.name ?? d.localName ?? "";
		const rssi = d.RSSI ?? 0;
		const summary = `phone=${nowSec} utc=${r.utc} diff=${diff}s status=0x${this.byteToHex(r.status)} ppg=${r.ppgAttached} behavior=${r.behavior}(${r.behaviorLabel}) activity=${r.activity}(${r.activityLabel}) hr=${r.hr} ppi=${r.ppi} spo2=${r.spo2Pct.toFixed(1)} bhr=${r.bhr} v=${r.voltageMv}mV`;
		const info: BroadcastDebugInfo = {
			seq: this.broadcastSeq,
			deviceId: d.deviceId,
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
		console.log(`[BOOM-ADV] 收到广播 #${info.seq}: ${summary}, raw=${rawHex}, v=${vHex}`);
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
		if (hex.length == 26) return hex;
		if (hex.length >= 34 && hex.substring(0, 8).toLowerCase() == "50000d00") {
			return hex.substring(8, 34);
		}
		if (hex.length > 26) {
			return hex.substring(hex.length - 26);
		}
		return "";
	}

	private checkBroadcastTimestamp(r: RealtimeBroadcast): void {
		if (r.utc <= 0) return;
		this.lastBroadcastUtc = r.utc;
		const nowSec = Math.floor(Date.now() / 1000);
		let diff = nowSec - r.utc;
		if (diff < 0) diff = 0 - diff;
		if (diff <= BROADCAST_TIME_DRIFT_SEC) return;
		const nowMs = Date.now();
		if (this.isTimeSyncing == true) return;
		if (nowMs - this.lastTimeSyncAt < BROADCAST_TIME_SYNC_COOLDOWN_MS) return;
		this.syncTimestampFromBroadcast(nowSec, r.utc, diff);
	}

	private async syncTimestampFromBroadcast(
		nowSec: number,
		broadcastUtc: number,
		diffSec: number
	): Promise<void> {
		if (this.device.status.value != "CONNECTED") return;
		this.isTimeSyncing = true;
		this.lastTimeSyncAt = Date.now();
		try {
			console.warn(
				`[BOOM-ADV] 广播时戳偏差 ${diffSec}s，重新设置设备时间: adv=${broadcastUtc}, phone=${nowSec}`
			);
			const ok = await this.device.protocol.setTimestamp(nowSec);
			if (ok == false) {
				console.warn("[BOOM-ADV] 广播校时发送失败");
			}
		} catch (e) {
			console.error("[BOOM-ADV] 广播校时异常:", e);
		} finally {
			this.isTimeSyncing = false;
		}
	}
}
