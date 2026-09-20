import { bluetoothDatabase } from "../database";
import { historyCoverage } from "./coverage-service";
import { getHistoryTunables } from "./tunables";
import { normalizeRanges, subtractRanges, countRangeSeconds } from "./coverage";
import type { HistoryTimeRange } from "./coverage";
import { logger } from "../../service/logger";

/**
 * 基准时间 `baseline_sec`（下称 `B`）：`[0, B)` 的每一秒都已记账完毕。
 *
 * 「记账完毕」有两种形式：合格（本地数据完整度达标）和已确认（设备已响应并
 * 明确没有更多数据）。两者都落在 `vital_ready_ranges` 里，缺口由 `B` 与该表
 * 相减直接得出，不存表。
 *
 * 区间和 `B` 都是秒级的、不整分钟对齐：对齐会在 `B` 停在分钟中间时让分类右端
 * 落到 `B` 之前，整轮判不动。
 */
export const BASELINE_SCHEMA: string[] = [
	`CREATE TABLE IF NOT EXISTS vital_sync_state (id INTEGER PRIMARY KEY CHECK(id=1), baseline_sec INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS vital_ready_ranges (from_sec INTEGER NOT NULL, to_sec INTEGER NOT NULL, PRIMARY KEY(from_sec,to_sec))`
];

/** 保留 Unix 秒值，同时附带可读的 UTC 时间，方便诊断日志定位实际时间。 */
export function formatHistorySec(sec: number): string {
	return `${sec}(${new Date(sec * 1000).toISOString().replace("T", " ")})`;
}

/**
 * 一分钟合格判定的连续缺失阈值，见方案第 3 节。
 *
 * 缺失总量那一关不在这里——它是 `missing * 100 < 窗口长度 * MISSING_TOTAL_PERCENT`，
 * 按窗口长度等比缩放，所以不是一个常量。
 */
const MINUTE_MAX_MISSING_RUN_SEC = 9;

/** 缺失总量容差：缺的秒数占窗口的百分比，`< 30%` 才算合格。 */
const MISSING_TOTAL_PERCENT = 30;

/** 一个待补缺口。`bridgeSeconds` 是合并相邻缺口时跨过的、本地已有的秒。 */
export type HistoryGap = {
	fromSec: number;
	toSec: number;
	repairSeconds: number;
	bridgeSeconds: number;
};

/** 分类结果，供日志与测试页核对。 */
export type BaselineClassifyResult = {
	ceiling: number;
	baselineBefore: number;
	baselineAfter: number;
	unclassifiedSeconds: number;
	qualifiedSeconds: number;
	gapSeconds: number;
	unqualifiedSegments: number;
};

/** 一个段的判定明细。`ready` 是段内可记账的子区间；`blockedRuns` 是真缺口的个数。 */
export type SegmentAssessment = {
	ready: HistoryTimeRange[];
	missingSeconds: number;
	longestMissingRun: number;
	blockedRuns: number;
	blockedSeconds: number;
};

/** 把秒列表压成连续区间。输入允许乱序。 */
function timestampsToRanges(timestamps: number[]): HistoryTimeRange[] {
	if (timestamps.length == 0) return [];
	const sorted = timestamps.slice();
	for (let i = 1; i < sorted.length; i++) {
		const value = sorted[i];
		let index = i - 1;
		while (index >= 0 && sorted[index] > value) {
			sorted[index + 1] = sorted[index];
			index--;
		}
		sorted[index + 1] = value;
	}
	const ranges: HistoryTimeRange[] = [];
	let from = sorted[0];
	let to = sorted[0] + 1;
	for (let i = 1; i < sorted.length; i++) {
		const value = sorted[i];
		if (value < to) continue;
		if (value == to) {
			to = value + 1;
			continue;
		}
		ranges.push({ fromSec: from, toSec: to });
		from = value;
		to = value + 1;
	}
	ranges.push({ fromSec: from, toSec: to });
	return ranges;
}

class HistoryBaseline {
	/**
	 * 记账右端，也是缺口右端、分类右端。
	 *
	 * 第 `s` 秒可以记账当且仅当 `s + minuteSettleSec <= now`，也就是
	 * `s <= now - minuteSettleSec`。这个条件对每一秒单独成立，与分钟边界无关，
	 * **不要向上取整到分钟**：取整会在 `B` 已推进到分钟中间时让分类右端落到
	 * `B` 之前，整轮判不动，缺口留着又拉起一次连接。
	 */
	stableCeiling(nowSec: number): number {
		return nowSec - getHistoryTunables().minuteSettleSec;
	}

	async getBaseline(): Promise<number> {
		const result = await bluetoothDatabase.query(
			"SELECT baseline_sec FROM vital_sync_state WHERE id=1"
		);
		if (result == null) throw new Error("读取基准时间失败");
		if (result.rows.length == 0) return 1;
		return parseInt(result.rows[0][0] as string);
	}

	private async setBaseline(value: number): Promise<void> {
		// Android 内置 SQLite 不支持 UPSERT，先 UPDATE 再 INSERT OR IGNORE。
		const saved = await bluetoothDatabase.transaction([
			`UPDATE vital_sync_state SET baseline_sec=${value} WHERE id=1`,
			`INSERT OR IGNORE INTO vital_sync_state (id,baseline_sec) VALUES (1,${value})`
		]);
		if (saved == false) throw new Error("保存基准时间失败");
	}

	async listReadyRanges(): Promise<HistoryTimeRange[]> {
		const result = await bluetoothDatabase.query(
			"SELECT from_sec,to_sec FROM vital_ready_ranges ORDER BY from_sec ASC"
		);
		if (result == null) throw new Error("读取已记账区间失败");
		const ranges: HistoryTimeRange[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			ranges.push({
				fromSec: parseInt(result.rows[i][0] as string),
				toSec: parseInt(result.rows[i][1] as string)
			});
		}
		return ranges;
	}

	/**
	 * 记账 `[from, to)`，右端先被 `stableCeiling` 封顶。超出它的秒尚无定论，
	 * 既不记账也不当作可读缺口，只是等时间走过去。
	 *
	 * 约束下沉到写入这一刻，`advanceBaseline()` 才能不做任何 clamp：
	 * `vital_ready_ranges` 里每一段的右端都不超过 `stableCeiling`，`B` 的上界自动成立。
	 */
	async markReady(fromSec: number, toSec: number, nowSec: number): Promise<void> {
		const from = Math.max(1, Math.floor(fromSec));
		let to = Math.floor(toSec);
		const ceiling = this.stableCeiling(nowSec);
		if (to > ceiling) to = ceiling;
		if (to <= from) return;
		await this.mergeReadyRanges([{ fromSec: from, toSec: to } as HistoryTimeRange]);
	}

	/**
	 * 整表归一化写入。
	 *
	 * 区间行数受「不合格段数」约束而不是时间长度（`B` 卡一天的代价是 1 条
	 * ready 区间，不是 1440 行），所以整体重写的成本可以忽略，而它天然完成
	 * 相邻合并，不需要逐条 diff 的脆弱 SQL。
	 *
	 * `existing` 是调用方**刚刚读到**的现有区间。`classify` 本来就为减法读了它，
	 * 而 `classify` 的写入只发生在这一次调用里，中间没有别的写入者，所以那份列表
	 * 就是当前值。不传则自己读（`markReady` 那条路径没有现成列表）。
	 */
	private async mergeReadyRanges(
		ranges: HistoryTimeRange[],
		existing: HistoryTimeRange[] | null = null
	): Promise<void> {
		if (ranges.length == 0) return;
		const current = existing != null ? existing : await this.listReadyRanges();
		const merged = normalizeRanges(current.concat(ranges));
		const statements: string[] = ["DELETE FROM vital_ready_ranges"];
		for (let i = 0; i < merged.length; i++) {
			statements.push(
				`INSERT OR IGNORE INTO vital_ready_ranges (from_sec,to_sec) VALUES (${merged[i].fromSec},${merged[i].toSec})`
			);
		}
		if ((await bluetoothDatabase.transaction(statements)) == false)
			throw new Error("保存已记账区间失败");
	}

	/**
	 * 判定一段 `[fromSec, toSec)`，返回其中「可以记账」的子区间。
	 *
	 * **不按分钟切，也不整段一刀切。** 判的只有两件事——缺的秒一共多少、最长的一段
	 * 连续缺了多少——两条都不需要知道分钟边界。做法分两遍：
	 *
	 * 1. **连续缺失**（逐段）：每段 `< 9` 秒才算过。空口空洞是连续的，所以这一条是
	 *    真正起作用的约束，它把容差的实际覆盖范围压在 8 秒以内。不过关的段就是
	 *    **真缺口**，把这一段切成若干候选区。
	 * 2. **缺失总量**（逐候选区）：`missing * 100 < 区长度 * 30`（缺的不到 30%）。
	 *    它防的是「很多段各 8 秒、加起来占了一大半」这种稀疏情形——只看连续缺失
	 *    是看不出来的。不过关则整个候选区都不记账。
	 *
	 * 第 1 遍先切、第 2 遍再算总量，是因为两者管的是不同粒度：总量是「这一片有多
	 * 稀疏」的度量，必须在一个不被真缺口打断的连续区域里算，否则一处真缺口会把它
	 * 后面几十秒在场的数据一起作废——`B` 停在缺口前面，后面合格的秒照常记进
	 * `vital_ready_ranges` 等它（5.6）。整段一刀切就会犯这个错。
	 *
	 * 第 3 关「这一段是否已经看完」只作用于贴着右端的段：右端之外还没判到，它可能
	 * 还更长，不能按当前长度放过。`endConfirmed` 为 true 表示右端之外已经确认过
	 * （那一段已被记账，所以未记账区间在此收尾），此时贴着右端的段才给结论。
	 * 不设这一关，一个横跨 `stableCeiling` 的 11 秒空洞会被拆成两段各 8 秒以内，
	 * 被容差整段吃掉。
	 */
	private assessSegment(
		fromSec: number,
		toSec: number,
		endConfirmed: boolean,
		presentRanges: HistoryTimeRange[]
	): SegmentAssessment {
		const window: HistoryTimeRange = { fromSec, toSec };
		const missingRanges = subtractRanges([window], presentRanges);
		const result: SegmentAssessment = {
			ready: [],
			missingSeconds: 0,
			longestMissingRun: 0,
			blockedRuns: 0,
			blockedSeconds: 0
		} as SegmentAssessment;
		let missing = 0;
		for (let i = 0; i < missingRanges.length; i++) {
			const width = missingRanges[i].toSec - missingRanges[i].fromSec;
			missing += width;
			if (width > result.longestMissingRun) result.longestMissingRun = width;
		}
		result.missingSeconds = missing;
		if (missingRanges.length == 0) {
			result.ready.push({ fromSec, toSec });
			return result;
		}

		// 第 1 遍：按连续缺失把整段切成候选区。真缺口本身不属于任何候选区。
		const regions: HistoryTimeRange[] = [];
		let start = fromSec;
		for (let i = 0; i < missingRanges.length; i++) {
			const run = missingRanges[i];
			const runSeconds = run.toSec - run.fromSec;
			// 缺失段贴着整段右端、而右端又没确认时，它可能还更长，这一轮不给结论。
			const knownEnd = run.toSec < toSec || endConfirmed == true;
			if (knownEnd == false || runSeconds >= MINUTE_MAX_MISSING_RUN_SEC) {
				if (run.fromSec > start) regions.push({ fromSec: start, toSec: run.fromSec });
				start = run.toSec;
				result.blockedRuns = result.blockedRuns + 1;
				result.blockedSeconds += runSeconds;
			}
		}
		if (toSec > start) regions.push({ fromSec: start, toSec });

		// 第 2 遍：逐个候选区算缺失总量。过了才记账。
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			const regionMissing = subtractRanges([region], presentRanges);
			let regionMissingSeconds = 0;
			for (let j = 0; j < regionMissing.length; j++) {
				regionMissingSeconds += regionMissing[j].toSec - regionMissing[j].fromSec;
			}
			if (regionMissingSeconds * 100 < (region.toSec - region.fromSec) * MISSING_TOTAL_PERCENT) {
				result.ready.push(region);
			}
		}
		return result;
	}

	/**
	 * 保留窗口钳制：`B` 早于 30 天保留起点时一次性跳过去。
	 *
	 * 必须**在分类之前**跑：分类要遍历 `[B, stableCeiling)`，全新安装时 `B = 1`，
	 * 不先钳制就要从 1970 年判到今天——那既不是要判的东西，也会直接把内存撑爆。
	 * 30 天保留窗口本身也是唯一的时间约束（设备更早的秒补不回来），所以跳过去没有
	 * 语义损失：早于保留起点的 ready 区间一并删掉，那些秒永远补不回来，留着只会在
	 * 弹窗和启动时被反复遍历。
	 *
	 * 幂等：已经超过保留起点时什么都不做。分类和推进各自调用一次，谁先来都成立。
	 *
	 * `knownBaseline` 是调用方**刚读到**的 `B`。同一轮心跳里 `classify` →
	 * `advanceBaseline` → `listRepairGaps` 会连着跑，每一步都重读一次库是浪费：
	 * `B` 在一次 tick 内不会因为别的原因变化。传进来且已越过保留起点时直接返回。
	 * 传 `null`（或不传）时照旧自己读——**钳制语义一个字没变**，只是省一次读。
	 */
	private async clampToRetention(
		nowSec: number,
		knownBaseline: number | null = null
	): Promise<number> {
		const retentionStart = historyCoverage.retentionStartSec(nowSec);
		// 只有「已知的 B 确实越过保留起点」才能跳过读库：低于时还要走下面的跳转，
		// 而低于保留起点正是全新安装的常见情形，不能拿旧值当结论。
		if (knownBaseline != null && knownBaseline >= retentionStart) return knownBaseline;
		const baseline = knownBaseline != null ? knownBaseline : await this.getBaseline();
		if (baseline >= retentionStart) return baseline;
		await this.setBaseline(retentionStart);
		await bluetoothDatabase.execute(
			`DELETE FROM vital_ready_ranges WHERE to_sec<=${retentionStart}`
		);
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准推进: B=${formatHistorySec(retentionStart)}, 原因=expired, 保留起点=${formatHistorySec(retentionStart)}`
		);
		return retentionStart;
	}

	/**
	 * 把 `[B, 分类右端)` 从「未分类」变成「已记账」或「缺口」。
	 *
	 * 幂等：已记账的部分先被减掉，不重判。所以每轮都从 `B` 走一遍没有副作用，
	 * 走得快慢只取决于 `ppi_data` 的行数——这也是不需要「已分类游标」的原因。
	 */
	async classify(nowSec: number, knownBaseline: number | null = null): Promise<BaselineClassifyResult> {
		const startedAt = Date.now();
		const ceiling = this.stableCeiling(nowSec);
		const baseline = await this.clampToRetention(nowSec, knownBaseline);
		const result: BaselineClassifyResult = {
			ceiling,
			baselineBefore: baseline,
			baselineAfter: baseline,
			unclassifiedSeconds: 0,
			qualifiedSeconds: 0,
			gapSeconds: 0,
			unqualifiedSegments: 0
		} as BaselineClassifyResult;
		if (ceiling <= baseline) return result;

		const ready = await this.listReadyRanges();
		const unclassified = subtractRanges(
			[{ fromSec: baseline, toSec: ceiling } as HistoryTimeRange],
			ready
		);
		let unclassifiedSeconds = 0;
		for (let i = 0; i < unclassified.length; i++) {
			unclassifiedSeconds += unclassified[i].toSec - unclassified[i].fromSec;
		}
		result.unclassifiedSeconds = unclassifiedSeconds;
		if (unclassifiedSeconds == 0) return result;

		// 一次查询覆盖全部未记账区间，不做单轮上限：查询范围本来就排除了已记账部分，
		// App 关闭期间 ppi_data 为空（零行返回），区间算术在内存里做，没有截断的理由。
		const timestamps = await historyCoverage.getPpiTimestamps({
			fromSec: unclassified[0].fromSec,
			toSec: unclassified[unclassified.length - 1].toSec
		} as HistoryTimeRange);
		const presentRanges = timestampsToRanges(timestamps);

		// 判定单元是**整个未记账区间**，不按分钟切。判的只有「缺了多少秒」和
		// 「最长连续缺了多少秒」两件事，两条都与分钟边界无关——按分钟切反而会在
		// 边界上把一个连续缺失段拆成两半，各自都小于 9 秒而被容差误吃。
		const newReady: HistoryTimeRange[] = [];
		for (let i = 0; i < unclassified.length; i++) {
			const piece = unclassified[i];
			if (piece.toSec <= piece.fromSec) continue;
			// 右端之外已确认（这一段的右端是被已记账区间截断的，不是 `stableCeiling`）
			// 时，贴着右端的缺失段是完整的，可以按容差判。
			const endConfirmed = piece.toSec < ceiling;
			const assessed = this.assessSegment(
				piece.fromSec,
				piece.toSec,
				endConfirmed,
				presentRanges
			);
			for (let j = 0; j < assessed.ready.length; j++) newReady.push(assessed.ready[j]);
			if (assessed.blockedRuns > 0) {
				result.unqualifiedSegments = result.unqualifiedSegments + assessed.blockedRuns;
				// 只在真正有定论的失败上打这一行：贴着 `stableCeiling` 的失败只是
				// 还没等到数据，下一轮会重判，打出来会把日志冲满。
				if (endConfirmed == true) {
					logger.info(
						"bluetooth",
						`[BOOM-BASE] 段不合格: 区间=${formatHistorySec(piece.fromSec)}~${formatHistorySec(piece.toSec)}, 长度=${piece.toSec - piece.fromSec}s, 缺失=${assessed.missingSeconds}s, 最长连续缺失=${assessed.longestMissingRun}s, 阻塞段数=${assessed.blockedRuns}, 阻塞秒=${assessed.blockedSeconds}s, 阈值=缺失<${MISSING_TOTAL_PERCENT}%, 连续<${MINUTE_MAX_MISSING_RUN_SEC}`
					);
				}
			}
		}

		for (let i = 0; i < newReady.length; i++) {
			result.qualifiedSeconds += newReady[i].toSec - newReady[i].fromSec;
		}
		await this.mergeReadyRanges(newReady, ready);
		result.gapSeconds = unclassifiedSeconds - result.qualifiedSeconds;
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 分类完成: 未记账=${unclassifiedSeconds}s, 新记账=${result.qualifiedSeconds}s, 新缺口=${result.gapSeconds}s, 不合格段=${result.unqualifiedSegments}, 分类右端=${formatHistorySec(ceiling)}, B=${formatHistorySec(baseline)}, 用时=${Date.now() - startedAt}ms`
		);
		return result;
	}

	/**
	 * 列出可读缺口，右端封顶在 `stableCeiling`。
	 *
	 * 不封顶会让「补到没有缺口为止」永不成立：`stableCeiling` 之后的秒读得到
	 * 但记不了账，本轮补完下一轮又出现同样的缺口，喂回读取循环。
	 *
	 * 缺口不存表：它由 `B` 和 `vital_ready_ranges` 相减直接得出，天然有序。
	 */
	async listRepairGaps(nowSec: number, knownBaseline: number | null = null): Promise<HistoryGap[]> {
		const ceiling = this.stableCeiling(nowSec);
		// 同样先钳制：全新安装时 `B = 1`，不钳制就会报出一个从 1970 年起的缺口。
		const baseline = await this.clampToRetention(nowSec, knownBaseline);
		const ready = await this.listReadyRanges();
		const gaps: HistoryGap[] = [];
		let cursor = baseline;
		for (let i = 0; i < ready.length; i++) {
			const range = ready[i];
			if (range.toSec <= cursor) continue;
			if (range.fromSec >= ceiling) break;
			if (range.fromSec > cursor) gaps.push(this.makeGap(cursor, Math.min(range.fromSec, ceiling)));
			if (range.toSec > cursor) cursor = range.toSec;
			if (cursor >= ceiling) break;
		}
		if (cursor < ceiling) gaps.push(this.makeGap(cursor, ceiling));
		return this.bridgeGaps(gaps);
	}

	private makeGap(fromSec: number, toSec: number): HistoryGap {
		return {
			fromSec,
			toSec,
			repairSeconds: toSec - fromSec,
			bridgeSeconds: 0
		} as HistoryGap;
	}

	/** 相距 `bridgeSec` 内的缺口合成一条读取链路，跨过的秒本地已有、不重复入库。 */
	private bridgeGaps(gaps: HistoryGap[]): HistoryGap[] {
		if (gaps.length <= 1) return gaps;
		const bridgeSec = getHistoryTunables().bridgeSec;
		const result: HistoryGap[] = [];
		for (let i = 0; i < gaps.length; i++) {
			const gap = gaps[i];
			const last = result.length == 0 ? null : result[result.length - 1];
			if (last != null && gap.fromSec - last.toSec <= bridgeSec) {
				last.repairSeconds += gap.repairSeconds;
				last.toSec = gap.toSec;
				last.bridgeSeconds = last.toSec - last.fromSec - last.repairSeconds;
				continue;
			}
			result.push(this.makeGap(gap.fromSec, gap.toSec));
		}
		return result;
	}

	sumRepairSeconds(gaps: HistoryGap[]): number {
		let total = 0;
		for (let i = 0; i < gaps.length; i++) total += gaps[i].repairSeconds;
		return total;
	}

	sumBridgeSeconds(gaps: HistoryGap[]): number {
		let total = 0;
		for (let i = 0; i < gaps.length; i++) total += gaps[i].bridgeSeconds;
		return total;
	}

	/**
	 * 推进 `B`：纯表操作，不查 `ppi_data`，也不做任何 clamp。
	 *
	 * 上界由记账规则保证（写进 `vital_ready_ranges` 的右端不超过 `stableCeiling`），
	 * 所以这里只剩「`B` 落在 `ready[0]` 内就前进」这一个循环。**`B` 会停在缺口
	 * 前面**：`ready[0]` 的起点大于 `B` 时循环立刻结束，后面那些合格的区间原样留着，
	 * 等缺口被补掉之后再消费（5.6）。
	 *
	 * `ready` 一次读出、在循环里就地消费：它是按 `from_sec` 升序的，消费一条就
	 * 去掉头部一条，不需要每轮重查全表。整条被 `B` 覆盖的区间在这里删掉——
	 * `[0, B)` 已经是「全部记账完毕」，留一条被完全覆盖的区间没有意义。
	 */
	async advanceBaseline(nowSec: number, knownBaseline: number | null = null): Promise<number> {
		let baseline = await this.clampToRetention(nowSec, knownBaseline);
		const baselineBefore = baseline;
		const ready = await this.listReadyRanges();
		let consumed = 0;
		const covered: HistoryTimeRange[] = [];
		while (ready.length > 0) {
			const first = ready[0];
			// `B` 停在缺口前面：后面的区间是合格的，但 `B` 过不去，这一轮到此为止。
			if (first.fromSec > baseline) break;
			if (first.toSec <= baseline) {
				// 整条都落在 `B` 之内：已被记账覆盖，删掉即可，`B` 不动。
				covered.push(first);
				ready.shift();
				consumed++;
				continue;
			}
			// `B` 落在这一条里面：直接跳到它的右端，然后继续看下一条——
			// 相邻的区间首尾相接，一轮循环能把它们整段吃掉。
			baseline = first.toSec;
			covered.push(first);
			ready.shift();
			consumed++;
		}
		// 先落库再返回。被覆盖的区间无论推进与否都要清掉——留着它们会在每轮 tick
		// 里被反复读出来。`B` 的落库失败会在 `setBaseline()` 里抛出，所以这里
		// 直接返回内存里的值即可，不需要再回读一次确认。
		if (covered.length > 0) {
			if (baseline != baselineBefore) await this.setBaseline(baseline);
			await this.deleteReadyRanges(covered);
		}
		// 只在真动了的时候打：`advanceBaseline()` 在每次分类后、每组缺口读取前后都会调用，
		// 没推进也打一行会把诊断缓冲区冲掉。`落后` 是「B 卡住不动」的第一现场——
		// 正常情况下它贴着 0（几秒的落库延迟），明显大于 0 就说明前面有真缺口。
		if (consumed > 0) {
			const ceiling = this.stableCeiling(nowSec);
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 基准推进: B=${formatHistorySec(baselineBefore)}->${formatHistorySec(baseline)}, 消费ready区间=${consumed}, 原因=ready, stableCeiling=${formatHistorySec(ceiling)}, 落后=${ceiling - baseline}s`
			);
		}
		return baseline;
	}

	/** 批量删除被 `B` 覆盖的区间，一条事务写完。 */
	private async deleteReadyRanges(ranges: HistoryTimeRange[]): Promise<void> {
		const statements: string[] = [];
		for (let i = 0; i < ranges.length; i++) {
			statements.push(
				`DELETE FROM vital_ready_ranges WHERE from_sec=${ranges[i].fromSec} AND to_sec=${ranges[i].toSec}`
			);
		}
		if ((await bluetoothDatabase.transaction(statements)) == false)
			throw new Error("清理已记账区间失败");
	}

	/** 只读快照，供测试页展示。 */
	async snapshot(nowSec: number): Promise<BaselineSnapshot> {
		return {
			baseline: await this.getBaseline(),
			ceiling: this.stableCeiling(nowSec),
			readyRanges: await this.listReadyRanges(),
			gaps: await this.listRepairGaps(nowSec)
		} as BaselineSnapshot;
	}
}

export type BaselineSnapshot = {
	baseline: number;
	ceiling: number;
	readyRanges: HistoryTimeRange[];
	gaps: HistoryGap[];
};

export const historyBaseline = new HistoryBaseline();
