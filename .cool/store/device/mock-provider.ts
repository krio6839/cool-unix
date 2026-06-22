/**
 * BOOM 设备 Mock 模拟器（开发/演示用）
 * - 启动后每秒推送一次伪 0x50 广播数据 → device.realtime
 * - 提供 mockReadXxx / mockSetXxx 方法模拟 GATT 响应
 * - 不走真实 kux 接口，纯本地内存模拟
 *
 * 注意：本类仅在没有真实 BOOM 设备时使用，便于 UI 调试与演示。
 * 生产环境保持 device.useMock = false，走真实 GATT 流程。
 */

import type { Device } from "./index";
import {
	parseCustomAdvData,
	toRealtimeBroadcast,
	parseFirmwareVersion,
	parseDeviceNumber,
	parseTimestamp,
	parseBiometric,
	parseVibrationResult
} from "../../bluetooth";
import type { RealtimeBroadcast } from "../../bluetooth";

export class MockProvider {
	private device: Device;
	private _timer: number = 0;
	private _hr: number = 72; // 心率基线
	private _spo2: number = 980; // 血氧基线（98.0%）
	private _voltage: number = 387; // 电池 3.87V
	private _behavior: number = 1; // 日常
	private _activity: number = 5; // 活动量高
	private _ppg: boolean = true;

	constructor(device: Device) {
		this.device = device;
	}

	/** 启动：每秒推送一次 0x50 广播 */
	start(): void {
		this.stop();
		//@ts-ignore
		this._timer = setInterval(() => {
			this._tick();
		}, 1000);
	}

	stop(): void {
		if (this._timer != 0) {
			clearInterval(this._timer);
			this._timer = 0;
		}
	}

	private _tick(): void {
		// 心率在基线附近 ±5 波动
		this._hr = 72 + Math.floor(Math.random() * 11) - 5;
		// 偶尔下降（模拟睡眠/放松）
		if (Math.random() < 0.1) {
			this._hr = 60 + Math.floor(Math.random() * 8);
			this._behavior = 0; // 休息
			this._activity = 3; // 精神放松
		} else {
			this._behavior = 1; // 日常
			this._activity = 5; // 活动量高
		}

		const status =
			((this._ppg ? 1 : 0) << 6) | ((this._behavior & 0x07) << 3) | (this._activity & 0x07);
		const utc = Math.floor(Date.now() / 1000);
		const ppi = 60000 / Math.max(this._hr, 1);
		const bhr = 70;

		// 手工拼 13B 广播 hex（LE）
		const vHex =
			this._u32le(utc) +
			this._i16le(this._voltage) +
			this._u8(status) +
			this._u8(this._hr) +
			this._u16le(Math.floor(ppi)) +
			this._u16le(this._spo2) +
			this._u8(bhr);

		const parsed = parseCustomAdvData(vHex);
		if (parsed != null) {
			const r: RealtimeBroadcast = toRealtimeBroadcast(parsed);
			this.device.realtime = r;
		}
	}

	/* ===== GATT 命令 mock 响应 ===== */

	mockReadFirmware(): string {
		const v = "010003"; // 1.0.3
		this.device.event.firmwareVersion = parseFirmwareVersion(v);
		return v;
	}

	mockSetDeviceNumber(s: string): string {
		let h = "";
		for (let i = 0; i < s.length; i++) {
			const code = s.charCodeAt(i);
			h += code.toString(16).padStart(2, "0");
		}
		this.device.event.deviceNumber = parseDeviceNumber(h);
		return h;
	}

	mockReadDeviceNumber(): string {
		const s = "ABCD-00012345";
		return this.mockSetDeviceNumber(s);
	}

	mockSetTimestamp(sec: number): string {
		const h = this._u32le(sec);
		this.device.event.boomTimestamp = parseTimestamp(h);
		return h;
	}

	mockReadTimestamp(): string {
		return this.mockSetTimestamp(Math.floor(Date.now() / 1000));
	}

	mockSetBiometric(b: {
		gender: number;
		weight: number;
		height: number;
		age: number;
		ppgPosition: number;
		bhr: number;
	}): string {
		const le16 = (n: number): string =>
			(n & 0xff).toString(16).padStart(2, "0") +
			((n >> 8) & 0xff).toString(16).padStart(2, "0");
		const h =
			b.gender.toString(16).padStart(2, "0") +
			le16(b.weight) +
			le16(b.height) +
			b.age.toString(16).padStart(2, "0") +
			b.ppgPosition.toString(16).padStart(2, "0") +
			b.bhr.toString(16).padStart(2, "0");
		this.device.event.biometricInfo = parseBiometric(h);
		return h;
	}

	mockReadBiometric(): string {
		return this.mockSetBiometric({
			gender: 0,
			weight: 6837,
			height: 17500,
			age: 30,
			ppgPosition: 0,
			bhr: 70
		});
	}

	mockControlVibration(_loops: number, _count: number, _onOffMs: number[]): string {
		const v = "00"; // 0=成功
		this.device.event.lastVibration = parseVibrationResult(v);
		return v;
	}

	/* ===== LE 编码辅助 ===== */

	private _u8(n: number): string {
		return (n & 0xff).toString(16).padStart(2, "0");
	}

	private _u16le(n: number): string {
		return (
			(n & 0xff).toString(16).padStart(2, "0") +
			((n >> 8) & 0xff).toString(16).padStart(2, "0")
		);
	}

	private _i16le(n: number): string {
		const v = n < 0 ? n + 0x10000 : n;
		return this._u16le(v);
	}

	private _u32le(n: number): string {
		return this._u16le(n & 0xffff) + this._u16le((n >>> 16) & 0xffff);
	}
}
