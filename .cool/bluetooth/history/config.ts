/**
 * 秒数据稳定余量。
 *
 * 分类和 ready 写入最多到 `nowSec - HISTORY_MINUTE_SETTLE_SEC`，避免把仍可能到达的
 * 当前秒误判为缺失。所有时间均为 Unix 秒，不做分钟边界对齐。
 */
export const HISTORY_MINUTE_SETTLE_SEC = 10;

/**
 * 缺口桥接距离。
 *
 * 相邻两个缺口之间已有数据不超过该秒数时，合成一次连续 GATT 读取；桥接部分只读过，
 * 不重复落库，也不计入真正需要修复的 `repairSeconds`。
 */
export const HISTORY_GATT_READ_BRIDGE_SEC = 120;
