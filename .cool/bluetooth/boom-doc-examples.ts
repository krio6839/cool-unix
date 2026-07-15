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
 * 4. 0x3A 响应是**多帧**（258B + 194B 两个 DI 帧）；每帧独立 verify
 */

import { BOOM_CMD } from "./boom-constants";

export type DocExample = {
    /** 命令码（T 字段） */
    t: number;
    /** 描述（如 "0x30 读固件版本"） */
    name: string;
    /** 手机发送的完整 hex 串（含 DataIdentifier + TLVC + CRC） */
    request: string;
    /** BOOM 响应的完整 hex 串（多帧时仅取首帧作"请求-响应"参考；完整验证需 multiFrames 字段） */
    response: string;
    /** 多帧响应：每帧一个完整 GATT hex（含 DI 头）；单帧时为 null */
    multiFrames: Array<string> | null;
};

export const DOC_EXAMPLES: DocExample[] = [
    {
        // 1.4.4.1 读固件版本号 — 行 73-74
        t: BOOM_CMD.READ_FIRMWARE_VERSION,
        name: "0x30 读固件版本",
        request: "06C0300000000F24",
        response: "09C0300003000100037EC2",
        multiFrames: null
    },
    {
        // 1.4.4.2 设置设备编号 (8位) — 行 83-84
        t: BOOM_CMD.SET_DEVICE_NUMBER,
        name: "0x31 写设备编号(8位)",
        request: "0EC0310008003132333435363738C557",
        response: "0EC0310008003132333435363738C557",
        multiFrames: null
    },
    {
        // 1.4.4.2 设置设备编号 (13位) — 行 86-87
        t: BOOM_CMD.SET_DEVICE_NUMBER,
        name: "0x31 写设备编号(13位)",
        request: "13C031000D004142432444203030303936353433C737",
        response: "13C031000D004142432444203030303936353433C737",
        multiFrames: null
    },
    {
        // 1.4.4.3 读取设备编号 — 行 96-97
        // 注意：响应 T=0x31（回显）
        t: BOOM_CMD.READ_DEVICE_NUMBER,
        name: "0x32 读设备编号(响应 T=0x31)",
        request: "06C032000000000E9C",
        response: "0EC0310008003132333435363738C557",
        multiFrames: null
    },
    {
        // 1.4.4.4 设置BOOM时戳 — 行 107-108
        t: BOOM_CMD.SET_BOOM_TIMESTAMP,
        name: "0x33 写时戳",
        request: "0AC033000400621A306AA8DE",
        response: "0AC033000400621A306AA8DE",
        multiFrames: null
    },
    {
        // 1.4.4.5 读取BOOM时戳 — 行 117-118
        // 注意：响应 T=0x33（回显）
        t: BOOM_CMD.READ_BOOM_TIMESTAMP,
        name: "0x34 读时戳(响应 T=0x33)",
        request: "06C0340000000E14",
        response: "0AC03300040091436D38F2E4",
        multiFrames: null
    },
    {
        // 1.4.4.6 设置生物识别数据
        t: BOOM_CMD.SET_BIOMETRIC,
        name: "0x35 写生物识别(文档示例)",
        request: "0EC03500080000581B504614003CE6DB",
        response: "0EC03500080000581B504614003CE6DB",
        multiFrames: null
    },
    {
        // 1.4.4.7 读取生物识别数据
        // 注意：响应 T=0x35（回显当前生物识别数据）
        t: BOOM_CMD.READ_BIOMETRIC,
        name: "0x36 读生物识别(响应 T=0x35)",
        request: "06C0360000000FAC",
        response: "0EC03500080000581B504614003CE6DB",
        multiFrames: null
    },
    {
        // 1.4.4.8 开始读生命体征 — 行 191-194（多帧响应）
        // 文档示例响应是 258B + 194B 两个 DI 帧
        t: BOOM_CMD.READ_VITAL_DATA_START,
        name: "0x3A 读生命体征(多帧 258B+194B)",
        request: "0CC03A0006003D173D6A00020C6D",
        response:
            "C0813A00BA01E8153D6A0002FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF4E04000010034E04000000034D04000008034D04000010034D0400000803" +
            "4C04000008034C04000018034C04000020034C04000018034B04000020034B04000018034B04000008034B04000010034B0400002003" +
            "4C04000018034C0400000000004D04000000004E04000000004F04000000004F040000F8024F04000010034F04000028034E040000" +
            "10034E04000000004D04000000004D04000000004C04000000004C0400000120034B04000018034B04000001034B0400002803" +
            "4B0400000180034B0400000108039ECB",
        // 注：完整 258B+194B 多帧 hex 见 DOC_EXAMPLES_MORE，这里只保留首帧用于普通 verify
        multiFrames: null // 实际由 DOC_EXAMPLES_MORE 提供
    },
    {
        // 1.4.4.9 继续读生命体征 — 行 213-215（无数据响应 28B）
        t: BOOM_CMD.READ_VITAL_DATA_CONTINUE,
        name: "0x3B 读生命体征(无数据 28B)",
        request: "07C03B0001000211C4",
        response: "22C03A001C00C8173D6A0002FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFD84A",
        multiFrames: null
    },
    {
        // 1.4.4.10 开始读事件 — 行 230-234
        t: BOOM_CMD.READ_EVENT_DATA_START,
        name: "0x3C 读事件(响应 17B 头)",
        request: "10C03C000A00000180C4326A007B386AF0F4",
        response:
            "17C03C0011000023000000DD3A2E6A23000000DD3A2E6A C059",
        multiFrames: null
    },
    {
        // 1.4.4.11 继续读事件 — 行 246-248
        t: BOOM_CMD.READ_EVENT_DATA_CONTINUE,
        name: "0x3D 读事件(响应 227B 多条)",
        request: "0BC03D000500000A00000050B9",
        response:
            "E3C03D00DD0000A5004412080023000000DD3A2E6A1F02000006020100A5007512070022000000643A2E6AA601000006020001" +
            "A50078120600210000005D3A2E6A9F01000006020100A500B7120520200000000000000000000000000000000000000000000000000000" +
            "00000000",
        multiFrames: null
    },
    {
        // 1.4.4.12 控制震动马达
        t: BOOM_CMD.CONTROL_VIBRATION,
        name: "0x40 震动马达(示例 500/1000/800ms)",
        request: "0EC040000800010201F403E803203787",
        response: "07C04000010000740F",
        multiFrames: null
    }
];

/* ==================== 0x3A 完整多帧文档示例（行 191-194） ==================== */

/** 状态说明.txt 1.4.4.8 完整多帧响应（258B + 194B）
 *  - 第 1 帧 C081...9ECB（258B）
 *  - 第 2 帧 C045...A96A（194B）
 *  注意：mock 自生成响应时按此结构对比（不要求逐字节一致，但要求 T/L/CRC 与文档首帧一致）
 */
export const DOC_EXAMPLE_3A_FRAMES: string[] = [
    // 帧 1：258B（包含 DI 头 2B + payload 256B）
    "C0813A00BA01E8153D6A0002FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" +
    "4E04000010034E04000000034D04000008034D04000010034D040000" +
    "08034C04000008034C04000018034C04000020034C0400001803" +
    "4B04000020034B04000018034B04000008034B04000010034B040000" +
    "20034C04000018034C0400000000004D04000000004E0400000000" +
    "4F04000000004F040000F8024F04000010034F04000028034E040000" +
    "10034E04000000004D04000000004D04000000004C0400000000" +
    "4C0400000120034B04000018034B04000001034B0400002803" +
    "4B0400000180034B040000010803039ECB",
    // 帧 2：194B
    "C0453A00C20050173D6A0002FFFFFFFFFFFFFFFFFFFF00001803" +
    "4B04000010034C04000008034C04000008034C04000008034D040000" +
    "10034D04000018034D04000020034C04000028034C0400000108" +
    "034C0400000108034C040000F8024C04000008034D0400001003" +
    "4D04000010034D04000020034D04000020034D04000010034D040000" +
    "10034D04000010034D040000F8024D04000000034D0400001003" +
    "4D04000010034D04000018034D04000020034D04000010034D040000" +
    "0803FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF A96A"
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
        const frameInfo = e.multiFrames == null ? "" : ` (多帧 ${e.multiFrames.length} 帧)`;
        console.log(`[BOOM-DOC] ${e.name}: 响应 hex=${e.response}${frameInfo}`);
    }
    if (DOC_EXAMPLE_3A_FRAMES.length > 0) {
        console.log(
            `[BOOM-DOC] 0x3A 完整多帧: ${DOC_EXAMPLE_3A_FRAMES.length} 帧 (${DOC_EXAMPLE_3A_FRAMES[0].length} + ${DOC_EXAMPLE_3A_FRAMES[1].length} hex)`
        );
    }
    //#endif
}
