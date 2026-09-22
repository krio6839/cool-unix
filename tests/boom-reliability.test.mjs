import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRuntime } from "./helpers/boom-runtime.mjs";

const rows = (db, sql) =>
	db
		.prepare(sql)
		.all()
		.map((row) => ({ ...row }));
const page = (startSec, n = 2, count = n * 60) => ({
	startSec,
	direction: 0,
	n,
	rmssdSdnn: Array.from({ length: n }, () => ({ rmssd: -1, sdnn: -1 })),
	vitalData: Array.from({ length: count }, () => ({ hr: 60, ppi: 1000, valid: true }))
});
/** 4 字节小端 hex：协议里所有多字节整数都是 LE。 */
const le = (value, bytes) => {
	let hex = "";
	for (let i = 0; i < bytes; i++)
		hex += ((value >> (8 * i)) & 0xff).toString(16).padStart(2, "0");
	return hex;
};
/**
 * 按 2.1.4 拼一条 Log_Data_t。
 * 头部 4B(flag,flag2,crc8,payload_len) + sn(2) + global_sn(4) + ts(4) + tick(4)
 * + eventType(1) + dataLen(1) + eventData = 40B 固定段 + eventData。
 */
const logDataItem = (eventType, eventDataHex, { ts = 1700000000, globalSn = 0 } = {}) =>
	"a5" +
	"00" +
	"00" +
	"00" +
	le(1, 2) +
	le(globalSn, 4) +
	le(ts, 4) +
	le(0, 4) +
	eventType.toString(16).padStart(2, "0") +
	(eventDataHex.length / 2).toString(16).padStart(2, "0") +
	eventDataHex;
/** 2.1.4.2.6 LogEvent_SleepResult：六个字段全 LE，22 字节。 */
const sleepResultEvent = (options = {}) =>
	logDataItem(
		8,
		le(options.sleepOnsetTime ?? 7 * 3600, 4) +
			le(options.awakeTime ?? 1800, 4) +
			le(options.lightSleepPeriod ?? 4 * 3600, 4) +
			le(options.deepSleepPeriod ?? 2 * 3600, 4) +
			le(options.otherSleepPeriod ?? 1800, 4) +
			le(options.heartRateRest ?? 55, 2),
		options
	);
/** 0x3C 事件头：17 字节（type 1 + 四个 u32）。 */
const eventHeader = (earliestSn, latestSn) =>
	le(0, 1) + le(earliestSn, 4) + le(1700000000, 4) + le(latestSn, 4) + le(1700000000, 4);
/**
 * 0x3D 的 V 字段：首字节固定为 0，其后才是 Log_Data_t 串联
 * （状态说明.txt 表格「0x3D Byte 0: 0」）。读取端就是按 1 字节偏移解析的。
 */
const eventBatch = (...items) => "00" + items.join("");

test("vital reads do not spread callback options through Android JSON serialization", async () => {
	const source = await readFile(".cool/store/device/history-reader.ts", "utf8");
	const method = source.slice(
		source.indexOf("async readVitalDataAuto("),
		source.indexOf("async readVitalGapGroup(")
	);
	assert.equal(method.includes("...options"), false);
});

test("vital result UI calls a device short page a protocol-allowed response", async () => {
	const source = await readFile("pages/device/test.uvue", "utf8");
	assert.equal(source.includes("本段数据长度不足"), false);
	assert.equal(source.includes("设备返回短页（协议允许）"), true);
});

test("cold start retains history progress so unavailable gaps are not reread forever", async () => {
	const source = await readFile(".cool/bluetooth/data-manager.ts", "utf8");
	const initDatabase = source.slice(
		source.indexOf("private async initDatabase()"),
		source.indexOf("private async ensureDatabaseReady()")
	);
	assert.equal(initDatabase.includes("clearHistorySessionRaw"), false);
});

test("quick vital history offers export after retaining all parsed pages", async () => {
	const source = await readFile("pages/device/test.uvue", "utf8");
	assert.equal(source.includes("exportVitalHistoryCsv"), true);
	assert.equal(source.includes("buildVitalHistoryCsv"), true);
	assert.equal(source.includes("saveCsvToDownloads"), true);
	assert.equal(source.includes("保存到下载"), true);
	assert.equal(source.includes("Download/BOOM"), true);
	assert.equal(source.includes("停止当前读取"), true);
	assert.equal(
		source.includes("shouldStop: () => vitalAutoReading.value == false || reachedTarget"),
		true
	);
});

test("Android CSV export writes into the public Download/BOOM directory", async () => {
	const source = await readFile(
		"uni_modules/boom-csv-saver/utssdk/app-android/index.uts",
		"utf8"
	);
	assert.equal(source.includes("MediaStore.Downloads.EXTERNAL_CONTENT_URI"), true);
	assert.equal(source.includes('Environment.DIRECTORY_DOWNLOADS + "/BOOM"'), true);
});

test("history-gap repair has one independent popup entry", async () => {
	const popup = await readFile("pages/device/components/DataDiagnosticsPopup.uvue", "utf8");
	const page = await readFile("pages/device/test.uvue", "utf8");
	assert.equal(popup.includes("loadHistoryGaps"), false);
	assert.equal(popup.includes("repair-history-gap"), false);
	assert.equal(popup.includes("补此缺口"), false);
	assert.equal(page.includes("repairHistoryGap"), true);
	assert.equal(page.includes("@repair-history-gap"), true);
	assert.equal(page.includes("HistoryGapRepairPopup"), true);
	const gapPopup = await readFile("pages/device/components/HistoryGapRepairPopup.uvue", "utf8");
	assert.equal(gapPopup.includes("连续读取窗口"), true);
	assert.equal(gapPopup.includes("实际待补"), true);
	assert.equal(gapPopup.includes("窗口内非待补"), true);
	// 缺口是推算出来的，没有游标、重试时间这些任务态字段。
	assert.equal(gapPopup.includes("当前游标"), false);
	assert.equal(gapPopup.includes("下次重试"), false);
	assert.equal(gapPopup.includes("watch(revision"), true);
	assert.equal(gapPopup.includes("scheduleVisibleRefresh"), false);
});

test("test page exposes six independent full-height popup entry points", async () => {
	const source = await readFile("pages/device/test.uvue", "utf8");
	for (const name of [
		"HistoryQuickReadPopup",
		"HistoryGapRepairPopup",
		"VitalProtocolPopup",
		"EventProtocolPopup",
		"DeviceControlPopup",
		"DataDiagnosticsPopup"
	]) {
		assert.equal(source.includes(`<${name}`), true, `${name} is mounted`);
	}
	assert.equal(source.includes("历史读取与协议调试"), false);
	assert.equal(source.includes("<DatabaseTestPopup"), false);
	for (const key of ["quick", "gap", "vital", "event", "control", "diagnostics"]) {
		assert.equal(source.includes(`key: "${key}"`), true, `entry: ${key}`);
	}
	assert.equal(source.includes('v-for="entry in testEntries"'), true);
	assert.equal(source.includes('@tap="openTestEntry(entry.key)"'), true);
	for (const binding of [
		'@read-range="testVitalHistoryRange"',
		'@stop="stopVitalAutoRead"',
		'@export="exportVitalHistoryCsv"',
		'@repair-history-gap="repairHistoryGap"',
		'@submit="submitVitalFromPopup"',
		'@submit="submitEventFromPopup"',
		'@command="runDeviceCommand"',
		'@submit-form="submitDeviceForm"'
	]) {
		assert.equal(source.includes(binding), true, binding);
	}
	assert.equal(source.includes("DataDiagnosticsPopup"), true);
});

test("six popup components keep their responsibilities and bottom full-height presentation", async () => {
	const expectations = {
		HistoryQuickReadPopup: ["read-range", "stop", "export"],
		HistoryGapRepairPopup: ["repairGroup", "historyBaseline.snapshot", "scheduleOpenRefresh"],
		VitalProtocolPopup: ["0x3A", "0x3B", "cl-select-date", "协议秒"],
		EventProtocolPopup: ["0x3C", "0x3D", "cl-select-date", "协议秒"],
		DeviceControlPopup: ["disconnect", "restore", "clear-error"],
		DataDiagnosticsPopup: ["upload", "协议日志", "诊断日志"]
	};
	for (const [name, markers] of Object.entries(expectations)) {
		const source = await readFile(`pages/device/components/${name}.uvue`, "utf8");
		assert.match(source, /direction=\"bottom\"/);
		assert.match(source, /:size=\"/);
		for (const marker of markers)
			assert.equal(source.includes(marker), true, `${name}: ${marker}`);
	}
});

test("automatic history repair plans from the baseline cursor, not a task queue", async () => {
	// 节奏只有一个决策点：心跳。规划的三步（分类 / 推进 / 列缺口）都在这里，
	// 补数据的读取在 history-repair.ts，两者都不再属于一个「sync」模块。
	const tick = await readFile(".cool/store/device/device-tick.ts", "utf8");
	const repair = await readFile(".cool/store/device/history-repair.ts", "utf8");
	assert.equal(tick.includes("historyBaseline.classify("), true);
	assert.equal(tick.includes("historyBaseline.advanceBaseline("), true);
	assert.equal(tick.includes("historyBaseline.listRepairGaps("), true);
	assert.equal(repair.includes("readVitalGapGroup(gap)"), true);
	assert.equal(tick.includes("lastCheckAt.value = Date.now()"), true);
	// 老的任务表规划路径不应再出现。
	assert.equal(repair.includes("historyProgress"), false);
	assert.equal(repair.includes("groupHistoryTasksForRead"), false);
	assert.equal(repair.includes("readVitalTaskGroup"), false);
	// 旧的 sync 模块整体删除，不留兼容层。
	await assert.rejects(readFile(".cool/store/device/sync.ts", "utf8"));
});

test("one tick does classification, baseline advance, and upload in a fixed order", async (t) => {
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	const order = [];
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${now - 300})`);
	// 本地 PPI 覆盖 [B, ceiling)：判定会把它整段记进 ready，`B` 因此推到右端。
	const values = [];
	for (let second = now - 300; second < now - 10; second++)
		values.push(`('${second}',${second},0,0,0,0)`);
	r.db.exec(`INSERT INTO ppi_data VALUES ${values.join(",")}`);

	const tick = new r.DeviceTick({ boundDeviceId: "device" });
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	tick.device.scheduler = {
		enqueueHistoryRepair() {
			order.push("connect");
		},
		requestFlush() {}
	};
	// 记录三步的先后：判定 → 推进 → 上传。
	const realClassify = baseline.classify.bind(baseline);
	const realAdvance = baseline.advanceBaseline.bind(baseline);
	baseline.classify = async (nowSec) => {
		order.push("classify");
		return realClassify(nowSec);
	};
	baseline.advanceBaseline = async (nowSec) => {
		order.push("advance");
		return realAdvance(nowSec);
	};
	const realUpload = r.uploader.uploadPpiData.bind(r.uploader);
	r.uploader.uploadPpiData = async () => {
		order.push("upload");
		return realUpload();
	};

	await tick.runTick("timer");

	// 判定先于上传：上传依据是本地的 ppi_data，判定不被上传结果影响。
	assert.deepEqual(order, ["classify", "advance", "upload"]);
	assert.equal(tick.lastError.value, "");
	assert.equal(tick.lastCheckAt.value > 0, true);
	// 判定确实发生了：合格的秒被吸收进 `B`，追到 `stableCeiling`。
	assert.equal(await baseline.getBaseline(), now - 10);
	// 没有缺口就不入队连接——缺口只搭顺风车，不制造连接。
	assert.equal(order.includes("connect"), false);
});

test("one tick reads the baseline once and never re-scans ready ranges in a loop", async (t) => {
	// 一次 tick 里 `B` 是一个值：分类只写 `vital_ready_ranges` 不改 `B`，所以推进和
	// 列缺口都该复用 tick 开头读到的那一份。重读不但浪费，断网时每次重读都是一个
	// 新的异常点（`getBaseline()` 读失败会抛）。
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${now - 3000})`);
	// 40 条首尾相接的已记账区间：消费循环要把它们整段吃掉，正是「循环里重查全表」
	// 最坏的情形（改回旧写法这里会是 40 次读）。
	for (let i = 0; i < 40; i++) {
		const from = now - 3000 + i * 60;
		r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${from},${from + 60})`);
	}
	const counts = { getBaseline: 0, listReadyRanges: 0 };
	for (const name of Object.keys(counts)) {
		const original = baseline[name].bind(baseline);
		baseline[name] = async (...args) => {
			counts[name] += 1;
			return original(...args);
		};
	}
	const tick = new r.DeviceTick({
		boundDeviceId: "device",
		scheduler: { enqueueHistoryRepair() {}, requestFlush() {} }
	});
	await tick.runTick("timer");
	assert.equal(tick.lastError.value, "");
	assert.equal(counts.getBaseline, 1);
	// 分类前、推进前、列缺口前各一次，每次前面都有一次写入——不能跨写复用。
	assert.equal(counts.listReadyRanges, 3);
	// 消费循环真的跑完了：`B` 追到区间右端，40 条区间被清空。
	assert.equal(await baseline.getBaseline(), now - 3000 + 40 * 60);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_ready_ranges").get().n, 0);
});

test("poke is rate-limited to one tick per minute and never re-enters", async (t) => {
	const r = await createRuntime(t);
	// 用真实的 `runTick`：限流与重入守卫都在它内部，绕开它测的就不是被测对象了。
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	let classifyRuns = 0;
	let concurrent = 0;
	let maxConcurrent = 0;
	const realClassify = baseline.classify.bind(baseline);
	baseline.classify = async (nowSec) => {
		classifyRuns++;
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await new Promise(setImmediate);
		concurrent--;
		return realClassify(nowSec);
	};
	const tick = new r.DeviceTick({ boundDeviceId: "device" });
	// 一轮 tick 必然以 classify 开头，所以它的调用次数就是 tick 的轮数。
	tick.poke("broadcast");
	tick.poke("broadcast");
	tick.poke("timer");
	await new Promise(setImmediate);
	await new Promise(setImmediate);
	assert.equal(classifyRuns, 1);
	// 一轮还没结束时重入直接返回，两轮不会交错。
	assert.equal(maxConcurrent, 1);
	// 节流窗口过去后才再跑一轮。
	tick.lastTickAt = Date.now() - 61000;
	tick.poke("timer");
	await new Promise(setImmediate);
	await new Promise(setImmediate);
	assert.equal(classifyRuns, 2);
});

test("broadcast only stores frames and pokes the tick, with no minute concept left", async () => {
	const broadcast = await readFile(".cool/store/device/broadcast.ts", "utf8");
	assert.equal(broadcast.includes("tick.poke("), true);
	// 采集层不认识「整分钟」：旧的主触发在广播里叫 uploadCompletedMinuteIfCrossed。
	assert.equal(broadcast.includes("uploadCompletedMinuteIfCrossed"), false);
	assert.equal(broadcast.includes("onMinuteCompleted"), false);
	assert.equal(/Minute(Sec|Boundary)/.test(broadcast), false);
});

test("a connection has no duration budget and does nothing special about its own hole", async () => {
	const scheduler = await readFile(".cool/store/device/gatt-scheduler.ts", "utf8");
	const tick = await readFile(".cool/store/device/device-tick.ts", "utf8");
	const repair = await readFile(".cool/store/device/history-repair.ts", "utf8");
	const connection = await readFile(".cool/store/device/connection.ts", "utf8");
	// 连接不设时长上限：单次预算存在时，它留下的空洞会被反复转交给下一次连接。
	assert.equal(scheduler.includes("GATT_FLUSH_BUDGET_MS"), false);
	assert.equal(tick.includes("HISTORY_AUTO_BACKLOG_INTERVAL_MS"), false);
	// 连接留下的缺秒就是普通缺口，由下一次连接顺带补掉（方案 9.2/9.3）。
	// 所以没有任何「识别连接空洞」的机制：不记录起点、不读尾巴、不判定接续。
	assert.equal(connection.includes("ConnectionHole"), false);
	assert.equal(scheduler.includes("readConnectionTailHoleBeforeDisconnect"), false);
	assert.equal(scheduler.includes("readVitalTailHole"), false);
	assert.equal(repair.includes("markBroadcastResume"), false);
	assert.equal(repair.includes("onBoundBroadcastFrame"), false);
});

test("history-gap popup still maps a no-data gap result to readable text", async () => {
	const reader = await readFile(".cool/store/device/history-reader.ts", "utf8");
	const page = await readFile("pages/device/test.uvue", "utf8");
	// 设备返回段早于目标窗口按“没有数据”收尾，不再是一种失败文案。
	assert.equal(reader.includes("device history page earlier than target"), false);
	assert.equal(page.includes("设备返回页面早于目标范围"), false);
	assert.equal(page.includes("补录完成：设备未返回有效生命体征"), true);
	assert.equal(page.includes("historyGapResultText"), true);
	assert.equal(page.includes('return result.saveOk && result.status == "DONE"'), true);
});
test("a manual gap repair refreshes the listed batch instead of leaving a stale card", async () => {
	const page = await readFile("pages/device/test.uvue", "utf8");
	// 手动补录绕过 sync，不会更新 lastHistorySyncAt，必须自己抬一次版本。
	assert.equal(page.includes("manualHistoryRevision.value = Date.now()"), true);
	assert.equal(page.includes("manualAt > latest ? manualAt : latest"), true);
});

test("a gap with no device data does not abort the remaining gaps in one connection", async (t) => {
	const r = await createRuntime(t);
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	// 补数据只依赖一个「能按缺口读一段」的 reader，因此可以配假 reader 独立跑，
	// 不需要构造整个设备栈（history-repair.ts 不 import Device）。
	const attempted = [];
	const noData = {
		status: "DONE",
		message: "target gap complete",
		pages: 1,
		savedRecords: 0,
		saveOk: true
	};
	const linkFailure = {
		status: "SEND_FAILED",
		message: "0x3B send failed",
		pages: 0,
		savedRecords: 0,
		saveOk: true
	};
	let script = {};
	const reader = {
		async readVitalGapGroup(gap) {
			attempted.push(gap.fromSec);
			const result = script[gap.fromSec];
			if (result.status == "DONE")
				await baseline.markReady(gap.fromSec, gap.toSec, Math.floor(Date.now() / 1000));
			return result;
		}
	};
	const now = Math.floor(Date.now() / 1000);
	// 两段缺口，中间隔着一段本地已有的秒。间隔要大于 bridgeSec（120 秒），
	// 否则 bridgeGaps 会把它们合成一条读取链路，测不到「一组失败不影响下一组」。
	const first = now - 900;
	const second = now - 500;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${first})`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	script = { [first]: noData, [second]: noData };
	// 前一个缺口“设备没数据”不是失败：同一次连接里后面的缺口仍然要读。
	await r.historyRepair.repairAllGaps(reader);
	assert.deepEqual(attempted, [first, second]);
	// 真正的链路失败仍然中止本轮，避免在坏连接上反复超时。
	attempted.length = 0;
	r.db.exec("DELETE FROM vital_ready_ranges");
	r.db.exec(`UPDATE vital_sync_state SET baseline_sec=${first} WHERE id=1`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	script = { [first]: linkFailure, [second]: linkFailure };
	await r.historyRepair.repairAllGaps(reader);
	assert.deepEqual(attempted, [first]);
});

test("a stopped gap is not reported as success and does not continue on the same connection", async (t) => {
	const r = await createRuntime(t);
	const attempted = [];
	const now = Math.floor(Date.now() / 1000);
	const first = now - 900;
	const second = now - 500;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${first})`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	const reader = {
		async readVitalGapGroup(gap) {
			attempted.push(gap.fromSec);
			return {
				status: "STOPPED",
				message: "gatt busy",
				pages: 0,
				savedRecords: 0,
				saveOk: true
			};
		}
	};

	await r.historyRepair.repairAllGaps(reader);
	assert.deepEqual(attempted, [first]);
	const summary = r.logs
		.map((entry) => entry.items.join(" "))
		.find((line) => line.includes("[BOOM-HISTORY] 补录结束"));
	assert.match(summary, /失败组=1/);
	assert.match(summary, /ok=false/);
});

test("DONE without accounting the whole gap is not success and does not continue", async (t) => {
	const r = await createRuntime(t);
	const attempted = [];
	const now = Math.floor(Date.now() / 1000);
	const first = now - 900;
	const second = now - 500;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${first})`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	const reader = {
		async readVitalGapGroup(gap) {
			attempted.push(gap.fromSec);
			// 模拟固件提前给出 DONE，但没有把当前窗口完整记账。
			return {
				status: "DONE",
				message: "gap read made no progress",
				pages: 1,
				savedRecords: 0,
				saveOk: true
			};
		}
	};

	await r.historyRepair.repairAllGaps(reader);
	assert.deepEqual(attempted, [first]);
	const summary = r.logs
		.map((entry) => entry.items.join(" "))
		.find((line) => line.includes("[BOOM-HISTORY] 补录结束"));
	assert.match(summary, /失败组=1/);
	assert.match(summary, /ok=false/);
});

test("a failed repair cannot look like baseline progress just because the retention window moved", async (t) => {
	const r = await createRuntime(t);
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	const now = Math.floor(Date.now() / 1000);
	const start = now - 30 * 24 * 60 * 60;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${start})`);
	const reader = {
		async readVitalGapGroup() {
			r.dateOffsetMs += 8000;
			return {
				status: "TIMEOUT",
				message: "wait vital response timeout",
				pages: 0,
				savedRecords: 0,
				saveOk: true
			};
		}
	};

	await r.historyRepair.repairAllGaps(reader);
	assert.equal(await baseline.getBaseline(), start);
	const group = r.logs
		.map((entry) => entry.items.join(" "))
		.find((line) => line.includes("[BOOM-HISTORY] 缺口组结束"));
	assert.match(group, /本组推进=0s/);
});

test("data diagnostics popup shows logs and defers full export to auto-archived files", async () => {
	const source = await readFile("pages/device/components/DataDiagnosticsPopup.uvue", "utf8");
	// 面板只渲染最近 200 条；全量日志靠自动落盘，不在弹窗里复制/导出。
	assert.equal(source.includes("getLogsAsync(200)"), true);
	assert.equal(source.includes("loadDiagnosticLogs"), true);
	assert.equal(source.includes("刷新诊断日志"), true);
	// 手动复制/导出已移除：它们只覆盖面板这一段，而落盘文件没有 1000 条上限。
	assert.equal(source.includes("uni.setClipboardData"), false);
	assert.equal(source.includes("saveCsvToDownloads"), false);
	assert.equal(source.includes("复制当前日志"), false);
	assert.equal(source.includes("导出当前日志"), false);
});

test("data diagnostics log card uses high-contrast colors", async () => {
	const source = await readFile("pages/device/components/DataDiagnosticsPopup.uvue", "utf8");
	assert.equal(source.includes("#111827"), true);
	assert.equal(source.includes("#f8fafc"), true);
	assert.equal(source.includes("#94a3b8"), true);
});

test("protocol popups select human-readable time and submit Unix seconds", async () => {
	for (const name of ["VitalProtocolPopup", "EventProtocolPopup"]) {
		const source = await readFile(`pages/device/components/${name}.uvue`, "utf8");
		assert.equal(source.includes('type="second"'), true, `${name}: second picker`);
		assert.equal(source.includes("toUnixSec"), true, `${name}: Unix-second conversion`);
		assert.equal(source.includes("时间戳')"), false, `${name}: no manual timestamp input`);
	}
});

test("event popup crosses the native component boundary with scalar display props", async () => {
	const page = await readFile("pages/device/test.uvue", "utf8");
	const popup = await readFile("pages/device/components/EventProtocolPopup.uvue", "utf8");
	assert.equal(page.includes(':event-text="eventText"'), false);
	assert.equal(page.includes(':event-header="eventHeaderText"'), true);
	assert.equal(page.includes(':event-count="eventCountText"'), true);
	assert.equal(page.includes(':event-items="eventItemsText"'), true);
	assert.equal(popup.includes("props.eventText"), false);
	assert.equal(popup.includes("props.eventHeader"), true);
});

test("protocol popups declare typed emit payloads so the page receives typed objects", async () => {
	// 对象字面量直传 emit 会被编组成 UTSJSONObject，父页面强类型入参收下它就会抛
	// IllegalArgumentException；载荷必须先在弹窗侧声明类型再 emit。
	const popups = {
		VitalProtocolPopup: ["VitalPopupPayload", "submitVitalFromPopup", "VitalPopupPayload"],
		EventProtocolPopup: ["EventPopupPayload", "submitEventFromPopup", "EventPopupPayload"],
		DeviceControlPopup: ["DevicePopupPayload", "submitDeviceForm", "DevicePopupPayload"]
	};
	for (const [name, [payloadType, handler]] of Object.entries(popups)) {
		const source = await readFile(`pages/device/components/${name}.uvue`, "utf8");
		assert.equal(source.includes(`const emit = defineEmits<{`), true, `${name}: typed emits`);
		assert.equal(source.includes(`payload: ${payloadType}`), true, `${name}: typed payload`);
		assert.equal(
			source.includes(`const payload: ${payloadType} = {`),
			true,
			`${name}: typed local`
		);
		assert.match(source, /emit\("[a-z-]+", payload\)/, `${name}: emits the typed local`);
		// 对象字面量不得再直接进 emit。
		assert.equal(/emit\("[a-z-]+",\s*\{/.test(source), false, `${name}: no inline object emit`);
		const page = await readFile("pages/device/test.uvue", "utf8");
		assert.equal(page.includes(handler), true, `${name}: ${handler} still wired`);
	}
});

test("a grouped history-gap repair uses one continuous 0x3A/0x3B reader", async () => {
	const page = await readFile("pages/device/test.uvue", "utf8");
	const reader = await readFile(".cool/store/device/history-reader.ts", "utf8");
	assert.equal(page.includes("readVitalGapGroup(gap)"), true);
	assert.equal(reader.includes("readVitalGapGroup"), true);
	// 一组缺口只建立一次 0x3A 上下文，之后连续 0x3B。
	assert.equal(reader.includes("private async readVitalRange("), true);
});

test("a valid all-zero broadcast second enters the PPI upload queue", async (t) => {
	const r = await createRuntime(t);
	assert.equal(await r.manager.storeBroadcastPpiData(12345, 0, 0, 0), true);
	assert.deepEqual(rows(r.db, "SELECT timestamp,hr,spo2,ppi,uploaded FROM ppi_data"), [
		{ timestamp: 12345, hr: 0, spo2: 0, ppi: 0, uploaded: 0 }
	]);
});
test("broadcast persistence keeps raw values even when display validity is false", async () => {
	const source = await readFile(".cool/store/device/broadcast.ts", "utf8");
	const method = source.slice(
		source.indexOf("private async storeBroadcastPpiData"),
		source.indexOf("private getBroadcastTimestamp")
	);
	assert.equal(method.includes("const hr = r.hr;"), true);
	assert.equal(method.includes("const spo2 = Math.round(r.spo2Pct * 10);"), true);
	assert.equal(method.includes("const ppi = r.ppi;"), true);
	assert.equal(method.includes("r.hrValid ?"), false);
	assert.equal(method.includes("r.spo2Valid ?"), false);
	assert.equal(method.includes("r.ppiValid ?"), false);
});
test("PPI retention deletes only uploaded rows outside the thirty-day window", async (t) => {
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO ppi_data VALUES ('old-uploaded',99,0,0,0,1)");
	r.db.exec("INSERT INTO ppi_data VALUES ('old-pending',99,0,0,0,0)");
	r.db.exec("INSERT INTO ppi_data VALUES ('current',100,0,0,0,1)");
	assert.equal(await r.manager.pruneUploadedPpiBefore(100), 1);
	assert.deepEqual(rows(r.db, "SELECT id FROM ppi_data ORDER BY id"), [
		{ id: "current" },
		{ id: "old-pending" }
	]);
});
test("automatic repair continues after one planning/database failure", async (t) => {
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${now - 600})`);
	const tick = new r.DeviceTick({ boundDeviceId: "device" });
	const enqueued = [];
	tick.device.scheduler = {
		enqueueHistoryRepair(reason) {
			enqueued.push(reason);
		},
		requestFlush() {}
	};
	// 第一轮数据库读失败：整轮抛出并记进 lastError，而不是被当成「没有缺口」。
	r.queryFailure = true;
	await tick.runTick("timer");
	assert.equal(tick.lastError.value == "", false);
	assert.deepEqual(enqueued, []);
	tick.lastTickAt = 0;
	// 下一轮恢复：同一份缺口要重新被规划出来并入队，失败不能把它吞掉。
	r.queryFailure = false;
	await tick.runTick("timer");
	assert.equal(tick.lastError.value, "");
	assert.deepEqual(enqueued, ["timer"]);
});

for (const response of [null, "ok", {}, { status: "error" }, { code: 0, status: "error" }]) {
	test(`upload keeps pending rows for ambiguous/failed HTTP 200: ${JSON.stringify(response)}`, async (t) => {
		const r = await createRuntime(t);
		r.seed(2);
		r.response = response;
		assert.equal(await r.uploader.uploadPpiData(), false);
		assert.equal(
			r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n,
			2
		);
	});
}

test("both existing success envelopes acknowledge uploads", async (t) => {
	const r = await createRuntime(t);
	r.seed(2);
	r.response = { code: 0, data: null };
	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 1").get().n, 2);
});

test("logs, history diagnostics and uploads default to the same Beijing time", async (t) => {
	// 2024-01-01 00:00:00Z，默认模式必须稳定解释成北京时间，不能受手机时区影响。
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO ppi_data VALUES ('1704067200',1704067200,60,0,1000,0)");
	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.posts[0].data.datas[0].time, "2024-01-01 08:00:00");
	assert.equal(r.posts[0].data.timezone, "08:00");

	r.diagnostics.record("info", "timezone", "default-zone");
	const log = r.diagnostics.getLogs().at(-1);
	assert.match(log, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00\]/);
	r.diagnostics.flushArchiveNow();
	assert.equal(r.archived.at(-1).folderDay, log.slice(1, 11).replaceAll("-", ""));

	const { formatHistorySec } = await r.load(".cool/bluetooth/history/baseline.ts");
	assert.equal(formatHistorySec(1704067200), "1704067200(2024-01-01 08:00:00.000+08:00)");
});

test("the local timezone config can make logs and uploads follow the phone timezone", async (t) => {
	const originalTimezone = process.env.TZ;
	process.env.TZ = "America/New_York";
	t.after(() => {
		process.env.TZ = originalTimezone;
	});

	const r = await createRuntime(t);
	const timezone = await r.load(".cool/utils/timezone.ts");
	timezone.setAppTimezoneMode("system");
	r.db.exec("INSERT INTO ppi_data VALUES ('1704067200',1704067200,60,0,1000,0)");
	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.posts[0].data.datas[0].time, "2023-12-31 19:00:00");
	assert.equal(r.posts[0].data.timezone, "-05:00");

	const { formatHistorySec } = await r.load(".cool/bluetooth/history/baseline.ts");
	assert.equal(formatHistorySec(1704067200), "1704067200(2023-12-31 19:00:00.000-05:00)");
	r.diagnostics.record("info", "timezone", "system-zone");
	assert.match(
		r.diagnostics.getLogs().at(-1),
		/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-\d{2}:\d{2}\]/
	);
});

test("system-timezone PPI uploads split a sparse batch at a DST offset change", async (t) => {
	const originalTimezone = process.env.TZ;
	process.env.TZ = "America/New_York";
	t.after(() => {
		process.env.TZ = originalTimezone;
	});
	const r = await createRuntime(t);
	const timezone = await r.load(".cool/utils/timezone.ts");
	timezone.setAppTimezoneMode("system");
	r.db.exec("INSERT INTO ppi_data VALUES ('winter',1704067200,60,0,1000,0)");
	r.db.exec("INSERT INTO ppi_data VALUES ('summer',1719792000,61,0,1001,0)");

	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.posts.length, 2);
	assert.deepEqual(
		r.posts.map((post) => ({
			timezone: post.data.timezone,
			times: post.data.datas.map((x) => x.time)
		})),
		[
			{ timezone: "-05:00", times: ["2023-12-31 19:00:00"] },
			{ timezone: "-04:00", times: ["2024-06-30 20:00:00"] }
		]
	);
});

test("a buffered diagnostic file stays in the timezone used by its first log", async (t) => {
	const originalTimezone = process.env.TZ;
	process.env.TZ = "America/New_York";
	t.after(() => {
		process.env.TZ = originalTimezone;
	});
	const r = await createRuntime(t);
	const timezone = await r.load(".cool/utils/timezone.ts");
	timezone.setAppTimezoneMode("beijing");
	r.diagnostics.record("info", "timezone", "before-switch");
	const log = r.diagnostics.getLogs().at(-1);
	const day = log.slice(1, 11).replaceAll("-", "");
	const clock = log.slice(12, 20).replaceAll(":", "");
	timezone.setAppTimezoneMode("system");
	r.diagnostics.record("info", "timezone", "after-switch");
	r.diagnostics.flushArchiveNow();
	assert.equal(r.archived.length, 2);
	assert.equal(r.archived[0].folderDay, day);
	assert.match(r.archived[0].fileName, new RegExp(`^diagnostic-${clock}-\\d+\\.txt$`));
	assert.match(r.archived[0].content, /before-switch/);
	assert.equal(r.archived[0].content.includes("after-switch"), false);
	assert.match(r.archived[1].content, /after-switch/);
	assert.equal(r.archived[1].content.includes("before-switch"), false);
});

test("the local timezone mode has one validated persistence API", async (t) => {
	const r = await createRuntime(t);
	const timezone = await r.load(".cool/utils/timezone.ts");
	assert.equal(typeof timezone.setAppTimezoneMode, "function");
	assert.equal(timezone.getAppTimezoneMode(), "beijing");
	timezone.setAppTimezoneMode("system");
	assert.equal(r.storage.boom_timezone_mode, "system");
	assert.equal(timezone.getAppTimezoneMode(), "system");
	timezone.setAppTimezoneMode("beijing");
	assert.equal("boom_timezone_mode" in r.storage, false);
	assert.equal(timezone.getAppTimezoneMode(), "beijing");
});

test("backlog is bounded per request; failed batch remains retryable", async (t) => {
	const r = await createRuntime(t);
	r.seed(750);
	r.respond = (options) => {
		if (r.posts.length === 2) options.fail({ message: "offline" });
		else options.success({ statusCode: 200, data: { status: "success" } });
	};
	assert.equal(await r.uploader.uploadPpiData(), false);
	assert.equal(r.posts.length, 2);
	assert.ok(r.posts.every((p) => p.data.datas.length <= 300));
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 1").get().n,
		300
	);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n,
		450
	);
	r.respond = null;
	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n, 0);
});

test("upload lock covers database reads and prevents duplicate simultaneous batches", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	await Promise.all([r.uploader.uploadPpiData(), r.uploader.uploadPpiData()]);
	assert.equal(r.posts.length, 1);
});

test("failed uploaded-flag write is reported as failure", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.executeFailure = true;
	assert.equal(await r.uploader.uploadPpiData(), false);
});

test("uploadData reports failure instead of unconditional success", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.respond = (options) => options.fail({ message: "offline" });
	assert.equal(await r.uploader.uploadData(), false);
});

test("upload has one automatic entry point and no count/interval gate", async (t) => {
	// 上传节奏只由触发点决定（心跳每轮 / 补录落库后 / 保活），编排层不再自己节流。
	// 老的「攒够 30 条 或 距上次 30 秒」把节奏重新变成隐式的，连常量一起删掉；
	// 「整分钟」这个触发概念也一并消失——判定与上传都不按分钟切。
	const uploader = await readFile(".cool/bluetooth/upload.ts", "utf8");
	assert.equal(uploader.includes("PPI_UPLOAD_BATCH_SIZE"), false);
	assert.equal(uploader.includes("PPI_UPLOAD_MIN_INTERVAL_MS"), false);
	assert.equal(uploader.includes("lastPpiUploadAttemptAt"), false);
	assert.equal(uploader.includes("requestPpiUpload"), false);
	// 退避仍然要有：失败批保持 uploaded=0，但不能随每次触发反复重试。
	assert.equal(uploader.includes("UPLOAD_FAILURE_BACKOFF_MS"), true);
	assert.equal(uploader.includes("private async uploadPpiIfPending()"), true);

	// 数据库层不再认识上传：编排整体搬走了。
	const manager = await readFile(".cool/bluetooth/data-manager.ts", "utf8");
	assert.equal(manager.includes("UPLOAD_PPI_URL"), false);
	assert.equal(manager.includes("uploadPpiIfPending"), false);

	// 秒级广播只落库 + 喊一声心跳，不认识「分钟」「判定」「上传」任何一个概念。
	const broadcast = await readFile(".cool/store/device/broadcast.ts", "utf8");
	const store = broadcast.slice(
		broadcast.indexOf("private async storeBroadcastPpiData"),
		broadcast.indexOf("private getBroadcastTimestamp")
	);
	assert.equal(store.includes("requestPpiUpload"), false);
	assert.equal(store.includes("uploadPpiIfPending"), false);
	assert.equal(store.includes("uploadCompletedMinuteIfCrossed"), false);
	assert.equal(broadcast.includes("lastBroadcastMinuteSec"), false);
	assert.equal(broadcast.includes("minuteUploadBusy"), false);
	assert.equal(broadcast.includes("onMinuteCompleted"), false);
	assert.equal(store.includes('this.device.tick.poke("broadcast")'), true);
});

test("the upload timer is gone instead of being kept as an uncalled second rhythm", async (t) => {
	// 心跳每轮都调 uploadData()，已经覆盖了定时兜底要做的一切（消费积压 + 失败重试）。
	// 把定时器留着「以备不时之需」等于留了第二个节奏来源：它一旦被接回去，上传节奏就
	// 又有两个互不知情的驱动了。真出问题该修心跳，而不是并存一条旁路。
	const uploader = await readFile(".cool/bluetooth/upload.ts", "utf8");
	assert.equal(uploader.includes("startUploadTimer"), false);
	assert.equal(uploader.includes("stopUploadTimer"), false);
	assert.equal(uploader.includes("UPLOAD_RETRY_INTERVAL_MS"), false);
	assert.equal(uploader.includes("uploadTimer"), false);
	// 单批条数上限来自 SQL LIMIT（data-manager 的 PPI_UPLOAD_PAGE_SIZE）。
	// 编排层再放一个同名常量会让人以为改它能改批大小。
	assert.equal(uploader.includes("PPI_UPLOAD_MAX_RECORDS"), false);
	assert.equal(uploader.includes("PPI_UPLOAD_MAX_BATCHES"), true);
});

test("the database layer keeps only what something actually reads", async (t) => {
	// 这两个方法没有任何调用方，且 getPpiTimestampsBetween 与
	// historyCoverage.getPpiTimestamps 是同一件事的两份实现（边界一个 <= 一个 <），
	// 留着只会让「本地有没有这一秒」有两个说法。
	const manager = await readFile(".cool/bluetooth/data-manager.ts", "utf8");
	assert.equal(manager.includes("getPpiTimestampsBetween"), false);
	assert.equal(manager.includes("getLatestSleepData"), false);
	// 关库的入口没人调，上传定时器也随本轮删除，destroy() 整个失去意义。
	assert.equal(manager.includes("async destroy()"), false);

	// 心跳的运行状态只有一个读者（测试页）。state 只写不读，删掉。
	const tick = await readFile(".cool/store/device/device-tick.ts", "utf8");
	assert.equal(tick.includes("state = ref"), false);
	assert.equal(tick.includes('"ticking"'), false);
	// lastError 有读者（测试页），必须留着。
	assert.equal(tick.includes("lastError = ref"), true);
});

test("expired credentials reject instead of leaving upload locked indefinitely", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.user.token = "expired";
	r.expired = true;
	r.refreshExpired = true;
	const outcome = await Promise.race([
		r.uploader.uploadPpiData(),
		new Promise((resolve) => setTimeout(() => resolve("pending"), 30))
	]);
	assert.equal(outcome, false);
	assert.equal(r.uploader.isUploading, false);
});

test("database query failure is not treated as an empty successful upload", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.queryFailure = true;
	assert.equal(await r.uploader.uploadData(), false);
	assert.equal(r.posts.length, 0);
});

test("database scan failure does not plan a fabricated empty-history repair", async (t) => {
	const r = await createRuntime(t);
	r.queryFailure = true;
	// 一轮心跳里数据库读失败就整轮抛出，不能被当成「没有缺口」悄悄过去。
	const tick = new r.DeviceTick({ boundDeviceId: "device" });
	await tick.runTick("timer");
	assert.equal(tick.lastError.value == "", false);
});

test("history persistence failure reports zero saved and does not start uploading", async (t) => {
	const r = await createRuntime(t);
	let released = false;
	const device = {
		beginGattTask: () => true,
		endGattTask: () => {
			released = true;
		},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				reader.latestVitalDataResponse = page(1000);
				reader.vitalDataResponseSeqValue++;
				return true;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	r.executeFailure = true;
	const read = await reader.readVitalDataAuto({
		startSec: 1300,
		direction: 0,
		minutes: 2
	});
	assert.equal(read.saveOk, false);
	assert.equal(read.savedRecords, 0);
	assert.equal(read.uploadAttempted, false);
	assert.equal(r.posts.length, 0);
	assert.equal(released, true);
});

test("vital reader logs a pre-send exception with its message", async (t) => {
	const r = await createRuntime(t);
	const device = {
		beginGattTask: () => true,
		endGattTask() {},
		event: {
			resetDataIdentifierReassembler() {
				throw new Error("reset vital reassembler failed");
			}
		},
		protocol: {}
	};
	const reader = new r.DeviceHistoryReader(device);
	await assert.rejects(
		reader.readVitalDataAuto({
			startSec: 1000,
			direction: 0,
			minutes: 2,
			persistData: false
		}),
		/reset vital reassembler failed/
	);
	assert.equal(
		r.logs.some((entry) => entry.items.join(" ").includes("reset vital reassembler failed")),
		true
	);
});

test("refresh failure rejects all queued requests and allows a later refresh", async (t) => {
	const r = await createRuntime(t);
	r.user.token = "old";
	r.expired = true;
	let rejectRefresh;
	r.user.refreshToken = () =>
		new Promise((resolve, reject) => {
			rejectRefresh = reject;
		});
	const first = r.request({ url: "/one" });
	const second = r.request({ url: "/two" });
	const pending = Promise.allSettled([first, second]);
	rejectRefresh(new Error("offline"));
	const settled = await Promise.race([
		pending,
		new Promise((resolve) => setTimeout(() => resolve(null), 30))
	]);
	assert.ok(settled);
	assert.deepEqual(
		settled.map((x) => x.status),
		["rejected", "rejected"]
	);
	r.user.refreshToken = async () => "renewed";
	await r.request({ url: "/three" });
	assert.equal(r.posts.length, 1);
	assert.equal(r.posts[0].header.Authorization, "renewed");
});

test("a failed upload backs off instead of re-requesting on every trigger", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.respond = (options) => options.fail({ message: "offline" });
	assert.equal(await r.uploader.uploadData(), false);
	assert.equal(await r.uploader.uploadData(), false);
	assert.equal(r.posts.length, 1);
	r.respond = null;
	r.uploader.lastPpiUploadFailedAt -= 61000;
	assert.equal(await r.uploader.uploadData(), true);
});

test("a small batch uploads immediately instead of waiting for a count threshold", async (t) => {
	const r = await createRuntime(t);
	r.seed(2);
	// 上传节奏由触发点决定（整分钟 / 定时兜底 / 补录落库后），不再有「攒够 30 条」这一关：
	// 触发点认为该传了，两条也要传上去，否则这两秒会一直等到下一次触发。
	assert.equal(await r.uploader.uploadData(), true);
	assert.equal(r.posts.length, 1);
	assert.equal(r.posts[0].data.datas.length, 2);
});

test("live broadcasts arriving mid-run do not extend it to the batch cap", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	// 实时广播每秒落库一条，比一次 HTTP 往返还快：每批都重查“当前未上传”会被新秒一直喂饱。
	let liveSec = Math.floor(Date.now() / 1000);
	const insertLive = r.db.prepare("INSERT INTO ppi_data VALUES (?, ?, 60, 0, 1000, 0)");
	r.respond = (options) => {
		liveSec += 1;
		insertLive.run(String(liveSec), liveSec);
		options.success({ statusCode: 200, data: { status: "success" } });
	};
	assert.equal(await r.uploader.uploadPpiData(), true);
	assert.equal(r.posts.length, 1);
	assert.equal(r.posts[0].data.datas.length, 30);
	// 读取期间新到的实时秒留到下一轮，既不撑长本轮，也不算本轮失败。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n, 1);
});

test("per-run budget leaves a large backlog for later and releases the upload lock", async (t) => {
	const r = await createRuntime(t);
	r.seed(3600);
	assert.equal(await r.uploader.uploadPpiData(), false);
	assert.ok(r.posts.length <= 10);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n,
		600
	);
	assert.equal(r.uploader.isUploading, false);
	assert.equal(await r.uploader.uploadPpiData(), true);
});

test("sleep failure is preserved and contributes to uploadData result", async (t) => {
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO sleep_data VALUES ('1000', 1000, 60, 60, 0, 0, '', 0)");
	r.response = { status: "error" };
	assert.equal(await r.uploader.uploadData(), false);
	assert.equal(r.db.prepare("SELECT uploaded FROM sleep_data").get().uploaded, 0);
	r.response = { status: "success" };
	assert.equal(await r.uploader.uploadData(), true);
	assert.equal(r.db.prepare("SELECT uploaded FROM sleep_data").get().uploaded, 1);
});

test("an in-flight PPI upload does not silently drop the sleep upload", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.db.exec("INSERT INTO sleep_data VALUES ('1000', 1000, 60, 60, 0, 0, '', 0)");
	// PPI 挂起不返回，模拟它连发多批占用上传通道的窗口；睡眠请求立即成功。
	const pending = [];
	r.respond = (options) => {
		if (options.url.indexOf("/sleep") >= 0)
			return options.success({ statusCode: 200, data: { status: "success" } });
		pending.push(options);
	};
	const ppi = r.uploader.uploadPpiData();
	await new Promise((s) => setTimeout(s, 5));
	assert.equal(r.uploader.isUploading, true);
	// 事件读取结束时正是这个调用顺序。共用一个上传锁时，它只会打一条 info 然后
	// 返回 false，记录留在 uploaded=0——“有睡眠事件但没上传”就是这样发生的。
	assert.equal(await r.uploader.uploadSleepData(), true);
	assert.equal(r.db.prepare("SELECT uploaded FROM sleep_data").get().uploaded, 1);
	assert.equal(r.posts.filter((p) => p.url.indexOf("/sleep") >= 0).length, 1);
	for (const item of pending) item.success({ statusCode: 200, data: { status: "success" } });
	await ppi;
});

test("sleep upload logs why it skipped and how the detail staged", async (t) => {
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO sleep_data VALUES ('1000', 1000, 60, 60, 0, 0, '', 0)");
	assert.equal(await r.uploader.uploadSleepData(), true);
	const line = r.logs.map((x) => x.items.join(" ")).find((x) => x.includes("上传睡眠数据:"));
	assert.ok(line != null, "no sleep upload line was logged");
	// 没有这一行，日志里就看不出 detail 是不是全 0——而全 0 正是服务端
	// 判定“没有睡眠数据”的依据。25200 字符的 detail 不能原样打印，只报统计。
	for (const field of ["count=", "ids=", "detail长度=", "无分期=", "detail头="]) {
		assert.equal(line.includes(field), true, `sleep log missing ${field}: ${line}`);
	}
	assert.equal(line.includes("000000000000000000000000"), true);
	// 设备未连接时跳过必须报出原因，否则只剩一个 false 无法定位。
	const offline = await createRuntime(t);
	offline.db.exec("INSERT INTO sleep_data VALUES ('1000', 1000, 60, 60, 0, 0, '', 0)");
	offline.uploader.setDeviceInfo("BOOM", "");
	assert.equal(await offline.uploader.uploadSleepData(), false);
	assert.equal(
		offline.logs.some((x) => x.items.join(" ").includes("原因=设备未连接")),
		true
	);
});

test("per-frame reassembly noise cannot flush the diagnostic buffer", async (t) => {
	const r = await createRuntime(t);
	const { DataIdentifierReassembler } = await r.load(".cool/bluetooth/boom-codec.ts");
	const reassembler = new DataIdentifierReassembler();
	const before = r.logs.length;
	// 坏连接上同一类异常会按帧重复；一页生命体征就有几十帧，逐帧告警足以把
	// 1000 行缓冲区冲干净。首次必记，之后按间隔采样，连续次数写在日志里。
	for (let i = 0; i < 120; i++) reassembler.push("4000" + "aa".repeat(8)); // 非起始帧
	const orphan = r.logs.slice(before).filter((x) => x.items.join(" ").includes("收到非起始帧"));
	assert.ok(orphan.length > 0, "the first orphan frame was not reported");
	assert.ok(orphan.length <= 4, `orphan frames flooded the log: ${orphan.length}`);
	assert.equal(orphan[0].items.join(" ").includes("连续=1"), true);
});

test("diagnostic logs archive to txt in batches instead of only living in the 1000-line buffer", async (t) => {
	const r = await createRuntime(t);
	r.diagnostics.init();
	// 排空 init 那一行，计数从 0 开始。
	r.diagnostics.flushArchiveNow();
	const base = r.archived.length;
	const record = (count, tag) => {
		for (let i = 0; i < count; i++) r.diagnostics.record("info", "t", `${tag}-${i}`);
	};

	// 内存/SQLite 只留最近 1000 条；落盘是另一条不受上限约束的路径。
	record(499, "a");
	assert.equal(r.archived.length - base, 0, "archived before the batch was full");
	record(1, "a");
	assert.equal(r.archived.length - base, 1, "a full batch was not archived");
	const file = r.archived[base];
	assert.equal(file.content.includes("a-0"), true, "oldest line of the batch was dropped");
	assert.equal((file.content.match(/a-/g) ?? []).length, 500, "batch did not contain 500 lines");
	// 文件名只有时刻和序号：日期由 Download/BOOM/logs/<yyyyMMdd>/ 目录表达。
	assert.match(file.fileName, /^diagnostic-\d{6}-\d+\.txt$/);

	// 不足一批时手动 flush 把余量也写出去。
	record(3, "b");
	assert.equal(r.archived.length - base, 1, "a partial batch was archived without being asked");
	r.diagnostics.flushArchiveNow();
	assert.equal(r.archived.length - base, 2, "flushArchiveNow did not write the remainder");
	assert.equal((r.archived[base + 1].content.match(/b-/g) ?? []).length, 3);
	r.diagnostics.flushArchiveNow();
	assert.equal(r.archived.length - base, 2, "an empty buffer wrote an empty file");

	// 清空要把没落盘的余量先写出去，否则用户以为清掉的是屏幕上这些。
	record(2, "c");
	await r.diagnostics.clear();
	assert.equal(r.archived.length - base, 3, "clear dropped un-archived logs");
	assert.equal(r.diagnostics.getLogs().length, 0);
});

test("an idle app still archives its logs instead of holding them in memory", async (t) => {
	const r = await createRuntime(t);
	r.diagnostics.init();
	r.diagnostics.flushArchiveNow();
	const base = r.archived.length;
	// 低于下限时即使时间到了也不写碎文件。
	for (let i = 0; i < 28; i++) r.diagnostics.record("info", "t", `idle-${i}`);
	r.dateOffsetMs = 6 * 60 * 1000;
	r.diagnostics.record("info", "t", "idle-28");
	assert.equal(r.archived.length - base, 0, "a sub-threshold batch was archived");

	// 到达下限且已超时 → 落盘。只按数量触发的话，空闲期这些日志会一直留在内存里。
	r.diagnostics.record("info", "t", "idle-29");
	assert.equal(r.archived.length - base, 1, "an overdue batch was never archived");
	assert.equal((r.archived[base].content.match(/idle-/g) ?? []).length, 30);

	// 落盘后计时重置：紧接着再攒够下限也不该立刻又写一个文件。
	for (let i = 0; i < 30; i++) r.diagnostics.record("info", "t", `reset-${i}`);
	assert.equal(r.archived.length - base, 1, "the interval did not reset after archiving");
	r.dateOffsetMs += 6 * 60 * 1000;
	r.diagnostics.record("info", "t", "tick");
	assert.equal(r.archived.length - base, 2, "the next overdue batch was not archived");
});

test("broadcast ingest keeps sleep staging independent of the display table", async (t) => {
	// 睡眠分期（sleep_status_data）只在广播每秒落库，上传时按事件窗口组装 detail。
	// 它必须独立于 realtime_broadcast_data —— 后者是首页展示用的表，写入失败时
	// 若连带跳过分期，整晚的 detail 会全 0，服务端据此判定“没有睡眠数据”。
	const source = await readFile(".cool/store/device/broadcast.ts", "utf8");
	const start = source.indexOf("private async storeBroadcastRecordByDevice");
	assert.ok(start > 0, "storeBroadcastRecordByDevice not found");
	// 取到下一个方法定义为止：这里要检查的是“谁在 record != null 里面”。
	const body = source.slice(start, source.indexOf("\n\tprivate ", start + 10));
	const guard = body.indexOf("if (record != null)");
	assert.ok(guard > 0, "the record guard is gone");
	// 落库结果只允许控制展示缓存，不能再包住任何落库调用。
	const guardedBlock = body.slice(guard, body.indexOf("}", guard));
	assert.equal(
		guardedBlock.includes("storeBroadcastPpiData"),
		false,
		"PPI storage is still inside the record != null block"
	);
	assert.equal(
		guardedBlock.includes("storeBroadcastSleepActivity"),
		false,
		"sleep staging is still inside the record != null block"
	);
	// 两个落库调用都必须在 guard 之后发生（无论它们在哪个方法里）。
	assert.ok(
		body.indexOf("storeBroadcastPpiData") > guard,
		"PPI storage happens before the record guard"
	);
	const stagingCall = source.indexOf("storeBroadcastSleepActivity", start);
	assert.ok(stagingCall > 0, "sleep staging call not found after the ingest entry point");

	// 运行时确认两张表互不牵连：广播表写失败时，分期照样能落库并读回。
	const r = await createRuntime(t);
	r.executeFailure = true;
	const failed = await r.manager.storeRealtimeBroadcast({
		broadcast: {
			receivedAt: 1700000000000,
			utc: 1700000000,
			voltageMv: 3900,
			ppgAttached: true,
			behavior: 0,
			activity: 2,
			hr: 60,
			hrValid: true,
			spo2Pct: 98,
			spo2Valid: true,
			ppi: 500,
			ppiValid: true,
			hrvMs: 30,
			rmssdValid: true,
			bhr: 55,
			bhrValid: true,
			stepsEveryday: 100,
			calorieEveryday: 10,
			eventSeq: 5,
			hasNewEvent: false,
			batteryStatus: 0,
			deviceId: "AA:BB"
		},
		rawHex: "50",
		vHex: "50",
		deviceId: "AA:BB"
	});
	assert.equal(failed, null, "the display table write was expected to fail");
	r.executeFailure = false;
	assert.equal(await r.manager.storeBroadcastSleepActivity(1700000000, 2), true);
	const staged = await r.manager.getSleepActivitiesBetween(1699999999, 1700000001);
	assert.equal(staged.get(1700000000), 2, "sleep staging was collateral damage");
});

test("ordinary API response compatibility is preserved", async (t) => {
	const r = await createRuntime(t);
	r.response = { legacy: true };
	const response = await r.request({ url: "/legacy" });
	assert.equal(response.legacy, true);
});

test("automatic history releases GATT without waiting for slow upload responses", async (t) => {
	const r = await createRuntime(t);
	let released = false;
	let pendingRequest;
	r.respond = (options) => {
		pendingRequest = options;
	};
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask: () => {
			released = true;
		},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData(query) {
				reader.latestVitalDataResponse = page(query.startSec - 120);
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				return false;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	// 缺口端点直接当读取窗口：末端作 anchor，向更早翻页。
	const gap = { fromSec: 100000, toSec: 101200, repairSeconds: 1200, bridgeSeconds: 0 };
	const reading = reader.readVitalGapGroup(gap);
	const outcome = await Promise.race([
		reading,
		new Promise((resolve) => setTimeout(() => resolve(null), 30))
	]);
	try {
		assert.ok(outcome, "history is blocked by the network request");
		assert.equal(released, true);
		assert.equal(outcome.saveOk, true);
		assert.equal(outcome.uploadAttempted, false);
		assert.equal(outcome.uploadScheduled, true);
	} finally {
		if (pendingRequest)
			pendingRequest.success({ statusCode: 200, data: { status: "success" } });
		await reading;
	}
});

test("scheduled history upload is coalesced and eventually acknowledges saved rows", async (t) => {
	const r = await createRuntime(t);
	r.seed(300);
	let pendingRequest;
	r.respond = (options) => {
		pendingRequest = options;
	};
	r.uploader.scheduleUpload();
	r.uploader.scheduleUpload();
	assert.equal(r.timers.length, 1);
	r.timers.shift()();
	await new Promise(setImmediate);
	assert.equal(r.posts.length, 1);
	assert.equal(r.uploader.isUploading, true);
	pendingRequest.success({ statusCode: 200, data: { status: "success" } });
	await new Promise(setImmediate);
	assert.equal(r.uploader.isUploading, false);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 1").get().n,
		300
	);
});

test("backward history starts at the newer edge and stops at the older edge", async (t) => {
	const r = await createRuntime(t);
	const queries = [];
	let cursor = 0;
	let continues = 0;
	const deliver = () => {
		cursor -= 120;
		reader.latestVitalDataResponse = page(cursor);
		reader.vitalDataResponseSeqValue++;
		return true;
	};
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData(query) {
				queries.push(query);
				cursor = query.startSec;
				return deliver();
			},
			async continueReadVitalData() {
				continues++;
				return deliver();
			}
		}
	};
	// 缺口 [100000, 101200)：anchor 取末端，让读取链路反向走到 100000。
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {}; // Omit native inter-command delay; keep the real read loop.
	const gap = { fromSec: 100000, toSec: 101200, repairSeconds: 1200, bridgeSeconds: 0 };
	const read = await reader.readVitalGapGroup(gap);
	assert.equal(queries[0].startSec, 101200);
	assert.equal(queries[0].direction, 0);
	assert.equal(read.pages, 10);
	assert.equal(continues, 9);
	assert.equal(read.savedRecords, 1200);
	assert.deepEqual(
		rows(r.db, "SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM ppi_data"),
		[{ first: 100000, last: 101199 }]
	);
});

test("recent window queries next minute and excludes future seconds", async (t) => {
	const r = await createRuntime(t);
	let query;
	let continues = 0;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: {
			resetDataIdentifierReassembler() {},
			notifySeqValue: 0,
			boomTimestamp: { value: 0 }
		},
		protocol: {
			async readVitalData(value) {
				query = value;
				reader.latestVitalDataResponse = page(value.startSec - 120);
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				continues++;
				if (continues > 1) return false;
				reader.latestVitalDataResponse = page(before - 240);
				reader.vitalDataResponseSeqValue++;
				return true;
			}
		}
	};
	const before = Math.floor(Date.now() / 1000);
	// 缺口窗口就是 [B, stableCeiling)，anchor 取末端——与自动路径同一条读取链路。
	// 窗口必须跨页（>120 秒），否则第一页就翻到窗口起点之前、读取立刻结束，
	// 看不到「锚点在未来」这一条路径。
	const gap = {
		fromSec: before - 300,
		toSec: before + 60,
		repairSeconds: 360,
		bridgeSeconds: 0
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const read = await reader.readVitalGapGroup(gap);
	const after = Math.floor(Date.now() / 1000);
	// 锚点就是缺口右端本身，不做分钟对齐：对齐会把窗口末端往回推，窄缺口会被推空。
	assert.equal(query.startSec, gap.toSec);
	assert.ok(query.startSec >= before && query.startSec <= after + 60);
	assert.equal(query.direction, 0);
	// 锚点在未来，因此只有已经产生的秒入库；未到来的秒既不落库也不记账。
	assert.ok(read.savedRecords > 0);
	assert.equal(
		r.db.prepare("SELECT MAX(timestamp) AS last FROM ppi_data").get().last < after,
		true
	);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_ready_ranges WHERE to_sec > " + after).get()
			.n,
		0
	);
});

test("home refresh keeps one /go request in flight and only polls silently", async () => {
	const page = await readFile("pages/index/home.uvue", "utf8");
	// 120 秒超时 + 30 秒轮询 + onMounted/onShow 双触发：不拦在途请求会同时堆叠多个。
	assert.equal(page.includes("refreshPending"), true);
	assert.equal(page.includes("if (refreshPending == true) return;"), true);
	assert.equal(page.includes("refreshPending = false;"), true);
	assert.equal(page.includes("refreshHomeData(true);"), true);
	assert.equal(page.includes("refreshHomeData(false);"), true);
	const store = await readFile(".cool/store/home.ts", "utf8");
	assert.equal(store.includes('showError: ErrorNoticeShowType = "toast"'), true);
	assert.equal(store.includes("showError"), true);
});

test("request failures without an explicit mode still surface a notice", async () => {
	const source = await readFile(".cool/service/error-notice.ts", "utf8");
	// RequestOptions.showError 声明默认 toast，实现里不能把未指定当成静默。
	assert.equal(source.includes('options.showType ?? "toast"'), true);
});

test("disconnected GATT clients are closed so stale callbacks cannot replay frames", async () => {
	const source = await readFile(
		"uni_modules/kux-bluetooth/utssdk/app-android/bluetoothManager.uts",
		"utf8"
	);
	// Android 只有 close() 会注销 BluetoothGattCallback；只 disconnect() 会让旧 client
	// 继续向当前注册的处理器投递 notify 与服务发现，同一帧被解析多次。
	assert.equal(source.includes("gatt.close()"), true);
	assert.equal(source.includes("private closeGattClient("), true);
	// 断开回调必须释放 client，而不是只通知上层。
	const stateCallback = source.slice(
		source.indexOf("(connected: boolean, gatt: BluetoothGatt) =>"),
		source.indexOf("(services: ArrayList<BluetoothGattService> | null) =>")
	);
	assert.equal(stateCallback.includes("} else {"), true);
	assert.equal(stateCallback.includes("this.closeGattClient(deviceId, gatt, epoch);"), true);
	// 连接超时的 client 也要登记，否则断开回调丢失后就再没有引用可关。
	assert.equal(source.includes("this.retireGattClient(deviceId, gatt);"), true);
	assert.equal(source.includes("private closeAllGattClients()"), true);
	// closeBLEConnection 只能 disconnect + 登记：直接 close() 会吃掉断开通知，
	// 而丢掉引用则会让这个 client 永远无法释放。
	const closeFn = source.slice(
		source.indexOf("closeBLEConnection(options: CloseBLEConnectionOptions)"),
		source.indexOf("class AcceptThread")
	);
	assert.equal(closeFn.includes("this.retireGattClient(deviceId, gatt);"), true);
	assert.equal(closeFn.includes("gatt.disconnect();"), true);
	assert.equal(closeFn.includes("gatt.close()"), false);
});

test("a sleep result event read from the device lands in sleep_data", async (t) => {
	const r = await createRuntime(t);
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			// 0x3C 头必须走真实解析：earliestSn/latestSn 为 0 会让读取直接判定“无事件数据”，
			// 根本进不到 0x3D 循环。
			async readEventData() {
				reader.handleEventData(eventHeader(1, 1), 0x3c);
				return true;
			},
			async continueReadEventData() {
				// 一页一条睡眠事件；数量不足 maxCount，读取会在本页自然收敛。
				reader.handleEventData(eventBatch(sleepResultEvent()), 0x3d);
				return true;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const read = await reader.readEventDataAuto({
		// 与调度层一致：EVENT_QUERY_TYPE_BY_TIME。
		type: 1,
		startSec: 1699900000,
		endSec: 1700100000,
		maxCount: 10,
		maxPages: 5,
		// 批次要静默 EVENT_BATCH_SETTLE_MS 才算收齐，超时必须留出这段静默窗口。
		timeoutMs: 3000,
		pageDelayMs: 0,
		persistSleepData: true,
		uploadAfterSave: true
	});
	assert.equal(read.status, "DONE");
	assert.equal(read.items.length, 1);
	assert.equal(read.savedSleepRecords, 1, "睡眠事件没有被保存");
	assert.equal(read.uploadAttempted, true);
	assert.equal(read.uploadOk, true);
	// uploaded=1 是 uploadAfterSave 的正常结果：落库与上传在同一次事件读取里完成，
	// 「最近睡眠」查的就是这张表。
	assert.deepEqual(rows(r.db, "SELECT * FROM sleep_data"), [
		{
			id: "1700000000",
			report_timestamp: 1700000000,
			bedtime: 25200,
			sleep_time: 23400,
			wake_time: 1800,
			getup_time: 0,
			detail: "",
			uploaded: 1
		}
	]);
	assert.equal(r.posts.length, 1);
	const recent = await r.manager.getRecentSleepData(10, null);
	assert.equal(recent.length, 1);
	assert.equal(recent[0].reportTimestamp, 1700000000);
});

test("a sleep event whose write fails is not reported as saved", async (t) => {
	const r = await createRuntime(t);
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readEventData() {
				reader.handleEventData(eventHeader(1, 1), 0x3c);
				return true;
			},
			async continueReadEventData() {
				reader.handleEventData(eventBatch(sleepResultEvent()), 0x3d);
				return true;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	// 落库失败时，savedSleep 必须为 0：否则日志里 saved 在涨、库里一行没有，
	// 「读到睡眠却查不到」就会被这条日志掩盖过去。
	r.executeFailure = true;
	const read = await reader.readEventDataAuto({
		type: 1,
		startSec: 1699900000,
		endSec: 1700100000,
		maxCount: 10,
		maxPages: 5,
		timeoutMs: 3000,
		pageDelayMs: 0,
		persistSleepData: true,
		uploadAfterSave: true
	});
	assert.equal(read.savedSleepRecords, 0);
	// 写入失败要留下明确的一行，而不是静默。
	assert.equal(
		r.logs.some((entry) => entry.items.join(" ").includes("睡眠数据写入失败")),
		true
	);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM sleep_data").get().n, 0);
});

test("a legacy sleep_data table is rebuilt so sleep results can actually be stored", async (t) => {
	const r = await createRuntime(t);
	// 复刻旧结构：多一个 NOT NULL 无默认值的 record_count、少一个 detail。
	r.db.exec("DROP TABLE IF EXISTS sleep_data");
	r.db.exec(`CREATE TABLE sleep_data (
    id TEXT PRIMARY KEY, report_timestamp INTEGER NOT NULL, bedtime INTEGER NOT NULL,
    sleep_time INTEGER NOT NULL, wake_time INTEGER NOT NULL, getup_time INTEGER NOT NULL,
    record_count INTEGER NOT NULL, uploaded INTEGER DEFAULT 0)`);
	r.db.exec("INSERT INTO sleep_data VALUES ('1699999999',1699999999,25200,23000,1500,0,1200,1)");

	const btDb = (await r.load(".cool/bluetooth/database.ts")).bluetoothDatabase;
	await btDb.close();
	await btDb.open();

	assert.deepEqual(
		r.db
			.prepare("PRAGMA table_info(sleep_data)")
			.all()
			.map((row) => row.name),
		[
			"id",
			"report_timestamp",
			"bedtime",
			"sleep_time",
			"wake_time",
			"getup_time",
			"detail",
			"uploaded"
		]
	);
	// 历史行必须保留（含 uploaded 状态），只有无从还原的 detail 补空串。
	assert.deepEqual(rows(r.db, "SELECT id, uploaded, detail FROM sleep_data"), [
		{ id: "1699999999", uploaded: 1, detail: "" }
	]);

	// 旧结构下 INSERT OR IGNORE 会把 NOT NULL 冲突静默吞掉：execute 返回 true、行没进去。
	const stored = await r.manager.storeSleepData({
		reportTimestamp: 1700000000,
		bedtime: 25200,
		sleepTime: 23400,
		wakeTime: 1800,
		getupTime: 0,
		detail: ""
	});
	assert.equal(stored, true);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM sleep_data").get().n, 2);
	assert.equal((await r.manager.getUnuploadedSleepData()).length, 1);
});

test("a failed sleep insert is reported instead of counted as saved", async (t) => {
	const r = await createRuntime(t);
	r.executeFailure = true;
	// 写入失败必须能被调用方看见：否则日志里 saved 在涨、库里一行没有。
	assert.equal(
		await r.manager.storeSleepData({
			reportTimestamp: 1700000000,
			bedtime: 25200,
			sleepTime: 23400,
			wakeTime: 1800,
			getupTime: 0,
			detail: ""
		}),
		false
	);
	assert.equal(
		r.logs.some((entry) => entry.items.join(" ").includes("睡眠数据写入失败")),
		true
	);
});

test("protocol probe accepts the documented 0x33 timestamp response to a 0x34 read", async (t) => {
	const r = await createRuntime(t);
	const { DeviceProtocolProbe } = await r.load(".cool/store/device/protocol-probe.ts");
	const event = {
		boomTimestampSeqValue: 4,
		boomTimestampLastT: 0,
		boomTimestamp: { value: 0 }
	};
	let sent = 0;
	const probe = new DeviceProtocolProbe({
		event,
		protocol: {
			async readTimestamp() {
				sent++;
				return true;
			}
		}
	});
	r.sleep = async () => {
		event.boomTimestampLastT = 0x33;
		event.boomTimestamp.value = 1760000000;
		event.boomTimestampSeqValue++;
	};

	const result = await probe.check(3000);

	assert.equal(sent, 1);
	assert.equal(result.status, "OK");
	assert.equal(result.deviceTimestamp, 1760000000);
});

test("protocol probe distinguishes timeout from an invalid timestamp response", async (t) => {
	const r = await createRuntime(t);
	const { DeviceProtocolProbe } = await r.load(".cool/store/device/protocol-probe.ts");
	const timeoutEvent = {
		boomTimestampSeqValue: 0,
		boomTimestampLastT: 0,
		boomTimestamp: { value: 0 }
	};
	const timeoutProbe = new DeviceProtocolProbe({
		event: timeoutEvent,
		protocol: {
			async readTimestamp() {
				return true;
			}
		}
	});
	r.sleep = async () => {
		r.dateOffsetMs += 1000;
	};
	assert.equal((await timeoutProbe.check(3000)).status, "TIMEOUT");

	const invalidEvent = {
		boomTimestampSeqValue: 0,
		boomTimestampLastT: 0,
		boomTimestamp: { value: 0 }
	};
	const invalidProbe = new DeviceProtocolProbe({
		event: invalidEvent,
		protocol: {
			async readTimestamp() {
				return true;
			}
		}
	});
	r.sleep = async () => {
		invalidEvent.boomTimestampLastT = 0x34;
		invalidEvent.boomTimestampSeqValue++;
	};
	assert.equal((await invalidProbe.check(3000)).status, "INVALID_RESPONSE");
});

test("protocol probe converts a thrown timestamp send into SEND_FAILED", async (t) => {
	const r = await createRuntime(t);
	const { DeviceProtocolProbe } = await r.load(".cool/store/device/protocol-probe.ts");
	const probe = new DeviceProtocolProbe({
		event: {
			boomTimestampSeqValue: 0,
			boomTimestampLastT: 0,
			boomTimestamp: { value: 0 }
		},
		protocol: {
			async readTimestamp() {
				throw new Error("write failed");
			}
		}
	});

	assert.equal((await probe.check(3000)).status, "SEND_FAILED");
});

test("device health warns on the third failed connection and survives reconstruction", async (t) => {
	const r = await createRuntime(t);
	const { DeviceHealth } = await r.load(".cool/store/device/device-health.ts");
	const health = new DeviceHealth();
	health.bind("AA:BB");
	health.recordUnresponsive();
	health.recordUnresponsive();
	assert.equal(health.warningActive.value, false);
	health.recordUnresponsive();
	assert.equal(health.failureCount.value, 3);
	assert.equal(health.warningActive.value, true);
	assert.equal(health.modalPending.value, true);
	health.acknowledgeModal();
	// Android 自定义基座会把 setStorageSync 的对象恢复为 JSON 字符串。
	r.storage.boom_device_protocol_health = JSON.stringify({
		deviceId: "AA:BB",
		failureCount: 3,
		warningActive: true,
		modalAcknowledged: true
	});

	const restored = new DeviceHealth();
	restored.bind("AA:BB");
	assert.equal(restored.failureCount.value, 3);
	assert.equal(restored.warningActive.value, true);
	assert.equal(restored.modalPending.value, false);
	restored.recordHealthyConnection();
	assert.equal(restored.failureCount.value, 0);
	assert.equal(restored.warningActive.value, false);
});

test("a history timeout reports the exact pending two-minute page", async (t) => {
	const r = await createRuntime(t);
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				return true;
			},
			async continueReadVitalData() {
				return true;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {
		r.dateOffsetMs += 1000;
	};
	const result = await reader.readVitalGapGroup({
		fromSec: 1000,
		toSec: 1300,
		repairSeconds: 300,
		bridgeSeconds: 0
	});

	assert.equal(result.status, "TIMEOUT");
	assert.equal(result.failedFromSec, 1180);
	assert.equal(result.failedToSec, 1300);
});

test("a stale page newer than the gap cannot move the timeout audit outside the gap", async (t) => {
	const r = await createRuntime(t);
	let reader;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				reader.latestVitalDataResponse = {
					startSec: 1400,
					direction: 0,
					n: 2,
					rmssdSdnn: [{}, {}],
					vitalData: Array.from({ length: 120 }, () => ({
						hr: 60,
						ppi: 1000,
						valid: true
					}))
				};
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				return true;
			}
		}
	};
	reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {
		r.dateOffsetMs += 1000;
	};
	const result = await reader.readVitalGapGroup({
		fromSec: 1000,
		toSec: 1300,
		repairSeconds: 300,
		bridgeSeconds: 0
	});

	assert.equal(result.status, "TIMEOUT");
	assert.equal(result.failedFromSec, 1180);
	assert.equal(result.failedToSec, 1300);
});

test("a verified history-page timeout is counted and later gap groups continue", async (t) => {
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	const first = now - 900;
	const second = now - 500;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${first})`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	const attempted = [];
	let resetCount = 0;
	const reader = {
		resetVitalResponseState() {
			resetCount++;
		},
		async readVitalGapGroup(gap) {
			attempted.push(gap.fromSec);
			return {
				status: "TIMEOUT",
				message: "wait vital response timeout",
				pages: 0,
				savedRecords: 0,
				saveOk: true,
				failedFromSec: gap.toSec - 120,
				failedToSec: gap.toSec
			};
		}
	};
	const probe = {
		async check() {
			return { status: "OK", latencyMs: 10, deviceTimestamp: now };
		}
	};

	const result = await r.historyRepair.repairAllGaps(reader, probe);

	assert.deepEqual(attempted, [first, second]);
	assert.equal(resetCount, 2, "each successful post-timeout probe resets partial history frames");
	assert.equal(result.stopReason, "COMPLETE");
	assert.equal(result.timedOutPages, 2);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_failures WHERE timeout_count=1").get()
			.n,
		2
	);
});

test("a failed post-timeout probe stops repair without blaming the history page", async (t) => {
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	const first = now - 900;
	const second = now - 500;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${first})`);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 700},${second})`);
	const attempted = [];
	const reader = {
		async readVitalGapGroup(gap) {
			attempted.push(gap.fromSec);
			return {
				status: "TIMEOUT",
				message: "wait vital response timeout",
				pages: 0,
				savedRecords: 0,
				saveOk: true,
				failedFromSec: gap.toSec - 120,
				failedToSec: gap.toSec
			};
		}
	};
	const probe = {
		async check() {
			return { status: "TIMEOUT", latencyMs: 3000, deviceTimestamp: 0 };
		}
	};

	const result = await r.historyRepair.repairAllGaps(reader, probe);

	assert.deepEqual(attempted, [first]);
	assert.equal(result.stopReason, "DEVICE_UNRESPONSIVE");
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_failures").get().n, 0);
});

test("the third verified timeout abandons and accounts only its exact page", async (t) => {
	const r = await createRuntime(t);
	const now = Math.floor(Date.now() / 1000);
	const from = now - 130;
	const to = now - 10;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${from})`);
	const { historyFailureStore } = await r.load(
		".cool/bluetooth/history/history-failure-store.ts"
	);
	await historyFailureStore.recordTimeout(from, to, now - 20);
	await historyFailureStore.recordTimeout(from, to, now - 10);
	const reader = {
		resetVitalResponseState() {},
		async readVitalGapGroup() {
			return {
				status: "TIMEOUT",
				message: "wait vital response timeout",
				pages: 0,
				savedRecords: 0,
				saveOk: true,
				failedFromSec: from,
				failedToSec: to
			};
		}
	};
	const probe = {
		async check() {
			return { status: "OK", latencyMs: 10, deviceTimestamp: now };
		}
	};

	const result = await r.historyRepair.repairAllGaps(reader, probe);

	assert.equal(result.abandonedPages, 1);
	assert.equal(
		await (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline.getBaseline(),
		to
	);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_failures WHERE abandoned=1").get().n,
		1
	);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_ready_ranges").get().n,
		0,
		"an abandoned range already consumed by B must not be reinserted"
	);
});

test("scheduler keeps automatic work queued when the initial protocol probe fails", async (t) => {
	const r = await createRuntime(t);
	const { DeviceGattScheduler } = await r.load(".cool/store/device/gatt-scheduler.ts");
	let restored = 0;
	let failures = 0;
	let healthy = 0;
	const device = {
		boundDeviceId: "AA:BB",
		isGattTaskBusy: () => false,
		getGattTaskName: () => "",
		connection: {
			async switchToConnectMode() {
				return true;
			},
			async switchToBroadcastMode() {
				restored++;
			},
			async disconnectDevice() {}
		},
		protocolProbe: {
			async check() {
				return { status: "TIMEOUT", latencyMs: 3000, deviceTimestamp: 0 };
			}
		},
		health: {
			recordUnresponsive() {
				failures++;
			},
			recordHealthyConnection() {
				healthy++;
			}
		},
		errorMessage: { value: "" }
	};
	const scheduler = new DeviceGattScheduler(device);
	scheduler.enqueueHistoryRepair("timer");

	await scheduler.flush("timer");

	assert.equal(scheduler.tasks.length, 1);
	assert.equal(failures, 1);
	assert.equal(healthy, 0);
	assert.equal(restored, 1);
});

test("scheduler clears device failures only after a fully responsive flush", async (t) => {
	const r = await createRuntime(t);
	const { DeviceGattScheduler } = await r.load(".cool/store/device/gatt-scheduler.ts");
	let healthy = 0;
	let synced = 0;
	const device = {
		boundDeviceId: "AA:BB",
		isGattTaskBusy: () => false,
		getGattTaskName: () => "",
		connection: {
			async switchToConnectMode() {
				return true;
			},
			async switchToBroadcastMode() {},
			async disconnectDevice() {}
		},
		protocolProbe: {
			async check() {
				return { status: "OK", latencyMs: 10, deviceTimestamp: 1760000000 };
			}
		},
		health: {
			recordUnresponsive() {},
			recordHealthyConnection() {
				healthy++;
			}
		},
		history: {},
		tick: {
			markHistorySynced() {
				synced++;
			}
		},
		errorMessage: { value: "" }
	};
	const scheduler = new DeviceGattScheduler(device);
	scheduler.enqueueHistoryRepair("timer");

	await scheduler.flush("timer");

	assert.equal(scheduler.tasks.length, 0);
	assert.equal(healthy, 1);
	assert.equal(synced, 1);
});

test("a successful manual abandoned-page retry clears its audit without rewinding baseline", async (t) => {
	const r = await createRuntime(t);
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	const { historyFailureStore } = await r.load(
		".cool/bluetooth/history/history-failure-store.ts"
	);
	const before = Math.floor(Date.now() / 1000) - 10;
	r.db.exec(`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${before})`);
	await historyFailureStore.recordTimeout(before - 120, before, before - 30);
	await historyFailureStore.recordTimeout(before - 120, before, before - 20);
	await historyFailureStore.recordTimeout(before - 120, before, before - 10);
	const reader = {
		async readVitalRangeManual() {
			return { status: "DONE", saveOk: true, savedRecords: 10 };
		}
	};

	const result = await r.historyRepair.retryAbandonedRange(reader, before - 120, before);

	assert.equal(result.status, "DONE");
	assert.equal(await historyFailureStore.get(before - 120, before), null);
	assert.equal(await baseline.getBaseline(), before);
});

test("device pages render the decoupled protocol-health warning", async () => {
	const component = await readFile("pages/device/components/DeviceHealthWarning.uvue", "utf8");
	const indexPage = await readFile("pages/device/index.uvue", "utf8");
	const detailPage = await readFile("pages/device/detail.uvue", "utf8");
	assert.equal(component.includes("warningActive"), true);
	assert.equal(component.includes("modalPending"), true);
	assert.equal(component.includes("acknowledgeModal"), true);
	assert.match(component, /const modalPending = computed<boolean>/);
	assert.match(component, /watch\(\s*modalPending,/);
	assert.doesNotMatch(component, /watch\(\s*\(\)\s*=>/);
	assert.equal(indexPage.includes("<DeviceHealthWarning"), true);
	assert.equal(detailPage.includes("<DeviceHealthWarning"), true);
});

test("history-gap diagnostics expose abandoned pages through the repair use case", async () => {
	const popup = await readFile("pages/device/components/HistoryGapRepairPopup.uvue", "utf8");
	const page = await readFile("pages/device/test.uvue", "utf8");
	assert.equal(popup.includes("listAbandonedHistoryRanges"), true);
	assert.equal(popup.includes('emit("retry-abandoned"'), true);
	assert.equal(page.includes('@retry-abandoned="retryAbandonedHistoryRange"'), true);
	assert.match(page, /retryAbandonedRange\(\s*deviceStore\.history/);
});
