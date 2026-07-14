/**
 * BOOM 设备 TLVC 协议层
 *
 * 职责：
 * 1. 发现 BOOM GATT Service（75c276c3-8f97-20bc-a143-b354244886d4）下的 write / notify 特征
 * 2. 启用 notify
 * 3. 8 个高层命令的发送封装（0x30 / 0x31 / 0x32 / 0x33 / 0x34 / 0x35 / 0x36 / 0x40）
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
	serializeVitalDataQuery,
	serializeVitalContinueQuery,
	serializeEventDataQuery,
	serializeEventContinueQuery
} from "../../bluetooth";
import type {
	VibrationSpec,
	VitalBiometric,
	VitalDataQueryRequest,
	EventDataQuery
} from "../../bluetooth";

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
	/** 设备引用（用于回写状态） */
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
		// 等待设备连接稳定
		await new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				resolve();
			}, 500);
		});

		let services: GetBLEDeviceServicesSuccessService[] = [];
		let retryCount = 0;
		const maxRetries = 3;

		// 重试机制获取 services
		while (retryCount < maxRetries) {
			try {
				services = await getServices(deviceId);
				if (services && services.length > 0) {
					break;
				}
				console.warn(`[BOOM-PROTO] 获取 services 为空，第 ${retryCount + 1} 次重试`);
			} catch (error) {
				console.warn(
					`[BOOM-PROTO] 获取 services 失败，第 ${retryCount + 1} 次重试:`,
					error
				);
			}

			retryCount++;
			if (retryCount < maxRetries) {
				await new Promise<void>((resolve, reject) => {
					setTimeout(() => {
						resolve();
					}, 1000);
				});
			}
		}

		if (!services || services.length === 0) {
			throw new Error(`无法获取设备 ${deviceId} 的 services，已重试 ${maxRetries} 次`);
		}

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

	/**
	 * 内部：发一个 TLVC 命令（自动包成单帧 DataIdentifier）
	 * 通过 GATT write 写给设备
	 */
	private async sendTlvc(t: number, vHex: string): Promise<boolean> {
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
	 * 直接发送一条完整 GATT 帧 hex（DataIdentifier + TLVC + CRC）
	 * 仅用于"快速发送示例"按钮，绕过高层命令封装
	 * @param hex 完整帧 hex（奇数长度 / 长度异常由调用方保证）
	 */
	async sendRawFrame(hex: string): Promise<boolean> {
		//#ifndef H5
		if (this.writeCharUuid == "") return false;
		return writeCharacteristic(
			this.device.currentDeviceId,
			BOOM_GATT_SERVICE_UUID,
			this.writeCharUuid,
			hexStringToArrayBuffer(hex),
			"write"
		);
		//#endif
		return false;
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

	/** 0x40 震动马达控制（onOffMs 长度=count*2-1；count 上限 10） */
	controlVibration(spec: VibrationSpec): Promise<boolean> {
		if (spec.count < 1 || spec.count > 10) {
			console.warn(`[BOOM-PROTO] 0x40 count=${spec.count} 非法（应为1~10）`);
			return Promise.resolve(false);
		}
		if (spec.onOffMs.length != spec.count * 2 - 1) {
			console.warn("[BOOM-PROTO] 0x40 onOffMs 长度应为 count*2-1");
			return Promise.resolve(false);
		}
		return this.sendTlvc(BOOM_CMD.CONTROL_VIBRATION, serializeVibration(spec));
	}

	/* ===== 0x3A/0x3B 历史生命体征（1.4.4.8/1.4.4.9） ===== */

	/**
	 * 0x3A 开始读生命体征数据
	 * @param req.startSec UTC 秒
	 * @param req.direction 0=向前 1=向后
	 * @param req.minutes 2 或 5
	 */
	readVitalData(req: VitalDataQueryRequest): Promise<boolean> {
		if (req.minutes != 2 && req.minutes != 5) {
			console.warn(`[BOOM-PROTO] 0x3A minutes=${req.minutes} 非法（应=2或5）`);
			return Promise.resolve(false);
		}
		return this.sendTlvc(BOOM_CMD.READ_VITAL_DATA_START, serializeVitalDataQuery(req));
	}

	/** 0x3B 继续读生命体征数据（minutes 只能是 2 或 5） */
	continueReadVitalData(minutes: number): Promise<boolean> {
		if (minutes != 2 && minutes != 5) {
			console.warn(`[BOOM-PROTO] 0x3B minutes=${minutes} 非法（应=2或5）`);
			return Promise.resolve(false);
		}
		return this.sendTlvc(
			BOOM_CMD.READ_VITAL_DATA_CONTINUE,
			serializeVitalContinueQuery(minutes)
		);
	}

	/* ===== 0x3C/0x3D 事件日志（1.4.4.10/1.4.4.11） ===== */

	/** 0x3C 开始读事件数据 */
	readEventData(req: EventDataQuery): Promise<boolean> {
		return this.sendTlvc(BOOM_CMD.READ_EVENT_DATA_START, serializeEventDataQuery(req));
	}

	/** 0x3D 继续读事件数据（maxCount 最大条数） */
	continueReadEventData(maxCount: number): Promise<boolean> {
		if (maxCount < 0) {
			console.warn(`[BOOM-PROTO] 0x3D maxCount=${maxCount} 不能为负`);
			return Promise.resolve(false);
		}
		return this.sendTlvc(
			BOOM_CMD.READ_EVENT_DATA_CONTINUE,
			serializeEventContinueQuery(maxCount)
		);
	}
}
