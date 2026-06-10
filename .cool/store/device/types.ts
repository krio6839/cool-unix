export type WearLocation = "大臂部" | "下胸部" | "腰部";

export const KEY_WEAR_LOCATION = "device_wear_location";
export const KEY_BOUND_DEVICE_ID = "bound_device_id";
/** 已保存到 ppi_data 的条数（断点续传用；0 表示未抓取过） */
export const KEY_PPI_SAVED_COUNT = "ppi_data_saved_count";
/** 已保存到 sleep_data 的条数（断点续传用；0 表示未抓取过） */
export const KEY_SLEEP_SAVED_COUNT = "sleep_data_saved_count";

export const TARGET_DEVICE_NAME = "BOOM1";

export enum DeviceStatusEnum {
	UNPAIRED = "unpaired",
	PAIRING = "pairing",
	SEARCHING = "searching",
	CONNECTED = "connected"
}

export type DeviceStatus = keyof typeof DeviceStatusEnum;
