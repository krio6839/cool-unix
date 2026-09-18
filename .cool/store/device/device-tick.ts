/**
 * 心跳：全套后台节奏的**唯一决策点**。
 *
 * 三件事各归各的模块——广播负责采集（`broadcast.ts` 落库后只喊一声 `poke()`）、
 * 判断负责推进基准（`history/baseline.ts`）、补数据负责连接读取
 * （`history-repair.ts`）。**这个文件是它们之间唯一的时序约定**：谁都不认识别人的
 * 节奏，只知道自己被 tick 到了。
 *
 * 一次 tick 做三件事，顺序固定：
 *
 * 1. `classify()`        —— 把 `[B, stableCeiling)` 里新稳定的秒判成合格或缺口。
 * 2. `advanceBaseline()` —— 把合格的秒吸收进 `B`。
 * 3. `uploadData()`      —— 把待传的记录推上去。
 *
 * 判定与上传是**两件独立的事**：判定依据是本地的 `ppi_data`，不是上传结果。
 * 上传失败时 `uploaded` 保持 0，由下一轮 tick 继续消费，不会因为弱网把已经收齐
 * 的秒判成待补。
 *
 * 1 + 2 不能省：分类把新稳定的秒写进 `vital_ready_ranges`，`advanceBaseline()`
 * 再把这个区间消费掉、`B` 才真的前进。广播在线时这一步每轮都在追，`B` 因此贴着
 * `stableCeiling`，不累积。
 *
 * 连接（第 4 件事）按 `CONNECT_INTERVAL_MS` 单独节流：连接会掐掉广播，所以它的
 * 频率由「本来就必须连的事」决定，缺口只搭顺风车，不制造连接（方案 8.4）。
 */
import { ref } from "vue";
import { historyBaseline } from "../../bluetooth/history/baseline";
import { bluetoothUploader } from "../../bluetooth/upload";
import { logger } from "../../service/logger";
import type { Device } from "./index";

/** 被谁唤醒的。只影响日志，不影响行为。 */
export type TickReason = "startup" | "broadcast" | "keepalive" | "timer";

export class DeviceTick {
	/**
	 * `poke()` 的限流：两次 tick 至少隔这么久。也是定时兜底的间隔。
	 *
	 * **必须是类级 static，不能写成模块级 `const`**：UTS 把整个工程合成一个 Kotlin
	 * 文件，模块级 `const` 会变成文件级字段，按模块顺序在 `IndexKt.<clinit>` 里赋值。
	 * `device` 单例的声明位置比这些常量早，它的构造函数又会直接调 `start()` → `poke()`，
	 * 于是 `poke()` 在 `<clinit>` 没跑完时就读到这个还没赋值的字段（JVM 默认 `null`），
	 * 触发 `NumberKt.compareTo(other=null)` 的 NPE，并让整个 `IndexKt` 变成
	 * NoClassDefFoundError。类级 static 随类初始化，早于任何实例构造，没有这个顺序问题。
	 */
	private static readonly TICK_MIN_INTERVAL_MS = 60 * 1000;
	/**
	 * 连接最小间隔，同时是「缺口要等多久才被补」的上界（方案 9.6）。
	 *
	 * 它顺带提供了缺口读取失败的天然退避：缺口不落库，没有 `retry_at` / `attempts`，
	 * 失败后缺口原样留着，下一轮到这里才会再试一次。
	 */
	private static readonly CONNECT_INTERVAL_MS = 10 * 60 * 1000;

	/**
	 * 整轮心跳抛出时留下的错误文本。这是除日志外**唯一**的落点，测试页会显示它。
	 *
	 * 单轮失败不改变行为（下一轮照跑），但连续出现说明有真问题；没有这个字段，
	 * 「心跳在跑但什么都没做」就只能靠翻日志才能看出来。
	 */
	lastError = ref<string>("");
	/** 最近一次判定的时刻与结论，测试页据此重读基准面板。 */
	lastCheckAt = ref<number>(0);
	lastHistorySyncAt = ref<number>(0);

	private device: Device;
	/**
	 * 一轮 tick 的串行标志。
	 *
	 * `poke()` 会被每一帧广播调用，而一轮 tick 里有若干次 await（数据库查询、
	 * 网络请求），不设防就会重入并交错。进入时置真、`finally` 置假。
	 */
	private ticking: boolean = false;
	private lastTickAt: number = 0;
	private lastConnectCheckAt: number = 0;
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
			// 一次 tick 只读一次 `B`：分类不改 `B`（只写 `vital_ready_ranges`），
			// 所以开头这个值对紧随其后的推进与列缺口都成立，作为参数一路传下去。
			// 推进在最后会回读一次确认落库结果，那是唯一必须重读的地方。
			const startBaseline = await historyBaseline.getBaseline();
			await historyBaseline.classify(nowSec, startBaseline);
			const baseline = await historyBaseline.advanceBaseline(nowSec, startBaseline);
			this.lastCheckAt.value = Date.now();
			this.lastError.value = "";
			logger.info(
				"bluetooth",
				`[BOOM-BASE] 刻度: now=${nowSec}, stableCeiling=${historyBaseline.stableCeiling(nowSec)}, B=${baseline}, reason=${reason}`
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
	 * 按最小间隔检查一次缺口，有就入队连接。
	 *
	 * **缺口不制造连接**：没有加急触发，它只等这个间隔（方案 8.4）。加急连接只有
	 * 本来就「必须连」的事——校时、事件读取、手动命令，它们各自入队、绕过这个间隔。
	 *
	 * `baseline` 由 `runTick` 传入：那是 `advanceBaseline()` 刚算出的当前 `B`，
	 * 这里再读一次库只会拿到同一个值（中间没有别的写入者）。
	 */
	private async maybeConnect(nowSec: number, baseline: number): Promise<void> {
		const now = Date.now();
		if (this.lastConnectCheckAt > 0 && now - this.lastConnectCheckAt < DeviceTick.CONNECT_INTERVAL_MS)
			return;
		// 先置时刻再判缺口：读取失败时缺口原样留着，下一轮到这里才会再试一次，
		// 这个间隔本身就是它的退避（方案 8.3）。
		this.lastConnectCheckAt = now;
		const gaps = await historyBaseline.listRepairGaps(nowSec, baseline);
		if (gaps.length == 0) {
			logger.info("bluetooth", `[BOOM-BASE] 基准停驻: B=${baseline}, 缺口组=0, 缺口秒=0`);
			return;
		}
		logger.info(
			"bluetooth",
			`[BOOM-BASE] 基准停驻: B=${baseline}, 阻塞起点=${gaps[0].fromSec}, 缺口组=${gaps.length}, 缺口秒=${historyBaseline.sumRepairSeconds(gaps)}`
		);
		this.device.scheduler.enqueueHistoryRepair("timer");
		this.device.scheduler.requestFlush("timer");
	}
}
