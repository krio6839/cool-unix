/**
 * BOOM 设备 Mock 模拟器（开发/演示用）
 *
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
	parseVibrationResult,
	encodeU8,
	encodeU16LE,
	encodeI16LE,
	encodeU32LE,
	encodeAscii
} from "../../bluetooth";
import type { RealtimeBroadcast, VitalBiometric } from "../../bluetooth";

export class MockProvider {
	private device: Device;

	/* ===== 模拟内部状态（每 tick 抖动）===== */
	private _timer: number = 0;
	private _hr: number = 72; // 心率基线（bpm）
	private _spo2: number = 980; // 血氧基线（98.0%，×10）
	private _voltage: number = 387; // 电池电压（3.87V，mV）
	private _behavior: number = 1; // 当前行为（0=休息 1=日常 2=步行 …）
	private _activity: number = 5; // 当前活动量（4=低 5=高）
	private _ppg: boolean = true; // 是否佩戴 PPG

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

	/** 停止定时器 */
	stop(): void {
		if (this._timer != 0) {
			clearInterval(this._timer);
			this._timer = 0;
		}
	}

	/**
	 * 每秒 tick：随机抖动心率 + 10% 概率切到睡眠/放松
	 * → 手工拼 13B 广播 hex → parseCustomAdvData → 写入 device.realtime
	 */
	private _tick(): void {
		// 心率在基线附近 ±5 波动
		this._hr = 72 + Math.floor(Math.random() * 11) - 5;
		if (Math.random() < 0.1) {
			// 偶尔下降：模拟睡眠/放松
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
		const ppi = Math.floor(60000 / Math.max(this._hr, 1));
		const bhr = 70;

		// 手工拼 13B 广播 hex（LE）
		const vHex =
			encodeU32LE(utc) +
			encodeI16LE(this._voltage) +
			encodeU8(status) +
			encodeU8(this._hr) +
			encodeU16LE(ppi) +
			encodeU16LE(this._spo2) +
			encodeU8(bhr);

		const parsed = parseCustomAdvData(vHex);
		if (parsed != null) {
			const r: RealtimeBroadcast = toRealtimeBroadcast(parsed);
			this.device.realtime = r;
		}
	}

	/* ===== GATT 命令 mock 响应（写入 device.event）===== */

	/** 0x30 读固件版本（mock 返回 "1.0.3"） */
	mockReadFirmware(): string {
		const v = "010003";
		this.device.event.firmwareVersion = parseFirmwareVersion(v);
		return v;
	}

	/** 0x31 写设备编号 */
	mockSetDeviceNumber(s: string): string {
		const h = encodeAscii(s);
		this.device.event.deviceNumber = parseDeviceNumber(h);
		return h;
	}

	/** 0x32 读设备编号（mock 返回 "ABCD-00012345"） */
	mockReadDeviceNumber(): string {
		return this.mockSetDeviceNumber("ABCD-00012345");
	}

	/** 0x33 写时戳 */
	mockSetTimestamp(sec: number): string {
		const h = encodeU32LE(sec);
		this.device.event.boomTimestamp = parseTimestamp(h);
		return h;
	}

	/** 0x34 读时戳（mock 返回当前时间） */
	mockReadTimestamp(): string {
		return this.mockSetTimestamp(Math.floor(Date.now() / 1000));
	}

	/** 0x35 写生物识别 */
	mockSetBiometric(b: VitalBiometric): string {
		const h =
			encodeU8(b.gender) +
			encodeU16LE(b.weight) +
			encodeU16LE(b.height) +
			encodeU8(b.age) +
			encodeU8(b.ppgPosition) +
			encodeU8(b.bhr);
		this.device.event.biometricInfo = parseBiometric(h);
		return h;
	}

	/** 0x36 读生物识别（mock 返回默认 30 岁男性 175cm/68.37kg） */
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

	/**
	 * 0x40 震动马达控制（mock 总是返回成功）
	 * @param _loops  循环次数（保留参数，后续可按 loops 模拟间隔）
	 * @param _count  震动次数（保留参数）
	 * @param _onOffMs on/off 时长数组（保留参数）
	 */
	mockControlVibration(_loops: number, _count: number, _onOffMs: number[]): string {
		const v = encodeU8(0); // 0=成功
		this.device.event.lastVibration = parseVibrationResult(v);
		return v;
	}
}
