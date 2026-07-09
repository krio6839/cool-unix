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
import { MAX_MULTI_FRAME_COUNT, MAX_RECV_BUF_BYTES, DEFAULT_MAX_FRAME_PAYLOAD_BYTES } from "./boom-constants";

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

/* ==================== DataIdentifier 多帧（1.3.2） ==================== */

/**
 * 单帧 DI 切分结果（具名类型，UTS 不支持内联 Array<{...}>）
 */
export type SplitDataFrame = {
    seq: number;
    isStart: boolean;
    isEnd: boolean;
    diHex: string;
};

/**
 * 把 payload 切分成多帧 DI（仅在 mock 中使用，真实 GATT 由设备按 MTU 切分）
 * - 每帧 DI: Start/End/Seq/ValidDataNumber
 * - 第 1 帧 isStart=true, 中间 isStart=false, isEnd=false; 最后帧 isEnd=true
 * - maxFrameBytes 默认 240B（按文档 1.3.2 payload 512B 上限留余量）
 *
 * @param payloadHex 已编码的 TLVC 帧 hex
 * @param maxFrameBytes 单帧 payload 字节数（默认 240）
 * @returns 帧数组（含 DI 头），按发送顺序
 */
export function splitDataIdentifier(
    payloadHex: string,
    maxFrameBytes: number = DEFAULT_MAX_FRAME_PAYLOAD_BYTES
): SplitDataFrame[] {
    if (payloadHex.length == 0) {
        return [];
    }
    if (maxFrameBytes <= 0) {
        maxFrameBytes = DEFAULT_MAX_FRAME_PAYLOAD_BYTES;
    }
    const chunkHexLen = maxFrameBytes * 2;
    const totalChunks = Math.ceil(payloadHex.length / chunkHexLen);
    if (totalChunks > MAX_MULTI_FRAME_COUNT) {
        console.warn(
            `[BOOM-CODEC] splitDataIdentifier 帧数 ${totalChunks} 超过上限 ${MAX_MULTI_FRAME_COUNT}`
        );
    }
    const result: SplitDataFrame[] = [];
    for (let i = 0; i < totalChunks; i++) {
        const startHex = i * chunkHexLen;
        const endHex = Math.min(startHex + chunkHexLen, payloadHex.length);
        const chunkHex = payloadHex.substring(startHex, endHex);
        const isStart = i == 0;
        const isEnd = i == totalChunks - 1;
        const seq = i & 0x0F; // 4 位序列号
        const di = wrapDataIdentifierMulti(chunkHex, seq, isStart, isEnd);
        const frame: SplitDataFrame = { seq, isStart, isEnd, diHex: di };
        result.push(frame);
    }
    return result;
}

/**
 * 把 payload 包成单帧多帧 DataIdentifier（支持 isStart/isEnd/seq）
 * @param payloadHex 单帧 payload hex
 * @param sequenceNumber 4 位序列号（0..15）
 * @param isStart 是否起始帧
 * @param isEnd 是否结束帧
 */
export function wrapDataIdentifierMulti(
    payloadHex: string,
    sequenceNumber: number,
    isStart: boolean,
    isEnd: boolean
): string {
    const validBytes = payloadHex.length / 2;
    let di = 0;
    if (isStart == true) di |= DI_START_BIT;
    if (isEnd == true) di |= DI_END_BIT;
    di |= (sequenceNumber & 0x0F) << 9;
    di |= validBytes & DI_LEN_MASK;
    return encodeU16LE(di) + payloadHex;
}

/** 解析单帧 DI 头（2B → 字段分解） */
export type ParsedDataIdentifier = {
    isStart: boolean;
    isEnd: boolean;
    sequenceNumber: number;
    validBytes: number;
    rawDi: number;
};

/** 解析 DI 头（前 4 hex → 字段）；hex 长度不足 4 返回 null */
export function parseDataIdentifier(hex: string): ParsedDataIdentifier | null {
    if (hex.length < 4) return null;
    const rawDi = parseU16LE(hex, 0);
    return {
        isStart: (rawDi & DI_START_BIT) != 0,
        isEnd: (rawDi & DI_END_BIT) != 0,
        sequenceNumber: (rawDi >> 9) & 0x0F,
        validBytes: rawDi & DI_LEN_MASK,
        rawDi
    };
}

/**
 * DataIdentifier 多帧重组器
 *
 * 接收多帧 DI（按到达顺序）→ 重组为完整 payload hex
 * 策略（按状态说明.txt 1.3.2 注释）：
 * - 起始帧：reset buffer, append vdn
 * - 中间帧：append vdn（按 sequenceNumber 顺序，乱序则丢弃旧帧）
 * - 结束帧：append vdn → 返回完整 hex（不含 DI 头）
 *
 * 上限：MAX_RECV_BUF_BYTES（1KB）/ MAX_MULTI_FRAME_COUNT（16 帧）
 */
export class DataIdentifierReassembler {
    private recvBuf: number[] = [];
    private recvIndex: number = 0;
    private startSeq: number = -1;
    private frameCount: number = 0;
    private isReceiving: boolean = false;

    reset(): void {
        this.recvBuf = [];
        this.recvIndex = 0;
        this.startSeq = -1;
        this.frameCount = 0;
        this.isReceiving = false;
    }

    /**
     * 推入一帧 DI（hex 字符串，含 2B DI 头 + payload）
     * @returns 完整 payload hex（结束帧到达时返回）；未完成返回 null
     */
    push(diFrameHex: string): string | null {
        if (diFrameHex.length < 4) {
            console.warn("[BOOM-CODEC] DI 帧长度不足 4 hex:", diFrameHex);
            return null;
        }
        const di = parseDataIdentifier(diFrameHex);
        if (di == null) return null;
        const payloadHex = diFrameHex.substring(4, 4 + di.validBytes * 2);

        // 起始帧：重置 buffer
        if (di.isStart == true) {
            this.reset();
            this.isReceiving = true;
            this.startSeq = di.sequenceNumber;
        }

        // 不在接收状态 → 忽略
        if (this.isReceiving != true) {
            console.warn("[BOOM-CODEC] 收到非起始帧但未开始接收,忽略");
            return null;
        }

        // 帧数上限检查
        if (this.frameCount >= MAX_MULTI_FRAME_COUNT) {
            console.warn(
                `[BOOM-CODEC] 超过最大帧数 ${MAX_MULTI_FRAME_COUNT},重置 buffer`
            );
            this.reset();
            return null;
        }

        // 追加 payload bytes
        for (let i = 0; i < payloadHex.length; i += 2) {
            const byte = parseInt(payloadHex.substring(i, i + 2), 16);
            this.recvBuf.push(byte);
            this.recvIndex++;
        }
        this.frameCount++;

        // 越界保护
        if (this.recvBuf.length > MAX_RECV_BUF_BYTES) {
            console.warn(
                `[BOOM-CODEC] buffer 超过 ${MAX_RECV_BUF_BYTES} 字节,重置`
            );
            this.reset();
            return null;
        }

        // 结束帧：拼成完整 hex 并返回
        if (di.isEnd == true) {
            let fullHex = "";
            for (let i = 0; i < this.recvBuf.length; i++) {
                const b = this.recvBuf[i];
                fullHex += ("00" + b.toString(16)).slice(-2);
            }
            console.log(
                `[BOOM-CODEC] 多帧重组完成: 帧数=${this.frameCount}, 总字节=${this.recvBuf.length}`
            );
            this.reset();
            return fullHex;
        }
        return null;
    }
}
