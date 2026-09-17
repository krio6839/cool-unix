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
 * **不返回结果对象**：唯一的调用方是 GATT 队列，它拿到结果也无处可用——连接已经
 * 跑完，该记的都在这两行日志里了。逐组的数字（`本组推进`、`落库秒`）留在日志中，
 * 那才是排查「补了但没记账」时真正会去看的地方。
 */
import { historyBaseline } from "../../bluetooth/history/baseline";
import { logger } from "../../service/logger";
import type { HistoryGap } from "../../bluetooth/history/baseline";
import type { VitalAutoReadResult } from "./history-reader";

/** 补数据只需要 reader 的这一个能力。`DeviceHistoryReader` 天然满足它。 */
export type GapReader = {
	readVitalGapGroup(gap: HistoryGap): Promise<VitalAutoReadResult>;
};

/** 一个缺口、以及它在这一次连接里的读取结果。 */
type GapOutcome = {
	gap: HistoryGap;
	read: VitalAutoReadResult;
};

/**
 * 把当前全部缺口读完。调用方负责确认「已连接且协议就绪」——这里不碰连接。
 *
 * 执行前重新规划一次，避免队列等待期间广播已经把缺口补上；收尾再重算一次，
 * 用 `B` 的前后差量给出「本轮到底推进了多少」的确切数字。
 */
export async function repairAllGaps(reader: GapReader): Promise<void> {
	const startedAt = Date.now();
	const nowSec = Math.floor(Date.now() / 1000);
	await historyBaseline.classify(nowSec);
	const baseline = await historyBaseline.advanceBaseline(nowSec, null);
	const gaps = await historyBaseline.listRepairGaps(nowSec, baseline);
	if (gaps.length == 0) return;
	const ceiling = historyBaseline.stableCeiling(nowSec);
	const totalRepairSeconds = historyBaseline.sumRepairSeconds(gaps);

	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 开始补录: B=${baseline}, 缺口组=${gaps.length}, 缺口秒=${totalRepairSeconds}, bridge秒=${historyBaseline.sumBridgeSeconds(gaps)}, stableCeiling=${ceiling}, 连接开始=${startedAt}`
	);
	const outcomes = await runVitalGaps(reader, gaps, baseline);
	let failedGroups = 0;
	for (let i = 0; i < outcomes.length; i++) {
		const read = outcomes[i].read;
		if (read.status == "TIMEOUT" || read.status == "SEND_FAILED" || read.saveOk == false)
			failedGroups++;
	}
	// 收尾重算：`B` 推到哪、还剩多少活，都由重新规划的缺口给出确切数字。
	// 落库的秒由 `readVitalRange` 的 finally 通过 `scheduleUpload()` 排空，这里不重复触发。
	const afterSec = Math.floor(Date.now() / 1000);
	const after = await historyBaseline.advanceBaseline(afterSec, null);
	const remaining = await historyBaseline.listRepairGaps(afterSec, after);
	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 补录结束: B=${baseline}->${after}, 已补组=${outcomes.length - failedGroups}, 失败组=${failedGroups}, 落库秒=${countSaved(outcomes)}, 剩余缺口=${remaining.length}, 剩余秒=${historyBaseline.sumRepairSeconds(remaining)}, stableCeiling=${historyBaseline.stableCeiling(afterSec)}, 连接时长=${Math.round((Date.now() - startedAt) / 1000)}s, ok=${failedGroups == 0}`
	);
}

async function runVitalGaps(
	reader: GapReader,
	gaps: HistoryGap[],
	startBaseline: number
): Promise<GapOutcome[]> {
	const outcomes: GapOutcome[] = [];
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
		const after = await historyBaseline.advanceBaseline(Math.floor(Date.now() / 1000), before);
		logger.info(
			"bluetooth",
			`[BOOM-HISTORY] 缺口组结束: ${i + 1}/${total}, window=${gap.fromSec}~${gap.toSec}, 缺口秒=${gap.repairSeconds}, bridge秒=${gap.bridgeSeconds}, status=${read.status}, pages=${read.pages}, 落库=${read.savedRecords}, B=${before}->${after}, 本组推进=${after - before}s`
		);
		outcomes.push({ gap, read } as GapOutcome);
		before = after;
		// 链路断了就停：后面的组只会在坏连接上再超时一遍。
		// 「设备这段没数据」（status=DONE、落库 0）不是失败，继续读下一组。
		if (read.status == "TIMEOUT" || read.status == "SEND_FAILED" || !read.saveOk) break;
	}
	return outcomes;
}

function countSaved(outcomes: GapOutcome[]): number {
	let saved = 0;
	for (let i = 0; i < outcomes.length; i++) saved += outcomes[i].read.savedRecords;
	return saved;
}
