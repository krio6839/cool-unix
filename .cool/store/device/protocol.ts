/**
 * BOOM 设备 TLVC 协议层
 *
 * 职责：
 * 1. 发现 BOOM GATT Service（75c276c3-8f97-20bc-a143-b354244886d4）下的 write / notify 特征
 * 2. 启用 notify
 * 3. 8 个高层命令的发送封装（0x30 / 0x31 / 0x32 / 0x33 / 0x34 / 0x35 / 0x36 / 0x40）
 * 4. Mock 模式：命令直接走 MockProvider，不下发真实 GATT
 */

import {
	hexStringToArrayBuffer,
	BOOM_GATT_SERVICE_UUID,
	encodeTlvc,
	wrapDataIdentifier,
	BOOM_CMD,
	serializeDeviceNumber,
	serializeTimestamp,
	serializeBiometric,
	serializeVibration,
	parseU8,
	parseU16LE,
	parseAscii
} from "../../bluetooth";
import type { VibrationSpec, VitalBiometric } from "../../bluetooth";

//#ifndef H5
import {
	getServices,
	getCharacteristics,
	writeCharacteristic,
	notifyCharacteristic
} from "../../bluetooth/kux";
import type {
	GetBLEDeviceServicesSuccessService,
	BLEDeviceCharacteristic
} from "../../bluetooth/kux";
//#endif

import type { Device } from "./index";

export class DeviceProtocol {
	/** 设备引用（用于回写状态 + Mock 分支） */
	private device: Device;

	/** 当前设备的 services 列表（动态发现） */
	services: Array<GetBLEDeviceServicesSuccessService> = [];
	/** uuid → characteristics 映射（动态发现） */
	characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

	/** BOOM 设备的 write 特征 UUID（动态发现） */
	writeCharUuid: string = "";
	/** BOOM 设备的 notify 特征 UUID（动态发现） */
	notifyCharUuid: string = "";

	constructor(device: Device) {
		this.device = device;
	}

	/**
	 * 获取设备所有 services + characteristics，并从中动态发现 BOOM GATT 服务的 write / notify 特征 UUID
	 */
	async getDeviceServicesAndCharacteristics(deviceId: string): Promise<void> {
		//#ifndef H5
		const services = await getServices(deviceId);
		this.services = services;
		const results = await Promise.all(
			services.map((s: GetBLEDeviceServicesSuccessService) =>
				getCharacteristics(deviceId, s.uuid)
			)
		);
		services.forEach((s, i) => {
			const chars = results[i] ?? [];
			this.characteristics.set(s.uuid, chars);
		});

		// 发现 BOOM GATT 服务的 write / notify 特征
		for (let i = 0; i < this.services.length; i++) {
			const s = this.services[i];
			if (s == null) continue;
			if (s.uuid.toLowerCase() != BOOM_GATT_SERVICE_UUID.toLowerCase()) continue;
			const chars = this.characteristics.get(s.uuid);
			if (chars == null) continue;
			for (let j = 0; j < chars.length; j++) {
				const c = chars[j];
				if (c == null) continue;
				const p = c.properties;
				if (p == null) continue;
				if (p.write == true && this.writeCharUuid == "") this.writeCharUuid = c.uuid;
				if ((p.notify == true || p.indicate == true) && this.notifyCharUuid == "")
					this.notifyCharUuid = c.uuid;
			}
		}
		//#endif
	}

	/** 启用 BOOM GATT notify */
	async enableNotify(): Promise<boolean> {
		//#ifndef H5
		if (this.notifyCharUuid == "") return false;
		return notifyCharacteristic(
			this.device.currentDeviceId,
			BOOM_GATT_SERVICE_UUID,
			this.notifyCharUuid,
			true,
			"notification"
		);
		//#endif
		return false;
	}

	/** 内部：发一个 TLVC 命令（自动包成单帧 DataIdentifier） */
	private async sendTlvc(t: number, vHex: string): Promise<boolean> {
		// Mock 模式：直接走 MockProvider，不下发真实 GATT
		if (this.device.useMock) {
			this._dispatchMock(t, vHex);
			return true;
		}
		//#ifndef H5
		if (this.writeCharUuid == "") return false;
		const frame = wrapDataIdentifier(encodeTlvc(t, vHex));
		return writeCharacteristic(
			this.device.currentDeviceId,
			BOOM_GATT_SERVICE_UUID,
			this.writeCharUuid,
			hexStringToArrayBuffer(frame),
			"write"
		);
		//#endif
		return false;
	}

	/**
	 * Mock 模式：按 T 码调用 MockProvider 对应方法
	 * 不走真实 GATT，纯本地内存模拟，让 TestPopup 不连真设备也能看到 event 字段更新
	 */
	private _dispatchMock(t: number, vHex: string): void {
		switch (t) {
			case BOOM_CMD.READ_FIRMWARE_VERSION:
				this.device.mock.mockReadFirmware();
				break;
			case BOOM_CMD.SET_DEVICE_NUMBER:
				this.device.mock.mockSetDeviceNumber(parseAscii(vHex));
				break;
			case BOOM_CMD.READ_DEVICE_NUMBER:
				this.device.mock.mockReadDeviceNumber();
				break;
			case BOOM_CMD.SET_BOOM_TIMESTAMP:
				this.device.mock.mockSetTimestamp(this._u32FromHex(vHex));
				break;
			case BOOM_CMD.READ_BOOM_TIMESTAMP:
				this.device.mock.mockReadTimestamp();
				break;
			case BOOM_CMD.SET_BIOMETRIC:
				this.device.mock.mockSetBiometric(this._parseBiometric(vHex));
				break;
			case BOOM_CMD.READ_BIOMETRIC:
				this.device.mock.mockReadBiometric();
				break;
			case BOOM_CMD.CONTROL_VIBRATION:
				this.device.mock.mockControlVibration(
					parseU8(vHex, 0),
					parseU8(vHex, 2),
					this._parseVibrationOnOff(vHex)
				);
				break;
			default:
				console.warn("[BOOM-MOCK] 未知 T:", t);
		}
	}

	/* ===== Mock 辅助：把 V 字段 hex 解码为业务对象 ===== */

	/** U32 LE 解析（带长度校验） */
	private _u32FromHex(h: string): number {
		if (h.length < 8) return 0;
		return parseU16LE(h, 0) | (parseU16LE(h, 4) << 16);
	}

	/** VitalBiometric 解码（8B packed LE） */
	private _parseBiometric(v: string): VitalBiometric {
		if (v.length < 16) {
			return { gender: 0, weight: 0, height: 0, age: 0, ppgPosition: 0, bhr: 0 };
		}
		return {
			gender: parseU8(v, 0),
			weight: parseU16LE(v, 2),
			height: parseU16LE(v, 6),
			age: parseU8(v, 10),
			ppgPosition: parseU8(v, 12),
			bhr: parseU8(v, 14)
		};
	}

	/** 震动 on/off 数组（count*2 项） */
	private _parseVibrationOnOff(v: string): number[] {
		const count = parseU8(v, 2);
		const out: number[] = [];
		for (let i = 0; i < count * 2; i++) {
			out.push(parseU16LE(v, 4 + i * 4));
		}
		return out;
	}

	/* ===== 0x30 ~ 0x40 高层命令 ===== */

	/** 0x30 读固件版本（响应 V=3B） */
	readFirmwareVersion(): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.READ_FIRMWARE_VERSION, "");
	}

	/** 0x31 写设备编号（请求 V=ASCII） */
	setDeviceNumber(s: string): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.SET_DEVICE_NUMBER, serializeDeviceNumber(s));
	}

	/** 0x32 读设备编号（响应 V=ASCII） */
	readDeviceNumber(): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.READ_DEVICE_NUMBER, "");
	}

	/** 0x33 写 UTC 时戳（请求 V=4B U32 LE） */
	setTimestamp(sec: number): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.SET_BOOM_TIMESTAMP, serializeTimestamp(sec));
	}

	/** 0x34 读 UTC 时戳（响应 V=4B U32 LE） */
	readTimestamp(): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.READ_BOOM_TIMESTAMP, "");
	}

	/** 0x35 写生物识别（请求 V=8B） */
	setBiometric(b: VitalBiometric): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.SET_BIOMETRIC, serializeBiometric(b));
	}

	/** 0x36 读生物识别（响应 V=8B） */
	readBiometric(): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.READ_BIOMETRIC, "");
	}

	/** 0x40 震动马达控制（请求 V=loops+count+n×2B on/off；count 上限 10） */
	controlVibration(spec: VibrationSpec): Promise<boolean> {
		if (spec.count > 10) spec.count = 10;
		return this.sendTlvc(BOOM_CMD.CONTROL_VIBRATION, serializeVibration(spec));
	}
}
