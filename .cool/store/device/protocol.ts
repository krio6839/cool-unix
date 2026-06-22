import {
    hexStringToArrayBuffer,
    BOOM_GATT_SERVICE_UUID,
    encodeTlvc,
    wrapDataIdentifier,
    BOOM_CMD,
    serializeDeviceNumber,
    serializeTimestamp,
    serializeBiometric,
    serializeVibration
} from "../../bluetooth";
import type { VibrationSpec, VitalBiometric } from "../../bluetooth";

//#ifndef H5
import {
    getServices,
    getCharacteristics,
    writeCharacteristic,
    notifyCharacteristic
} from "../../bluetooth/kux";

import type {
    GetBLEDeviceServicesSuccessService,
    BLEDeviceCharacteristic
} from "../../bluetooth/kux";
//#endif

import type { Device } from "./index";

/**
 * BOOM 设备 TLVC 协议层
 * 负责：
 * 1. 发现 BOOM GATT Service（75c276c3-8f97-20bc-a143-b354244886d4）下的 write / notify 特征
 * 2. 启用 notify
 * 3. 8 个高层命令的发送封装（0x30/0x31/0x32/0x33/0x34/0x35/0x36/0x40）
 */
export class DeviceProtocol {
    private device: Device;

    services: Array<GetBLEDeviceServicesSuccessService> = [];
    characteristics: Map<string, Array<BLEDeviceCharacteristic>> = new Map();

    /** BOOM 设备的 write / notify 特征 UUID（动态发现） */
    writeCharUuid: string = "";
    notifyCharUuid: string = "";

    constructor(device: Device) {
        this.device = device;
    }

    /**
     * 获取设备所有 services + characteristics，并从中动态发现 BOOM GATT 服务的 write/notify 特征 UUID
     */
    async getDeviceServicesAndCharacteristics(deviceId: string): Promise<void> {
        //#ifndef H5
        const services = await getServices(deviceId);
        this.services = services;
        const results = await Promise.all(
            services.map((s: GetBLEDeviceServicesSuccessService) =>
                getCharacteristics(deviceId, s.uuid)
            )
        );
        services.forEach((s, i) => {
            const chars = results[i] ?? [];
            this.characteristics.set(s.uuid, chars);
        });

        // 发现 BOOM GATT 服务的 write / notify 特征
        for (let i = 0; i < this.services.length; i++) {
            const s = this.services[i];
            if (s == null) continue;
            if (s.uuid.toLowerCase() != BOOM_GATT_SERVICE_UUID.toLowerCase()) continue;
            const chars = this.characteristics.get(s.uuid);
            if (chars == null) continue;
            for (let j = 0; j < chars.length; j++) {
                const c = chars[j];
                if (c == null) continue;
                const p = c.properties;
                if (p == null) continue;
                if (p.write == true && this.writeCharUuid == "")
                    this.writeCharUuid = c.uuid;
                if ((p.notify == true || p.indicate == true) && this.notifyCharUuid == "")
                    this.notifyCharUuid = c.uuid;
            }
        }
        //#endif
    }

    /** 启用 BOOM GATT notify */
    async enableNotify(): Promise<boolean> {
        //#ifndef H5
        if (this.notifyCharUuid == "") return false;
        return notifyCharacteristic(
            this.device.currentDeviceId,
            BOOM_GATT_SERVICE_UUID,
            this.notifyCharUuid,
            true,
            "notification"
        );
        //#endif
        return false;
    }

    /** 内部：发一个 TLVC 命令（自动包成单帧 DataIdentifier） */
    private async sendTlvc(t: number, vHex: string): Promise<boolean> {
        // Mock 模式：直接走 MockProvider，不下发真实 GATT
        if (this.device.useMock) {
            this._dispatchMock(t, vHex);
            return true;
        }
        //#ifndef H5
        if (this.writeCharUuid == "") return false;
        const frame = wrapDataIdentifier(encodeTlvc(t, vHex));
        return writeCharacteristic(
            this.device.currentDeviceId,
            BOOM_GATT_SERVICE_UUID,
            this.writeCharUuid,
            hexStringToArrayBuffer(frame),
            "write"
        );
        //#endif
        return false;
    }

    /**
     * Mock 模式：按 T 码调用 MockProvider 对应方法
     * 不走真实 GATT，纯本地内存模拟，让 TestPopup 不连真设备也能看到 event 字段更新
     */
    private _dispatchMock(t: number, vHex: string): void {
        switch (t) {
            case BOOM_CMD.READ_FIRMWARE_VERSION:
                this.device.mock.mockReadFirmware();
                break;
            case BOOM_CMD.SET_DEVICE_NUMBER:
                this.device.mock.mockSetDeviceNumber(this._asciiFromHex(vHex));
                break;
            case BOOM_CMD.READ_DEVICE_NUMBER:
                this.device.mock.mockReadDeviceNumber();
                break;
            case BOOM_CMD.SET_BOOM_TIMESTAMP:
                this.device.mock.mockSetTimestamp(this._u32FromHex(vHex));
                break;
            case BOOM_CMD.READ_BOOM_TIMESTAMP:
                this.device.mock.mockReadTimestamp();
                break;
            case BOOM_CMD.SET_BIOMETRIC:
                this.device.mock.mockSetBiometric(this._biometricFromHex(vHex));
                break;
            case BOOM_CMD.READ_BIOMETRIC:
                this.device.mock.mockReadBiometric();
                break;
            case BOOM_CMD.CONTROL_VIBRATION: {
                const parsed = this._vibrationFromHex(vHex);
                this.device.mock.mockControlVibration(parsed.loops, parsed.count, parsed.onOffMs);
                break;
            }
            default:
                console.warn("[BOOM-MOCK] 未知 T:", t);
        }
    }

    /* ===== Mock 辅助：hex → 业务对象 ===== */

    private _asciiFromHex(h: string): string {
        let s = "";
        for (let i = 0; i < h.length; i += 2) {
            const code = parseInt(h.substring(i, i + 2), 16);
            s += String.fromCharCode(code);
        }
        return s;
    }

    private _u32FromHex(h: string): number {
        if (h.length < 8) return 0;
        return parseInt(h.substring(0, 2), 16)
             | (parseInt(h.substring(2, 4), 16) << 8)
             | (parseInt(h.substring(4, 6), 16) << 16)
             | (parseInt(h.substring(6, 8), 16) << 24);
    }

    private _u16FromHex(h: string, off: number): number {
        return parseInt(h.substring(off, off + 2), 16)
             | (parseInt(h.substring(off + 2, off + 4), 16) << 8);
    }

    private _biometricFromHex(h: string): {
        gender: number; weight: number; height: number;
        age: number; ppgPosition: number; bhr: number;
    } {
        if (h.length < 16) {
            return { gender: 0, weight: 0, height: 0, age: 0, ppgPosition: 0, bhr: 0 };
        }
        return {
            gender:      parseInt(h.substring(0, 2), 16),
            weight:      this._u16FromHex(h, 2),
            height:      this._u16FromHex(h, 6),
            age:         parseInt(h.substring(10, 12), 16),
            ppgPosition: parseInt(h.substring(12, 14), 16),
            bhr:         parseInt(h.substring(14, 16), 16)
        };
    }

    private _vibrationFromHex(h: string): {
        loops: number; count: number; onOffMs: number[];
    } {
        if (h.length < 4) {
            return { loops: 0, count: 0, onOffMs: [] };
        }
        const loops = parseInt(h.substring(0, 2), 16);
        const count = parseInt(h.substring(2, 4), 16);
        const onOffMs: number[] = [];
        for (let i = 0; i < count * 2; i++) {
            onOffMs.push(this._u16FromHex(h, 4 + i * 4));
        }
        return { loops, count, onOffMs };
    }

    /* ===== 0x30 ~ 0x40 高层命令 ===== */
    readFirmwareVersion(): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.READ_FIRMWARE_VERSION, "");
    }
    setDeviceNumber(s: string): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.SET_DEVICE_NUMBER, serializeDeviceNumber(s));
    }
    readDeviceNumber(): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.READ_DEVICE_NUMBER, "");
    }
    setTimestamp(sec: number): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.SET_BOOM_TIMESTAMP, serializeTimestamp(sec));
    }
    readTimestamp(): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.READ_BOOM_TIMESTAMP, "");
    }
    setBiometric(b: VitalBiometric): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.SET_BIOMETRIC, serializeBiometric(b));
    }
    readBiometric(): Promise<boolean> {
        return this.sendTlvc(BOOM_CMD.READ_BIOMETRIC, "");
    }
    controlVibration(spec: VibrationSpec): Promise<boolean> {
        if (spec.count > 10) spec.count = 10;
        return this.sendTlvc(BOOM_CMD.CONTROL_VIBRATION, serializeVibration(spec));
    }
}
