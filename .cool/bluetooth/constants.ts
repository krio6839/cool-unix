// ==================== 上传接口常量 ====================

/**
 * 上传间隔时间（毫秒）
 */
export const UPLOAD_INTERVAL = 30 * 1000;

/**
 * 最大数据保存时间（毫秒）- 90天
 */
export const MAX_DATA_AGE = 90 * 24 * 60 * 60 * 1000;

// const UPLOAD_URL = "http://47.100.30.18:8000/upload";

/**
 * PPI数据上传接口完整地址
 */
export const UPLOAD_PPI_URL = "/upload/ppi";

/**
 * 睡眠数据上传接口完整地址
 */
export const UPLOAD_SLEEP_URL = "/upload/sleep";
