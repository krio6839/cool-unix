/**
 * BOOM 协议 — LE 字节编/解码公共工具
 *
 * 全部函数输入输出均为 hex 字符串（无空格、无 0x 前缀），
 * U 表示无符号，I 表示有符号，LE 表示小端字节序。
 * 所有函数为纯函数，无外部依赖，便于单测。
 */

/* ==================== 编码（number → hex） ==================== */

/**
 * U8 编码：1 字节 hex（2 字符），如 0x30 → "30"
 */
export function encodeU8(n: number): string {
	return (n & 0xff).toString(16).padStart(2, "0");
}

/**
 * U16 LE 编码：2 字节 hex，LSB 在前，如 0x1234 → "3412"
 */
export function encodeU16LE(n: number): string {
	return encodeU8(n) + encodeU8((n >> 8) & 0xff);
}

/**
 * U16 BE 编码：2 字节 hex，MSB 在前，如 0x1234 → "1234"
 */
export function encodeU16BE(n: number): string {
	return encodeU8((n >> 8) & 0xff) + encodeU8(n);
}

/**
 * I16 LE 编码：负数自动转补码，如 -1 → "ffff"
 */
export function encodeI16LE(n: number): string {
	const v = n < 0 ? n + 0x10000 : n;
	return encodeU16LE(v);
}

/**
 * U32 LE 编码：4 字节 hex，LSB 在前
 */
export function encodeU32LE(n: number): string {
	return encodeU16LE(n & 0xffff) + encodeU16LE((n >>> 16) & 0xffff);
}

/* ==================== 解析（hex → number） ==================== */

/**
 * U8 解析：默认从 offset=0 读 1B
 * @param h hex 字符串
 * @param off 起始字节偏移（单位：hex 字符，默认 0）
 */
export function parseU8(h: string, off: number = 0): number {
	return parseInt(h.substring(off, off + 2), 16);
}

/**
 * U16 LE 解析：默认从 offset=0 读 2B
 */
export function parseU16LE(h: string, off: number = 0): number {
	return parseU8(h, off) | (parseU8(h, off + 2) << 8);
}

/**
 * I16 LE 解析：>0x7FFF 自动减 0x10000 转有符号
 */
export function parseI16LE(h: string, off: number = 0): number {
	const u = parseU16LE(h, off);
	return u > 0x7fff ? u - 0x10000 : u;
}

/**
 * U32 LE 解析：默认从 offset=0 读 4B
 */
export function parseU32LE(h: string, off: number = 0): number {
	// 使用算术而不是 32 位位运算，避免最高位为 1 时变成负数。
	return parseU16LE(h, off) + parseU16LE(h, off + 4) * 65536;
}

/** IEEE754 float32 小端解析，不依赖 DataView/Buffer。 */
export function parseFloat32LE(h: string, off: number = 0): number {
	const b0 = parseU8(h, off);
	const b1 = parseU8(h, off + 2);
	const b2 = parseU8(h, off + 4);
	const b3 = parseU8(h, off + 6);
	const sign = (b3 & 0x80) == 0 ? 1 : -1;
	const exp = ((b3 & 0x7f) << 1) | ((b2 >> 7) & 0x01);
	const frac = ((b2 & 0x7f) * 65536 + b1 * 256 + b0) as number;
	if (exp == 255) {
		return frac == 0 ? sign * Infinity : NaN;
	}
	if (exp == 0) {
		if (frac == 0) return sign * 0;
		return sign * Math.pow(2, -126) * (frac / 8388608);
	}
	return sign * Math.pow(2, exp - 127) * (1 + frac / 8388608);
}

/* ==================== ASCII 字符串编解码 ==================== */

/**
 * ASCII 字符串 → hex（每字符 1B），如 "AB" → "4142"
 */
export function encodeAscii(s: string): string {
	let h = "";
	for (let i = 0; i < s.length; i++) {
		// UTS 中 charCodeAt 返回 Number | null，兜底 0
		const code: number = s.charCodeAt(i) ?? 0;
		h += encodeU8(code);
	}
	return h;
}

/**
 * hex → ASCII 字符串（每 2 hex 字符 1B），如 "4142" → "AB"
 * @param h hex 字符串
 * @param off 起始字节偏移（单位：hex 字符，默认 0）
 * @param byteLen 要解析的字节数（默认到 h 末尾）
 *
 * 注意：UTS 不支持纯 `?:` 可选参数，byteLen 用 `number | null = null` 表示
 */
export function parseAscii(h: string, off: number = 0, byteLen: number | null = null): string {
	const end = byteLen != null ? off + byteLen * 2 : h.length;
	let s = "";
	for (let i = off; i < end; i += 2) {
		// UTS 中 fromCharCode 返回 String | null，兜底 ""
		s += String.fromCharCode(parseU8(h, i)) ?? "";
	}
	return s;
}
