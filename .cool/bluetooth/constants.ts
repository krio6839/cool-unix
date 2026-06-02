/**
 * LED按钮服务UUID
 */
export const LED_BUTTON_SERVICE_UUID = "00001523-1212-efde-1523-785feabcd123";

/**
 * LED按钮特征UUID
 */
export const LED_BUTTON_CHARACTERISTIC_UUID = "00001525-1212-efde-1523-785feabcd123";

/**
 * 心率服务UUID
 */
export const HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";

/**
 * 心率特征UUID
 */
export const HEART_RATE_CHARACTERISTIC_UUID = "00002a37-0000-1000-8000-00805f9b34fb";

/**
 * 电池服务UUID
 */
export const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";

/**
 * UART服务UUID
 */
export const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

/**
 * 血氧特征UUID
 */
export const BLOOD_OXYGEN_CHARACTERISTIC_UUID = "00001524-1212-efde-1523-785feabcd123";

/**
 * UART发送特征UUID
 */
export const UART_TX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

/**
 * UART接收特征UUID
 */
export const UART_RX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// ==================== 上传接口常量 ====================

/**
 * 上传间隔时间（毫秒）- 每10秒上传一次
 */
export const UPLOAD_INTERVAL = 10 * 1000;

/**
 * 最大数据保存时间（毫秒）- 90天
 */
export const MAX_DATA_AGE = 90 * 24 * 60 * 60 * 1000;

const UPLOAD_URL = "http://47.100.30.18:8000/upload";

/**
 * PPI数据上传接口完整地址
 */
export const UPLOAD_PPI_URL = "/upload/ppi";

/**
 * 睡眠数据上传接口完整地址
 */
export const UPLOAD_SLEEP_URL = "/upload/sleep";
