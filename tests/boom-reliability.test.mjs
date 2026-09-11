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

test("vital reads do not spread callback options through Android JSON serialization", async () => {
	const source = await readFile(".cool/store/device/history-reader.ts", "utf8");
	const method = source.slice(
		source.indexOf("async readVitalDataAuto("),
		source.indexOf("async readVitalTaskGroup(")
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
	assert.equal(gapPopup.includes("当前游标"), true);
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
		HistoryGapRepairPopup: ["repairGroup", "listPendingTaskGroups", "countPendingTasks", "scheduleOpenRefresh"],
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

test("automatic history repair uses the same grouped read window as the manual popup", async () => {
	const progress = await readFile(".cool/bluetooth/history/progress.ts", "utf8");
	const sync = await readFile(".cool/store/device/sync.ts", "utf8");
	assert.equal(progress.includes("groupHistoryTasksForRead"), true);
	assert.equal(progress.includes("listPendingTaskGroups"), true);
	// 自动补录不再直接读 plan() 的固定批次，而是按剩余时间预算挑任务。
	assert.equal(sync.includes("historyProgress.listBudgetedTasks(deadlineAt)"), true);
	assert.equal(sync.includes("groupHistoryTasksForRead(budgeted)"), true);
	assert.equal(sync.includes("readVitalTaskGroup(gap.tasks, deadlineAt)"), true);
	assert.equal(sync.includes("lastCheckAt.value = Date.now()"), true);
});
test("the GATT link budget leaves room for broadcast between repair rounds", async () => {
	const scheduler = await readFile(".cool/store/device/gatt-scheduler.ts", "utf8");
	const sync = await readFile(".cool/store/device/sync.ts", "utf8");
	// 补录期间广播是停的：单次预算必须有界，且回访间隔要留出广播时间。
	assert.equal(scheduler.includes("const GATT_FLUSH_BUDGET_MS = 120 * 1000"), true);
	assert.equal(sync.includes("HISTORY_AUTO_BACKLOG_INTERVAL_MS"), true);
	assert.equal(sync.includes("backlog ? HISTORY_AUTO_BACKLOG_INTERVAL_MS"), true);
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
	const sync = new r.DeviceSync({ boundDeviceId: "device" });
	const attempted = [];
	const gaps = [
		{ deviceId: "device", kind: "recent", tasks: [{ id: "recent" }] },
		{ deviceId: "device", kind: "archive", tasks: [{ id: "archive:a" }] }
	];
	const noData = {
		status: "DONE",
		message: "target window complete",
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
	let script = { recent: noData, "archive:a": noData };
	sync.device.history = {
		async readVitalTaskGroup(tasks) {
			attempted.push(tasks[0].id);
			return script[tasks[0].id];
		}
	};
	// 前一个缺口“设备没数据”不是失败：同一次连接里后面的缺口仍然要读。
	await sync.runVitalGaps(gaps, Date.now() + 60000);
	assert.deepEqual(attempted, ["recent", "archive:a"]);
	// 真正的链路失败仍然中止本轮，避免在坏连接上反复超时。
	attempted.length = 0;
	script = { recent: linkFailure, "archive:a": linkFailure };
	await sync.runVitalGaps(gaps, Date.now() + 60000);
	assert.deepEqual(attempted, ["recent"]);
});

test("data diagnostics popup offers copy and export actions for visible logs", async () => {
	const source = await readFile("pages/device/components/DataDiagnosticsPopup.uvue", "utf8");
	assert.equal(source.includes("saveCsvToDownloads"), true);
	assert.equal(source.includes("uni.setClipboardData"), true);
	assert.equal(source.includes("复制当前日志"), true);
	assert.equal(source.includes("导出当前日志"), true);
	assert.equal(source.includes('"diagnostic-log"'), true);
	assert.equal(source.includes('"protocol-log"'), true);
	assert.equal(source.includes(".txt`"), true);
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

test("a grouped history-gap repair uses one continuous 0x3A/0x3B reader", async () => {
	const page = await readFile("pages/device/test.uvue", "utf8");
	const reader = await readFile(".cool/store/device/history-reader.ts", "utf8");
	assert.equal(page.includes("readVitalTaskGroup(tasks)"), true);
	assert.equal(reader.includes("readVitalTaskGroup"), true);
	assert.equal(reader.includes("连续补录"), true);
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
	assert.deepEqual(
		rows(r.db, "SELECT id FROM ppi_data ORDER BY id"),
		[{ id: "current" }, { id: "old-pending" }]
	);
});
test("automatic repair continues after one planning/database failure", async (t) => {
	const r = await createRuntime(t);
	let wakes = 0;
	const sync = new r.DeviceSync({ boundDeviceId: "device" });
	r.sleep = async () => {
		wakes++;
		r.queryFailure = wakes === 1;
		assert.ok(wakes <= 2, "loop failed to recover and schedule repair");
	};
	sync.device.scheduler = {
		enqueueHistoryRepair() {},
		enqueueEventBackfill() {
			return false;
		},
		requestFlush() {
			sync.stopAutoRepair();
		}
	};
	sync.autoEnabled = true;
	sync.autoGeneration = 1;
	await sync.runAutoLoop(1);
	assert.equal(wakes, 2);
});

for (const response of [null, "ok", {}, { status: "error" }, { code: 0, status: "error" }]) {
	test(`upload keeps pending rows for ambiguous/failed HTTP 200: ${JSON.stringify(response)}`, async (t) => {
		const r = await createRuntime(t);
		r.seed(2);
		r.response = response;
		assert.equal(await r.manager.uploadPpiData(), false);
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
	assert.equal(await r.manager.uploadPpiData(), true);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 1").get().n, 2);
});

test("backlog is bounded per request; failed batch remains retryable", async (t) => {
	const r = await createRuntime(t);
	r.seed(750);
	r.respond = (options) => {
		if (r.posts.length === 2) options.fail({ message: "offline" });
		else options.success({ statusCode: 200, data: { status: "success" } });
	};
	assert.equal(await r.manager.uploadPpiData(), false);
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
	assert.equal(await r.manager.uploadPpiData(), true);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n, 0);
});

test("upload lock covers database reads and prevents duplicate simultaneous batches", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	await Promise.all([r.manager.uploadPpiData(), r.manager.uploadPpiData()]);
	assert.equal(r.posts.length, 1);
});

test("failed uploaded-flag write is reported as failure", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.executeFailure = true;
	assert.equal(await r.manager.uploadPpiData(), false);
});

test("uploadData reports failure instead of unconditional success", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.respond = (options) => options.fail({ message: "offline" });
	assert.equal(await r.manager.uploadData(), false);
});

test("expired credentials reject instead of leaving upload locked indefinitely", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.user.token = "expired";
	r.expired = true;
	r.refreshExpired = true;
	const outcome = await Promise.race([
		r.manager.uploadPpiData(),
		new Promise((resolve) => setTimeout(() => resolve("pending"), 30))
	]);
	assert.equal(outcome, false);
	assert.equal(r.manager.isUploading, false);
});

test("database query failure is not treated as an empty successful upload", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.queryFailure = true;
	assert.equal(await r.manager.uploadData(), false);
	assert.equal(r.posts.length, 0);
});

test("database scan failure does not plan a fabricated empty-history repair", async (t) => {
	const r = await createRuntime(t);
	r.queryFailure = true;
	await assert.rejects(new r.DeviceSync({ boundDeviceId: "device" }).planHistorySync());
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

test("failed upload waits for retry instead of re-requesting on every broadcast", async (t) => {
	const r = await createRuntime(t);
	r.seed(30);
	r.respond = (options) => options.fail({ message: "offline" });
	assert.equal(await r.manager.requestPpiUpload(), false);
	assert.equal(await r.manager.requestPpiUpload(), false);
	assert.equal(r.posts.length, 1);
	r.respond = null;
	r.manager.lastPpiUploadFailedAt -= 31000;
	assert.equal(await r.manager.requestPpiUpload(), true);
});

test("a small throttled batch is pending, not reported as uploaded", async (t) => {
	const r = await createRuntime(t);
	r.seed(2);
	assert.equal(await r.manager.uploadData(), false);
	assert.equal(r.posts.length, 0);
	r.manager.lastPpiUploadAttemptAt -= 31000;
	assert.equal(await r.manager.uploadData(), true);
	assert.equal(r.posts.length, 1);
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
	assert.equal(await r.manager.uploadPpiData(), true);
	assert.equal(r.posts.length, 1);
	assert.equal(r.posts[0].data.datas.length, 30);
	// 读取期间新到的实时秒留到下一轮，既不撑长本轮，也不算本轮失败。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n, 1);
});

test("per-run budget leaves a large backlog for later and releases the upload lock", async (t) => {
	const r = await createRuntime(t);
	r.seed(3600);
	assert.equal(await r.manager.uploadPpiData(), false);
	assert.ok(r.posts.length <= 10);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE uploaded = 0").get().n,
		600
	);
	assert.equal(r.manager.isUploading, false);
	assert.equal(await r.manager.uploadPpiData(), true);
});

test("sleep failure is preserved and contributes to uploadData result", async (t) => {
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO sleep_data VALUES ('1000', 1000, 60, 60, 0, 0, '', 0)");
	r.response = { status: "error" };
	assert.equal(await r.manager.uploadData(), false);
	assert.equal(r.db.prepare("SELECT uploaded FROM sleep_data").get().uploaded, 0);
	r.response = { status: "success" };
	assert.equal(await r.manager.uploadData(), true);
	assert.equal(r.db.prepare("SELECT uploaded FROM sleep_data").get().uploaded, 1);
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
	const { historyProgress } = await r.load(".cool/bluetooth/history/progress.ts");
	const task = (await historyProgress.plan("device", 100000)).find((x) => x.kind === "archive");
	const device = {
		boundDeviceId: task.deviceId,
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
	const reading = reader.readVitalTaskGroup([task]);
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
	r.manager.scheduleUpload();
	r.manager.scheduleUpload();
	assert.equal(r.timers.length, 1);
	r.timers.shift()();
	await new Promise(setImmediate);
	assert.equal(r.posts.length, 1);
	assert.equal(r.manager.isUploading, true);
	pendingRequest.success({ statusCode: 200, data: { status: "success" } });
	await new Promise(setImmediate);
	assert.equal(r.manager.isUploading, false);
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
	// 直接落一条已规划任务，让读取链路从 101200 反向走到 100000。
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('archive:100000:101200','archive',100000,101200,101200,'pending',0,0,'')"
	);
	const task = {
		id: "archive:100000:101200",
		deviceId: "device",
		kind: "archive",
		fromSec: 100000,
		toSec: 101200,
		cursorSec: 101200,
		status: "pending",
		retryAt: 0,
		attempts: 0
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {}; // Omit native inter-command delay; keep the real read loop.
	const read = await reader.readVitalTaskGroup([task]);
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
	const { historyProgress } = await r.load(".cool/bluetooth/history/progress.ts");
	let query;
	let stopped = false;
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
				stopped = true;
				return false;
			}
		}
	};
	const before = Math.floor(Date.now() / 1000);
	// recent 任务的窗口就是 [stable, 下一整分钟)，直接驱动它走的同一条读取链路。
	const recent = (await historyProgress.plan("device", before)).find(
		(x) => x.kind === "recent"
	);
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const read = await reader.readVitalTaskGroup([recent]);
	const after = Math.floor(Date.now() / 1000);
	assert.equal(stopped, true);
	assert.equal(query.startSec, recent.cursorSec);
	assert.ok(query.startSec >= before && query.startSec <= after + 60);
	assert.equal(query.direction, 0);
	// 锚点在未来，因此只有已经产生的秒入库。
	assert.ok(read.savedRecords >= 60 && read.savedRecords <= 120);
	assert.equal(
		r.db.prepare("SELECT MAX(timestamp) AS last FROM ppi_data").get().last < after,
		true
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
