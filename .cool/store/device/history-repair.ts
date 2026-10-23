/**
 * 补数据：一次连接内把 `[B, stableCeiling)` 这一段顺序读完。
 *
 * 为什么是「一整段」而不是「先算区间再逐段读」：设备在 `direction=1` 下会跳过没记录的
 * 时间、直接给下一段有数据的页，所以从 `B` 一路向前读下来就是完整的补录。
 *
 * 读取只回答一个问题——设备到底有没有这一段：有就给页，没有就跳过。所以**「设备不回」
 * 永远只是失败**，不会被折算成「设备没有这段数据」；那等于替设备下结论，会平白丢掉一段
 * 可能真实存在的数据。失败就让 `B` 停在读到的位置，下一次连接从这里接着读。
 *
 * 这里**不 import `Device`**：只依赖一个「能按一段时间顺序读」的 reader，所以它可以配一个
 * 假 reader 独立测试。连接由调用方（gatt-scheduler）负责，本文件不碰。
 */
import { historyBaseline, formatHistorySec } from "../../bluetooth/history/baseline";
import { logger } from "../../service/logger";
import type { RangeReader, VitalAutoReadResult } from "./history-reader";
import type { DeviceProtocolProbe } from "./protocol-probe";

export type HistoryRepairStopReason = "COMPLETE" | "DEVICE_UNRESPONSIVE" | "LOCAL_FAILURE";

/**
 * 同一次连接里最多重锚几次。
 *
 * 存在的理由是设备固件在 `0x3B` 翻页路径上有一个可复现的缺陷：某一页没填满时，下一页的
 * `startSec` 会**固定退回 480 秒（4 页）**，客户端只能判停滞收尾。重新用 `0x3A` 以当前
 * `accountedUntil` 锚定就能绕过——`0x3A` 走显式起点，不依赖那个已经算错的内部游标。
 *
 * 上限只是防跑飞：固件要是连着锚定也错，读满这个次数就该让连接收手，把通道让给下一次心跳。
 */
const REANCHOR_MAX_ATTEMPTS = 8;

/**
 * 把 `[B, stableCeiling)` 读完，返回是否要中断这次连接。
 *
 * 调用方负责确认「已连接且协议就绪」——这里不碰连接。执行前先分类推进一次（避免排队期间
 * 广播已经把落后量补掉），收尾再读一次 `B`，用前后差量给出「本轮到底推进了多少」。
 */
export async function repairFromBaseline(
	reader: RangeReader,
	probe: DeviceProtocolProbe | null = null
): Promise<HistoryRepairStopReason> {
	const startedAt = Date.now();
	const nowSec = Math.floor(Date.now() / 1000);
	const classified = await historyBaseline.classify(nowSec);
	const baseline = classified.baselineAfter;
	const ceiling = historyBaseline.stableCeiling(nowSec);
	if (ceiling <= baseline) return "COMPLETE";

	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 开始补录: B=${formatHistorySec(baseline)}, 窗口=${formatHistorySec(baseline)}~${formatHistorySec(ceiling)}, 窗口秒=${ceiling - baseline}, 连接开始=${startedAt}`
	);

	let attempt = 0;
	let stopReason: HistoryRepairStopReason = "COMPLETE";
	let read = await reader.readVitalRangeForward(baseline, ceiling, null);
	stopReason = await resolveStopReason(reader, probe, read);

	// 页停滞 / 超时但设备还活着时，在**同一次连接里**重新锚定继续读。
	// 不这么做就得断开、等满 `CONNECT_INTERVAL_MS` 再连一次，而 10/16 真机上这段落后要磨
	// 一个多小时才能补完（每轮只推进 20~50 分钟，且每轮都撞同一个 480s 倒退）。
	while (stopReason == "COMPLETE" && isRetryable(read) && attempt < REANCHOR_MAX_ATTEMPTS) {
		attempt++;
		const after = await historyBaseline.getBaseline();
		// 读不到任何东西就别重试了：`0x3A` 已经在上一次尝试里问过同一段，设备答不出就是答不出。
		if (after <= baseline) break;
		logger.warn(
			"bluetooth",
			`[BOOM-HISTORY] 停滞后同连接重锚续读: 第${attempt}次, status=${read.status}, 从 B=${formatHistorySec(after)} 重新发 0x3A, 上次失败页=${read.failedToSec != null ? formatHistorySec(read.failedToSec) : "未知"}, reason=${read.message}`
		);
		read = await reader.readVitalRangeForward(after, ceiling, null);
		stopReason = await resolveStopReason(reader, probe, read);
	}

	// `B` 推到哪、还剩多少活，都由读取链路逐页记账后的实际值给出。落库的秒由
	// `readVitalRange` 的 finally 通过 `scheduleUpload()` 排空，这里不重复触发。
	// 整轮沿用规划时的 nowSec：连接耗时会让 30 天保留起点自然向前滑，换成当前时间会让
	// TIMEOUT/pages=0 也显示「B 推进了几秒」，把过期错算成补录成果。
	const after = await historyBaseline.getBaseline();
	const remainingSeconds = Math.max(0, ceiling - after);
	const deferredTailSeconds = Math.max(
		0,
		historyBaseline.stableCeiling(Math.floor(Date.now() / 1000)) - ceiling
	);
	// `DONE` 只说明读取器认为链路结束；只有 `B` 越过窗口右端才证明整段都已落库或被设备
	// 确认无数据，否则本轮仍算没补完，不能打印 ok=true。
	const completed = isReadCompleted(read) && after >= ceiling;
	logger.info(
		"bluetooth",
		`[BOOM-HISTORY] 补录结束: B=${formatHistorySec(baseline)}->${formatHistorySec(after)}, 本段推进=${after - baseline}s, status=${read.status}, pages=${read.pages}, 落库秒=${read.savedRecords}, 窗口剩余秒=${remainingSeconds}, deferredTail=${deferredTailSeconds}s, stableCeiling=${formatHistorySec(ceiling)}, 重锚次数=${attempt}, 连接时长=${Math.round((Date.now() - startedAt) / 1000)}s, ok=${completed}`
	);
	return stopReason;
}

/**
 * 这一轮是否值得在同一次连接里原样再问一次。
 *
 * 只有页级失败（超时 / 页停滞）值得重试：连接本身是好的，只是某几页没读成。`DONE` /
 * `STOPPED` 是读取器自己认为链路结束了，再问一次只会重复问设备已经回答过的事。
 * 落库失败也不重试 —— 那是本地的问题，再读一遍还是同样的错。
 */
function isRetryable(read: VitalAutoReadResult): boolean {
	if (read.saveOk == false) return false;
	return read.status == "TIMEOUT" || read.status == "PAGE_STALLED";
}

/**
 * 页级失败只回答一个问题：要不要中断这次连接。
 *
 * 设备级失败（超时、页停滞）先探活：设备还活着，就清掉可能残留的半个响应帧、让本轮正常
 * 收尾，`B` 停在读到的位置；设备失活则中断整轮，把通道让给重连。本地失败（落库失败、发送
 * 失败）与设备无关，同样只中断本轮。
 *
 * **不再有任何持久化的失败记录。** 「设备不回」不产生记账、不越过 `B`，也就没有需要跨连接
 * 记住的东西：落后量原样留着，下一轮心跳按 10 分钟间隔再来一次即可。
 */
async function resolveStopReason(
	reader: RangeReader,
	probe: DeviceProtocolProbe | null,
	read: VitalAutoReadResult
): Promise<HistoryRepairStopReason> {
	if (read.status != "TIMEOUT" && read.status != "PAGE_STALLED")
		return read.saveOk == false || read.status == "SEND_FAILED" ? "LOCAL_FAILURE" : "COMPLETE";
	if (probe != null) {
		const probeResult = await probe.check();
		if (probeResult.status != "OK") {
			logger.warn(
				"bluetooth",
				`[BOOM-HISTORY] 历史页失败后探活失败: status=${probeResult.status}, page=${formatFailedRange(read)}, reason=${read.message}`
			);
			return "DEVICE_UNRESPONSIVE";
		}
	}
	reader.resetVitalResponseState();
	logger.warn(
		"bluetooth",
		`[BOOM-HISTORY] 历史页读取失败: status=${read.status}, page=${formatFailedRange(read)}, reason=${read.message}`
	);
	return "COMPLETE";
}

/** 只有读链路明确完成且所有落库/记账步骤成功，才允许把这一段称为补完。 */
function isReadCompleted(read: VitalAutoReadResult): boolean {
	return read.status == "DONE" && read.saveOk == true;
}

/** 失败页区间。两个字段都可能为 `null`（首包就失败），这时只说「未知」而不是打 `null`。 */
function formatFailedRange(read: VitalAutoReadResult): string {
	if (read.failedFromSec == null || read.failedToSec == null) return "未知";
	return `${formatHistorySec(read.failedFromSec)}~${formatHistorySec(read.failedToSec)}`;
}
