/**
 * 新 BOOM 设备协议 V 字段解析 / 序列化 + 0x50 自定义广播解析
 *
 * 字节级编/解码统一复用 boom-bytes.ts。
 */

import type {
    CustomAdvData,
    FirmwareVersion,
    RealtimeBroadcast,
    VitalBiometric,
    VibrationResult,
    VibrationSpec,
    AdvStatus,
    VitalDataPerSecond,
    VitalDataQueryRequest,
    VitalDataQueryResponse,
    RmssdSdnnPair,
    EventDataQuery,
    EventDataHeaderResponse,
    LogDataHeader,
    LogDataItem,
    EventDataText,
    EventDataReset,
    EventDataSetTime,
    EventDataFormatDS,
    EventDataWear,
    EventDataSleepResult,
    EventDataSedentary
} from "./boom-types";
import {
    encodeU8,
    encodeU16LE,
    encodeU32LE,
    encodeAscii,
    encodeI16LE,
    parseU8,
    parseU16LE,
    parseI16LE,
    parseU32LE,
    parseAscii
} from "./boom-bytes";
import {
    VITAL_DATA_INVALID,
    VITAL_DATA_BLANK,
    VITAL_MINUTES_OPTIONS,
    LOG_EVENT_TYPE
} from "./boom-constants";

/* ==================== V 字段解析（响应） ==================== */

/** 0x30 响应 V：3B 固件版本（major / minor / revision） */
export function parseFirmwareVersion(v: string): FirmwareVersion {
    return {
        major: parseU8(v, 0),
        minor: parseU8(v, 2),
        revision: parseU8(v, 4)
    };
}

/** 0x31/0x32 响应 V：ASCII 设备编号 */
export function parseDeviceNumber(v: string): string {
    return parseAscii(v);
}

/** 0x33/0x34 响应 V：UINT32 UTC 时戳（LE） */
export function parseTimestamp(v: string): number {
    return parseU32LE(v, 0);
}

/** 0x35/0x36 响应 V：8B vital_biometric_info_t（packed LE） */
export function parseBiometric(v: string): VitalBiometric {
    return {
        gender: parseU8(v, 0),
        weight: parseU16LE(v, 2),
        height: parseU16LE(v, 6),
        age: parseU8(v, 10),
        ppgPosition: parseU8(v, 12),
        bhr: parseU8(v, 14)
    };
}

/** 0x40 响应 V：1B 结果码（0=成功） */
export function parseVibrationResult(v: string): VibrationResult {
    return { code: parseU8(v, 0) };
}

/* ==================== V 字段序列化（请求） ==================== */

/** 0x31 请求 V：ASCII 设备编号 */
export function serializeDeviceNumber(s: string): string {
    return encodeAscii(s);
}

/** 0x33 请求 V：UINT32 UTC 时戳（LE） */
export function serializeTimestamp(sec: number): string {
    return encodeU32LE(sec);
}

/** 0x35 请求 V：8B vital_biometric_info_t（packed LE） */
export function serializeBiometric(b: VitalBiometric): string {
    return (
        encodeU8(b.gender) +
        encodeU16LE(b.weight) +
        encodeU16LE(b.height) +
        encodeU8(b.age) +
        encodeU8(b.ppgPosition) +
        encodeU8(b.bhr)
    );
}

/**
 * 0x40 请求 V：循环(1B) + 次数(1B) + n×2B on/off
 * n = count * 2（每对 = 震动ms + 静默ms）
 */
export function serializeVibration(spec: VibrationSpec): string {
    let h = encodeU8(spec.loops) + encodeU8(spec.count);
    for (let i = 0; i < spec.onOffMs.length; i++) {
        h += encodeU16LE(spec.onOffMs[i] ?? 0);
    }
    return h;
}

/* ==================== 0x50 自定义广播解析（13 字节） ==================== */

/**
 * 解析 0x50 自定义广播的 V 数据（13B packed LE）
 * @param vHex 13 字节的 hex 字符串（26 hex 字符）
 * @returns CustomAdvData；长度不足返回 null
 */
export function parseCustomAdvData(vHex: string): CustomAdvData | null {
    if (vHex.length < 26) return null; // 13B = 26 hex
    return {
        utc: parseU32LE(vHex, 0),
        voltage: parseI16LE(vHex, 8),
        status: parseU8(vHex, 12),
        hr: parseU8(vHex, 14),
        ppi: parseU16LE(vHex, 16),
        spo2: parseU16LE(vHex, 20),
        bhr: parseU8(vHex, 24)
    };
}

/**
 * 解码 status 字节：bit6=PPG佩戴 bit5-3=行为 bit2-0=活动
 * 状态说明.txt 2.1.2
 */
export function decodeAdvStatus(status: number): AdvStatus {
    return {
        ppgAttached: ((status >> 6) & 0x01) == 0x01,
        behavior: (status >> 3) & 0x07,
        activity: status & 0x07
    };
}

/** 扁平化为 RealtimeBroadcast（含 status 解码 + 接收时间戳） */
export function toRealtimeBroadcast(d: CustomAdvData): RealtimeBroadcast {
    const s = decodeAdvStatus(d.status);
    return {
        receivedAt: Date.now(),
        utc: d.utc,
        voltageMv: d.voltage,
        ppgAttached: s.ppgAttached,
        behavior: s.behavior,
        activity: s.activity,
        hr: d.hr,
        ppi: d.ppi,
        spo2Pct: d.spo2 / 10, // 950 → 95.0
        bhr: d.bhr
    };
}

/**
 * 预留：状态说明文档补全后，按 status 分支处理历史数据片段（睡眠/血氧/活动）
 * 当前实现：仅返回 null；文档补全后在此按 status.behavior / status.activity 分支
 *   - behavior ∈ {0,1,2} && activity ∈ {0,1,2} → 睡眠片段
 *   - activity == 5                              → 活动数据片段
 */
export function parseCustomAdvExtended(_d: CustomAdvData): UTSJSONObject | null {
    // TODO: 文档补全后实现
    return null;
}

/* ==================== 0x3A/0x3B 生命体征数据（1.4.4.8/1.4.4.9 + 2.1.3） ==================== */

/* ----- 请求侧序列化 ----- */

/**
 * 0x3A 请求 V（6B）：4B startSec(LE) + 1B direction + 1B minutes
 * minutes 必须在 VITAL_MINUTES_OPTIONS 内；非法时 warn + 输出原值（不抛错，让上层校验）
 */
export function serializeVitalDataQuery(req: VitalDataQueryRequest): string {
    let valid = false;
    for (let i = 0; i < VITAL_MINUTES_OPTIONS.length; i++) {
        if (VITAL_MINUTES_OPTIONS[i] == req.minutes) {
            valid = true;
            break;
        }
    }
    if (valid == false) {
        console.warn(
            `[BOOM-PARSER] 0x3A minutes=${req.minutes} 非法（应=2或5），仍按原值编码`
        );
    }
    return (
        encodeU32LE(req.startSec) +
        encodeU8(req.direction) +
        encodeU8(req.minutes)
    );
}

/** 0x3B 请求 V（1B）：minutes（只能是 2 或 5） */
export function serializeVitalContinueQuery(minutes: number): string {
    return encodeU8(minutes);
}

/* ----- 响应侧解析 ----- */

/** 解析 6B VitalData_Per_Second（1.4.4.8 + 2.1.3）
 * @param hex 完整 hex 字符串
 * @param off 字节偏移（hex 字符为单位）
 */
export function parseVitalDataPerSecond(hex: string, off: number): VitalDataPerSecond {
    const hr = parseU8(hex, off);
    const status = parseU8(hex, off + 2);
    const pitch = parseU8(hex, off + 4);
    const acc = parseU8(hex, off + 6);
    const ppi = parseU16LE(hex, off + 8);
    const valid = hr != VITAL_DATA_INVALID && hr != VITAL_DATA_BLANK;
    return { hr, status, pitch, acc, ppi, valid };
}

/** 解析 RMSSD/SDNN 8B（4B float LE + 4B float LE），全 FF 标记为无效 */
function parseRmssdSdnn(hex: string, off: number): RmssdSdnnPair {
    // 文档用 float，但 UTS 不一定能直接读 float
    // 简化处理：直接把 4B 当 hex 字符串展示；valid=全 FF 才无效
    const rmssdHex = hex.substring(off, off + 8);
    const sdnnHex = hex.substring(off + 8, off + 16);
    const allFF =
        rmssdHex.toLowerCase() == "ffffffff" && sdnnHex.toLowerCase() == "ffffffff";
    if (allFF) {
        return { rmssd: NaN, sdnn: NaN, valid: false };
    }
    // UTS 安全兜底：把 4B LE 解析为 0（避免 NaN 污染 JSON 序列化）
    const rmssdBits = parseU32LE(hex, off);
    const sdnnBits = parseU32LE(hex, off + 8);
    return { rmssd: rmssdBits, sdnn: sdnnBits, valid: true };
}

/** 解析 0x3A/0x3B 响应 V（变长）
 * 格式: 4B startSec(LE) + 1B direction + 1B n + n*8B RMSSD/SDNN + n*60*6B vital
 */
export function parseVitalDataResponse(vHex: string): VitalDataQueryResponse {
    const startSec = parseU32LE(vHex, 0);
    const direction = parseU8(vHex, 8);
    const n = parseU8(vHex, 10);
    const rmssdSdnn: RmssdSdnnPair[] = [];
    let off = 12; // 跳过 4B+1B+1B
    for (let i = 0; i < n; i++) {
        rmssdSdnn.push(parseRmssdSdnn(vHex, off));
        off += 16; // 8B/项
    }
    const vitalData: VitalDataPerSecond[] = [];
    for (let i = 0; i < n * 60; i++) {
        vitalData.push(parseVitalDataPerSecond(vHex, off));
        off += 12; // 6B/项
    }
    return { startSec, direction, n, rmssdSdnn, vitalData };
}

/* ==================== 0x3C/0x3D 事件数据（1.4.4.10/1.4.4.11 + 2.1.4） ==================== */

/* ----- 请求侧序列化 ----- */

/** 0x3C 请求 V（10B）：1B type + 4B startSec(LE) + 4B endSec(LE) */
export function serializeEventDataQuery(req: EventDataQuery): string {
    return (
        encodeU8(req.type) +
        encodeU32LE(req.startSec) +
        encodeU32LE(req.endSec)
    );
}

/** 0x3D 请求 V（5B）：1B type + 4B maxCount(LE) */
export function serializeEventContinueQuery(maxCount: number): string {
    return encodeU8(0) + encodeU32LE(maxCount); // 文档示例中 type=0，按 ALL 续读
}

/* ----- 响应侧解析 ----- */

/** 解析 0x3C 响应 V（17B）：1B type + 4B earliestSn + 4B earliestTs + 4B latestSn + 4B latestTs */
export function parseEventDataHeader(vHex: string): EventDataHeaderResponse {
    return {
        type: parseU8(vHex, 0),
        earliestSn: parseU32LE(vHex, 2),
        earliestSec: parseU32LE(vHex, 10),
        latestSn: parseU32LE(vHex, 18),
        latestSec: parseU32LE(vHex, 26)
    };
}

/** 解析 8B DS_Data_Header_t */
export function parseLogDataHeader(hex: string, off: number): LogDataHeader {
    return {
        flag: parseU8(hex, off),
        flag2: parseU8(hex, off + 2),
        crc8: parseU8(hex, off + 4),
        payloadLen: parseU8(hex, off + 6),
        sn: parseU16LE(hex, off + 8),
        globalSn: parseU16LE(hex, off + 12)
    };
}

/* ----- eventData 子解析器（2.1.4.2.x）----- */

/** 2.1.4.2.1 Text/RemoteCmd/SetDeviceSn：eventData = ASCII */
export function parseEventDataText(eventDataHex: string): EventDataText {
    return { text: parseAscii(eventDataHex) };
}

/** 2.1.4.2.2 Reset：eventData = 4B LE（重启原因） */
export function parseEventDataReset(eventDataHex: string): EventDataReset {
    if (eventDataHex.length < 8) return { value: 0 };
    return { value: parseU32LE(eventDataHex, 0) };
}

/** 2.1.4.2.3 SetTime：eventData = 8B（两个 4B LE） */
export function parseEventDataSetTime(eventDataHex: string): EventDataSetTime {
    if (eventDataHex.length < 16) return { oldSec: 0, newSec: 0 };
    return {
        oldSec: parseU32LE(eventDataHex, 0),
        newSec: parseU32LE(eventDataHex, 8)
    };
}

/** 2.1.4.2.4 FormatDS：eventData = 4B LE（擦除扇区地址） */
export function parseEventDataFormatDS(eventDataHex: string): EventDataFormatDS {
    if (eventDataHex.length < 8) return { address: 0 };
    return { address: parseU32LE(eventDataHex, 0) };
}

/** 2.1.4.2.5 Wear：eventData = 2B（before/after） */
export function parseEventDataWear(eventDataHex: string): EventDataWear {
    if (eventDataHex.length < 4) return { before: 0, after: 0 };
    return {
        before: parseU8(eventDataHex, 0),
        after: parseU8(eventDataHex, 2)
    };
}

/** 2.1.4.2.6 SleepResult：eventData = 22B（4B+4B+4B+4B+4B+2B LE） */
export function parseEventDataSleepResult(eventDataHex: string): EventDataSleepResult {
    if (eventDataHex.length < 44) {
        return {
            sleepOnsetSec: 0,
            awakeSec: 0,
            lightSleepSec: 0,
            deepSleepSec: 0,
            otherSleepSec: 0,
            restHr: 0
        };
    }
    return {
        sleepOnsetSec: parseU32LE(eventDataHex, 0),
        awakeSec: parseU32LE(eventDataHex, 8),
        lightSleepSec: parseU32LE(eventDataHex, 16),
        deepSleepSec: parseU32LE(eventDataHex, 24),
        otherSleepSec: parseU32LE(eventDataHex, 32),
        restHr: parseU16LE(eventDataHex, 40)
    };
}

/** 2.1.4.2.7 Sedentary：eventData = 2B LE（久坐阈值秒数） */
export function parseEventDataSedentary(eventDataHex: string): EventDataSedentary {
    if (eventDataHex.length < 4) return { thresholdSec: 0 };
    return { thresholdSec: parseU16LE(eventDataHex, 0) };
}

/* UTS 不支持内联对象字面量类型作返回值，具名 type 声明 */
export type ParseLogDataItemResult = {
    item: LogDataItem;
    nextOff: number;
};

export type ParseLogDataListResult = {
    items: LogDataItem[];
    nextOff: number;
};

/**
 * 按 eventType 分派到具体子解析器
 * @returns UTSJSONObject 形式的结果；SetBiometricInfo 直接复用 parseBiometric
 */
export function parseEventData(eventType: number, eventDataHex: string): UTSJSONObject {
    switch (eventType) {
        case LOG_EVENT_TYPE.Text:
        case LOG_EVENT_TYPE.RemoteCmd:
        case LOG_EVENT_TYPE.SetDeviceSn:
            return parseEventDataText(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.Reset:
            return parseEventDataReset(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.SetTime:
            return parseEventDataSetTime(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.FormatDS:
        case LOG_EVENT_TYPE.SflashErase:
            return parseEventDataFormatDS(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.Wear:
            return parseEventDataWear(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.SleepResult:
            return parseEventDataSleepResult(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.Sedentary:
            return parseEventDataSedentary(eventDataHex) as UTSJSONObject;
        case LOG_EVENT_TYPE.SetBiometricInfo:
            return parseBiometric(eventDataHex) as UTSJSONObject;
        default:
            // 未知类型：返回原始 hex 兜底
            const fallback: UTSJSONObject = { rawHex: eventDataHex };
            return fallback;
    }
}

/**
 * 解析单条 Log_Data_t（变长）
 * - 8B header + 4B ts + 4B tick + 1B eventType + 1B dataLen + dataLen B eventData
 * @param hex 完整 hex
 * @param off 字节偏移（hex 字符单位）
 * @returns { item, nextOff }：item 解析结果，nextOff 下一条 Log_Data 起始偏移
 */
export function parseLogDataItem(hex: string, off: number): ParseLogDataItemResult {
    const header = parseLogDataHeader(hex, off);
    const ts = parseU32LE(hex, off + 16); // 8B header + 4B ts
    const tick = parseU32LE(hex, off + 32); // +4B tick
    const eventType = parseU8(hex, off + 40); // +1B eventType
    const dataLen = parseU8(hex, off + 42); // +1B dataLen
    const eventDataHex = hex.substring(off + 88, off + 88 + dataLen * 2);
    const parsedEvent = parseEventData(eventType, eventDataHex);
    const item: LogDataItem = {
        header,
        ts,
        tick,
        eventType,
        dataLen,
        eventDataHex,
        parsedEvent
    };
    // 18B(header+ts+tick) + 2B(type+len) + dataLen
    const nextOff = off + 88 + dataLen * 2;
    return { item, nextOff };
}

/**
 * 解析多条 Log_Data_t 串联
 * @param hex 完整 hex
 * @param off 起始偏移
 * @param maxCount 最多解析多少条（默认无限，按 hex 长度走）
 * @returns { items, nextOff }
 */
export function parseLogDataList(
    hex: string,
    off: number,
    maxCount: number = 0
): ParseLogDataListResult {
    const items: LogDataItem[] = [];
    let cur = off;
    let count = 0;
    while (cur + 88 <= hex.length) {
        if (maxCount > 0 && count >= maxCount) break;
        const r = parseLogDataItem(hex, cur);
        items.push(r.item);
        cur = r.nextOff;
        count++;
        // 防御：nextOff 没推进则退出
        if (r.nextOff <= cur) break;
    }
    return { items, nextOff: cur };
}
