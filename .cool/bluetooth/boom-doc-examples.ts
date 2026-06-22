/**
 * 状态说明.txt 1.4.4.x 节文档示例
 *
 * 完整 hex 串（含 DataIdentifier 头 + TLVC + CRC），用作"事实标准"——
 * mock 自生成响应后会与文档示例比对，验证字节布局 / CRC / T 码是否正确。
 *
 * 关键发现：
 * 1. 文档示例是完整 GATT 帧（含 DataIdentifier）
 * 2. 响应 T 码有"回显"特性：
 *    - 0x32 读设备号 → 响应 T=0x31
 *    - 0x34 读时戳   → 响应 T=0x33
 * 3. SET 类命令（0x31/0x33）的响应 V 与请求 V 完全一致（回显）
 */

import { BOOM_CMD } from "./boom-constants";

export type DocExample = {
    /** 命令码（T 字段） */
    t: number;
    /** 描述（如 "0x30 读固件版本"） */
    name: string;
    /** 手机发送的完整 hex 串（含 DataIdentifier + TLVC + CRC） */
    request: string;
    /** BOOM 响应的完整 hex 串 */
    response: string;
};

export const DOC_EXAMPLES: DocExample[] = [
    {
        // 1.4.4.1 读固件版本号 — 行 73-74
        t: BOOM_CMD.READ_FIRMWARE_VERSION,
        name: "0x30 读固件版本",
        request: "06C030000000000F24",
        response: "09C0300003000100037EC2"
    },
    {
        // 1.4.4.2 设置设备编号 (8位) — 行 83-84
        t: BOOM_CMD.SET_DEVICE_NUMBER,
        name: "0x31 写设备编号(8位)",
        request: "0EC0310008003132333435363738C557",
        response: "0EC0310008003132333435363738C557"
    },
    {
        // 1.4.4.2 设置设备编号 (13位) — 行 86-87
        t: BOOM_CMD.SET_DEVICE_NUMBER,
        name: "0x31 写设备编号(13位)",
        request: "13C031000D004142432444203030303936353433C737",
        response: "13C031000D004142432444203030303936353433C737"
    },
    {
        // 1.4.4.3 读取设备编号 — 行 96-97
        // 注意：响应 T=0x31（回显）
        t: BOOM_CMD.READ_DEVICE_NUMBER,
        name: "0x32 读设备编号(响应 T=0x31)",
        request: "06C032000000000E9C",
        response: "0EC0310008003132333435363738C557"
    },
    {
        // 1.4.4.4 设置BOOM时戳 — 行 107-108
        t: BOOM_CMD.SET_BOOM_TIMESTAMP,
        name: "0x33 写时戳",
        request: "0AC033000400621A306AA8DE",
        response: "0AC033000400621A306AA8DE"
    },
    {
        // 1.4.4.5 读取BOOM时戳 — 行 117-118
        // 注意：响应 T=0x33（回显）
        t: BOOM_CMD.READ_BOOM_TIMESTAMP,
        name: "0x34 读时戳(响应 T=0x33)",
        request: "06C034000000000E14",
        response: "0AC03300040091436D38F2E4"
    }
];

/**
 * 按 T 码索引的文档示例字典（mock.handleCommand 时按 T 查找）
 * 一个 T 码可能对应多组示例（如 0x31 有 8 位和 13 位两组）
 */
export const DOC_EXAMPLES_BY_T: Map<number, DocExample[]> = new Map();
for (let i = 0; i < DOC_EXAMPLES.length; i++) {
    const e = DOC_EXAMPLES[i];
    const arr = DOC_EXAMPLES_BY_T.get(e.t);
    if (arr == null) {
        DOC_EXAMPLES_BY_T.set(e.t, [e]);
    } else {
        arr.push(e);
    }
}

/**
 * 在 mock 启动时打印已加载的文档示例
 */
export function logDocExamplesLoaded(): void {
    //#ifdef APP
    console.log(`[BOOM-DOC] 已加载 ${DOC_EXAMPLES.length} 组文档示例 (状态说明.txt 1.4.4.x)`);
    for (let i = 0; i < DOC_EXAMPLES.length; i++) {
        const e = DOC_EXAMPLES[i];
        console.log(`[BOOM-DOC] ${e.name}: 响应 hex=${e.response}`);
    }
    //#endif
}
