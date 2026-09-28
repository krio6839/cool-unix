import { bluetoothDatabase } from "../database";
import { historyCoverage } from "./coverage-service";
import { HISTORY_MINUTE_SETTLE_SEC } from "./config";
import { subtractRanges, countRangeSeconds, rangesFromTimestamps } from "./coverage";
import type { HistoryTimeRange } from "./coverage";
import { logger } from "../../service/logger";
import { formatAppDateTime, getAppTimezone } from "../../utils/timezone";

/**
 * 历史进度只由两个游标表达，都存单行状态表 `vital_sync_state`（由数据库初始化流程幂等
 * 建表）里的两个整数：
 *
 * - `baseline_sec`（下称 `B`）：「读到哪」。`[0, B)` 每一秒都已记账，也是读取窗口左端。
 * - `classified_until_sec`（下称 `C`）：「判到哪」。省掉 `B` 卡住时每轮从 `B` 重判整段。
 *
 * 恒有 `B <= C <= stableCeiling`。两者都是裸的 Unix 秒，不整分钟对齐。
 * 判定与记账的规则见 `BOOM蓝牙运行流程.md` 第 8 节。
 */
export const BASELINE_SCHEMA: string[] = [
	`CREATE TABLE IF NOT EXISTS vital_sync_state (
		id INTEGER PRIMARY KEY CHECK(id=1),
		baseline_sec INTEGER NOT NULL,
		classified_until_sec INTEGER NOT NULL DEFAULT 1
	)`,
	// 旧版本用区间表记「非连续地记过哪些秒」。进度现在只由 `B` 一个整数表达，
	// 这张表已无人读写，升级时直接丢掉（幂等，重复启动无副作用）。
	`DROP TABLE IF EXISTS vital_ready_ranges`,
	// 旧版本把「设备反复不回这一页」记成审计并在三次后当作「设备没有这段数据」。
	// 没有回答就是没有回答，替设备下这个结论会平白丢掉一段可能真实存在的数据，
	// 所以整套放弃机制连表一起删掉：读取失败只是失败，下一次连接从 `B` 接着读。
	`DROP TABLE IF EXISTS vital_history_failures`
];

/** 保留 Unix 秒值，同时附带按 App 本地配置格式化的时间，方便诊断日志定位。 */
export function formatHistorySec(sec: number): string {
	const timestamp = sec * 1000;
	const timezone = getAppTimezone(timestamp);
	const sign = timezone.startsWith("-") ? "" : "+";
	return `${sec}(${formatAppDateTime(timestamp, " ", true)}${sign}${timezone})`;
}

/** 合格容差（定死，见方案第 3 节）：连续缺失 ≥ 9s 不合格，缺失占比 ≥ 30% 不合格。 */
const MINUTE_MAX_MISSING_RUN_SEC = 9;
const MISSING_TOTAL_PERCENT = 30;

/* ===== 对外数据结构 ===== */

/**
 * 一轮分类的增量结果，供调度日志与回归测试核对。
 *
 * `baselineAfter` 是本轮 `B` 落到哪：`B == C` 时等于合格前缀的右端；`B < C` 时说明 `B`
 * 正卡在前面某段不合格段上，本轮到不了它，值等于 `baselineBefore`。判完但不合格的秒既没
 * 被 `B` 消费、也不留在 `B` 后面，只能等一次读取去设备里取，日志里的「不合格」就是它。
 */
type BaselineClassifyResult = {
	classifiedBefore: number;
	classifiedAfter: number;
	baselineBefore: number;
	baselineAfter: number;
	/** 本轮判定窗口的总长度，即 `ceiling - classifiedBefore`。 */
	unclassifiedSeconds: number;
	unqualifiedSegments: number;
};

/**
 * 一段判定明细。`ready` 是段内可记账的子区间；`blockedRuns` / `blockedSeconds` 只统计
 * **已判定**的不合格段；`pendingFromSec` 是贴着开放右端、尚未长完的那段缺失的起点。
 */
type SegmentAssessment = {
	ready: HistoryTimeRange[];
	missingSeconds: number;
	longestMissingRun: number;
	blockedRuns: number;
	blockedSeconds: number;
	pendingFromSec: number | null;
};

/**
 * 测试页只读快照；类型由 `snapshot()` 推导给调用方，不作为跨模块契约导出。
 *
 * `behind` 是 `ceiling - baseline`，即「还有多少秒没有记账」，也是连接闸门的输入。
 */
type BaselineSnapshot = {
	baseline: number;
	classifiedUntil: number;
	ceiling: number;
	behind: number;
};

/* ===== SQLite 兼容语句 ===== */

/**
 * 一次把两个游标写下去。默认只**抬高**，不后退：
 * `C` 不会被 `B` 落在后面（分类要判的范围从 `C` 起），`B` 也不会被写回旧值。
 *
 * `reset` 用于「新绑定 / 保留窗口回收」——那两种场合必须把 `C` 拉回与 `B` 齐平，
 * 不能继承旧设备或故障版本留下的分类进度。
 */
function progressStatements(
	value: number,
	classifiedUntil: number,
	reset: boolean = false
): string[] {
	const cursor = reset
		? `classified_until_sec=${value}`
		: `classified_until_sec=CASE WHEN classified_until_sec<${value} THEN ${value} ELSE classified_until_sec END`;
	const statements = [
		`UPDATE vital_sync_state SET baseline_sec=${value},${cursor} WHERE id=1`,
		`INSERT OR IGNORE INTO vital_sync_state (id,baseline_sec,classified_until_sec) VALUES (1,${value},${value})`
	];
	if (classifiedUntil > value)
		statements.push(
			`UPDATE vital_sync_state SET classified_until_sec=${classifiedUntil} WHERE id=1`
		);
	return statements;
}

/* ===== 分类纯计算：不访问数据库、不推进 B ===== */

/** 创建零统计结果；后续只填写本轮实际分类产生的增量。 */
function makeClassifyResult(baseline: number, classified: number): BaselineClassifyResult {
	return {
		classifiedBefore: classified,
		classifiedAfter: classified,
		baselineBefore: baseline,
		baselineAfter: baseline,
		unclassifiedSeconds: 0,
		unqualifiedSegments: 0
	} as BaselineClassifyResult;
}

/**
 * 判断一段未记账区间：
 * 1. 连续缺失达到 9 秒的段判不合格、不记账，同时把剩下的地方切成候选区；
 * 2. 每个候选区再检查总缺失率，低于 30% 才进 `ready`；
 * 3. 贴着开放右端的短缺失暂不下结论，由调用方把 `C` 停在它的起点。
 *
 * 判定范围的右端**永远是 `stableCeiling`**（本轮只判 `[C, stableCeiling)`），所以贴右端
 * 的那一段缺失永远只是「目前这么长」，不能当完整缺失处理。
 */
function assessSegment(
	fromSec: number,
	toSec: number,
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
		// 贴右端的短缺失还在长，最终会不会超过阈值还不知道，所以不算「已判定的不合格段」，
		// 只记进 `pendingFromSec`；但它和真不合格段一样把候选区切开。
		const pending = run.toSec == toSec && runSeconds < MINUTE_MAX_MISSING_RUN_SEC;
		const cuts = run.toSec == toSec || runSeconds >= MINUTE_MAX_MISSING_RUN_SEC;
		if (pending) result.pendingFromSec = run.fromSec;
		if (cuts) {
			if (pending == false) {
				result.blockedRuns++;
				result.blockedSeconds += runSeconds;
			}
			if (run.fromSec > candidateStart)
				candidates.push({ fromSec: candidateStart, toSec: run.fromSec });
			candidateStart = run.toSec;
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

/**
 * `B` 能推到哪里：判定起点起、**连续**合格的右端。
 *
 * 候选区是从判定起点一段段切出来的，所以第一段就是「从头连着合格」的那一段。它没通过
 * 总量那一关时 `ready[0]` 可能是被不合格段隔开的后面那一段，那就一秒都不能推——`B` 必须
 * 停在不合格段前面，等读取把这一整段覆盖掉。
 */
function qualifiedPrefixEnd(fromSec: number, assessment: SegmentAssessment): number {
	const ready = assessment.ready;
	if (ready.length == 0 || ready[0].fromSec != fromSec) return fromSec;
	return ready[0].toSec;
}

/**
 * 两个游标的读写与推进。**没有第三张表。**
 *
 * 早先的 `vital_ready_ranges` 存「非连续地记过哪些秒」，为的是让 `B` 一次消费它后面那些
 * 零散合格区间。但读取永远是从 `B` 起一路读到 `stableCeiling`，那些区间一定会被这次读取
 * 整段覆盖，存下来只多一份和 `B` 不同步的风险。
 *
 * 两个游标正常一起前进（`B == C`，判完就推）；出现跨不过去的不合格段时 `B` 停在该段起点、
 * `C` 继续随心跳推进，直到一次读取把这一整段解开。
 */
class HistoryBaseline {
	/* ===== 时间边界 ===== */

	/**
	 * 记账、分类与读取的统一稳定上界：第 `s` 秒可用当且仅当
	 * `s + HISTORY_MINUTE_SETTLE_SEC <= now`。
	 *
	 * **不要向上取整到分钟**：取整会让判定右端在 `B` 已推进到分钟中间时落到 `B` 之前，
	 * 整轮判不动，未记账的秒留着又拉起一次连接。
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
	async getClassifiedUntil(): Promise<number> {
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
	 * 本地没有 `baseline_sec` 不等于过去 30 天都要补录：默认从当前稳定右端开始。旧故障版本
	 * 会把空基准钳到保留窗口左端、制造整整 30 天的未记账段，所以启动时若 `B` 仍不晚于保留
	 * 起点，也按同一规则恢复到稳定右端——产品允许统计级数据不完整，放弃这段过期积压比发起
	 * 数百次无效 GATT 连接更符合目标。
	 */
	async initializeIfMissing(nowSec: number): Promise<number> {
		await this.ensureClassificationCursorColumn();
		const current = await this.getBaseline();
		const retentionStart = historyCoverage.retentionStartSec(nowSec);
		if (current > retentionStart) return current;
		const initial = Math.max(1, this.stableCeiling(nowSec));
		const reason = current <= 1 ? "bootstrap" : "retention-start-recovery";
		const saved = await bluetoothDatabase.transaction(
			progressStatements(initial, initial, true)
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
			progressStatements(initial, initial, true)
		);
		if (saved == false) throw new Error("重置新绑定基准时间失败");
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 新绑定基准初始化: B=${formatHistorySec(initial)}, 原因=new-binding`
		);
	}

	/**
	 * 保留窗口钳制：`B` 早于 30 天保留起点时一次性跳过去。
	 *
	 * 必须**在分类之前**跑：全新安装时 `B = 1`，不先钳制就要从 1970 年判到今天，既不是要判
	 * 的东西，也会把内存撑爆。30 天保留窗口也是唯一的时间约束（更早的秒设备也补不回来），
	 * 所以跳过去没有语义损失。幂等，分类与读取各自调用一次，谁先来都成立。
	 *
	 * `knownBaseline` 是调用方**刚读到**的 `B`，一次 tick 内不会变，传进来可以省一次读库。
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
		await this.saveProgress(retentionStart, retentionStart);
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准推进: B=${formatHistorySec(retentionStart)}, 原因=expired, 保留起点=${formatHistorySec(retentionStart)}`
		);
		return retentionStart;
	}

	/* ===== 游标推进 ===== */

	/**
	 * 把两个游标推进到 `baseline` / `classifiedUntil`，`C` 永不低于 `B`。
	 * 唯一写状态的地方。
	 */
	private async saveProgress(baseline: number, classifiedUntil: number): Promise<void> {
		if ((await bluetoothDatabase.transaction(progressStatements(baseline, classifiedUntil))) == false)
			throw new Error("保存基准进度失败");
	}

	/* ===== 读取侧记账 ===== */

	/**
	 * 把 `[B, toSec)` 记为已记账：`B` 推到 `toSec`，右端先被 `stableCeiling` 封顶。
	 *
	 * 只有「记到哪」一个参数——`B` 本身就是「已经算到哪」，读取永远从 `B` 起连续确认。
	 * 跳页与整页落库走同一个调用。超出 `stableCeiling` 的秒尚无定论：既不推进 `B`，
	 * 也不用重读，等时间走过去即可。
	 */
	async advanceAccounted(toSec: number, nowSec: number): Promise<number> {
		const to = Math.floor(toSec);
		if (to <= 0) return await this.getBaseline();
		const ceiling = this.stableCeiling(nowSec);
		const bounded = to > ceiling ? ceiling : to;
		const current = await this.getBaseline();
		if (bounded <= current) return current;
		await this.saveProgress(bounded, bounded);
		return bounded;
	}

	/* ===== C 增量分类 ===== */

	/** 一轮只判一段窗口，所以「段不合格」最多一行，不需要限流。 */
	private logUnqualifiedSegments(range: HistoryTimeRange, assessment: SegmentAssessment): void {
		if (assessment.blockedRuns == 0) return;
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 段不合格: 区间=${formatHistorySec(range.fromSec)}~${formatHistorySec(range.toSec)}, 长度=${range.toSec - range.fromSec}s, 缺失=${assessment.missingSeconds}s, 最长连续缺失=${assessment.longestMissingRun}s, 阻塞段数=${assessment.blockedRuns}, 阻塞秒=${assessment.blockedSeconds}s, 阈值=缺失<${MISSING_TOTAL_PERCENT}%, 连续<${MINUTE_MAX_MISSING_RUN_SEC}`
		);
	}

	/**
	 * 判定 `[C, stableCeiling)` 这一段，并把结果落到两个游标上。
	 *
	 * 起点取 `C` 而不是 `B`，所以 `B` 卡住时不会每轮重判它身后已经判定过的秒。
	 *
	 * `B` 的推进有一条硬约束：**只有判定起点就是 `B` 时才能推**。`B < C` 意味着 `B` 正卡在
	 * 前面某段不合格段上，这一段判出来的合格前缀在它后面，唯一能解开的是「从 `B` 起读到
	 * `stableCeiling`」的那次读取——读取会把整段覆盖掉，现在记下来只是白记。
	 */
	async classify(
		nowSec: number,
		knownBaseline: number | null = null
	): Promise<BaselineClassifyResult> {
		const startedAt = Date.now();
		const ceiling = this.stableCeiling(nowSec);
		const baselineBefore = await this.clampToRetention(nowSec, knownBaseline);
		const classified = Math.max(baselineBefore, Math.min(ceiling, await this.getClassifiedUntil()));
		const result = makeClassifyResult(baselineBefore, classified);
		if (ceiling <= classified) return result;

		const range: HistoryTimeRange = { fromSec: classified, toSec: ceiling } as HistoryTimeRange;
		const timestamps = await historyCoverage.getPpiTimestamps(range);
		const present = rangesFromTimestamps(range, timestamps);
		const assessment = assessSegment(range.fromSec, range.toSec, present);
		this.logUnqualifiedSegments(range, assessment);

		// 贴右端的短缺失还没定论：`C` 停在它前面，下一轮只重判这几秒。
		const pending = assessment.pendingFromSec;
		result.classifiedAfter = pending != null && pending < ceiling ? pending : ceiling;
		result.unclassifiedSeconds = ceiling - classified;
		result.unqualifiedSegments = assessment.blockedRuns;
		let baselineAfter = baselineBefore;
		if (baselineBefore == classified) baselineAfter = qualifiedPrefixEnd(classified, assessment);
		result.baselineAfter = baselineAfter;
		// 先写状态、再记日志：中途退出最多会重判，不能跳过尚未记账的秒。
		if (baselineAfter != baselineBefore || result.classifiedAfter > classified)
			await this.saveProgress(baselineAfter, result.classifiedAfter);
		const judged = result.classifiedAfter - classified;
		const accounted = baselineAfter - baselineBefore;
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 分类完成: C=${formatHistorySec(classified)}->${formatHistorySec(result.classifiedAfter)}, 待判断=${result.unclassifiedSeconds}s, 记入B=${accounted}s, 不合格=${Math.max(0, judged - accounted)}s, 不合格段=${result.unqualifiedSegments}, stableCeiling=${formatHistorySec(ceiling)}, B=${formatHistorySec(baselineAfter)}, 用时=${Date.now() - startedAt}ms`
		);
		return result;
	}

	/* ===== 诊断只读视图 ===== */

	/** 只读快照，供测试页展示。`behind` 同时是连接闸门的输入。 */
	async snapshot(nowSec: number): Promise<BaselineSnapshot> {
		const baseline = await this.getBaseline();
		const ceiling = this.stableCeiling(nowSec);
		return {
			baseline: baseline,
			classifiedUntil: await this.getClassifiedUntil(),
			ceiling: ceiling,
			behind: Math.max(0, ceiling - baseline)
		} as BaselineSnapshot;
	}
}

/** 历史分类与基准推进的唯一进程内入口。 */
export const historyBaseline = new HistoryBaseline();
