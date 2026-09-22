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
 *
 * 返回值只告诉 scheduler 是否因设备失活而必须停止连接；逐组的业务数字仍留在日志，
 * 避免调度器理解历史记账细节。
 */
import { historyBaseline } from "../../bluetooth/history/baseline";
import { logger } from "../../service/logger";
import type { HistoryGap } from "../../bluetooth/history/baseline";
import type { AbandonedRangeReader, GapReader, VitalAutoReadResult } from "./history-reader";
import {
	historyFailureStore,
	type HistoryFailureRecord
} from "../../bluetooth/history/history-failure-store";
import type { DeviceProtocolProbe } from "./protocol-probe";

export type HistoryRepairStopReason = "COMPLETE" | "DEVICE_UNRESPONSIVE" | "LOCAL_FAILURE";

export type HistoryRepairResult = {
	stopReason: HistoryRepairStopReason;
	timedOutPages: number;
	stalledPages: number;
	abandonedPages: number;
};

export async function retryAbandonedRange(
	reader: AbandonedRangeReader,
	fromSec: number,
	toSec: number
): Promise<VitalAutoReadResult> {
	const result = await reader.readVitalRangeManual(fromSec, toSec);
	if (result.status == "DONE" && result.saveOk == true) {
		await historyFailureStore.clearRange(fromSec, toSec);
	}
	return result;
}

export async function listAbandonedHistoryRanges(): Promise<HistoryFailureRecord[]> {
	return await historyFailureStore.listAbandoned();
}

/** 一个缺口、以及它在这一次连接里的读取结果。 */
type GapOutcome = {
	gap: HistoryGap;
	read: VitalAutoReadResult;
	completed: boolean;
};

/**
 * 把当前全部缺口读完。调用方负责确认「已连接且协议就绪」——这里不碰连接。
 *
 * 执行前重新规划一次，避免队列等待期间广播已经把缺口补上；收尾再重算一次，
 * 用 `B` 的前后差量给出「本轮到底推进了多少」的确切数字。
 */
export async function repairAllGaps(
	reader: GapReader,
	probe: DeviceProtocolProbe | null = null
): Promise<HistoryRepairResult> {
	const startedAt = Date.now();
	const nowSec = Math.floor(Date.now() / 1000);
	await reconcileAbandonedRanges(nowSec);
	await historyBaseline.classify(nowSec);
	const baseline = await historyBaseline.advanceBaseline(nowSec, null);
	const gaps = await historyBaseline.listRepairGaps(nowSec, baseline);
	if (gaps.length == 0) return makeRepairResult("COMPLETE", 0, 0, 0);
	const ceiling = historyBaseline.stableCeiling(nowSec);
	const totalRepairSeconds = historyBaseline.sumRepairSeconds(gaps);

	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 开始补录: B=${baseline}, 缺口组=${gaps.length}, 缺口秒=${totalRepairSeconds}, bridge秒=${historyBaseline.sumBridgeSeconds(gaps)}, stableCeiling=${ceiling}, 连接开始=${startedAt}`
	);
	const run = await runVitalGaps(reader, probe, gaps, baseline, nowSec);
	const outcomes = run.outcomes;
	let failedGroups = 0;
	for (let i = 0; i < outcomes.length; i++) {
		if (outcomes[i].completed == false) failedGroups++;
	}
	// 收尾重算：`B` 推到哪、还剩多少活，都由重新规划的缺口给出确切数字。
	// 落库的秒由 `readVitalRange` 的 finally 通过 `scheduleUpload()` 排空，这里不重复触发。
	// 整轮沿用规划时的 nowSec：连接耗时会让 30 天保留起点自然向前滑，如果在这里
	// 换成当前时间，TIMEOUT/pages=0 也会显示“B 推进了几秒”，把过期错算成补录成果。
	const after = await historyBaseline.advanceBaseline(nowSec, null);
	const remaining = await historyBaseline.listRepairGaps(nowSec, after);
	const afterSec = Math.floor(Date.now() / 1000);
	const deferredTailSeconds = Math.max(
		0,
		historyBaseline.stableCeiling(afterSec) - historyBaseline.stableCeiling(nowSec)
	);
	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 补录结束: B=${baseline}->${after}, 已补组=${outcomes.length - failedGroups}, 失败组=${failedGroups}, 落库秒=${countSaved(outcomes)}, 计划剩余缺口=${remaining.length}, 计划剩余秒=${historyBaseline.sumRepairSeconds(remaining)}, deferredTail=${deferredTailSeconds}s, stableCeiling=${historyBaseline.stableCeiling(nowSec)}, 连接时长=${Math.round((Date.now() - startedAt) / 1000)}s, ok=${failedGroups == 0}`
	);
	await reconcileAbandonedRanges(nowSec);
	return makeRepairResult(
		run.stopReason,
		run.timedOutPages,
		run.stalledPages,
		run.abandonedPages
	);
}

type GapRunResult = {
	outcomes: GapOutcome[];
	stopReason: HistoryRepairStopReason;
	timedOutPages: number;
	stalledPages: number;
	abandonedPages: number;
};

async function runVitalGaps(
	reader: GapReader,
	probe: DeviceProtocolProbe | null,
	gaps: HistoryGap[],
	startBaseline: number,
	planNowSec: number
): Promise<GapRunResult> {
	const outcomes: GapOutcome[] = [];
	let stopReason: HistoryRepairStopReason = "COMPLETE";
	let timedOutPages = 0;
	let stalledPages = 0;
	let abandonedPages = 0;
	const total = gaps.length;
	// 上一组的 `B` 就是下一组的起点：两组之间没有别的写入者，中间那次
	// `advanceBaseline()` 因此是重复调用。
	let before = startBaseline;
	for (let i = 0; i < gaps.length; i++) {
		const gap = gaps[i];
		const read = await reader.readVitalGapGroup(gap);
		// 每组记账推进了多少，用 `B` 的前后差量度量。这是核对「记账是否按预期推进」
		// 的直接证据：`B` 没动就说明这一组的读取没有转成记账（被 `stableCeiling`
		// 封顶、或落库失败），而这在 `落库秒` 上完全看不出来——两者是两件事。
		const after = await historyBaseline.advanceBaseline(planNowSec, before);
		// `DONE` 只是读取器认为链路结束；只有 B 已越过当前组右端，才能证明整个窗口
		// 都已落库或被设备明确确认无数据。否则仍是未完成，不能继续后面的组或打印 ok=true。
		const completed = isReadCompleted(read) && after >= gap.toSec;
		logger.info(
			"bluetooth",
			`[BOOM-HISTORY] 缺口组结束: ${i + 1}/${total}, window=${gap.fromSec}~${gap.toSec}, 缺口秒=${gap.repairSeconds}, bridge秒=${gap.bridgeSeconds}, status=${read.status}, pages=${read.pages}, 落库=${read.savedRecords}, B=${before}->${after}, 本组推进=${after - before}s, complete=${completed}`
		);
		outcomes.push({ gap, read, completed } as GapOutcome);
		before = after;
		if (completed == true) {
			await historyFailureStore.clearWithin(gap.fromSec, gap.toSec);
			continue;
		}
		if (
			(read.status == "TIMEOUT" || read.status == "PAGE_STALLED") &&
			read.failedFromSec != null &&
			read.failedToSec != null &&
			probe != null
		) {
			const probeResult = await probe.check();
			if (probeResult.status != "OK") {
				stopReason = "DEVICE_UNRESPONSIVE";
				logger.warn(
					"bluetooth",
					`[BOOM-HISTORY] 历史页失败后探活失败: status=${probeResult.status}, page=${read.failedFromSec}~${read.failedToSec}, reason=${read.message}`
				);
				break;
			}
			reader.resetVitalResponseState();
			const failure = await historyFailureStore.recordFailure(
				read.failedFromSec,
				read.failedToSec,
				Math.floor(Date.now() / 1000)
			);
			if (read.status == "TIMEOUT") timedOutPages++;
			else stalledPages++;
			if (failure.abandoned == true) {
				await historyBaseline.markReady(failure.fromSec, failure.toSec, planNowSec);
				abandonedPages++;
			}
			logger.warn(
				"bluetooth",
				`[BOOM-HISTORY] 历史页确认失败: status=${read.status}, page=${failure.fromSec}~${failure.toSec}, count=${failure.failureCount}, abandoned=${failure.abandoned}, reason=${read.message}`
			);
			continue;
		}
		// 非页级失败属于本地/发送/记账问题，不能按设备数据缺失累计或放弃。
		stopReason = "LOCAL_FAILURE";
		break;
	}
	return {
		outcomes,
		stopReason,
		timedOutPages,
		stalledPages,
		abandonedPages
	} as GapRunResult;
}

async function reconcileAbandonedRanges(nowSec: number): Promise<void> {
	const abandoned = await historyFailureStore.listAbandoned();
	const baseline = await historyBaseline.getBaseline();
	for (let i = 0; i < abandoned.length; i++) {
		if (abandoned[i].toSec <= baseline) continue;
		await historyBaseline.markReady(
			Math.max(baseline, abandoned[i].fromSec),
			abandoned[i].toSec,
			nowSec
		);
	}
}

function makeRepairResult(
	stopReason: HistoryRepairStopReason,
	timedOutPages: number,
	stalledPages: number,
	abandonedPages: number
): HistoryRepairResult {
	return { stopReason, timedOutPages, stalledPages, abandonedPages } as HistoryRepairResult;
}

/** 只有读链路明确完成且所有落库/记账步骤成功，才允许把本组称为成功。 */
function isReadCompleted(read: VitalAutoReadResult): boolean {
	return read.status == "DONE" && read.saveOk == true;
}

function countSaved(outcomes: GapOutcome[]): number {
	let saved = 0;
	for (let i = 0; i < outcomes.length; i++) saved += outcomes[i].read.savedRecords;
	return saved;
}
