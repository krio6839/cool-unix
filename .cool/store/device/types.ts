import { PPG_POSITION_OPTIONS } from "../../bluetooth/boom-constants";
import type { PpgPositionOption, PpgPositionValue } from "../../bluetooth/boom-types";

export type WearLocation = PpgPositionValue;
export type WearLocationOption = PpgPositionOption;

export const DEFAULT_WEAR_LOCATION: WearLocation = 2;

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

export function isValidWearLocation(value: number): boolean {
    for (let i = 0; i < PPG_POSITION_OPTIONS.length; i++) {
        const item = PPG_POSITION_OPTIONS[i];
        if (item != null && item.value == value) return true;
    }
    return false;
}

export function normalizeWearLocation(value: any): WearLocation {
    if (typeof value == "number" && isValidWearLocation(value)) return value;
    if (typeof value == "string") {
        if (value == "大臂部") return 2;
        if (value == "腰部") return 6;
        if (value == "下胸部") return 6;
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed) == false && isValidWearLocation(parsed)) return parsed;
    }
    return DEFAULT_WEAR_LOCATION;
}

export function getWearLocationLabel(location: WearLocation): string {
    for (let i = 0; i < PPG_POSITION_OPTIONS.length; i++) {
        const item = PPG_POSITION_OPTIONS[i];
        if (item != null && item.value == location) return item.label;
    }
    return "上臂";
}

export function getWearLocationOptions(): WearLocationOption[] {
    return PPG_POSITION_OPTIONS.slice();
}
