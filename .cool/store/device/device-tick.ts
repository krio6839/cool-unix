/**
 * 心跳：全套后台节奏的**唯一决策点**。
 *
 * 三件事各归各的模块——广播负责采集（`broadcast.ts` 落库后只喊一声 `poke()`）、判定负责
 * 推进基准（`history/baseline.ts`）、补数据负责连接读取（`history-repair.ts`）。这个文件
 * 是它们之间唯一的时序约定：谁都不认识别人的节奏，只知道自己被 tick 到了。
 *
 * 一次 tick 固定两步：`classify()`（同时推进 `B` 与 `C`）→ `uploadData()`，然后
 * `maybeConnect()`。判定与上传是两件独立的事——判定依据是本地的 `ppi_data`，不是上传结果，
 * 弱网下上传失败只会让 `uploaded` 保持 0，不会把已经收齐的秒判成待补。
 *
 * 广播在线时分类每轮都在追，`B` 与 `C` 因此一起贴着 `stableCeiling`，不累积。
 * 连接由三道闸门把关（`B` 的落后量、最小间隔、设备是否在场）：连接会掐掉广播，所以它的
 * 频率由「本来就必须连的事」决定，落后量只搭顺风车，不制造连接。
 */
import { ref } from "vue";
import { formatHistorySec, historyBaseline } from "../../bluetooth/history/baseline";
import { bluetoothUploader } from "../../bluetooth/upload";
import { logger } from "../../service/logger";
import type { Device } from "./index";

/** 被谁唤醒的。只影响日志，不影响行为。 */
export type TickReason = "startup" | "broadcast" | "keepalive" | "timer";

export class DeviceTick {
	/**
	 * `poke()` 的限流：两次 tick 至少隔这么久。也是定时兜底的间隔。
	 *
	 * **必须是类级 static，不能写成模块级 `const`**：UTS 把整个工程合成一个 Kotlin 文件，
	 * 模块级 `const` 会变成文件级字段，在 `IndexKt.<clinit>` 里赋值；而 `device` 单例声明
	 * 更早、构造时就会调 `start()` → `poke()`，于是读到还没赋值的字段（JVM 默认 `null`），
	 * 触发 `NumberKt.compareTo(other=null)` 的 NPE，并让整个 `IndexKt` 变成
	 * NoClassDefFoundError。类级 static 随类初始化，没有这个顺序问题。
	 */
	private static readonly TICK_MIN_INTERVAL_MS = 60 * 1000;
	/**
	 * 连接最小间隔，同时是「落后量要等多久才被补」的上界。
	 *
	 * 它顺带提供读取失败的天然退避：没记账的秒不落库，没有 `retry_at` / `attempts`，
	 * 失败后落后量原样留着，下一轮到间隔满了才会再试一次。
	 */
	private static readonly CONNECT_INTERVAL_MS = 10 * 60 * 1000;

	/**
	 * 连接触发门槛：`B` 落后 `stableCeiling` 不足这么多秒时一律不连。
	 *
	 * 这是「减少连接次数」的主要旋钮。广播健康时 `B` 由合格判定逐秒推进、落后只有几秒，
	 * 这里天然不成立；只有跨不过去的不合格段（设备关机、长时间丢包）才会把落后量攒上来。
	 * 卡住的那点秒不会丢：读取窗口 `[B, stableCeiling)` 一直包含它们。
	 */
	private static readonly CONNECT_MIN_BEHIND_SEC = 300;

	/**
	 * 设备在场静默期：这么久没收到过绑定广播就认为设备不在场，此时连接只会白等一次超时。
	 * 后台广播是常态可用的，所以「长时间收不到广播」是一个可信的不在场信号。
	 */
	private static readonly PRESENCE_SILENCE_MS = 5 * 60 * 1000;

	/**
	 * 整轮心跳抛出时留下的错误文本，测试页会显示它。单轮失败不改变行为（下一轮照跑），
	 * 但连续出现说明有真问题；没有这个字段，「心跳在跑但什么都没做」只能靠翻日志看出来。
	 */
	lastError = ref<string>("");
	/** 最近一次判定的时刻与结论，测试页据此重读基准面板。 */
	lastCheckAt = ref<number>(0);
	lastHistorySyncAt = ref<number>(0);

	private device: Device;
	/** 一轮 tick 的串行标志。`poke()` 被每帧广播调用，而一轮里有若干次 await，不设防会重入。 */
	private ticking: boolean = false;
	private lastTickAt: number = 0;
	private lastConnectCheckAt: number = 0;
	/** 「这一轮不连」的原因说明的限流状态，见 `logStall()`。 */
	private lastStallLogAt: number = 0;
	private lastStallLogKey: string = "";
	private timer: number | null = null;

	constructor(device: Device) {
		this.device = device;
	}

	/**
	 * 唤醒一次。广播每落库一帧、保活每次 tick 都调它。
	 *
	 * **限流在这里**，调用方不需要自己判断「该不该跑」——它只管说「有新数据了」。
	 * 前台靠广播帧驱动、后台靠保活和定时器，两条路走同一个节流。
	 */
	poke(reason: TickReason): void {
		const now = Date.now();
		if (now - this.lastTickAt < DeviceTick.TICK_MIN_INTERVAL_MS) return;
		this.runTick(reason);
	}

	/** 起定时兜底，并立刻跑一轮：首次 tick 就该把 App 关闭期间积压的时间判完。 */
	start(): void {
		if (this.device.boundDeviceId == "") return;
		this.poke("startup");
		if (this.timer != null) return;
		//@ts-ignore setInterval 在 UTS 不同平台返回类型不一，用 number 容器
		this.timer = setInterval(() => {
			this.poke("timer");
		}, DeviceTick.TICK_MIN_INTERVAL_MS);
		logger.info("bluetooth", "[BOOM-TICK] 已启动基准时间心跳");
	}

	stop(): void {
		const timer = this.timer;
		if (timer == null) return;
		clearInterval(timer);
		this.timer = null;
		logger.info("bluetooth", "[BOOM-TICK] 已停止基准时间心跳");
	}

	/** 连接任务结束后回填，供测试页判断「刚刚补过一轮」。 */
	markHistorySynced(): void {
		this.lastHistorySyncAt.value = Date.now();
	}

	/**
	 * 一轮心跳。异常在这里兜住：心跳是个长驻循环，一轮失败不能让它停摆。
	 */
	private async runTick(reason: TickReason): Promise<void> {
		if (this.ticking == true) return;
		this.ticking = true;
		this.lastTickAt = Date.now();
		try {
			const nowSec = Math.floor(Date.now() / 1000);
			// 一次 tick 只读一次 `B`：分类同时推进两个游标，开头这个值对后面的连接闸门也成立。
			const classified = await historyBaseline.classify(
				nowSec,
				await historyBaseline.getBaseline()
			);
			const baseline = classified.baselineAfter;
			this.lastCheckAt.value = Date.now();
			this.lastError.value = "";
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 刻度: now=${formatHistorySec(nowSec)}, stableCeiling=${formatHistorySec(historyBaseline.stableCeiling(nowSec))}, B=${formatHistorySec(baseline)}, reason=${reason}`
			);
			await bluetoothUploader.uploadData();
			await this.maybeConnect(nowSec, baseline);
		} catch (e) {
			this.lastError.value = `${e}`;
			logger.error("bluetooth", "[BOOM-TICK] 本轮心跳异常，下轮继续", `${e}`);
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * 按「落后量 + 最小间隔 + 设备在场」三道闸门决定要不要发起一次补录连接。
	 *
	 * 三道闸门各挡一类浪费：`B` 落后很少就没有必要连；读取失败后落后量仍然过线，最小间隔
	 * 就是它的退避；设备不在场时广播本来就没有，连接只会白等一次超时。
	 *
	 * **落后量不制造连接**：没有加急触发，最急也是等这个间隔。加急连接只有本来就「必须连」
	 * 的事——校时、事件读取、手动命令，它们各自入队、绕过这里。
	 *
	 * `baseline` 由 `runTick` 传入：那是本轮 `classify()` 判完后的当前 `B`，中间没有别的
	 * 写入者，这里再读一次库只会拿到同一个值。
	 */
	private async maybeConnect(nowSec: number, baseline: number): Promise<void> {
		const now = Date.now();
		const ceiling = historyBaseline.stableCeiling(nowSec);
		const behind = ceiling - baseline;
		if (behind < DeviceTick.CONNECT_MIN_BEHIND_SEC) {
			this.logStall(
				"behind",
				`[BOOM-BASE] 基准停驻: B=${baseline}, 落后=${behind}s, 未达连接门槛=${DeviceTick.CONNECT_MIN_BEHIND_SEC}s`
			);
			return;
		}
		if (this.lastConnectCheckAt > 0 && now - this.lastConnectCheckAt < DeviceTick.CONNECT_INTERVAL_MS)
			return;
		const broadcastAgeMs = this.device.broadcast.getBroadcastAgeMs();
		if (broadcastAgeMs >= DeviceTick.PRESENCE_SILENCE_MS) {
			this.logStall(
				"absent",
				`[BOOM-BASE] 基准停驻: B=${baseline}, 落后=${behind}s, 但已 ${Math.round(broadcastAgeMs / 1000)}s 未收到广播，判定设备不在场，跳过连接`
			);
			return;
		}
		// 先置时刻再入队：读取失败时落后量原样留着，下一轮到间隔满了才会再试一次。
		this.lastConnectCheckAt = now;
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 触发补录连接: B=${baseline}, stableCeiling=${ceiling}, 落后=${behind}s, 读取窗口=${baseline}~${ceiling}`
		);
		this.device.scheduler.enqueueHistoryRepair("timer");
		this.device.scheduler.requestFlush("timer");
	}

	/**
	 * 「这一轮不连」的原因说明：同一原因 10 分钟最多打一行。
	 *
	 * 心跳每 60 秒一轮，无条件打就是每天 1440 行，会把内存与 SQLite 的 1000 条缓冲占满，
	 * 真出问题时的前后文反而被冲掉。按 `key` 而不是整行文本判断，因为 `落后=${behind}s`
	 * 每轮都在变；原因本身变化时（门槛 → 不在场）立即打，不吃限流。
	 */
	private logStall(key: string, text: string): void {
		const now = Date.now();
		if (
			key == this.lastStallLogKey &&
			this.lastStallLogAt > 0 &&
			now - this.lastStallLogAt < DeviceTick.CONNECT_INTERVAL_MS
		)
			return;
		this.lastStallLogAt = now;
		this.lastStallLogKey = key;
		logger.info("bluetooth", text);
	}
}
