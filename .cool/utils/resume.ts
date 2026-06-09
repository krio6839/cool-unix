import { storage } from "./storage";

/**
 * 读取持久化的进度计数(断点续传专用)。
 *
 * 封装三件事:
 *  1. 跨平台类型守卫 —— Android 端 storage 可能返回 String,UTS 强转会抛 ClassCastException;
 *     且不能用 `Number()` —— UTS 编译时会被解析为 java.lang.Number 抽象类,导致编译失败。
 *     这里用 typeof 守卫 + parseInt(UTS 安全映射到 String.toIntOrNull)。
 *  2. 边界检查 —— 已保存 > 设备总条数时,认为设备历史被清空,自动重置为 0 并落盘。
 *  3. 完成判断 —— 已保存 >= 设备总条数时,标记为"已全部抓取",调用方应跳过本次抓取。
 *
 * @param key 持久化 storage key(已保存条数)
 * @param totalCount 设备当前总条数
 * @returns savedCount(已保存条数;边界情况下已重置为 0) + isComplete(是否已全部抓取)
 *
 * @example
 * const { savedCount, isComplete } = loadResumeCount(KEY_PPI_SAVED_COUNT, status.heartRateCount);
 * if (isComplete) return;
 * // ... 从 savedCount 继续抓取
 */
type ResumeResult = {
	savedCount: number;
	isComplete: boolean;
};

export function loadResumeCount(
	key: string,
	totalCount: number
): ResumeResult {
	const raw = storage.get(key);
	let savedCount = 0;
	if (typeof raw == "number") {
		savedCount = raw;
	} else if (typeof raw == "string") {
		const parsed = parseInt(raw, 10);
		savedCount = isNaN(parsed) ? 0 : parsed;
	}

	// 边界:已保存 > 设备总条数 → 设备历史被清空 → 重置计数
	if (savedCount > totalCount) {
		console.log(
			`[RESUME] 已保存(${savedCount}) > 设备总条数(${totalCount})，设备历史被清空，重置计数`
		);
		storage.set(key, 0, 0);
		savedCount = 0;
	}

	// 全部已抓取
	if (savedCount >= totalCount) {
		return { savedCount, isComplete: true };
	}

	return { savedCount, isComplete: false };
}
