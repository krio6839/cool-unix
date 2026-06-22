/**
 * BOOM 设备 Mock 模拟器（开发/演示用）
 *
 * - 启动后每秒推送一次伪 0x50 广播数据 → device.realtime
 * - 接收 sendTlvc 命令 → 自生成响应 V → encodeTlvc → 与状态说明.txt 文档示例比对
 *   → 模拟 GATT notify 调 event.handleNotifyData(buffer)
 * - 真实 GATT 与 Mock 共享同一份 event-handler 解析代码
 *
 * 注意：本类仅在没有真实 BOOM 设备时使用，便于 UI 调试与演示。
 * 生产环境保持 device.useMock = false，走真实 GATT 流程。
 */

import type { Device } from "./index";
import {
	parseCustomAdvData,
	toRealtimeBroadcast,
	encodeU8,
	encodeU16LE,
	encodeI16LE,
	encodeU32LE,
	encodeAscii,
	encodeTlvc,
	hexStringToArrayBuffer,
	parseU32LE,
	parseU8,
	parseU16LE,
	parseAscii,
	DOC_EXAMPLES_BY_T,
	BOOM_CMD
} from "../../bluetooth";
import type { RealtimeBroadcast, VitalBiometric, DocExample } from "../../bluetooth";

/* UTS 不支持内联对象字面量类型，必须 type 声明 */
type DecodedTlvcPayload = {
	t: number;
	v: string;
};

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

	/* ===== GATT 命令响应的内部状态（SET 保存，READ 返回）===== */
	/** 设备编号（默认 "12345678"，与文档 1.4.4.2 示例 V 一致） */
	private _deviceNumber: string = "12345678";
	/** BOOM UTC 时戳（默认 0x386D4391 = 949118353，与文档 0x34 响应 V 一致） */
	private _timestamp: number = 0x386d4391;
	/** 生物识别（默认 30 岁男性 175cm/68.37kg，与原 mock 行为一致） */
	private _biometric: VitalBiometric = {
		gender: 0,
		weight: 6837,
		height: 17500,
		age: 30,
		ppgPosition: 0,
		bhr: 70
	};

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
			this.device.realtime.value = r;
		}
	}

	/* ===== GATT 命令-响应循环（mock 模拟设备行为）===== */

	/**
	 * Mock 设备接收 TLVC 命令 → 解析 T 码 → 生成响应 V → 编码 TLVC →
	 * 与状态说明.txt 文档示例比对 → 模拟 GATT notify 调 event.handleNotifyData
	 *
	 * 真实 GATT 与 Mock 共享 event-handler 解析代码
	 *
	 * @param t     命令码（T 字段）
	 * @param vHex  请求 V 字段 hex（SET 类命令才有值；READ 类命令为空字符串）
	 */
	handleCommand(t: number, vHex: string): void {
		// 1. 处理 SET 类命令（保存状态）+ 生成响应 V
		//    注意：0x32/0x34 的响应 T 码会"回显"为 0x31/0x33（文档 1.4.4.3 / 1.4.4.5）
		let responseV = "";
		switch (t) {
			case BOOM_CMD.READ_FIRMWARE_VERSION:
				responseV = "010003"; // 1.0.3 (与文档示例一致)
				break;

			case BOOM_CMD.SET_DEVICE_NUMBER:
				// 0x31 设置设备编号 → 保存 + V 回显
				this._deviceNumber = parseAscii(vHex);
				responseV = vHex;
				break;

			case BOOM_CMD.READ_DEVICE_NUMBER:
				// 0x32 读设备编号 → 响应 T 改写为 0x31（回显），V 字段是设备编号
				responseV = encodeAscii(this._deviceNumber);
				t = BOOM_CMD.SET_DEVICE_NUMBER;
				break;

			case BOOM_CMD.SET_BOOM_TIMESTAMP:
				// 0x33 设置时戳 → 保存 + V 回显
				this._timestamp = parseU32LE(vHex);
				responseV = vHex;
				break;

			case BOOM_CMD.READ_BOOM_TIMESTAMP:
				// 0x34 读时戳 → 响应 T 改写为 0x33（回显）
				responseV = encodeU32LE(this._timestamp);
				t = BOOM_CMD.SET_BOOM_TIMESTAMP;
				break;

			case BOOM_CMD.SET_BIOMETRIC:
				// 0x35 设置生物识别 → 保存 + V 回显
				this._biometric = this._parseBiometric(vHex);
				responseV = vHex;
				break;

			case BOOM_CMD.READ_BIOMETRIC:
				// 0x36 读生物识别
				responseV = this._serializeBiometric(this._biometric);
				break;

			case BOOM_CMD.CONTROL_VIBRATION:
				// 0x40 震动马达 → 响应 V = 1B 成功码
				responseV = encodeU8(0); // 0=成功
				break;

			default:
				console.warn("[BOOM-MOCK] 未知 T:", "0x" + t.toString(16));
				return;
		}

		// 2. 编码成完整 TLVC 帧（用真实 encodeTlvc，验证 CRC 路径）
		const tlvcFrame = encodeTlvc(t, responseV);

		// 3. 与文档示例比对（关键步骤！）
		this._verifyAgainstDoc(t, responseV, tlvcFrame);

		// 4. 转 ArrayBuffer（与 GATT notify 一致）
		const buffer = hexStringToArrayBuffer(tlvcFrame);

		// 5. 推送给 event-handler（与真实 notify 共用解析代码）
		this.device.event.handleNotifyData(buffer);
	}

	/**
	 * 用状态说明.txt 文档示例作为"事实标准"验证响应
	 * - 自生成 (0x30/0x32/0x34/0x36 读): 完整比对 TLVC 帧（验证 T/L/CRC/V 全正确）
	 * - 回显   (0x31/0x33/0x35 写):    V 是用户输入不可预测，只验证 TLVC 框架 T/L/CRC
	 *   注: 文档仅提供 0x30/0x31/0x32/0x33/0x34 共 6 组示例，0x35/0x36/0x40 无文档示例，跳过验证
	 */
	private _verifyAgainstDoc(t: number, responseV: string, generatedFrame: string): void {
		const examples: Array<DocExample> | null = DOC_EXAMPLES_BY_T.get(t) ?? null;
		if (examples == null) {
			// 文档无示例（如 0x35/0x36/0x40），跳过
			return;
		}

		const vLower = responseV.toLowerCase();
		const generatedLower = generatedFrame.toLowerCase();

		// 优先比对完整 TLVC 帧（不含 DataIdentifier 头，4 hex）
		// 这样能验证 T 码、字节布局、CRC 全部正确
		for (let i = 0; i < examples.length; i++) {
			const ex = examples[i];
			const exTlvc = ex.response.length >= 4 ? ex.response.substring(4).toLowerCase() : "";
			if (exTlvc == generatedLower) {
				console.log(`[BOOM-MOCK] ${ex.name} 完整 TLVC 帧通过文档示例验证 ✓`);
				return;
			}
		}

		// 回显类（0x31/0x33 SET）：V 是用户输入，不可预测 → TLVC 框架可能因 L 不同而不匹配
		// 自生成类：V 由 mock 内部状态决定，必须完全匹配 → 匹配失败时降级只比 V 字段
		const isEcho =
			t == BOOM_CMD.SET_DEVICE_NUMBER ||
			t == BOOM_CMD.SET_BOOM_TIMESTAMP ||
			t == BOOM_CMD.SET_BIOMETRIC;
		if (isEcho) {
			const ex = examples[0];
			const exTlvc = ex.response.length >= 4 ? ex.response.substring(4).toLowerCase() : "";
			if (exTlvc.length > 4 && generatedLower.startsWith(exTlvc.substring(0, 4))) {
				// T/L 头 4hex 匹配（不同长度的 V 不影响 T/L 比对）
				console.log(
					`[BOOM-MOCK] ${ex.name} TLVC 框架 (T+L) 通过文档示例验证 (V 是用户输入，未比对) ✓`
				);
			} else {
				console.log(
					`[BOOM-MOCK] ${ex.name} TLVC 框架未匹配 (V 是用户输入，未严格验证) - V="${vLower}"`
				);
			}
			return;
		}

		// 自生成类：降级只比 V 字段（不验证 T 码、CRC 全部，但验证业务内容）
		for (let i = 0; i < examples.length; i++) {
			const ex = examples[i];
			const exF = decodeTlvcPayload(ex.response);
			if (exF == null) continue;
			if (exF.v.toLowerCase() == vLower) {
				console.log(`[BOOM-MOCK] ${ex.name} V 字段匹配文档示例 (V=${vLower})`);
				return;
			}
		}

		console.warn(
			`[BOOM-MOCK] T=0x${t.toString(16)} 响应 V="${vLower}" 未匹配到文档示例`,
			`(已加载 ${examples.length} 组示例)`
		);
	}

	/* ===== 8B vital_biometric_info_t 解析/序列化辅助 ===== */

	/** 8B hex → VitalBiometric（小端序 packed 结构） */
	private _parseBiometric(vHex: string): VitalBiometric {
		let i = 0;
		const gender = parseU8(vHex, i);
		i += 2;
		const weight = parseU16LE(vHex, i);
		i += 4;
		const height = parseU16LE(vHex, i);
		i += 4;
		const age = parseU8(vHex, i);
		i += 2;
		const ppgPosition = parseU8(vHex, i);
		i += 2;
		const bhr = parseU8(vHex, i);
		return {
			gender: gender,
			weight: weight,
			height: height,
			age: age,
			ppgPosition: ppgPosition,
			bhr: bhr
		};
	}

	/** VitalBiometric → 8B hex（小端序 packed 结构） */
	private _serializeBiometric(b: VitalBiometric): string {
		return (
			encodeU8(b.gender) +
			encodeU16LE(b.weight) +
			encodeU16LE(b.height) +
			encodeU8(b.age) +
			encodeU8(b.ppgPosition) +
			encodeU8(b.bhr)
		);
	}
}

/**
 * 内部辅助：从完整 GATT hex（含 DataIdentifier 头）解码出 TLVC payload V
 * 文档示例 0x32 响应是 "0EC0310008003132333435363738C557"
 *   - DataIdentifier: 0EC0 (2B)
 *   - T: 3100 (2B LE → 0x31)
 *   - L: 0800 (2B LE → 8)
 *   - V: 3132333435363738 (8B ASCII)
 *   - C: C557 (2B CRC)
 */
function decodeTlvcPayload(fullHex: string): DecodedTlvcPayload | null {
	if (fullHex.length < 12) return null;
	// 跳过 DataIdentifier 头（2B = 4 hex）
	const tlvcStart = 4;
	const t = parseU16LE(fullHex, tlvcStart);
	const l = parseU16LE(fullHex, tlvcStart + 4);
	const v = fullHex.substring(tlvcStart + 8, tlvcStart + 8 + l * 2);
	return { t, v };
}
