/**
 * BOOM 设备事件处理器
 *
 * 监听 GATT notify → arrayBuffer → TLVC → CRC 校验 → 按 T 码分派到 event 字段。
 * 每个响应字段对应一个 T 码，UI 通过响应式 ref 直接读取。
 */

import {
	arrayBufferToHexString,
	decodeTlvc,
	BOOM_GATT_SERVICE_UUID,
	BOOM_CMD,
	parseFirmwareVersion,
	parseDeviceNumber,
	parseTimestamp,
	parseBiometric,
	parseVibrationResult
} from "../../bluetooth";
import type { FirmwareVersion, VitalBiometric, VibrationResult } from "../../bluetooth";

//#ifndef H5
import { onCharacteristicValueChange } from "../../bluetooth/kux";
//#endif

import { ref } from "vue";
import type { Device } from "./index";

export class EventHandler {
	/* ===== 响应字段（按 T 码分派，ref 响应式）===== */

	/** 0x30 读固件版本响应 */
	firmwareVersion = ref<FirmwareVersion | null>(null);
	/** 0x31/0x32 设备编号（ASCII） */
	deviceNumber = ref<string>("");
	/** 0x33/0x34 BOOM UTC 时戳（秒） */
	boomTimestamp = ref<number>(0);
	/** 0x35/0x36 生物识别 */
	biometricInfo = ref<VitalBiometric | null>(null);
	/** 0x40 震动马达最后一次响应 */
	lastVibration = ref<VibrationResult | null>(null);

	private device: Device;

	constructor(device: Device) {
		this.device = device;
	}

	/**
	 * 订阅 BOOM GATT Service 的 notify characteristic
	 * 收到 arrayBuffer → 转给 handleNotifyData 统一处理
	 */
	onCharacteristicValueChange(): void {
		//#ifndef H5
		onCharacteristicValueChange((res) => {
			// 过滤：只处理 BOOM GATT Service
			const serviceId = (res.serviceId ?? "").toLowerCase();
			if (serviceId != BOOM_GATT_SERVICE_UUID.toLowerCase()) return;
			this.handleNotifyData(res.value);
		});
		//#endif
	}

	/**
	 * 处理 GATT notify 收到的 ArrayBuffer
	 * 路径: arrayBufferToHexString → decodeTlvc (CRC 校验) → 按 T 码分派到 event 字段
	 *
	 * 真实 GATT 与 Mock 共用此方法（mock 模拟 notify 时也调它）
	 */
	handleNotifyData(value: ArrayBuffer): void {
		const hexData = arrayBufferToHexString(value);
		const f = decodeTlvc(hexData);
		if (f == null) {
			console.warn("[BOOM] CRC 校验失败:", hexData);
			return;
		}

		// 按 T 码分派到对应字段
		switch (f.t) {
			case BOOM_CMD.READ_FIRMWARE_VERSION:
				this.firmwareVersion.value = parseFirmwareVersion(f.v);
				console.log("[BOOM] 固件版本:", this.firmwareVersion.value);
				break;
			case BOOM_CMD.SET_DEVICE_NUMBER:
			case BOOM_CMD.READ_DEVICE_NUMBER:
				this.deviceNumber.value = parseDeviceNumber(f.v);
				console.log("[BOOM] 设备编号:", this.deviceNumber.value);
				break;
			case BOOM_CMD.SET_BOOM_TIMESTAMP:
			case BOOM_CMD.READ_BOOM_TIMESTAMP:
				this.boomTimestamp.value = parseTimestamp(f.v);
				console.log("[BOOM] 时戳:", this.boomTimestamp.value);
				break;
			case BOOM_CMD.SET_BIOMETRIC:
			case BOOM_CMD.READ_BIOMETRIC:
				this.biometricInfo.value = parseBiometric(f.v);
				console.log("[BOOM] 生物识别:", this.biometricInfo.value);
				break;
			case BOOM_CMD.CONTROL_VIBRATION:
				this.lastVibration.value = parseVibrationResult(f.v);
				console.log("[BOOM] 震动结果:", this.lastVibration.value);
				break;
			default:
				console.log("[BOOM] 未知 T:", f.t, "数据:", hexData);
		}
	}
}
