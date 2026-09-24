import { bluetoothDatabase } from "../database";
import { historyCoverage } from "./coverage-service";
import {
	HISTORY_GATT_READ_BRIDGE_SEC,
	HISTORY_MINUTE_SETTLE_SEC
} from "./config";
import {
	normalizeRanges,
	subtractRanges,
	countRangeSeconds,
	rangesFromTimestamps
} from "./coverage";
import type { HistoryTimeRange } from "./coverage";
import { logger } from "../../service/logger";
import { formatAppDateTime, getAppTimezone } from "../../utils/timezone";

/**
 * 基准时间 `baseline_sec`（下称 `B`）：`[0, B)` 的每一秒都已记账完毕。
 *
 * 「记账完毕」有两种形式：合格（本地数据完整度达标）和已确认（设备已响应并
 * 明确没有更多数据）。两者都落在 `vital_ready_ranges` 里，缺口由 `B` 与该表
 * 相减直接得出，不存表。
 *
 * 分类游标 `C` 表示 `[保留起点, C)` 已经判定过。`B` 可以被旧缺口卡住，`C` 仍随
 * 每分钟心跳向前，只处理新稳定区间，避免反复加载 `B` 之后已经判定过的 PPI。
 * `B`、`C` 和区间都按秒记录，不整分钟对齐。
 */
/** B/C 单行状态表和归一化 ready 区间表；由数据库初始化流程幂等执行。 */
export const BASELINE_SCHEMA: string[] = [
	`CREATE TABLE IF NOT EXISTS vital_sync_state (
		id INTEGER PRIMARY KEY CHECK(id=1),
		baseline_sec INTEGER NOT NULL,
		classified_until_sec INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE IF NOT EXISTS vital_ready_ranges (from_sec INTEGER NOT NULL, to_sec INTEGER NOT NULL, PRIMARY KEY(from_sec,to_sec))`
];

/** 保留 Unix 秒值，同时附带按 App 本地配置格式化的时间，方便诊断日志定位。 */
export function formatHistorySec(sec: number): string {
	const timestamp = sec * 1000;
	const timezone = getAppTimezone(timestamp);
	const sign = timezone.startsWith("-") ? "" : "+";
	return `${sec}(${formatAppDateTime(timestamp, " ", true)}${sign}${timezone})`;
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

/** 单轮最多展开多少条不合格段，避免历史积压时每分钟用重复信息冲掉关键故障。 */
const MAX_UNQUALIFIED_DETAIL_LOGS = 5;

/* ===== 对外数据结构 ===== */

/** 一个待补缺口。`bridgeSeconds` 是合并相邻缺口时跨过的、本地已有的秒。 */
export type HistoryGap = {
	fromSec: number;
	toSec: number;
	repairSeconds: number;
	bridgeSeconds: number;
};

/** 分类结果，仅暴露本轮增量和 C 的变化，供调度日志与回归测试核对。 */
type BaselineClassifyResult = {
	classifiedBefore: number;
	classifiedAfter: number;
	unclassifiedSeconds: number;
	qualifiedSeconds: number;
	gapSeconds: number;
	unqualifiedSegments: number;
};

/** 一个段的判定明细。`ready` 是段内可记账的子区间；`blockedRuns` 是真缺口的个数。 */
type SegmentAssessment = {
	ready: HistoryTimeRange[];
	missingSeconds: number;
	longestMissingRun: number;
	blockedRuns: number;
	blockedSeconds: number;
	pendingFromSec: number | null;
};

/** 测试页只读快照；类型由 `snapshot()` 推导给调用方，不作为跨模块契约导出。 */
type BaselineSnapshot = {
	baseline: number;
	ceiling: number;
	readyRanges: HistoryTimeRange[];
	gaps: HistoryGap[];
};

/* ===== SQLite 兼容语句 ===== */

/** 普通推进保留较新的 C，只保证 `C >= B`。 */
function baselineAdvanceStatements(value: number): string[] {
	return [
		`UPDATE vital_sync_state SET baseline_sec=${value},classified_until_sec=CASE WHEN classified_until_sec<${value} THEN ${value} ELSE classified_until_sec END WHERE id=1`,
		`INSERT OR IGNORE INTO vital_sync_state (id,baseline_sec,classified_until_sec) VALUES (1,${value},${value})`
	];
}

/** 新绑定或故障恢复必须同时重置 B/C，不能继承旧设备或异常的分类进度。 */
function baselineResetStatements(value: number): string[] {
	return [
		`UPDATE vital_sync_state SET baseline_sec=${value},classified_until_sec=${value} WHERE id=1`,
		`INSERT OR IGNORE INTO vital_sync_state (id,baseline_sec,classified_until_sec) VALUES (1,${value},${value})`
	];
}

/* ===== 分类纯计算：不访问数据库、不推进 B ===== */

type AssessedSegment = {
	range: HistoryTimeRange;
	endConfirmed: boolean;
	assessment: SegmentAssessment;
};

type ClassificationPass = {
	ready: HistoryTimeRange[];
	classifiedUntil: number;
	unqualifiedSegments: number;
	assessed: AssessedSegment[];
};

/** 创建零统计结果；后续只填写本轮实际分类产生的增量。 */
function makeClassifyResult(
	classified: number
): BaselineClassifyResult {
	return {
		classifiedBefore: classified,
		classifiedAfter: classified,
		unclassifiedSeconds: 0,
		qualifiedSeconds: 0,
		gapSeconds: 0,
		unqualifiedSegments: 0
	} as BaselineClassifyResult;
}
/**
 * 判断一段未记账区间：
 * 1. 连续缺失达到 9 秒时切开候选区，缺失段本身留下作为真缺口；
 * 2. 每个候选区再检查总缺失率，低于 30% 才进入 ready；
 * 3. 贴着开放右端的短缺失暂不下结论，由调用方把 C 停在它的起点。
 *
 * `endConfirmed` 表示右侧已有 ready 把本段截断；只有这种情况下，贴右端的
 * 缺失才是完整缺失，而不是仍可能继续增长的尾巴。
 */
function assessSegment(
	fromSec: number,
	toSec: number,
	endConfirmed: boolean,
	presentRanges: HistoryTimeRange[]
): SegmentAssessment {
	const missingRanges = subtractRanges([{ fromSec, toSec }], presentRanges);
	const result: SegmentAssessment = {
		ready: [],
		missingSeconds: countRangeSeconds(missingRanges),
		longestMissingRun: 0,
		blockedRuns: 0,
		blockedSeconds: 0,
		pendingFromSec: null
	} as SegmentAssessment;
	if (missingRanges.length == 0) {
		result.ready.push({ fromSec, toSec });
		return result;
	}

	const candidates: HistoryTimeRange[] = [];
	let candidateStart = fromSec;
	for (let i = 0; i < missingRanges.length; i++) {
		const run = missingRanges[i];
		const runSeconds = run.toSec - run.fromSec;
		if (runSeconds > result.longestMissingRun) result.longestMissingRun = runSeconds;
		const touchesOpenEnd = run.toSec == toSec && endConfirmed == false;
		if (touchesOpenEnd && runSeconds < MINUTE_MAX_MISSING_RUN_SEC)
			result.pendingFromSec = run.fromSec;
		if (touchesOpenEnd || runSeconds >= MINUTE_MAX_MISSING_RUN_SEC) {
			if (run.fromSec > candidateStart)
				candidates.push({ fromSec: candidateStart, toSec: run.fromSec });
			candidateStart = run.toSec;
			result.blockedRuns++;
			result.blockedSeconds += runSeconds;
		}
	}
	if (toSec > candidateStart) candidates.push({ fromSec: candidateStart, toSec });

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const missingSeconds = countRangeSeconds(subtractRanges([candidate], presentRanges));
		if (missingSeconds * 100 < (candidate.toSec - candidate.fromSec) * MISSING_TOTAL_PERCENT)
			result.ready.push(candidate);
	}
	return result;
}

/** 对本轮所有未记账区间做纯计算，不访问数据库。 */
function classifyRanges(
	unclassified: HistoryTimeRange[],
	presentRanges: HistoryTimeRange[],
	ceiling: number
): ClassificationPass {
	const pass: ClassificationPass = {
		ready: [],
		classifiedUntil: ceiling,
		unqualifiedSegments: 0,
		assessed: []
	} as ClassificationPass;
	for (let i = 0; i < unclassified.length; i++) {
		const range = unclassified[i];
		if (range.toSec <= range.fromSec) continue;
		const endConfirmed = range.toSec < ceiling;
		const assessment = assessSegment(range.fromSec, range.toSec, endConfirmed, presentRanges);
		if (assessment.pendingFromSec != null && assessment.pendingFromSec < pass.classifiedUntil)
			pass.classifiedUntil = assessment.pendingFromSec;
		pass.ready = pass.ready.concat(assessment.ready);
		pass.unqualifiedSegments += assessment.blockedRuns;
		pass.assessed.push({ range, endConfirmed, assessment } as AssessedSegment);
	}
	return pass;
}

class HistoryBaseline {
	/* ===== 时间边界 ===== */

	/**
	 * 记账与分类的稳定上界。实际缺口右端还会被分类游标 `C` 封顶。
	 *
	 * 第 `s` 秒可以记账当且仅当 `s + HISTORY_MINUTE_SETTLE_SEC <= now`。这个条件
	 * 对每一秒单独成立，与分钟边界无关，
	 * **不要向上取整到分钟**：取整会在 `B` 已推进到分钟中间时让分类右端落到
	 * `B` 之前，整轮判不动，缺口留着又拉起一次连接。
	 */
	stableCeiling(nowSec: number): number {
		return nowSec - HISTORY_MINUTE_SETTLE_SEC;
	}

	/* ===== B / C 状态与迁移 ===== */

	/** 读取 B；状态行尚未建立时返回安全起点 1。 */
	async getBaseline(): Promise<number> {
		const result = await bluetoothDatabase.query(
			"SELECT baseline_sec FROM vital_sync_state WHERE id=1"
		);
		if (result == null) throw new Error("读取基准时间失败");
		if (result.rows.length == 0) return 1;
		return parseInt(result.rows[0][0] as string);
	}

	/** 读取 C，并在内存中保证 `C >= B`，防御旧库或异常写入。 */
	private async getClassifiedUntil(): Promise<number> {
		const result = await bluetoothDatabase.query(
			"SELECT baseline_sec,classified_until_sec FROM vital_sync_state WHERE id=1"
		);
		if (result == null) throw new Error("读取分类游标失败");
		if (result.rows.length == 0) return 1;
		const baseline = parseInt(result.rows[0][0] as string);
		const classified = parseInt(result.rows[0][1] as string);
		return Math.max(baseline, classified);
	}

	/** 兼容只有 baseline_sec 的旧表；纯新增列，不重建、不丢任何进度。 */
	private async ensureClassificationCursorColumn(): Promise<void> {
		const result = await bluetoothDatabase.query("PRAGMA table_info(vital_sync_state)");
		if (result == null) throw new Error("读取基准时间表结构失败");
		let exists = false;
		for (let i = 0; i < result.rows.length; i++) {
			if ((result.rows[i][1] as string) == "classified_until_sec") exists = true;
		}
		if (exists == false) {
			if (
				(await bluetoothDatabase.execute(
					"ALTER TABLE vital_sync_state ADD COLUMN classified_until_sec INTEGER NOT NULL DEFAULT 1"
				)) == false
			)
				throw new Error("分类游标字段迁移失败");
		}
		if (
			(await bluetoothDatabase.execute(
				"UPDATE vital_sync_state SET classified_until_sec=baseline_sec WHERE classified_until_sec<baseline_sec"
			)) == false
		)
			throw new Error("分类游标迁移失败");
	}

	/**
	 * 为新建的基准表落下启动点，并修复旧故障版本留下的「30 天起点」。
	 *
	 * 旧版本升级时本地没有 `baseline_sec`，这不等于过去 30 天都需要补录。默认从当前
	 * 已稳定的右端开始；`B` 仍在 30 天保留窗口内的后续冷启动由已有行继续推进，
	 * App 关闭期间的缺口仍会正常保留下来。
	 *
	 * 已发布的故障版本会先把空基准钳到保留窗口左端，再制造整整 30 天的缺口。因此，
	 * 启动时若 `B` 仍不晚于当前保留起点，也按同一规则恢复到稳定右端。产品允许统计级
	 * 数据不完整，放弃这段过期积压比发起数百次无效 GATT 连接更符合目标。
	 */
	async initializeIfMissing(nowSec: number): Promise<number> {
		await this.ensureClassificationCursorColumn();
		const current = await this.getBaseline();
		const retentionStart = historyCoverage.retentionStartSec(nowSec);
		if (current > retentionStart) return current;
		const initial = Math.max(1, this.stableCeiling(nowSec));
		const reason = current <= 1 ? "bootstrap" : "retention-start-recovery";
		const saved = await bluetoothDatabase.transaction(
			["DELETE FROM vital_ready_ranges"].concat(baselineResetStatements(initial))
		);
		if (saved == false) throw new Error("初始化基准时间失败");
		const baseline = await this.getBaseline();
		if (baseline == initial) {
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 基准初始化: B=${formatHistorySec(initial)}, 原因=${reason}`
			);
		}
		return baseline;
	}

	/** 新绑定不能继承上一台设备的进度；从绑定当下的稳定右端重新开始。 */
	async resetForNewBinding(nowSec: number): Promise<void> {
		const initial = Math.max(1, this.stableCeiling(nowSec));
		const saved = await bluetoothDatabase.transaction(
			["DELETE FROM vital_ready_ranges"].concat(baselineResetStatements(initial))
		);
		if (saved == false) throw new Error("重置新绑定基准时间失败");
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 新绑定基准初始化: B=${formatHistorySec(initial)}, 原因=new-binding`
		);
	}

	/** 原子推进 B 并清理其左侧 ready；C 永远不会被 B 落在后面。 */
	private async saveBaseline(value: number): Promise<void> {
		const statements = baselineAdvanceStatements(value);
		statements.push(`DELETE FROM vital_ready_ranges WHERE to_sec<=${value}`);
		const saved = await bluetoothDatabase.transaction(statements);
		if (saved == false) throw new Error("保存基准时间失败");
	}

	/** 保存本轮已经判定完的右端；调用方必须先持久化相应 ready。 */
	private async setClassifiedUntil(value: number): Promise<void> {
		if (
			(await bluetoothDatabase.execute(
				`UPDATE vital_sync_state SET classified_until_sec=${Math.floor(value)} WHERE id=1`
			)) == false
		)
			throw new Error("保存分类游标失败");
	}

	/* ===== ready range 持久化 ===== */

	/** 读取全部 ready 区间，按起点升序；数据库异常不伪装为空列表。 */
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
	 * 保留窗口钳制：`B` 早于 30 天保留起点时一次性跳过去。
	 *
	 * 必须**在分类之前**跑：首次迁移时 `C` 从 `B` 起步，全新安装时 `B = 1`，
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
		await this.saveBaseline(retentionStart);
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准推进: B=${formatHistorySec(retentionStart)}, 原因=expired, 保留起点=${formatHistorySec(retentionStart)}`
		);
		return retentionStart;
	}

	/* ===== C 增量分类 ===== */

	private logUnqualifiedSegments(pass: ClassificationPass): void {
		let logged = 0;
		let suppressed = 0;
		for (let i = 0; i < pass.assessed.length; i++) {
			const item = pass.assessed[i];
			const assessment = item.assessment;
			if (assessment.blockedRuns == 0 || item.endConfirmed == false) continue;
			if (logged >= MAX_UNQUALIFIED_DETAIL_LOGS) {
				suppressed++;
				continue;
			}
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 段不合格: 区间=${formatHistorySec(item.range.fromSec)}~${formatHistorySec(item.range.toSec)}, 长度=${item.range.toSec - item.range.fromSec}s, 缺失=${assessment.missingSeconds}s, 最长连续缺失=${assessment.longestMissingRun}s, 阻塞段数=${assessment.blockedRuns}, 阻塞秒=${assessment.blockedSeconds}s, 阈值=缺失<${MISSING_TOTAL_PERCENT}%, 连续<${MINUTE_MAX_MISSING_RUN_SEC}`
			);
			logged++;
		}
		if (suppressed > 0) {
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 不合格段日志已省略: 展开=${logged}, 省略=${suppressed}, 本轮不合格段=${pass.unqualifiedSegments}`
			);
		}
	}

	/**
	 * 把 `[C, stableCeiling)` 从「未分类」变成「已记账」或「缺口」。短缺失若贴着
	 * 右端，长度仍未确定，`C` 停在它的起点；下一轮只重判这几秒。
	 */
	async classify(
		nowSec: number,
		knownBaseline: number | null = null
	): Promise<BaselineClassifyResult> {
		const startedAt = Date.now();
		const ceiling = this.stableCeiling(nowSec);
		const baseline = await this.clampToRetention(nowSec, knownBaseline);
		const classified = Math.max(baseline, Math.min(ceiling, await this.getClassifiedUntil()));
		const result = makeClassifyResult(classified);
		if (ceiling <= classified) return result;

		const ready = await this.listReadyRanges();
		const unclassified = subtractRanges(
			[{ fromSec: classified, toSec: ceiling } as HistoryTimeRange],
			ready
		);
		result.unclassifiedSeconds = countRangeSeconds(unclassified);
		if (result.unclassifiedSeconds == 0) {
			await this.setClassifiedUntil(ceiling);
			result.classifiedAfter = ceiling;
			return result;
		}

		const queryRange: HistoryTimeRange = {
			fromSec: unclassified[0].fromSec,
			toSec: unclassified[unclassified.length - 1].toSec
		} as HistoryTimeRange;
		const timestamps = await historyCoverage.getPpiTimestamps(queryRange);
		const present = rangesFromTimestamps(queryRange, timestamps);
		const pass = classifyRanges(unclassified, present, ceiling);
		this.logUnqualifiedSegments(pass);

		result.qualifiedSeconds = countRangeSeconds(pass.ready);
		result.unqualifiedSegments = pass.unqualifiedSegments;
		result.classifiedAfter = pass.classifiedUntil;
		const pendingSeconds = ceiling - pass.classifiedUntil;
		result.gapSeconds = Math.max(
			0,
			result.unclassifiedSeconds - pendingSeconds - result.qualifiedSeconds
		);
		// 先写 ready，再推进 C。中途退出最多会重判，不能跳过尚未记账的秒。
		await this.mergeReadyRanges(pass.ready, ready);
		await this.setClassifiedUntil(pass.classifiedUntil);
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 分类完成: C=${formatHistorySec(classified)}->${formatHistorySec(pass.classifiedUntil)}, 待判断=${result.unclassifiedSeconds}s, 新记账=${result.qualifiedSeconds}s, 新缺口=${result.gapSeconds}s, 不合格段=${result.unqualifiedSegments}, stableCeiling=${formatHistorySec(ceiling)}, B=${formatHistorySec(baseline)}, 用时=${Date.now() - startedAt}ms`
		);
		return result;
	}

	/* ===== 缺口规划 ===== */

	/**
	 * 列出可读缺口，右端封顶在 `min(C, stableCeiling)`。
	 *
	 * 不封顶会让「补到没有缺口为止」永不成立：`stableCeiling` 之后的秒读得到
	 * 但记不了账，本轮补完下一轮又出现同样的缺口，喂回读取循环。
	 *
	 * 缺口不存表：它由 `[B, C)` 和 `vital_ready_ranges` 相减直接得出，天然有序。
	 */
	async listRepairGaps(
		nowSec: number,
		knownBaseline: number | null = null
	): Promise<HistoryGap[]> {
		const ceiling = Math.min(this.stableCeiling(nowSec), await this.getClassifiedUntil());
		const baseline = await this.clampToRetention(nowSec, knownBaseline);
		if (ceiling <= baseline) return [];
		// 缺口就是 `[B, min(C, stableCeiling)) - ready`。统一复用 coverage.ts，
		// 避免在这里再维护一套容易出现边界差异的游标减法。
		const missing = subtractRanges(
			[{ fromSec: baseline, toSec: ceiling } as HistoryTimeRange],
			await this.listReadyRanges()
		);
		const gaps: HistoryGap[] = [];
		for (let i = 0; i < missing.length; i++)
			gaps.push(this.makeGap(missing[i].fromSec, missing[i].toSec));
		return this.bridgeGaps(gaps);
	}

	/** 把一个尚未桥接的缺失区间转换为读取计划。 */
	private makeGap(fromSec: number, toSec: number): HistoryGap {
		return {
			fromSec,
			toSec,
			repairSeconds: toSec - fromSec,
			bridgeSeconds: 0
		} as HistoryGap;
	}

	/** 相距不超过固定桥接距离的缺口合成一条读取链路；跨过的秒已有、不重复入库。 */
	private bridgeGaps(gaps: HistoryGap[]): HistoryGap[] {
		if (gaps.length <= 1) return gaps;
		const result: HistoryGap[] = [];
		for (let i = 0; i < gaps.length; i++) {
			const gap = gaps[i];
			const last = result.length == 0 ? null : result[result.length - 1];
			if (last != null && gap.fromSec - last.toSec <= HISTORY_GATT_READ_BRIDGE_SEC) {
				last.repairSeconds += gap.repairSeconds;
				last.toSec = gap.toSec;
				last.bridgeSeconds = last.toSec - last.fromSec - last.repairSeconds;
				continue;
			}
			result.push(this.makeGap(gap.fromSec, gap.toSec));
		}
		return result;
	}

	/** 汇总真正缺失、需要设备补回的秒数，不包含桥接跨度。 */
	sumRepairSeconds(gaps: HistoryGap[]): number {
		let total = 0;
		for (let i = 0; i < gaps.length; i++) total += gaps[i].repairSeconds;
		return total;
	}

	/** 汇总为减少连接/命令次数而跨过的已有数据秒数。 */
	sumBridgeSeconds(gaps: HistoryGap[]): number {
		let total = 0;
		for (let i = 0; i < gaps.length; i++) total += gaps[i].bridgeSeconds;
		return total;
	}

	/* ===== B 推进 ===== */

	/**
	 * 推进 `B`：纯表操作，不查 `ppi_data`。这里只做保留期钳制，不重新执行分类。
	 *
	 * 上界由记账规则保证（写进 `vital_ready_ranges` 的右端不超过 `stableCeiling`），
	 * 所以这里只剩「`B` 落在 `ready[0]` 内就前进」这一个循环。**`B` 会停在缺口
	 * 前面**：`ready[0]` 的起点大于 `B` 时循环立刻结束，后面那些合格的区间原样留着，
	 * 等缺口被补掉之后再消费（5.6）。
	 *
	 * `ready` 一次读出并按顺序扫描；扫描到第一条起点晚于 B 的区间即停止。被 B
	 * 覆盖的前缀最后批量删除，既不反复查表，也不在循环里移动数组元素。
	 */
	async advanceBaseline(nowSec: number, knownBaseline: number | null = null): Promise<number> {
		let baseline = await this.clampToRetention(nowSec, knownBaseline);
		const baselineBefore = baseline;
		const ready = await this.listReadyRanges();
		let consumed = 0;
		for (let i = 0; i < ready.length; i++) {
			const range = ready[i];
			// `B` 停在缺口前面：后面的区间是合格的，但 `B` 过不去，这一轮到此为止。
			if (range.fromSec > baseline) break;
			if (range.toSec > baseline) baseline = range.toSec;
			consumed++;
		}
		// B 与其左侧 ready 在同一事务提交，失败时不会留下「B 已进、区间未删」或反向状态。
		if (consumed > 0) await this.saveBaseline(baseline);
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

	/* ===== 诊断只读视图 ===== */

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

/** 历史分类、缺口推导和 B 推进的唯一进程内入口。 */
export const historyBaseline = new HistoryBaseline();
