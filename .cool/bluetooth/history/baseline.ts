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

/** 一分钟合格判定的两个阈值，见方案第 3 节。 */
const MINUTE_MAX_MISSING = 20;
const MINUTE_MAX_MISSING_RUN_SEC = 9;

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
	unqualifiedMinutes: number;
};

/** 一分钟的判定明细。`accountTo` 是这段可以记账到的秒；`blockedRun > 0` 表示被某段缺失卡住。 */
export type MinuteAssessment = {
	minuteSec: number;
	missingSeconds: number;
	longestMissingRun: number;
	accountTo: number;
	blockedRun: number;
};

function minuteStartsIn(fromSec: number, toSec: number): number[] {
	const result: number[] = [];
	if (toSec <= fromSec) return result;
	let minute = Math.floor(fromSec / 60) * 60;
	while (minute < toSec) {
		if (minute + 60 > fromSec) result.push(minute);
		minute += 60;
	}
	return result;
}

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
	 * 区间行数受「不合格分钟段数」约束而不是时间长度（`B` 卡一天的代价是 1 条
	 * ready 区间，不是 1440 行），所以整体重写的成本可以忽略，而它天然完成
	 * 相邻合并，不需要逐条 diff 的脆弱 SQL。
	 */
	private async mergeReadyRanges(ranges: HistoryTimeRange[]): Promise<void> {
		if (ranges.length == 0) return;
		const existing = await this.listReadyRanges();
		const merged = normalizeRanges(existing.concat(ranges));
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
	 * 判定一个分钟窗口，返回「这段能记账到哪一秒」。
	 *
	 * 窗口是 `[windowFrom, windowTo)`，两端都可能被截断：左端被 `B` 或前一条已记账
	 * 区间截断，右端被分钟末尾、`stableCeiling` 或已记账区间截断。判定按缺失段顺序
	 * 逐段推进，每段都要过三关：
	 *
	 * 1. **缺失总量**：`missing * 3 < 窗口长度`。完整分钟下就是第 3 节的
	 *    `missing * 3 < 60`（missing ≤ 19）；窗口被截断时按长度等比缩放，
	 *    这样同一分钟内分两次判定的容忍度相加仍等于完整分钟的那一份，不会放大。
	 * 2. **连续缺失**：每段 `< 9` 秒。连接空洞是连续的，所以这一条才是真正起作用的
	 *    约束——它把容差的实际覆盖范围压在 8 秒以内。
	 * 3. **这一段是否已经看完**。缺失段贴着窗口右端时，右端之外还没判到，
	 *    这段可能还更长，不能按当前长度放过；只有分钟已走完（`windowTo` 到达
	 *    分钟末尾）或窗口右端是被已记账区间截断（右端之外已经确认过）时，
	 *    才认为这一段是完整的。不设这一关，一个横跨 `stableCeiling` 的 11 秒
	 *    空洞会被拆成两段各 8 秒以内，被容差整段吃掉。
	 *
	 * 不满足的段就是 `B` 的停驻点：它自己成为缺口，由读取路径消费。
	 */
	private assessMinute(
		minuteSec: number,
		windowFrom: number,
		windowTo: number,
		windowEndsPiece: boolean,
		presentRanges: HistoryTimeRange[]
	): MinuteAssessment {
		const window: HistoryTimeRange = { fromSec: windowFrom, toSec: windowTo };
		const missingRanges = subtractRanges([window], presentRanges);
		const windowLength = windowTo - windowFrom;
		let missing = 0;
		let longestRun = 0;
		for (let i = 0; i < missingRanges.length; i++) {
			const width = missingRanges[i].toSec - missingRanges[i].fromSec;
			missing += width;
			if (width > longestRun) longestRun = width;
		}
		// 缺失总量这一关先算，它是对整个窗口的约束，不随逐段推进而改变。
		const withinTotal = missing * 3 < windowLength;
		let accountTo = windowFrom;
		let blockedRun = 0;
		if (missingRanges.length > 0) {
			// 第一个缺失段之前一定是在场秒：它们确实已收齐，记账永远安全。
			accountTo = missingRanges[0].fromSec;
			for (let i = 0; i < missingRanges.length; i++) {
				const run = missingRanges[i];
				const runSeconds = run.toSec - run.fromSec;
				const knownEnd = run.toSec < windowTo || windowTo >= minuteSec + 60 || windowEndsPiece;
				if (withinTotal == false || knownEnd == false || runSeconds >= MINUTE_MAX_MISSING_RUN_SEC) {
					blockedRun = runSeconds;
					break;
				}
				// 这一段过了容差，等同于「设备确认这里没有」：缺的秒连同它之前在场的秒一起记账。
				accountTo = run.toSec;
			}
			// 最后一段缺失之后到窗口右端全是在场秒，同样已收齐。不补这一步，一个
			// 合格的分钟会在最后一个缺失段处被截断，尾巴上的在场秒白判一轮。
			if (blockedRun == 0) accountTo = windowTo;
		} else {
			accountTo = windowTo;
		}
		return {
			minuteSec,
			missingSeconds: missing,
			longestMissingRun: longestRun,
			accountTo,
			blockedRun
		} as MinuteAssessment;
	}

	/**
	 * 保留窗口钳制：`B` 早于 30 天保留起点时一次性跳过去。
	 *
	 * 必须**在分类之前**跑：分类是逐分钟走的，全新安装时 `B = 1`，不先钳制就要从
	 * 1970 年判到今天（约 3000 万个分钟）——那既不是要判的东西，也会直接把内存撑爆。
	 * 30 天保留窗口本身也是唯一的时间约束（设备更早的秒补不回来），所以跳过去没有
	 * 语义损失：早于保留起点的 ready 区间一并删掉，那些秒永远补不回来，留着只会在
	 * 弹窗和启动时被反复遍历。
	 *
	 * 幂等：已经超过保留起点时什么都不做。分类和推进各自调用一次，谁先来都成立。
	 */
	private async clampToRetention(nowSec: number): Promise<number> {
		const baseline = await this.getBaseline();
		const retentionStart = historyCoverage.retentionStartSec(nowSec);
		if (baseline >= retentionStart) return baseline;
		await this.setBaseline(retentionStart);
		await bluetoothDatabase.execute(
			`DELETE FROM vital_ready_ranges WHERE to_sec<=${retentionStart}`
		);
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准推进: B=${retentionStart}, 原因=expired, 保留起点=${retentionStart}`
		);
		return retentionStart;
	}

	/**
	 * 把 `[B, 分类右端)` 从「未分类」变成「已记账」或「缺口」。
	 *
	 * 幂等：已记账的分钟先被减掉，不重判。所以每轮都从 `B` 走一遍没有副作用，
	 * 走得快慢只取决于 `ppi_data` 的行数——这也是不需要「已分类游标」的原因。
	 */
	async classify(nowSec: number): Promise<BaselineClassifyResult> {
		const startedAt = Date.now();
		const ceiling = this.stableCeiling(nowSec);
		const baseline = await this.clampToRetention(nowSec);
		const result: BaselineClassifyResult = {
			ceiling,
			baselineBefore: baseline,
			baselineAfter: baseline,
			unclassifiedSeconds: 0,
			qualifiedSeconds: 0,
			gapSeconds: 0,
			unqualifiedMinutes: 0
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

		// 一次查询覆盖全部未记账分钟，不做单轮上限：查询范围本来就排除了已记账部分，
		// App 关闭期间 ppi_data 为空（零行返回），区间算术在内存里做，没有截断的理由。
		const timestamps = await historyCoverage.getPpiTimestamps({
			fromSec: unclassified[0].fromSec,
			toSec: unclassified[unclassified.length - 1].toSec
		} as HistoryTimeRange);
		const presentRanges = timestampsToRanges(timestamps);

		// 逐分钟判定：判定单元是分钟（阈值是按一分钟定义的），但每一分钟的可判范围是
		// [M, min(M+60, ceiling))，不再被整分钟下界一笔勾销。
		const newReady: HistoryTimeRange[] = [];
		for (let i = 0; i < unclassified.length; i++) {
			const piece = unclassified[i];
			const minutes = minuteStartsIn(piece.fromSec, piece.toSec);
			for (let j = 0; j < minutes.length; j++) {
				const minute = minutes[j];
				const windowFrom = Math.max(minute, piece.fromSec);
				const windowTo = Math.min(minute + 60, piece.toSec, ceiling);
				if (windowTo <= windowFrom) continue;
				// 这一段的右端若就是本次未记账区间的右端，说明右端之外已被记账过
				// （`stableCeiling` 不会切在中间——它是这次查询的右端），
				// 那么贴着右端的缺失段是完整的，可以按容差判。
				const endsPiece = piece.toSec < ceiling && windowTo == piece.toSec;
				const assessed = this.assessMinute(
					minute,
					windowFrom,
					windowTo,
					endsPiece,
					presentRanges
				);
				if (assessed.accountTo > windowFrom) {
					newReady.push({ fromSec: windowFrom, toSec: assessed.accountTo });
				}
				if (assessed.blockedRun > 0) {
					result.unqualifiedMinutes = result.unqualifiedMinutes + 1;
					// 只在真正有定论的失败上打这一行：贴着 `stableCeiling` 的失败只是
					// 还没等到数据，下一轮会重判，打出来会把日志冲满。
					if (windowTo < ceiling || endsPiece == true) {
						logger.info(
							"bluetooth",
							`[BOOM-BASE] 分钟不合格: minute=${minute}, 窗口=${windowFrom}~${windowTo}, missing=${assessed.missingSeconds}, 最长连续缺失=${assessed.longestMissingRun}, 阻塞段=${assessed.blockedRun}, 阈值=缺失<1/3, 连续<${MINUTE_MAX_MISSING_RUN_SEC}`
						);
					}
					// **不 break**：这一分钟成为缺口、`B` 停在它前面就够了，后面的分钟照判。
					// 合格的那些必须照常记进 `vital_ready_ranges`，否则它们既不在 `[0,B)`
					// 里、也没被标记，下轮还要从头重判——`B` 卡一天就白判一天。
					// 5.6 说的「后面合格的分钟堆在 ready 里等它」、8.2 桥接的
					// 「12:05 不合格、12:06 合格 → ready[0] = [12:06,12:07)」都依赖这一点。
					continue;
				}
			}
		}

		for (let i = 0; i < newReady.length; i++) {
			result.qualifiedSeconds += newReady[i].toSec - newReady[i].fromSec;
		}
		await this.mergeReadyRanges(newReady);
		result.gapSeconds = unclassifiedSeconds - result.qualifiedSeconds;
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 分类完成: 未记账=${unclassifiedSeconds}s, 新记账=${result.qualifiedSeconds}s, 新缺口=${result.gapSeconds}s, 不合格分钟=${result.unqualifiedMinutes}, 分类右端=${ceiling}, B=${baseline}, 用时=${Date.now() - startedAt}ms`
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
	async listRepairGaps(nowSec: number): Promise<HistoryGap[]> {
		const ceiling = this.stableCeiling(nowSec);
		// 同样先钳制：全新安装时 `B = 1`，不钳制就会报出一个从 1970 年起的缺口。
		const baseline = await this.clampToRetention(nowSec);
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
	 * 所以这里只剩「`B` 落在 `ready[0]` 内就前进」这一个循环。
	 * `ready[0]` 被消费后 `ready[1]` 顶上来，下一个缺口自动浮现，不需要重新枚举。
	 */
	async advanceBaseline(nowSec: number): Promise<number> {
		let baseline = await this.clampToRetention(nowSec);
		let consumed = 0;
		while (true) {
			const ready = await this.listReadyRanges();
			if (ready.length == 0) break;
			const first = ready[0];
			if (first.fromSec > baseline) break;
			if (first.toSec <= baseline) {
				// 整条都落在 `B` 之内：已被记账覆盖，删掉即可。
				await bluetoothDatabase.execute(
					`DELETE FROM vital_ready_ranges WHERE from_sec=${first.fromSec} AND to_sec=${first.toSec}`
				);
				consumed++;
				continue;
			}
			// `B` 落在这一条里面：直接跳到它的右端。整条随之被 `B` 覆盖，同样删除——
			// `[0, B)` 已经是「全部记账完毕」，再留一条被完全覆盖的区间没有意义。
			baseline = first.toSec;
			await this.setBaseline(baseline);
			await bluetoothDatabase.execute(
				`DELETE FROM vital_ready_ranges WHERE from_sec=${first.fromSec} AND to_sec=${first.toSec}`
			);
			consumed++;
		}
		if (consumed > 0) {
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 基准推进: B=${baseline}, 消费ready区间=${consumed}, 原因=ready`
			);
		}
		return baseline;
	}

	/**
	 * 广播接续判定：连接留下空洞后，广播恢复的第一帧 `T0` 到达时调用。
	 *
	 * 连接一定会留下缺秒，而连接又只由「有缺口」触发——不在同一轮消化掉，
	 * 下一次检查就会再拉起一条连接，后者又留下新的缺秒，循环自己咬住自己。
	 * 这里把 `[B, ceiling)` 整段按「确认无数据」记账并推进 `B`。
	 *
	 * 两个必须遵守的点：
	 * 1. **必须记账，不能只推 `B`。** `advanceBaseline()` 的循环是「`B` 落在
	 *    `ready[0]` 内就前进」，没有对应区间它一步都不动。
	 * 2. **这不是容差吸收，是有意丢掉这段秒。** 容差的连续缺失条件是 < 9 秒，
	 *    而连接空洞是连续的，所以只有 ≤ 8 秒才真落在容差内；9 秒到宽限值之间
	 *    是本设计主动放弃的真数据，换来的是不反复连接。
	 *
	 * @returns 推进后的 `B`；判定不成立（gap 大于宽限、或 `B` 已经到位）返回 `-1`。
	 */
	async markBroadcastResume(t0Sec: number): Promise<number> {
		if (t0Sec <= 0) return -1;
		// 先钳制再量 gap：`gap = T0 - B` 必须是「从有意义的基准起」的量。
		// 不钳制的话全新安装的 `B = 1` 会量出几十年的空洞，判断虽然同样是「交给设备」，
		// 但那条 `[1, ceiling)` 一旦被误当成小空洞，就会把几十年直接记成「确认无数据」。
		const baseline = await this.clampToRetention(t0Sec);
		const ceiling = this.stableCeiling(t0Sec);
		if (ceiling <= baseline) return -1;
		const gap = t0Sec - baseline;
		const grace = getHistoryTunables().broadcastResumeGraceSec;
		if (gap > grace) {
			logger.info(
				"bluetooth",
				`[BOOM-ADV] 广播接续: T0=${t0Sec}, B=${baseline}, gap=${gap}s, 宽限=${grace}s, 决策=交给设备`
			);
			return -1;
		}
		await this.markReady(baseline, ceiling, t0Sec);
		const after = await this.advanceBaseline(t0Sec);
		logger.info(
			"bluetooth",
			`[BOOM-ADV] 广播接续: T0=${t0Sec}, B=${baseline}->${after}, gap=${gap}s, 宽限=${grace}s, 决策=推进`
		);
		return after;
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
