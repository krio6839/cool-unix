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
	parseU16LE,
	parseDataIdentifier,
	parseFirmwareVersion,
	parseDeviceNumber,
	parseTimestamp,
	parseBiometric,
	parseVibrationResult,
	parseDeviceControlResult,
	DataIdentifierReassembler
} from "../../bluetooth";
import type {
	DeviceControlResult,
	FirmwareVersion,
	VitalBiometric,
	VibrationResult
} from "../../bluetooth";

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
	/** 0x33/0x34 时戳响应序号（用于连接初始化等待 0x34 回包） */
	boomTimestampSeq = ref<number>(0);
	/** 0x35/0x36 生物识别 */
	biometricInfo = ref<VitalBiometric | null>(null);
	/** 0x35/0x36 生物识别响应序号（即使内容相同也递增） */
	biometricInfoSeq = ref<number>(0);
	/** 0x35/0x36 最近一次生物识别响应到达时间 */
	biometricInfoReceivedAt = ref<number>(0);
	/** 0x40 震动马达最后一次响应 */
	lastVibration = ref<VibrationResult | null>(null);
	/** 0x41 设备控制最后一次响应 */
	lastDeviceControl = ref<DeviceControlResult | null>(null);
	deviceControlSeq = ref<number>(0);
	deviceControlReceivedAt = ref<number>(0);

	/** 任意 BOOM notify 到达序号（用于自动补拉超时诊断） */
	notifySeqValue: number = 0;
	/** 最近一次 BOOM notify 到达时间（Date.now 毫秒） */
	lastNotifyAtValue: number = 0;
	/** 0x33/0x34 时戳响应序号原始值 */
	boomTimestampSeqValue: number = 0;
	/** 最近一次时戳响应 T 码（0x33 或 0x34） */
	boomTimestampLastT: number = 0;

	private device: Device;

	/** 0x3A/0x3B 多帧重组器（跨多帧 DI 拼成完整 V） */
	private _vitalReassembler: DataIdentifierReassembler = new DataIdentifierReassembler();

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
	 * 处理 GATT notify 数据
	 * 路径: arrayBufferToHexString → DI 检测（多帧时重组） → decodeTlvc (CRC 校验) → 按 T 码分派到 event 字段
	 *
	 * DI 检测：前 2B 16-bit LE，若 bit15 或 bit14 非 0，视为 DataIdentifier 头
	 *   - 单帧（Start+End）：重组器只收到一帧，直接返回 payload
	 * - 多帧：累计到 End 帧后返回完整 payload
	 */
	handleNotifyData(value: ArrayBuffer): void {
		const hexData = arrayBufferToHexString(value);
		let tlvcHex = hexData;
		this.notifySeqValue = this.notifySeqValue + 1;
		this.lastNotifyAtValue = Date.now();
		console.log(`[BOOM] notify hex=${hexData}`);
		this.device.addProtocolLog("RX", "notify", hexData, "");

		// DI 检测：bit 15 (0x8000) 或 bit 14 (0x4000) 非 0 → DI 帧
		if (this._vitalReassembler.expectsContinuationFragment()) {
			const reassembled = this._vitalReassembler.push(hexData);
			if (reassembled == null) {
				return;
			}
			tlvcHex = reassembled;
		} else if (hexData.length >= 4) {
			const firstTwoBytes = parseU16LE(hexData, 0);
			if ((firstTwoBytes & 0xc000) != 0) {
				const di = parseDataIdentifier(hexData);
				if (
					di != null &&
					di.isStart == true &&
					di.isEnd == true &&
					hexData.length >= 4 + di.validBytes * 2
				) {
					tlvcHex = hexData.substring(4, 4 + di.validBytes * 2);
				} else {
					// 多帧或单个 DI payload 被底层 notify 拆片
					const reassembled = this._vitalReassembler.push(hexData);
					if (reassembled == null) {
						// 还在接收中，等待后续帧
						return;
					}
					// 重组完成 → 走正常 TLVC 解析
					tlvcHex = reassembled;
				}
			}
		}

		const f = decodeTlvc(tlvcHex);
		if (f == null) {
			console.warn("[BOOM] CRC 校验失败:", tlvcHex);
			this.device.addProtocolLog("ERR", "CRC 校验失败", tlvcHex, "");
			return;
		}
		if (f.l == 0) {
			console.warn(`[BOOM] 设备返回参数或格式错误: t=0x${f.t.toString(16)}`);
			this.device.addProtocolLog("ERR", `0x${f.t.toString(16)} 空响应`, tlvcHex, "");
			return;
		}
		this.device.addProtocolLog(
			"INFO",
			`解析 0x${f.t.toString(16)}`,
			tlvcHex,
			`L=${f.l}, V=${f.v}`
		);

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
				this.boomTimestampSeqValue = this.boomTimestampSeqValue + 1;
				this.boomTimestampSeq.value = this.boomTimestampSeqValue;
				this.boomTimestampLastT = f.t;
				console.log("[BOOM] 时戳:", this.boomTimestamp.value);
				break;
			case BOOM_CMD.SET_BIOMETRIC:
			case BOOM_CMD.READ_BIOMETRIC:
				this.biometricInfo.value = parseBiometric(f.v);
				this.biometricInfoSeq.value = this.biometricInfoSeq.value + 1;
				this.biometricInfoReceivedAt.value = Date.now();
				console.log("[BOOM] 生物识别:", this.biometricInfo.value);
				break;
			case BOOM_CMD.CONTROL_VIBRATION:
				this.lastVibration.value = parseVibrationResult(f.v);
				console.log("[BOOM] 震动结果:", this.lastVibration.value);
				break;
			case BOOM_CMD.CONTROL_DEVICE:
				this.lastDeviceControl.value = parseDeviceControlResult(f.v);
				this.deviceControlSeq.value = this.deviceControlSeq.value + 1;
				this.deviceControlReceivedAt.value = Date.now();
				console.log("[BOOM] 设备控制结果:", this.lastDeviceControl.value);
				break;
			/* ===== 0x3A/0x3B 生命体征（多帧重组） ===== */
			case BOOM_CMD.READ_VITAL_DATA_START:
			case BOOM_CMD.READ_VITAL_DATA_CONTINUE:
				this.device.history.handleVitalData(f.v, f.t);
				break;
			/* ===== 0x3C/0x3D 事件数据 ===== */
			case BOOM_CMD.READ_EVENT_DATA_START:
			case BOOM_CMD.READ_EVENT_DATA_CONTINUE:
				this.device.history.handleEventData(f.v, f.t);
				break;
			default:
				console.log("[BOOM] 未知 T:", f.t, "数据:", hexData);
		}
	}
}
