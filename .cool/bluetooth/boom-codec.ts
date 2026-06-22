/**
 * 新 BOOM 设备协议编解码层
 * - MODBUS CRC-16 (poly 0xA001, init 0xFFFF)
 * - TLVC 帧编/解码
 * - DataIdentifier 单帧打包
 *
 * 字节级编/解码统一复用 boom-bytes.ts。
 */

import type { TlvcFrame } from "./boom-types";
import { encodeU16LE, parseU16LE } from "./boom-bytes";

/* DataIdentifier 字段位掩码（来自状态说明.txt 1.4.3） */
const DI_START_BIT = 0x8000; // bit15: Start
const DI_END_BIT = 0x4000;   // bit14: End
const DI_LEN_MASK = 0x01FF;  // bit0-8: ValidDataNumber（单帧无 SequenceNumber）

/**
 * MODBUS CRC-16（poly 0xA001, init 0xFFFF）
 * 文档示例：crc16Modbus("30000000") → 0x240F（小端序 0F 24）
 */
export function crc16Modbus(hex: string): number {
    let crc = 0xFFFF;
    for (let i = 0; i < hex.length; i += 2) {
        crc = crc ^ parseInt(hex.substring(i, i + 2), 16);
        for (let j = 0; j < 8; j++) {
            if ((crc & 1) != 0) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc = crc >> 1;
            }
        }
    }
    return crc & 0xFFFF;
}

/**
 * 编码 T+L+V+CRC → TLVC hex（LE）
 * @param t 2B 命令码
 * @param vHex V 字段的 hex 字符串
 * @returns 完整 TLVC 帧 hex（含 4B CRC）
 */
export function encodeTlvc(t: number, vHex: string): string {
    const l = vHex.length / 2;
    const body = encodeU16LE(t) + encodeU16LE(l) + vHex;
    return body + encodeU16LE(crc16Modbus(body));
}

/**
 * 校验+解析 TLVC 帧；CRC 错或长度不足返回 null
 */
export function decodeTlvc(hex: string): TlvcFrame | null {
    if (hex.length < 12) return null; // T(2)+L(2)+C(2) 至少 6B
    const cHex = hex.substring(hex.length - 4);
    const body = hex.substring(0, hex.length - 4);
    const expected = crc16Modbus(body);
    const got = parseU16LE(cHex, 0);
    if (expected != got) return null;
    const t = parseU16LE(body, 0);
    const l = parseU16LE(body, 4);
    const v = body.substring(8, 8 + l * 2);
    if (v.length != l * 2) return null;
    return { t, l, v, c: got };
}

/**
 * 把 TLVC 包成单帧 DataIdentifier
 * @param payloadHex 已编码的 TLVC 帧 hex
 * @returns DI(2B) + payload
 */
export function wrapDataIdentifier(payloadHex: string): string {
    const validBytes = payloadHex.length / 2;
    const di = DI_START_BIT | DI_END_BIT | (validBytes & DI_LEN_MASK);
    return encodeU16LE(di) + payloadHex;
}
