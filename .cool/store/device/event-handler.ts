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
	parseVitalDataResponse,
	parseEventDataHeader,
	parseLogDataList,
	DataIdentifierReassembler
} from "../../bluetooth";
import type {
	FirmwareVersion,
	VitalBiometric,
	VibrationResult,
	VitalDataQueryResponse,
	EventDataHeaderResponse,
	LogDataItem
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
	/** 0x35/0x36 生物识别 */
	biometricInfo = ref<VitalBiometric | null>(null);
	/** 0x35/0x36 生物识别响应序号（即使内容相同也递增） */
	biometricInfoSeq = ref<number>(0);
	/** 0x35/0x36 最近一次生物识别响应到达时间 */
	biometricInfoReceivedAt = ref<number>(0);
	/** 0x40 震动马达最后一次响应 */
	lastVibration = ref<VibrationResult | null>(null);
	/** 0x3A/0x3B 最近一次生命体征查询结果（多帧重组后） */
	vitalDataResponse = ref<VitalDataQueryResponse | null>(null);
	/** 0x3C 事件头（最早/最晚 sn + ts） */
	eventDataHeader = ref<EventDataHeaderResponse | null>(null);
	/** 0x3C/0x3D 累积事件列表（按到达顺序追加） */
	eventDataList = ref<LogDataItem[]>([]);

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
			/* ===== 0x3A/0x3B 生命体征（多帧重组） ===== */
			case BOOM_CMD.READ_VITAL_DATA_START:
			case BOOM_CMD.READ_VITAL_DATA_CONTINUE:
				this._handleVitalData(f.v, f.t);
				break;
			/* ===== 0x3C/0x3D 事件数据 ===== */
			case BOOM_CMD.READ_EVENT_DATA_START:
			case BOOM_CMD.READ_EVENT_DATA_CONTINUE:
				this._handleEventData(f.v, f.t);
				break;
			default:
				console.log("[BOOM] 未知 T:", f.t, "数据:", hexData);
		}
	}

	/**
	 * 处理 0x3A/0x3B 响应（多帧重组由 handleNotifyData 完成，到此处 f.v 已是完整 payload）
	 */
	private _handleVitalData(vHex: string, t: number): void {
		const resp = parseVitalDataResponse(vHex);
		this.vitalDataResponse.value = resp;
		const validCount = resp.vitalData.filter((d) => d.valid == true).length;
		console.log(
			`[BOOM] 生命体征响应: t=0x${t.toString(16)}, n=${resp.n}, vitalCount=${resp.vitalData.length}, validCount=${validCount}`
		);
	}

	/**
	 * 处理 0x3C/0x3D 响应
	 * - 0x3C: 17B 头（最早/最晚 sn + ts）
	 * - 0x3D: 多条 Log_Data_t 串联
	 */
	private _handleEventData(vHex: string, t: number): void {
		// 文档表格把续读响应写成 0x3C，示例则是 0x3D；17B 头长度可用于兼容判断。
		if (t == BOOM_CMD.READ_EVENT_DATA_START && vHex.length == 34) {
			// 0x3C：先解析头（17B）
			this.eventDataHeader.value = parseEventDataHeader(vHex);
			console.log(
				`[BOOM] 事件头: type=${this.eventDataHeader.value?.type}, earliestSn=${this.eventDataHeader.value?.earliestSn}, latestSn=${this.eventDataHeader.value?.latestSn}`
			);
		} else {
			// 0x3D（或固件返回的 0x3C）：多条 Log_Data_t
			// Byte 0 为协议固定字段，Log_Data_t 从 Byte 1 开始。
			const r = parseLogDataList(vHex, 2);
			if (r.items.length > 0) {
				// 追加到累积列表
				this.eventDataList.value = this.eventDataList.value.concat(r.items);
				console.log(
					`[BOOM] 事件追加: count=${r.items.length}, total=${this.eventDataList.value.length}`
				);
			}
		}
	}
}
