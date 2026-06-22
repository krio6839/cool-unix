/**
 * 新 BOOM 设备协议编解码层
 * - MODBUS CRC-16 (poly 0xA001, init 0xFFFF)
 * - TLVC 帧编/解码
 * - DataIdentifier 单帧打包
 */

import type { TlvcFrame } from "./boom-types";

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

/** T+L+V 编码为 TLVC hex（含 CRC，LE） */
export function encodeTlvc(t: number, vHex: string): string {
    const tHex = (t & 0xFF).toString(16).padStart(2, "0")
               + ((t >> 8) & 0xFF).toString(16).padStart(2, "0");
    const l = vHex.length / 2;
    const lHex = (l & 0xFF).toString(16).padStart(2, "0")
               + ((l >> 8) & 0xFF).toString(16).padStart(2, "0");
    const body = tHex + lHex + vHex;
    const crc = crc16Modbus(body);
    const cHex = (crc & 0xFF).toString(16).padStart(2, "0")
               + ((crc >> 8) & 0xFF).toString(16).padStart(2, "0");
    return body + cHex;
}

/** 校验+解析 TLVC；CRC 错返回 null */
export function decodeTlvc(hex: string): TlvcFrame | null {
    if (hex.length < 12) return null;
    const cHex = hex.substring(hex.length - 4);
    const body = hex.substring(0, hex.length - 4);
    const expected = crc16Modbus(body);
    const got = parseInt(cHex.substring(0, 2), 16)
              | (parseInt(cHex.substring(2, 4), 16) << 8);
    if (expected != got) return null;
    const tHex = hex.substring(0, 4);
    const lHex = hex.substring(4, 8);
    const t = parseInt(tHex.substring(0, 2), 16)
            | (parseInt(tHex.substring(2, 4), 16) << 8);
    const l = parseInt(lHex.substring(0, 2), 16)
            | (parseInt(lHex.substring(2, 4), 16) << 8);
    const v = hex.substring(8, 8 + l * 2);
    if (v.length != l * 2) return null;
    return { t, l, v, c: got };
}

/**
 * 把 TLVC 包成单帧 DataIdentifier
 * DataIdentifier 字段：
 *   bit15: Start Bit = 1
 *   bit14: End Bit   = 1
 *   bit9-13: SequenceNumber = 0（单帧无序号）
 *   bit0-8: ValidDataNumber = payload 字节数
 */
export function wrapDataIdentifier(payloadHex: string): string {
    const validBytes = payloadHex.length / 2;
    const di = 0x8000   // Start
             | 0x4000   // End
             | 0x0000   // Seq=0
             | (validBytes & 0x1FF);
    return (di & 0xFF).toString(16).padStart(2, "0")
         + ((di >> 8) & 0xFF).toString(16).padStart(2, "0")
         + payloadHex;
}
