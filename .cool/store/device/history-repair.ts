/**
 * 补数据：一次连接内把 `listRepairGaps()` 的缺口读完。
 *
 * 「一次读完，不循环补读」是刻意的（方案 8.3）：读到的东西越多耗时越长，而耗时
 * 就在制造新的尾巴；只要 `T ≤ 11 分钟`，第一轮留下的尾巴本来就被容差吸收
 * （连续缺失 < 9 秒），多跑一轮省下的是 0，纯粹多占 GATT。剩下没读的留给下一次连接。
 *
 * 这里**不 import `Device`**：只依赖一个「能按缺口读一段」的 reader，所以它可以
 * 配一个假 reader 独立测试，不需要构造整个设备栈。连接由调用方（gatt-scheduler）
 * 负责，本文件不碰。
 */
import { historyBaseline } from "../../bluetooth/history/baseline";
import { logger } from "../../service/logger";
import type { HistoryGap } from "../../bluetooth/history/baseline";
import type { HistoryReadStatus, VitalAutoReadResult } from "./history-reader";

/**
 * 补数据只需要 reader 的这一个能力。`DeviceHistoryReader` 显式 `implements` 它。
 *
 * 必须是 `interface` 而不是 `type` 对象字面量：UTS 名义类型，没有结构化子类型，
 * 类实例无法赋给对象字面量类型（编译错误 error17：实际类型 DeviceHistoryReader，
 * 预期类型 GapReader）。类侧要 `implements GapReader` 才成立。
 */
export interface GapReader {
	readVitalGapGroup(gap: HistoryGap): Promise<VitalAutoReadResult>;
}

/** 一次补录规划的结果。 */
export type HistorySyncPlan = {
	needed: boolean;
	gaps: HistoryGap[];
	baseline: number;
	ceiling: number;
	totalRepairSeconds: number;
};

/** 单个缺口在一次 GATT 连接中的补拉结果。 */
export type HistoryGapRepairResult = {
	gap: HistoryGap;
	status: HistoryReadStatus;
	message: string;
	pages: number;
	savedRecords: number;
	saveOk: boolean;
	uploadScheduled: boolean;
};

export type HistoryRepairResult = {
	ok: boolean;
	message: string;
	plan: HistorySyncPlan;
	results: HistoryGapRepairResult[];
	savedRecords: number;
};

/**
 * 把当前全部缺口读完。调用方负责确认「已连接且协议就绪」——这里不碰连接。
 *
 * 执行前重新规划一次，避免队列等待期间广播已经把缺口补上；收尾再重算一次，
 * 用 `B` 的前后差量给出「本轮到底推进了多少」的确切数字。
 */
export async function repairAllGaps(reader: GapReader): Promise<HistoryRepairResult> {
	const startedAt = Date.now();
	const nowSec = Math.floor(Date.now() / 1000);
	await historyBaseline.classify(nowSec);
	const baseline = await historyBaseline.advanceBaseline(nowSec);
	const gaps = await historyBaseline.listRepairGaps(nowSec);
	const plan: HistorySyncPlan = {
		needed: gaps.length > 0,
		gaps,
		baseline,
		ceiling: historyBaseline.stableCeiling(nowSec),
		totalRepairSeconds: historyBaseline.sumRepairSeconds(gaps)
	} as HistorySyncPlan;
	if (plan.needed == false) {
		return makeResult(true, "no history gaps", plan, []);
	}

	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 开始补录: B=${plan.baseline}, 缺口组=${plan.gaps.length}, 缺口秒=${plan.totalRepairSeconds}, bridge秒=${historyBaseline.sumBridgeSeconds(plan.gaps)}, stableCeiling=${plan.ceiling}, 连接开始=${startedAt}`
	);
	const results = await runVitalGaps(reader, plan.gaps);
	let ok = true;
	let failedGroups = 0;
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (item.status == "TIMEOUT" || item.status == "SEND_FAILED" || item.saveOk == false) {
			ok = false;
			failedGroups++;
		}
	}
	// 收尾重算：`B` 推到哪、还剩多少活，都由重新规划的缺口给出确切数字。
	// 落库的秒由 `readVitalRange` 的 finally 通过 `scheduleUpload()` 排空，这里不重复触发。
	const afterSec = Math.floor(Date.now() / 1000);
	const after = await historyBaseline.advanceBaseline(afterSec);
	const remaining = await historyBaseline.listRepairGaps(afterSec);
	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 补录结束: B=${plan.baseline}->${after}, 已补组=${results.length - failedGroups}, 失败组=${failedGroups}, 落库秒=${countSaved(results)}, 剩余缺口=${remaining.length}, 剩余秒=${historyBaseline.sumRepairSeconds(remaining)}, stableCeiling=${historyBaseline.stableCeiling(afterSec)}, 连接时长=${Math.round((Date.now() - startedAt) / 1000)}s, ok=${ok}`
	);
	return makeResult(ok, ok ? "history repair done" : "history partial failed", plan, results);
}

async function runVitalGaps(
	reader: GapReader,
	gaps: HistoryGap[]
): Promise<HistoryGapRepairResult[]> {
	const results: HistoryGapRepairResult[] = [];
	const total = gaps.length;
	for (let i = 0; i < gaps.length; i++) {
		const gap = gaps[i];
		// 每组记账推进了多少，用 `B` 的前后差量度量。这是核对「记账是否按预期推进」
		// 的直接证据：`B` 没动就说明这一组的读取没有转成记账（被 `stableCeiling`
		// 封顶、或落库失败），而这在 `落库秒` 上完全看不出来——两者是两件事。
		const before = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000));
		const result = await reader.readVitalGapGroup(gap);
		const after = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000));
		logger.info(
			"bluetooth",
			`[BOOM-HISTORY] 缺口组结束: ${i + 1}/${total}, window=${gap.fromSec}~${gap.toSec}, 缺口秒=${gap.repairSeconds}, bridge秒=${gap.bridgeSeconds}, status=${result.status}, pages=${result.pages}, 落库=${result.savedRecords}, B=${before}->${after}, 本组推进=${after - before}s`
		);
		results.push({
			gap,
			status: result.status,
			message: result.message,
			pages: result.pages,
			savedRecords: result.savedRecords,
			saveOk: result.saveOk,
			uploadScheduled: result.uploadScheduled
		} as HistoryGapRepairResult);
		if (result.status == "TIMEOUT" || result.status == "SEND_FAILED" || !result.saveOk) break;
	}
	return results;
}

function countSaved(results: HistoryGapRepairResult[]): number {
	let saved = 0;
	for (let i = 0; i < results.length; i++) saved += results[i].savedRecords;
	return saved;
}

function makeResult(
	ok: boolean,
	message: string,
	plan: HistorySyncPlan,
	results: HistoryGapRepairResult[]
): HistoryRepairResult {
	return {
		ok,
		message,
		plan,
		results,
		savedRecords: countSaved(results)
	} as HistoryRepairResult;
}
