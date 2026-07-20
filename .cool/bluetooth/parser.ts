/**
 * hex ↔ ArrayBuffer 通用工具
 * 新 BOOM 协议不再依赖任何旧协议解析函数
 */

/**
 * 十六进制字符串 → ArrayBuffer
 * 支持 0x 前缀与空白字符
 */
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

/**
 * ArrayBuffer → 十六进制字符串（小写）
 */
export const arrayBufferToHexString = (buffer: ArrayBuffer): string => {
	const uint8Array = new Uint8Array(buffer);
	let hexStr = "";
	for (let i = 0; i < uint8Array.length; i++) {
		const bit = uint8Array[i];
		hexStr += ("00" + bit.toString(16)).slice(-2);
	}
	return hexStr;
};
