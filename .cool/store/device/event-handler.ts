import {
    arrayBufferToHexString,
    decodeTlvc,
    BOOM_GATT_SERVICE_UUID,
    BOOM_CMD,
    parseFirmwareVersion,
    parseDeviceNumber,
    parseTimestamp,
    parseBiometric,
    parseVibrationResult
} from "../../bluetooth";
import type { FirmwareVersion, VitalBiometric, VibrationResult } from "../../bluetooth";

//#ifndef H5
import { onCharacteristicValueChange } from "../../bluetooth/kux";
//#endif

import type { Device } from "./index";

/**
 * BOOM 设备事件处理器
 * 监听 GATT notify → 解析 TLVC → 写入对应字段
 */
export class EventHandler {
    firmwareVersion: FirmwareVersion | null = null;
    deviceNumber: string = "";
    boomTimestamp: number = 0;
    biometricInfo: VitalBiometric | null = null;
    lastVibration: VibrationResult | null = null;

    private device: Device;

    constructor(device: Device) {
        this.device = device;
    }

    onCharacteristicValueChange(): void {
        //#ifndef H5
        onCharacteristicValueChange((res) => {
            const hexData = arrayBufferToHexString(res.value);
            const serviceId = (res.serviceId ?? "").toLowerCase();
            if (serviceId != BOOM_GATT_SERVICE_UUID.toLowerCase()) return;

            const f = decodeTlvc(hexData);
            if (f == null) {
                console.warn("[BOOM] CRC 校验失败:", hexData);
                return;
            }

            switch (f.t) {
                case BOOM_CMD.READ_FIRMWARE_VERSION:
                    this.firmwareVersion = parseFirmwareVersion(f.v);
                    console.log("[BOOM] 固件版本:", this.firmwareVersion);
                    break;
                case BOOM_CMD.SET_DEVICE_NUMBER:
                case BOOM_CMD.READ_DEVICE_NUMBER:
                    this.deviceNumber = parseDeviceNumber(f.v);
                    console.log("[BOOM] 设备编号:", this.deviceNumber);
                    break;
                case BOOM_CMD.SET_BOOM_TIMESTAMP:
                case BOOM_CMD.READ_BOOM_TIMESTAMP:
                    this.boomTimestamp = parseTimestamp(f.v);
                    console.log("[BOOM] 时戳:", this.boomTimestamp);
                    break;
                case BOOM_CMD.SET_BIOMETRIC:
                case BOOM_CMD.READ_BIOMETRIC:
                    this.biometricInfo = parseBiometric(f.v);
                    console.log("[BOOM] 生物识别:", this.biometricInfo);
                    break;
                case BOOM_CMD.CONTROL_VIBRATION:
                    this.lastVibration = parseVibrationResult(f.v);
                    console.log("[BOOM] 震动结果:", this.lastVibration);
                    break;
                default:
                    console.log("[BOOM] 未知 T:", f.t, "数据:", hexData);
            }
        });
        //#endif
    }
}
