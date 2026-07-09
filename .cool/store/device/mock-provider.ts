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
	BOOM_CMD,
	splitDataIdentifier,
	wrapDataIdentifierMulti,
	VITAL_DATA_INVALID,
	LOG_EVENT_TYPE
} from "../../bluetooth";
import type {
	RealtimeBroadcast,
	VitalBiometric,
	DocExample,
	VitalDataPerSecond,
	LogDataItem
} from "../../bluetooth";

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

	/* ===== 0x3A/0x3B 生命体征数据 mock 状态 ===== */
	/** 模拟 5 分钟生命体征缓存（key = 秒级 ts，value = 6B VitalDataPerSecond hex） */
	private _vitalCache: Map<number, string> = new Map();
	/** 上次 0x3A/0x3B 响应的最后一秒 ts（用于 0x3B 续读偏移） */
	private _vitalLastReturnedSec: number = 0;
	/** _vitalCache 起始时间戳（5 分钟回看：_vitalCacheStartSec ~ _vitalCacheStartSec + 300） */
	private _vitalCacheStartSec: number = 0;

	/* ===== 0x3C/0x3D 事件日志 mock 状态 ===== */
	/** 模拟事件队列（默认 10 条不同类型事件，sn 从 0x23 起递增） */
	private _eventCache: LogDataItem[] = [];
	/** 事件已发出游标（nextReadIndex 之前的已发出，0x3D 续读时从该位置开始） */
	private _eventNextReadIndex: number = 0;

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
				// 注意：最大长度 29 由 DEVICE_NUMBER_MAX_LEN 常量定义（boom-constants.ts）
				// UTS 编译器不支持跨模块 const 导入校验，故用硬编码值
				if (this._deviceNumber.length > 29) {
					console.warn(
						`[BOOM-MOCK] 设备编号超长 (${this._deviceNumber.length}/29): "${this._deviceNumber}"`
					);
				}
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

			case BOOM_CMD.READ_VITAL_DATA_START:
				// 0x3A 开始读生命体征 → 多帧响应（用 splitDataIdentifier 切分）
				this._initVitalCacheIfNeeded();
				responseV = this._buildVitalResponseV(vHex, false);
				// 多帧：直接返回，后续通过 _emitVitalMultiFrames 推送
				this._emitVitalMultiFrames(t, responseV);
				return;

			case BOOM_CMD.READ_VITAL_DATA_CONTINUE:
				// 0x3B 继续读生命体征
				this._initVitalCacheIfNeeded();
				responseV = this._buildVitalResponseV(vHex, true);
				this._emitVitalMultiFrames(t, responseV);
				return;

			case BOOM_CMD.READ_EVENT_DATA_START:
				// 0x3C 开始读事件 → 响应 17B 头（按文档）
				this._initEventCacheIfNeeded();
				responseV = this._buildEventHeaderV();
				break;

			case BOOM_CMD.READ_EVENT_DATA_CONTINUE:
				// 0x3D 继续读事件 → 多条 Log_Data_t 串联（可能多帧）
				this._initEventCacheIfNeeded();
				responseV = this._buildEventListV(vHex);
				// 多帧：直接返回，后续通过 _emitEventMultiFrames 推送
				this._emitEventMultiFrames(t, responseV);
				return;

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

	/* ===== 0x3A/0x3B 生命体征数据 mock 实现 ===== */

	/**
	 * 首次调用 0x3A 时初始化 _vitalCache（5 分钟数据：300 秒 × 6B）
	 * 约 50% 概率 hr 无效（0xFF），与文档示例的无效段密度一致
	 */
	private _initVitalCacheIfNeeded(): void {
		if (this._vitalCache.size > 0) return;
		const now = this._timestamp - 60; // 假定时戳比"现在"早 60s
		this._vitalCacheStartSec = now;
		for (let i = 0; i < 300; i++) {
			const sec = now + i;
			const invalid = Math.random() < 0.3; // 30% 无效（与文档示例密度相当）
			const hr = invalid ? VITAL_DATA_INVALID : 60 + Math.floor(Math.random() * 40);
			const status = ((1 & 0x07) << 3) | (5 & 0x07); // PPG attached + Daily + ACT+
			const pitch = 80 + Math.floor(Math.random() * 30);
			const acc = 50 + Math.floor(Math.random() * 100);
			const ppi = Math.floor(60000 / Math.max(hr, 1));
			const v = encodeU8(hr) + encodeU8(status) + encodeU8(pitch) + encodeU8(acc) + encodeU16LE(ppi);
			this._vitalCache.set(sec, v);
		}
		console.log(
			`[BOOM-MOCK] _vitalCache 初始化: ${this._vitalCache.size} 秒 (startSec=${now})`
		);
	}

	/**
	 * 构造 0x3A/0x3B 响应 V
	 * @param vHex 请求 V
	 * @param isContinue true=0x3B（基于上次返回偏移续读）false=0x3A
	 * @returns 完整响应 V（含 4B startSec + 1B dir + 1B n + n×8B RMSSD/SDNN + n×60×6B vital）
	 */
	private _buildVitalResponseV(vHex: string, isContinue: boolean): string {
		// 解析请求 V：4B startSec + 1B dir + 1B minutes
		const startSec = isContinue ? this._vitalLastReturnedSec : parseU32LE(vHex, 0);
		const direction = isContinue ? 0 : parseU8(vHex, 8);
		const minutes = isContinue ? parseU8(vHex, 0) : parseU8(vHex, 10);

		if (minutes != 2 && minutes != 5) {
			console.warn(`[BOOM-MOCK] 0x3A/0x3B minutes=${minutes} 非法，使用 2`);
		}
		const useMin = minutes == 5 ? 5 : 2;
		const useDir = direction == 1 ? 1 : 0;

		// 起点时间戳
		const baseSec = useDir == 0 ? startSec : startSec - useMin * 60 + 1;
		const n = useMin;

		// 4B startSec + 1B dir + 1B n
		let v = encodeU32LE(baseSec) + encodeU8(useDir) + encodeU8(n);

		// n × 8B RMSSD/SDNN（用 0xFF×8 表示无效，按文档 1.4.4.8）
		for (let i = 0; i < n; i++) {
			v += "FFFFFFFFFFFFFFFF"; // 8B 全 FF
		}

		// n × 60 × 6B vital data
		for (let i = 0; i < n * 60; i++) {
			const sec = baseSec + i;
			const data = this._vitalCache.get(sec);
			if (data == null) {
				// 缓存外：标记为 6B 无效数据（hr=0xFF）
				v += "FFFFFFFFFFFF";
			} else {
				v += data;
			}
		}

		this._vitalLastReturnedSec = baseSec + n * 60 - 1;
		return v;
	}

	/**
	 * 把响应 V 切分成多帧 DI → 多次调 handleNotifyData
	 * （mock 模拟真实 GATT 的多帧推送）
	 */
	private _emitVitalMultiFrames(t: number, vHex: string): void {
		// 1. 先用 encodeTlvc 把响应 V 包成完整 TLVC（带 DI 头）
		const tlvcHex = encodeTlvc(t, vHex);
		// 2. 切分成多帧
		const frames = splitDataIdentifier(tlvcHex, 240);
		console.log(
			`[BOOM-MOCK] 0x${t.toString(16)} 响应 ${frames.length} 帧 (共 ${tlvcHex.length / 2}B)`
		);
		// 3. 逐帧调 handleNotifyData
		for (let i = 0; i < frames.length; i++) {
			const f = frames[i];
			const buffer = hexStringToArrayBuffer(f.diHex);
			this.device.event.handleNotifyData(buffer);
		}
	}

	/* ===== 0x3C/0x3D 事件日志 mock 实现 ===== */

	/**
	 * 首次调用 0x3C 时初始化 _eventCache（10 条不同类型事件）
	 * 复用文档 0x3D 示例的格式：sn=0x23,0x22,0x21,...,0x1A（10 条递减 sn）
	 */
	private _initEventCacheIfNeeded(): void {
		if (this._eventCache.length > 0) return;
		const baseSec = 0x6A2E3ADD; // 与文档 0x3C earliest/latest ts 一致
		const baseSn = 0x23;
		// 10 条事件：sn 从 0x23 递减到 0x1A
		const types: number[] = [
			LOG_EVENT_TYPE.SetTime,
			LOG_EVENT_TYPE.Reset,
			LOG_EVENT_TYPE.FormatDS,
			LOG_EVENT_TYPE.SflashErase,
			LOG_EVENT_TYPE.RemoteCmd,
			LOG_EVENT_TYPE.Wear,
			LOG_EVENT_TYPE.SetDeviceSn,
			LOG_EVENT_TYPE.SleepResult,
			LOG_EVENT_TYPE.Sedentary,
			LOG_EVENT_TYPE.SetBiometricInfo
		];
		for (let i = 0; i < 10; i++) {
			const sn = baseSn - i;
			const ts = baseSec - i * 3600; // 每条间隔 1 小时
			const tick = 1000000 + i * 3600;
			const eventType = types[i];
			const dataLen = this._mockEventDataLen(eventType);
			const eventDataHex = this._mockEventDataHex(eventType, i);
			// parsedEvent 字段兜底填入 rawHex，UI 端可按需用 parseEventData 重解析
			const item: LogDataItem = {
				header: {
					flag: 0xA5,
					flag2: 0x00,
					crc8: 0x00,
					payloadLen: dataLen,
					sn: sn,
					globalSn: sn
				},
				ts: ts,
				tick: tick,
				eventType: eventType,
				dataLen: dataLen,
				eventDataHex: eventDataHex,
				parsedEvent: { rawHex: eventDataHex } as UTSJSONObject
			};
			this._eventCache.push(item);
		}
		this._eventNextReadIndex = 0;
		console.log(
			`[BOOM-MOCK] _eventCache 初始化: ${this._eventCache.length} 条事件`
		);
	}

	private _mockEventDataLen(eventType: number): number {
		switch (eventType) {
			case LOG_EVENT_TYPE.Text:
			case LOG_EVENT_TYPE.RemoteCmd:
			case LOG_EVENT_TYPE.SetDeviceSn:
				return 8; // 假定的 ASCII 长度
			case LOG_EVENT_TYPE.Reset:
			case LOG_EVENT_TYPE.FormatDS:
				return 4;
			case LOG_EVENT_TYPE.SetTime:
				return 8;
			case LOG_EVENT_TYPE.SflashErase:
				return 4;
			case LOG_EVENT_TYPE.Wear:
				return 2;
			case LOG_EVENT_TYPE.SleepResult:
				return 22;
			case LOG_EVENT_TYPE.Sedentary:
				return 2;
			case LOG_EVENT_TYPE.SetBiometricInfo:
				return 8;
			default:
				return 0;
		}
	}

	private _mockEventDataHex(eventType: number, idx: number): string {
		// 简化：返回占位 hex，UI 展示 eventType 即可
		const baseText = encodeAscii("MOCK" + idx);
		switch (eventType) {
			case LOG_EVENT_TYPE.Text:
			case LOG_EVENT_TYPE.RemoteCmd:
			case LOG_EVENT_TYPE.SetDeviceSn:
				return baseText;
			case LOG_EVENT_TYPE.Reset:
				return encodeU32LE(idx);
			case LOG_EVENT_TYPE.FormatDS:
			case LOG_EVENT_TYPE.SflashErase:
				return encodeU32LE(0x08000000 + idx * 0x1000);
			case LOG_EVENT_TYPE.SetTime:
				return encodeU32LE(0x6A000000) + encodeU32LE(this._timestamp);
			case LOG_EVENT_TYPE.Wear:
				return encodeU8(0) + encodeU8(idx % 2);
			case LOG_EVENT_TYPE.SleepResult:
				return (
					encodeU32LE(7200) +
					encodeU32LE(28800) +
					encodeU32LE(10800) +
					encodeU32LE(7200) +
					encodeU32LE(1800) +
					encodeU16LE(58)
				);
			case LOG_EVENT_TYPE.Sedentary:
				return encodeU16LE(3600);
			case LOG_EVENT_TYPE.SetBiometricInfo:
				return this._serializeBiometric(this._biometric);
			default:
				return "FFFFFFFF";
		}
	}

	/** 构造 0x3C 响应 V（17B：1B type + 4B earliestSn + 4B earliestTs + 4B latestSn + 4B latestTs） */
	private _buildEventHeaderV(): string {
		const first = this._eventCache[0];
		const last = this._eventCache[this._eventCache.length - 1];
		const earliestSn = first == null ? 0 : first.header.sn;
		const latestSn = last == null ? 0 : last.header.sn;
		const earliestTs = first == null ? 0 : first.ts;
		const latestTs = last == null ? 0 : last.ts;
		return (
			encodeU8(0) + encodeU32LE(earliestSn) + encodeU32LE(earliestTs) +
			encodeU32LE(latestSn) + encodeU32LE(latestTs)
		);
	}

	/**
	 * 构造 0x3D 响应 V（多条 Log_Data_t 串联）
	 * @param vHex 请求 V（5B：1B type + 4B maxCount）
	 */
	private _buildEventListV(vHex: string): string {
		const maxCount = parseU32LE(vHex, 2);
		const takeCount = maxCount > 0 ? maxCount : this._eventCache.length - this._eventNextReadIndex;
		let v = "";
		let count = 0;
		while (
			this._eventNextReadIndex < this._eventCache.length &&
			count < takeCount
		) {
			const item = this._eventCache[this._eventNextReadIndex];
			this._eventNextReadIndex++;
			if (item == null) break;
			// 8B header + 4B ts + 4B tick + 1B eventType + 1B dataLen + dataLen B eventData
			v += this._serializeLogDataItem(item);
			count++;
		}
		return v;
	}

	/** 序列化单条 Log_Data_t（变长） */
	private _serializeLogDataItem(item: LogDataItem): string {
		const h = item.header;
		const headerHex =
			encodeU8(h.flag) +
			encodeU8(h.flag2) +
			encodeU8(h.crc8) +
			encodeU8(h.payloadLen) +
			encodeU16LE(h.sn) +
			encodeU16LE(h.globalSn);
		return (
			headerHex +
			encodeU32LE(item.ts) +
			encodeU32LE(item.tick) +
			encodeU8(item.eventType) +
			encodeU8(item.dataLen) +
			item.eventDataHex
		);
	}

	/** 把 0x3D 响应 V 切多帧并推送 */
	private _emitEventMultiFrames(t: number, vHex: string): void {
		const tlvcHex = encodeTlvc(t, vHex);
		const frames = splitDataIdentifier(tlvcHex, 240);
		console.log(
			`[BOOM-MOCK] 0x${t.toString(16)} 响应 ${frames.length} 帧 (共 ${tlvcHex.length / 2}B)`
		);
		for (let i = 0; i < frames.length; i++) {
			const f = frames[i];
			const buffer = hexStringToArrayBuffer(f.diHex);
			this.device.event.handleNotifyData(buffer);
		}
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
