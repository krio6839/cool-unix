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
import { MAX_MULTI_FRAME_COUNT, MAX_RECV_BUF_BYTES } from "./boom-constants";

/* DataIdentifier 字段位掩码（来自状态说明.txt 1.4.3） */
const DI_START_BIT = 0x8000; // bit15: Start
const DI_END_BIT = 0x4000;   // bit14: End
const DI_LEN_MASK = 0x03FF;  // bit0-9: ValidDataNumber

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

/* ==================== DataIdentifier 多帧接收（1.3.2） ==================== */

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
        sequenceNumber: (rawDi >> 10) & 0x0F,
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
 * 上限：MAX_RECV_BUF_BYTES / MAX_MULTI_FRAME_COUNT（16 帧）
 */
export class DataIdentifierReassembler {
    private recvBuf: number[] = [];
    private frameCount: number = 0;
    private isReceiving: boolean = false;
    private pendingFrameRemainingBytes: number = 0;
    private pendingFrameIsEnd: boolean = false;

    reset(): void {
        this.recvBuf = [];
        this.frameCount = 0;
        this.isReceiving = false;
        this.pendingFrameRemainingBytes = 0;
        this.pendingFrameIsEnd = false;
    }

    /** 是否正在等待上一帧 DI payload 的后续物理 notify 分片 */
    expectsContinuationFragment(): boolean {
        return this.pendingFrameRemainingBytes > 0;
    }

    /**
     * 推入一帧 DI（hex 字符串，含 2B DI 头 + payload）
     * @returns 完整 payload hex（结束帧到达时返回）；未完成返回 null
     */
    push(diFrameHex: string): string | null {
        if (this.pendingFrameRemainingBytes > 0) {
            return this.pushContinuationPayload(diFrameHex);
        }

        if (diFrameHex.length < 4) {
            console.warn("[BOOM-CODEC] DI 帧长度不足 4 hex:", diFrameHex);
            return null;
        }

        const di = parseDataIdentifier(diFrameHex);
        if (di == null) return null;
        const availablePayloadHex = diFrameHex.substring(4);
        const payloadHex = availablePayloadHex.substring(0, di.validBytes * 2);

        // 起始帧：重置 buffer
        if (di.isStart == true) {
            this.reset();
            this.isReceiving = true;
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

        const expectedSeq = this.frameCount & 0x0F;
        if (di.sequenceNumber != expectedSeq) {
            console.warn(
                `[BOOM-CODEC] DI 序号不连续: expected=${expectedSeq}, actual=${di.sequenceNumber}`
            );
            this.reset();
            return null;
        }

        this.appendPayloadHex(payloadHex);

        // 越界保护
        if (this.recvBuf.length > MAX_RECV_BUF_BYTES) {
            console.warn(
                `[BOOM-CODEC] buffer 超过 ${MAX_RECV_BUF_BYTES} 字节,重置`
            );
            this.reset();
            return null;
        }

        const receivedBytes = payloadHex.length / 2;
        if (receivedBytes < di.validBytes) {
            this.pendingFrameRemainingBytes = di.validBytes - receivedBytes;
            this.pendingFrameIsEnd = di.isEnd;
            console.log(
                `[BOOM-CODEC] DI payload 分片: seq=${di.sequenceNumber}, 已收=${receivedBytes}, 剩余=${this.pendingFrameRemainingBytes}`
            );
            return null;
        }

        return this.finishLogicalFrame(di.isEnd);
    }

    /** 追加上一帧 DI 未收完的 payload 物理分片 */
    private pushContinuationPayload(hexData: string): string | null {
        const takeBytes = Math.min(this.pendingFrameRemainingBytes, hexData.length / 2);
        const payloadHex = hexData.substring(0, takeBytes * 2);
        this.appendPayloadHex(payloadHex);
        this.pendingFrameRemainingBytes -= takeBytes;

        if (this.recvBuf.length > MAX_RECV_BUF_BYTES) {
            console.warn(
                `[BOOM-CODEC] buffer 超过 ${MAX_RECV_BUF_BYTES} 字节,重置`
            );
            this.reset();
            return null;
        }

        if (this.pendingFrameRemainingBytes > 0) {
            console.log(
                `[BOOM-CODEC] DI payload 续片: 已追加=${takeBytes}, 剩余=${this.pendingFrameRemainingBytes}`
            );
            return null;
        }

        return this.finishLogicalFrame(this.pendingFrameIsEnd);
    }

    private appendPayloadHex(payloadHex: string): void {
        for (let i = 0; i < payloadHex.length; i += 2) {
            const byte = parseInt(payloadHex.substring(i, i + 2), 16);
            this.recvBuf.push(byte);
        }
    }

    /** 一个逻辑 DI 帧完整后调用；End 帧返回完整 TLVC payload */
    private finishLogicalFrame(isEnd: boolean): string | null {
        this.frameCount++;
        this.pendingFrameIsEnd = false;

        if (isEnd == false) return null;

        let fullHex = "";
        for (let i = 0; i < this.recvBuf.length; i++) {
            const b = this.recvBuf[i];
            fullHex += ("00" + b.toString(16)).slice(-2);
        }
        console.log(
            `[BOOM-CODEC] DI 重组完成: 帧数=${this.frameCount}, 总字节=${this.recvBuf.length}`
        );
        this.reset();
        return fullHex;
    }
}
