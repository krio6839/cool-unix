import { getServiceName, getCharacteristicName } from "../data/bluetooth-constants";
import type { HeartRateRecord, DataReadyStatus, SleepData } from "./types";

export { getServiceName, getCharacteristicName };

export const stringToArrayBuffer = (str: string): ArrayBuffer => {
	const hexRegex = /^(0x)?[0-9a-fA-F]+$/;
	if (hexRegex.test(str)) {
		return hexStringToArrayBuffer(str);
	}

	const buffer = new ArrayBuffer(str.length);
	const bufferView = new Uint8Array(buffer);
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		bufferView[i] = code != null ? code : 0;
	}
	return buffer;
};

export const hexStringToArrayBuffer = (hexStr: string): ArrayBuffer => {
	hexStr = hexStr.replace(/\s|0x/g, "");

	if (hexStr.length % 2 != 0) {
		hexStr = "0" + hexStr;
	}

	const buffer = new ArrayBuffer(hexStr.length / 2);
	const bufferView = new Uint8Array(buffer);

	for (let i = 0; i < hexStr.length; i += 2) {
		bufferView[i / 2] = parseInt(hexStr.substring(i, i + 2), 16);
	}

	return buffer;
};

export const arrayBufferToHexString = (buffer: ArrayBuffer): string => {
	const uint8Array = new Uint8Array(buffer);
	let hexStr = "";
	for (let i = 0; i < uint8Array.length; i++) {
		const bit = uint8Array[i];
		hexStr += ("00" + bit.toString(16)).slice(-2);
	}
	return hexStr;
};

export const parseHeartRateData = (hexData: string): Array<number> => {
	const hexStr = hexData.replace(/\s/g, "").toUpperCase();
	if (hexStr.length < 4) {
		return [0, 0];
	}

	const bytes: number[] = [];
	for (let i = 0; i < hexStr.length; i += 2) {
		bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
	}

	const heartRate = bytes[1];
	const ppi = bytes[2] + (bytes[3] << 8);

	return [heartRate, ppi];
};

export const parseBloodOxygenData = (hexData: string): number => {
	const hexStr = hexData.replace(/\s/g, "").toUpperCase();
	if (hexStr.length < 2) {
		return 0;
	}

	return parseInt(hexStr.substring(0, 2), 16);
};

export const parseBatteryData = (hexData: string): number => {
	const hexStr = hexData.replace(/\s/g, "").toUpperCase();
	if (hexStr.length < 2) {
		return 0;
	}

	return parseInt(hexStr.substring(0, 2), 16);
};

export const parseDataReadyStatus = (hexData: string): DataReadyStatus => {
	const cleanData = hexData.replace(/\s/g, "").toUpperCase();

	// 如果包含 AAAA 或 , 说明是直接的 ASCII 字符串
	if (cleanData.indexOf("AAAA") != -1 || cleanData.indexOf(",") != -1) {
		const parts = cleanData.split(",");
		if (parts.length != 2) {
			return { heartRateCount: 0, sleepCount: 0 };
		}
		const heartRateCount = parseInt(parts[0], 10) ?? 0;
		const sleepCount = parseInt(parts[1], 10) ?? 0;
		return { heartRateCount, sleepCount };
	}

	// 否则假设是十六进制 ASCII 编码的数据（如 "3438302c30"）
	// 转换为 ASCII 字符串后再解析
	if (cleanData.length % 2 === 0) {
		let asciiStr = "";
		for (let i = 0; i < cleanData.length; i += 2) {
			const charCode = parseInt(cleanData.substring(i, i + 2), 16);
			if (!isNaN(charCode)) {
				asciiStr += String.fromCharCode(charCode);
			}
		}
		const parts = asciiStr.split(",");
		if (parts.length === 2) {
			const heartRateCount = parseInt(parts[0], 10) ?? 0;
			const sleepCount = parseInt(parts[1], 10) ?? 0;
			return { heartRateCount, sleepCount };
		}
	}

	return { heartRateCount: 0, sleepCount: 0 };
};

export const parseRTCResponse = (hexData: string): number => {
	// 1. 十六进制 → 文本
	let text = "";
	for (let i = 0; i < hexData.length; i += 2) {
		const byte = hexData.substring(i, i + 2);
		text += String.fromCharCode(parseInt(byte, 16));
	}

	// 2. 提取 RTC: 后面的数字（UTS 严格模式写法）
	const match = text.match(/RTC:(\d+)/);
	if (match !== null && match[1] !== null) {
		// 使用非空断言操作符确保类型为 string
		return parseInt(match[1]!, 10);
	}
	return 0;
};

export const parseHistoricalHeartRateData = (hexData: string): Array<HeartRateRecord> => {
	const cleanData = hexData.replace(/\s/g, "").toUpperCase();
	const records: Array<HeartRateRecord> = [];
	const bytes: number[] = [];
	for (let i = 0; i < cleanData.length; i += 2) {
		bytes.push(parseInt(cleanData.substring(i, i + 2), 16));
	}

	const groupCount = Math.floor(bytes.length / 8);
	for (let i = 0; i < groupCount; i++) {
		const offset = i * 8;
		const timestamp =
			bytes[offset] +
			(bytes[offset + 1] << 8) +
			(bytes[offset + 2] << 16) +
			(bytes[offset + 3] << 24);
		const heartRate = bytes[offset + 4];
		const bloodOxygen = bytes[offset + 5];
		const ppi = bytes[offset + 6] + (bytes[offset + 7] << 8);
		if (timestamp != -1) {
			records.push({ timestamp, heartRate, bloodOxygen, ppi });
		}
	}
	return records;
};

export const parseSleepData = (hexData: string): SleepData => {
	const cleanData = hexData.replace(/\s/g, "").toUpperCase();
	const bytes: number[] = [];
	for (let i = 0; i < cleanData.length; i += 2) {
		bytes.push(parseInt(cleanData.substring(i, i + 2), 16));
	}

	const reportTimestamp = parseUint32LE(bytes, 0);
	const bedtime = parseUint32LE(bytes, 4);
	const sleepTime = parseUint32LE(bytes, 8);
	const wakeTime = parseUint32LE(bytes, 12);
	const getupTime = parseUint32LE(bytes, 16);
	const recordCount = parseUint32LE(bytes, 20);
	const statusHex = cleanData.substring(48);
	const detail = parseStatusBytesToDetail(statusHex);

	return {
		reportTimestamp,
		bedtime,
		sleepTime,
		wakeTime,
		getupTime,
		recordCount,
		detail
	};
};

/**
 * 把状态字节流（recordCount 字节）按用户规则生成 detail 字符串。
 * 规则：状态字节按有符号解析，detail_char = (signed_value + 2).toString()，逐字节拼接。
 *   - 0xFE (signed=-2) → "0"
 *   - 0xFF (signed=-1) → "1"
 *   - 0x00 → "2"
 *   - 0x01 → "3"
 *   - 0x02 → "4"
 *   - 0x03 → "5"
 */
export const parseStatusBytesToDetail = (hexData: string): string => {
	const cleanData = hexData.replace(/\s/g, "").toUpperCase();
	let detail = "";
	for (let i = 0; i < cleanData.length; i += 2) {
		const unsigned = parseInt(cleanData.substring(i, i + 2), 16);
		const signed = unsigned > 127 ? unsigned - 256 : unsigned;
		detail += (signed + 2).toString();
	}
	return detail;
};

/**
 * 从字节数组按 LSB 模式解析 uint32。
 * @param bytes 字节数组
 * @param offset 起始字节偏移
 * @returns 解析出的 32 位无符号整数（可能 > 2^31 会被当作 number 看待，BLE 协议上为秒计数）
 */
export const parseUint32LE = (bytes: number[], offset: number): number => {
	const b0 = bytes[offset] ?? 0;
	const b1 = bytes[offset + 1] ?? 0;
	const b2 = bytes[offset + 2] ?? 0;
	const b3 = bytes[offset + 3] ?? 0;
	// 通过 >>> 0 把 32 位有符号结果转无符号；超过 32 位有符号时 number 转为浮点，保持精度直至 2^53
	return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
};

export const convertNumberToHexString = (num: number, byteLength: number): string => {
	let hex = num.toString(16);
	while (hex.length < byteLength * 2) {
		hex = "0" + hex;
	}
	return hex;
};

export const convertNumberToHexStringLSB = (num: number, byteLength: number): string => {
	// 将数字按小端序转换为字节数组
	const result: string[] = [];
	for (let i = 0; i < byteLength; i++) {
		const byte = (num >> (i * 8)) & 0xff;
		result.push(byte.toString(16).padStart(2, "0"));
	}
	return result.join("");
};
