import { storage } from "../../utils/storage";
import { logger } from "../../service/logger";

/**
 * 基准补录的运行时可调参数。
 *
 * 这两个值只有真机数据才能定，而「改一次代码、重装一次」的调参节奏不可接受，
 * 所以它们不写死在常量里：默认值仍定义在这里，本地覆盖走 uni storage 持久化。
 * 所有读取点都必须调用 `getHistoryTunables()`，不允许别处直接引用默认常量——
 * 否则调参只对一部分路径生效，日志里会看到「文档说改了、行为没变」。
 */
export type HistoryTunables = {
	/** 记账余量：`stableCeiling = now - minuteSettleSec`。唯一会造成数据错误的参数。 */
	minuteSettleSec: number;
	/** 桥接：相距这么近的缺口合并成一条读取链路。 */
	bridgeSec: number;
};

/** 缺口桥接的默认值，沿用老流程的 `HISTORY_GATT_READ_BRIDGE_SEC`。 */
export const HISTORY_GATT_READ_BRIDGE_SEC = 120;

const DEFAULT_TUNABLES: HistoryTunables = {
	minuteSettleSec: 10,
	bridgeSec: HISTORY_GATT_READ_BRIDGE_SEC
} as HistoryTunables;

const TUNE_PREFIX = "boom_history_tune_";
const TUNE_KEYS: string[] = ["minuteSettleSec", "bridgeSec"];

/**
 * 生效值缓存。
 *
 * 缓存的是**计算结果**而不是「模块加载时的快照」：`setHistoryTunable()` 会立刻
 * 让缓存失效，所以改完马上生效，不需要重启。缓存本身是必需的——`minuteSettleSec`
 * 每秒都会被广播路径读到，每次都走 `uni.getStorageSync` 是同步 IO。
 */
let cached: HistoryTunables | null = null;

function defaultValueOf(key: string): number {
	if (key == "minuteSettleSec") return DEFAULT_TUNABLES.minuteSettleSec;
	if (key == "bridgeSec") return DEFAULT_TUNABLES.bridgeSec;
	return 0;
}

function readOverride(key: string): number {
	try {
		const raw = storage.get(TUNE_PREFIX + key);
		if (raw == null || raw == "") return 0;
		const value = parseInt(`${raw}`);
		if (isNaN(value) == true || value <= 0) return 0;
		return value;
	} catch (e) {
		logger.warn("bluetooth", `[BOOM-TUNE] 读取参数覆盖失败: key=${key}, error=${e}`);
		return 0;
	}
}

function buildTunables(): HistoryTunables {
	const result: HistoryTunables = {
		minuteSettleSec: DEFAULT_TUNABLES.minuteSettleSec,
		bridgeSec: DEFAULT_TUNABLES.bridgeSec
	} as HistoryTunables;
	for (let i = 0; i < TUNE_KEYS.length; i++) {
		const key = TUNE_KEYS[i];
		const override = readOverride(key);
		if (override <= 0) continue;
		if (key == "minuteSettleSec") result.minuteSettleSec = override;
		else if (key == "bridgeSec") result.bridgeSec = override;
	}
	return result;
}

export function getHistoryTunables(): HistoryTunables {
	if (cached != null) return cached;
	cached = buildTunables();
	return cached;
}

/** 某个参数的当前生效值。 */
export function getHistoryTunable(key: string): number {
	const current = getHistoryTunables();
	if (key == "minuteSettleSec") return current.minuteSettleSec;
	if (key == "bridgeSec") return current.bridgeSec;
	return 0;
}

/** 默认值，供弹窗展示「默认 / 已覆盖」。 */
export function getHistoryTunableDefault(key: string): number {
	return defaultValueOf(key);
}

export function getHistoryTunableKeys(): string[] {
	return TUNE_KEYS.slice();
}

export function isHistoryTunableOverridden(key: string): boolean {
	return readOverride(key) > 0;
}

/**
 * 写入覆盖值。`value <= 0` 视为清除覆盖、回落到默认值。
 * 覆盖必须打日志，否则「为什么行为和文档不一致」会很难查。
 */
export function setHistoryTunable(key: string, value: number): void {
	const fallback = defaultValueOf(key);
	if (fallback <= 0) {
		logger.warn("bluetooth", `[BOOM-TUNE] 忽略未知参数: key=${key}`);
		return;
	}
	if (value <= 0) {
		storage.remove(TUNE_PREFIX + key);
		cached = null;
		logger.info("bluetooth", `[BOOM-TUNE] 参数已重置: key=${key}, 生效=${fallback}`);
		return;
	}
	storage.set(TUNE_PREFIX + key, value, 0);
	cached = null;
	logger.info(
		"bluetooth",
		`[BOOM-TUNE] 参数覆盖: key=${key}, 默认=${fallback}, 生效=${value}`
	);
}

export function resetHistoryTunables(): void {
	for (let i = 0; i < TUNE_KEYS.length; i++) {
		storage.remove(TUNE_PREFIX + TUNE_KEYS[i]);
	}
	cached = null;
	logger.info("bluetooth", `[BOOM-TUNE] 参数已重置: key=all`);
}
