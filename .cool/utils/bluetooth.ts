import { getServiceName, getCharacteristicName } from "../data/bluetooth-constants";

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

export const HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";
export const BLOOD_OXYGEN_SERVICE_UUID = "00001523-1212-efde-1523-785feabcd123";
export const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
export const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const LED_BUTTON_SERVICE_UUID = "00001523-1212-efde-1523-785feabcd123";
export const LED_BUTTON_CHARACTERISTIC_UUID = "00001525-1212-efde-1523-785feabcd123";
