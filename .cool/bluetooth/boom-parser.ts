/**
 * 新 BOOM 设备协议 V 字段解析 / 序列化 + 0x50 自定义广播解析
 */

import { BOOM_CMD } from "./boom-constants";
import type {
    CustomAdvData,
    FirmwareVersion,
    RealtimeBroadcast,
    VitalBiometric,
    VibrationResult,
    VibrationSpec
} from "./boom-types";

/* ==================== V 字段解析（响应） ==================== */

/** 0x30 响应 V：3B 固件版本（major/minor/revision） */
export function parseFirmwareVersion(v: string): FirmwareVersion {
    const major = parseInt(v.substring(0, 2), 16);
    const minor = parseInt(v.substring(2, 4), 16);
    const revision = parseInt(v.substring(4, 6), 16);
    return { major, minor, revision };
}

/** 0x31/0x32 响应 V：ASCII 设备编号 */
export function parseDeviceNumber(v: string): string {
    let s = "";
    for (let i = 0; i < v.length; i += 2) {
        s += String.fromCharCode(parseInt(v.substring(i, i + 2), 16));
    }
    return s;
}

/** 0x33/0x34 响应 V：UINT32 UTC 时戳（LE） */
export function parseTimestamp(v: string): number {
    return parseInt(v.substring(0, 2), 16)
         | (parseInt(v.substring(2, 4), 16) << 8)
         | (parseInt(v.substring(4, 6), 16) << 16)
         | (parseInt(v.substring(6, 8), 16) << 24);
}

/** 0x35/0x36 响应 V：8B vital_biometric_info_t（packed LE） */
export function parseBiometric(v: string): VitalBiometric {
    const gender      = parseInt(v.substring(0, 2), 16);
    const weight      = parseInt(v.substring(2, 4), 16)
                      | (parseInt(v.substring(4, 6), 16) << 8);
    const height      = parseInt(v.substring(6, 8), 16)
                      | (parseInt(v.substring(8, 10), 16) << 8);
    const age         = parseInt(v.substring(10, 12), 16);
    const ppgPosition = parseInt(v.substring(12, 14), 16);
    const bhr         = parseInt(v.substring(14, 16), 16);
    return { gender, weight, height, age, ppgPosition, bhr };
}

/** 0x40 响应 V：1B 结果码（0=成功） */
export function parseVibrationResult(v: string): VibrationResult {
    return { code: parseInt(v.substring(0, 2), 16) };
}

/* ==================== V 字段序列化（请求） ==================== */

/** 0x31 请求 V：ASCII 设备编号 */
export function serializeDeviceNumber(s: string): string {
    let h = "";
    for (let i = 0; i < s.length; i++) {
        h += s.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return h;
}

/** 0x33 请求 V：UINT32 UTC 时戳（LE） */
export function serializeTimestamp(sec: number): string {
    return (sec & 0xFF).toString(16).padStart(2, "0")
         + ((sec >> 8) & 0xFF).toString(16).padStart(2, "0")
         + ((sec >> 16) & 0xFF).toString(16).padStart(2, "0")
         + ((sec >> 24) & 0xFF).toString(16).padStart(2, "0");
}

/** 0x35 请求 V：8B vital_biometric_info_t（packed LE） */
export function serializeBiometric(b: VitalBiometric): string {
    const le16 = (n: number): string =>
        (n & 0xFF).toString(16).padStart(2, "0")
        + ((n >> 8) & 0xFF).toString(16).padStart(2, "0");
    return b.gender.toString(16).padStart(2, "0")
         + le16(b.weight)
         + le16(b.height)
         + b.age.toString(16).padStart(2, "0")
         + b.ppgPosition.toString(16).padStart(2, "0")
         + b.bhr.toString(16).padStart(2, "0");
}

/**
 * 0x40 请求 V：循环(1B) + 次数(1B) + n×2B on/off
 * n = count * 2（每对 = 震动ms + 静默ms）
 */
export function serializeVibration(spec: VibrationSpec): string {
    let h = spec.loops.toString(16).padStart(2, "0")
         + spec.count.toString(16).padStart(2, "0");
    for (let i = 0; i < spec.onOffMs.length; i++) {
        const ms = spec.onOffMs[i] ?? 0;
        h += (ms & 0xFF).toString(16).padStart(2, "0")
           + ((ms >> 8) & 0xFF).toString(16).padStart(2, "0");
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
    if (vHex.length < 26) return null;  // 13B = 26 hex
    return {
        utc:     parseUint32LEHex(vHex.substring(0, 8)),
        voltage: parseInt16LEHex(vHex.substring(8, 12)),
        status:  parseInt(vHex.substring(12, 14), 16),
        hr:      parseInt(vHex.substring(14, 16), 16),
        ppi:     parseUint16LEHex(vHex.substring(16, 20)),
        spo2:    parseUint16LEHex(vHex.substring(20, 24)),
        bhr:     parseInt(vHex.substring(24, 26), 16)
    };
}

/**
 * 解码 status 字节：bit6=PPG佩戴 bit5-3=行为 bit2-0=活动
 * 状态说明.txt 2.1.2
 */
export function decodeAdvStatus(status: number): {
    ppgAttached: boolean;
    behavior: number;
    activity: number;
} {
    return {
        ppgAttached: ((status >> 6) & 0x01) == 0x01,
        behavior:    (status >> 3) & 0x07,
        activity:    status & 0x07
    };
}

/** 扁平化为 RealtimeBroadcast（含 status 解码 + 接收时间戳） */
export function toRealtimeBroadcast(d: CustomAdvData): RealtimeBroadcast {
    const s = decodeAdvStatus(d.status);
    return {
        receivedAt:  Date.now(),
        utc:         d.utc,
        voltageMv:   d.voltage,
        ppgAttached: s.ppgAttached,
        behavior:    s.behavior,
        activity:    s.activity,
        hr:          d.hr,
        ppi:         d.ppi,
        spo2Pct:     d.spo2 / 10,
        bhr:         d.bhr
    };
}

/**
 * 预留：状态说明文档补全后，按 status 分支处理历史数据片段（睡眠/血氧/活动）
 * 当前实现：仅返回 null；文档补全后在此按 status.behavior / status.activity 分支
 *   - behavior ∈ {0,1,2} && activity ∈ {0,1,2} → 睡眠片段
 *   - activity == 5                              → 活动数据片段
 */
export function parseCustomAdvExtended(_d: CustomAdvData): unknown | null {
    // TODO: 文档补全后实现
    return null;
}

/* ==================== 内部：LE 字节解析 ==================== */

function parseUint16LEHex(h: string): number {
    return parseInt(h.substring(0, 2), 16)
         | (parseInt(h.substring(2, 4), 16) << 8);
}

function parseInt16LEHex(h: string): number {
    const u = parseUint16LEHex(h);
    return u > 0x7FFF ? u - 0x10000 : u;
}

function parseUint32LEHex(h: string): number {
    return parseInt(h.substring(0, 2), 16)
         | (parseInt(h.substring(2, 4), 16) << 8)
         | (parseInt(h.substring(4, 6), 16) << 16)
         | (parseInt(h.substring(6, 8), 16) << 24);
}

/** 抑制 BOOM_CMD 未使用告警（保留供将来扩展点使用） */
export const _KEEP_BOOM_CMD = BOOM_CMD;
