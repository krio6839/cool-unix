/**
 * 秒数据稳定余量。
 *
 * 分类（推进 `C`、以及 `B` 的合格推进）和读取侧记账（`advanceAccounted`）都最多到
 * `nowSec - HISTORY_MINUTE_SETTLE_SEC`，避免把仍可能到达的当前秒误判为缺失。
 * 所有时间均为 Unix 秒，不做分钟边界对齐。
 */
export const HISTORY_MINUTE_SETTLE_SEC = 10;
