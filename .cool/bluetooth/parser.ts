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
	const parts = cleanData.split(",");
	if (parts.length != 2) {
		return { heartRateCount: 0, sleepCount: 0 };
	}
	const heartRateCount = parseInt(parts[0], 10) ?? 0;
	const sleepCount = parseInt(parts[1], 10) ?? 0;
	return { heartRateCount, sleepCount };
};

export const parseRTCResponse = (hexData: string): number => {
	const cleanData = hexData.replace(/\s/g, "").toUpperCase();
	const rtcIndex = cleanData.indexOf("5254433A");
	if (rtcIndex == -1) {
		const num = parseInt(cleanData, 16);
		return isNaN(num) ? 0 : num;
	}
	const numStr = cleanData.substring(rtcIndex + 8);
	const num = parseInt(numStr, 16);
	return isNaN(num) ? 0 : num;
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
		records.push({ timestamp, heartRate, bloodOxygen, ppi });
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
