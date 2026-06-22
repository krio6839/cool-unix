export type WearLocation = "大臂部" | "下胸部" | "腰部";

export const KEY_WEAR_LOCATION = "device_wear_location";
export const KEY_BOUND_DEVICE_ID = "bound_device_id";

/** 新设备名匹配：BOOM-XXXX 前缀（来自状态说明.txt 1.4.1） */
export const TARGET_DEVICE_NAME_PREFIX = "BOOM-";

export enum DeviceStatusEnum {
    UNPAIRED = "unpaired",
    PAIRING = "pairing",
    SEARCHING = "searching",
    CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;
