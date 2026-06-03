import { getServiceName, getCharacteristicName } from "../data/bluetooth-constants";
import type { HeartRateRecord, DataReadyStatus, SleepData, SleepStatus } from "./types";

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

	const reportTimestamp = bytes[0] + (bytes[1] << 8) + (bytes[2] << 16) + (bytes[3] << 24);
	const bedtime = bytes[4] + (bytes[5] << 8) + (bytes[6] << 16) + (bytes[7] << 24);
	const sleepTime = bytes[8] + (bytes[9] << 8) + (bytes[10] << 16) + (bytes[11] << 24);
	const wakeTime = bytes[12] + (bytes[13] << 8) + (bytes[14] << 16) + (bytes[15] << 24);
	const getupTime = bytes[16] + (bytes[17] << 8) + (bytes[18] << 16) + (bytes[19] << 24);
	const recordCount = bytes[20] + (bytes[21] << 8) + (bytes[22] << 16) + (bytes[23] << 24);

	const statuses: SleepStatus[] = [];
	for (let i = 24; i < bytes.length; i++) {
		const val = bytes[i];
		let statusNum = 0;
		if (val == 254) {
			statusNum = -2;
		} else if (val == 255) {
			statusNum = -1;
		} else if (val == 0) {
			statusNum = 0;
		} else if (val == 1) {
			statusNum = 1;
		} else {
			statusNum = val;
		}
		statuses.push({
			id: "",
			sleepId: "",
			minuteIndex: i - 24,
			status: statusNum
		});
	}

	return { reportTimestamp, bedtime, sleepTime, wakeTime, getupTime, recordCount, statuses };
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
