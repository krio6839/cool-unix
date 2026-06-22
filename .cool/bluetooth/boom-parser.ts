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
    AdvStatus
} from "./boom-types";
import {
    encodeU8,
    encodeU16LE,
    encodeU32LE,
    encodeAscii,
    parseU8,
    parseU16LE,
    parseI16LE,
    parseU32LE,
    parseAscii
} from "./boom-bytes";

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
export function parseCustomAdvExtended(_d: CustomAdvData): unknown | null {
    // TODO: 文档补全后实现
    return null;
}
