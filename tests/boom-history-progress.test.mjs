import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "./helpers/boom-runtime.mjs";

const page = (startSec, count = 120) => ({
	startSec,
	direction: 0,
	n: 2,
	rmssdSdnn: [{}, {}],
	vitalData: Array.from({ length: count }, () => ({ hr: 0, ppi: 0, valid: true }))
});
async function setup(t) {
	const r = await createRuntime(t);
	const m = await r.load(".cool/bluetooth/history/progress.ts");
	r.progress = m.historyProgress;
	return r;
}
test("local coverage distinguishes stored seconds, missing seconds, and checked-empty seconds", async (t) => {
	const r = await createRuntime(t);
	const { analyzeLocalCoverage } = await r.load(".cool/bluetooth/history/coverage.ts");
	const plain = analyzeLocalCoverage(
		{ fromSec: 100, toSec: 110 },
		[100, 101, 104, 105, 109],
		[]
	);
	assert.equal(plain.presentSeconds, 5);
	assert.equal(plain.missingSeconds, 5);
	assert.deepEqual(plain.missingRanges, [
		{ fromSec: 102, toSec: 104 },
		{ fromSec: 106, toSec: 109 }
	]);
	assert.deepEqual(plain.repairRanges, plain.missingRanges);
	const checked = analyzeLocalCoverage(
		{ fromSec: 100, toSec: 110 },
		[100, 101, 104, 105, 109],
		[{ fromSec: 102, toSec: 106 }]
	);
	assert.deepEqual(checked.checkedWithoutPpiRanges, [{ fromSec: 102, toSec: 104 }]);
	assert.deepEqual(checked.repairRanges, [{ fromSec: 106, toSec: 109 }]);
});
test("automatic and manual repair share one nearby-fragment GATT window rule", async (t) => {
	const r = await createRuntime(t);
	const { canReadHistoryTaskGroup, groupHistoryTasksForRead } = await r.load(
		".cool/bluetooth/history/progress.ts"
	);
	const tasks = [
		{
			id: "archive:100:101",
			deviceId: "",
			kind: "archive",
			fromSec: 100,
			toSec: 101,
			cursorSec: 101,
			status: "pending",
			retryAt: 0,
			attempts: 0
		},
		{
			id: "archive:103:104",
			deviceId: "device",
			kind: "archive",
			fromSec: 103,
			toSec: 104,
			cursorSec: 104,
			status: "pending",
			retryAt: 0,
			attempts: 1
		}
	];
	assert.equal(canReadHistoryTaskGroup(tasks), true);
	const views = groupHistoryTasksForRead(tasks);
	assert.equal(views.length, 1);
	assert.equal(views[0].deviceId, "");
	assert.deepEqual(views[0].taskIds, ["archive:100:101", "archive:103:104"]);
	assert.equal(views[0].fromSec, 100);
	assert.equal(views[0].toSec, 104);
	assert.equal(views[0].repairSeconds, 2);
	assert.equal(views[0].bridgeSeconds, 2);
});
test("newest window is read before long history even when it starts later", async (t) => {
	const r = await createRuntime(t);
	const { groupHistoryTasksForRead } = await r.load(".cool/bluetooth/history/progress.ts");
	const task = (kind, fromSec, toSec) => ({
		id: `${kind}:${fromSec}:${toSec}`,
		deviceId: "device",
		kind,
		fromSec,
		toSec,
		cursorSec: toSec,
		status: "pending",
		retryAt: 0,
		attempts: 0
	});
	// recent 的 fromSec 最大；只按 fromSec 排序会把它排到最后，尾部预算被 archive 吃光。
	const views = groupHistoryTasksForRead([
		task("archive", 100, 200),
		task("recent", 900, 960),
		task("incremental", 500, 560)
	]);
	assert.deepEqual(
		views.map((item) => item.kind),
		["recent", "incremental", "archive"]
	);
	assert.equal(views[0].fromSec, 900);
	// 同一优先级内部仍按起点升序，保证相邻合并与 repair/bridge 统计不受影响。
	// 两段间隔超过 120 秒的桥接窗口，因此保持为两个独立分组。
	const sameKind = groupHistoryTasksForRead([
		task("archive", 400, 500),
		task("archive", 100, 200)
	]);
	assert.deepEqual(
		sameKind.map((item) => item.fromSec),
		[100, 400]
	);
});
test("coverage service queries local PPI separately from checked-empty ranges", async (t) => {
	const r = await createRuntime(t);
	r.db.exec("INSERT INTO ppi_data VALUES ('100',100,0,0,0,0)");
	r.db.exec("INSERT INTO ppi_data VALUES ('101',101,0,0,0,0)");
	r.db.exec("INSERT INTO ppi_data VALUES ('105',105,0,0,0,0)");
	r.db.exec("INSERT INTO vital_history_ranges VALUES (102,104)");
	const { historyCoverage } = await r.load(".cool/bluetooth/history/coverage-service.ts");
	const snapshot = await historyCoverage.inspect({ fromSec: 100, toSec: 106 });
	assert.deepEqual(snapshot.missingRanges, [{ fromSec: 102, toSec: 105 }]);
	assert.deepEqual(snapshot.checkedWithoutPpiRanges, [{ fromSec: 102, toSec: 104 }]);
	assert.deepEqual(snapshot.repairRanges, [{ fromSec: 104, toSec: 105 }]);
	assert.equal(historyCoverage.retentionStartSec(2592100), 100);
});
test("history reconciliation queues only local missing seconds", async (t) => {
	const r = await setup(t);
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('archive:100:1900','archive',100,1900,1900,'pending',0,0,'')"
	);
	for (let second = 100; second < 1900; second++) {
		if (second >= 400 && second < 460) continue;
		r.db.exec(`INSERT INTO ppi_data VALUES ('${second}',${second},0,0,0,0)`);
	}
	const tasks = await r.progress.reconcilePendingTasks(2000);
	assert.deepEqual(
		tasks.map((item) => [item.fromSec, item.toSec]),
		[[400, 460]]
	);
});
test("only a complete all-FF second is invalid; zero and partial FF remain valid", async (t) => {
	const r = await createRuntime(t);
	assert.equal(r.parser.parseVitalDataPerSecond("ffffffffffff", 0).valid, false);
	assert.equal(r.parser.parseVitalDataPerSecond("000000000000", 0).valid, true);
	assert.equal(r.parser.parseVitalDataPerSecond("0000ff000000", 0).valid, true);
});
test("a repair batch stays capped while the popup can report the whole queue", async (t) => {
	const r = await setup(t);
	const { HISTORY_TASK_BATCH_LIMIT, groupHistoryTasksForRead } = await r.load(
		".cool/bluetooth/history/progress.ts"
	);
	// 每小时只有 1 秒有数据：本地因此留下大量互不相邻的碎片缺口。
	const end = 1000000;
	const values = [];
	for (let second = end - 3600; second < end; second += 5)
		values.push(`('${second}',${second},70,0,900,1)`);
	r.db.exec(`INSERT INTO ppi_data VALUES ${values.join(",")}`);
	const planned = await r.progress.plan("device", end);
	const total = await r.progress.countPendingTasks();
	assert.ok(total > HISTORY_TASK_BATCH_LIMIT, `total=${total}`);
	assert.equal(planned.length, HISTORY_TASK_BATCH_LIMIT);
	// 弹窗列出的必须正好是这一次补录会处理的任务，否则“补完还显示”会被误读成失败。
	const groups = groupHistoryTasksForRead(await r.progress.listPendingTasks());
	let listed = 0;
	for (const group of groups) listed += group.taskIds.length;
	assert.equal(listed, HISTORY_TASK_BATCH_LIMIT);
	assert.ok(groups.length >= 1);
});
test("an unscanned span is reported as pending-scan, not as a confirmed gap", async (t) => {
	const r = await setup(t);
	// 每天佩戴 8 小时、30 天：本地缺失的秒绝大多数只是“没佩戴”，不是设备缺数据。
	const end = 1000000;
	const values = [];
	for (let day = 0; day < 30; day++) {
		const dayStart = end - (day + 1) * 86400;
		for (let second = 0; second < 8 * 3600; second++)
			values.push(`('${dayStart + second}',${dayStart + second},70,0,900,1)`);
	}
	r.db.exec(`INSERT INTO ppi_data VALUES ${values.join(",")}`);
	await r.progress.plan("device", end);
	const scanSpan = () => {
		const rows = r.db
			.prepare("SELECT from_sec,to_sec FROM vital_history_tasks WHERE kind='scan'")
			.all();
		if (rows.length === 0) return 0;
		let total = 0;
		for (const row of rows) total += row.to_sec - row.from_sec;
		return total;
	};
	// 未扫描部分必须是 scan 任务：它不是“确认缺数据”，不该被当成真缺口占用完整链路。
	assert.ok(scanSpan() > 0);
	// 每轮调和只比对最近 6 小时，未扫描余量因此逐轮收缩，而不是原地不动。
	const before = scanSpan();
	// scan 余量带 1 秒退避（避免同轮反复调和），这里让它到期以模拟下一轮检查。
	r.db.exec("UPDATE vital_history_tasks SET retry_at=0 WHERE kind='scan'");
	await r.progress.plan("device", end + 60);
	assert.ok(scanSpan() < before, `${scanSpan()} !< ${before}`);
	// 真缺口只来自本次比对到的窗口，跨度受调和窗口约束。
	const archive = r.db
		.prepare("SELECT from_sec,to_sec FROM vital_history_tasks WHERE kind='archive'")
		.all();
	for (const item of archive) assert.ok(item.to_sec - item.from_sec <= 6 * 3600);
});
test("a gap wider than one link budget is still selected so its cursor advances", async (t) => {
	const r = await setup(t);
	const { groupHistoryTasksForRead } = await r.load(".cool/bluetooth/history/progress.ts");
	// 一个 6 小时的 archive 窗口约 180 页，超过 120 秒预算（约 82 页）。
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('archive:900000:921600','archive',900000,921600,921600,'pending',0,0,'')"
	);
	const picked = await r.progress.listBudgetedTasks(Date.now() + 120000);
	// 必须选中：否则它会永远排在队尾、永远读不到（游标永远不会推进）。
	assert.equal(picked.length, 1);
	assert.equal(picked[0].id, "archive:900000:921600");
	// 再多的任务也不会被一起拖进来，链路只跑这一个窗口。
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('archive:800000:810000','archive',800000,810000,810000,'pending',0,0,'')"
	);
	const picked2 = await r.progress.listBudgetedTasks(Date.now() + 120000);
	assert.ok(picked2.length >= 1);
	let span = 0;
	const groups = groupHistoryTasksForRead(picked2);
	for (const group of groups) span += group.toSec - group.fromSec;
	assert.ok(span <= 12 * 3600, `span=${span}`);
});
test("a small group at the head of the queue cannot starve a huge group behind it", async (t) => {
	const r = await setup(t);
	const { groupHistoryTasksForRead } = await r.load(".cool/bluetooth/history/progress.ts");
	// 队头是 3 分钟的 recent，队尾是一段跨度极大的旧历史：后者远超单次预算，
	// 但必须仍被选中，否则它的游标永远不推进，每轮都重读同一段。
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('recent','recent',999840,1000020,1000020,'pending',0,0,'')"
	);
	r.db.exec(
		"INSERT INTO vital_history_tasks VALUES ('archive:400000:999000','archive',400000,999000,999000,'pending',0,0,'')"
	);
	const picked = await r.progress.listBudgetedTasks(Date.now() + 120000);
	const kinds = groupHistoryTasksForRead(picked).map((g) => g.kind);
	assert.ok(kinds.includes("recent"), `kinds=${kinds}`);
	assert.ok(kinds.includes("archive"), `kinds=${kinds}`);
});
test("realtime metric display preserves zero and labels only nonzero invalid values", async (t) => {
	const r = await createRuntime(t);
	const { formatRealtimeMetric } = await r.load(".cool/bluetooth/boom-parser.ts");
	assert.equal(formatRealtimeMetric(0, false, 0), "0");
	assert.equal(formatRealtimeMetric(0, false, 1), "0");
	assert.equal(formatRealtimeMetric(-1, false, 0), "invalid");
	assert.equal(formatRealtimeMetric(86.3, true, 1), "86.3");
});
test("truncated vital response is rejected instead of being treated as a short page", async (t) => {
	const r = await createRuntime(t);
	// 1 minute summary (8B) + one complete 6B second + one trailing byte.
	const response = "010000000001" + "0000000000000000" + "000000000000" + "aa";
	assert.throws(() => r.parser.parseVitalDataResponse(response), /截断/);
});
test("a short vital response with complete seconds is retained for cursor progression", async (t) => {
	const r = await createRuntime(t);
	// 设备允许短页：n=1 的摘要后，只返回一个完整的全 FF 秒记录。
	const response = "010000000001" + "ffffffffffffffff" + "ffffffffffff";
	const parsed = r.parser.parseVitalDataResponse(response);
	assert.equal(parsed.n, 1);
	assert.equal(parsed.vitalData.length, 1);
	assert.equal(parsed.vitalData[0].valid, false);
});

test("vital CSV export preserves both zero values and complete-FF invalid seconds", async (t) => {
	const r = await createRuntime(t);
	const { buildVitalHistoryCsv } = await r.load(".cool/bluetooth/history/export.ts");
	const csv = buildVitalHistoryCsv([
		{
			startSec: 100,
			direction: 0,
			n: 1,
			rmssdSdnn: [],
			vitalData: [
				{ hr: 0, status: 0, pitch: 0, acc: 0, ppi: 0, valid: true },
				{ hr: 255, status: 255, pitch: 255, acc: 255, ppi: 65535, valid: false }
			]
		}
	]);
	assert.match(
		csv,
		/timestamp,local_time,page_start_sec,page_index,second_index,hr,ppi,status,pitch,acc,valid/
	);
	assert.match(csv, /100,\t1970-01-01 08:01:40,100,1,0/);
	assert.match(csv, /100,.*?,100,1,0,0,0,0,0,0,1/);
	assert.match(csv, /101,.*?,100,1,1,255,65535,255,255,255,0/);
});

test("a six-byte zero timestamp frame finishes history reading without a minute summary", async (t) => {
	const r = await createRuntime(t);
	const parsed = r.parser.parseVitalDataResponse("000000000002");
	assert.equal(parsed.startSec, 0);
	assert.equal(parsed.direction, 0);
	assert.equal(parsed.n, 2);
	assert.deepEqual(parsed.rmssdSdnn, []);
	assert.deepEqual(parsed.vitalData, []);
});
test("session repair tables do not retain a device identifier", async (t) => {
	const r = await createRuntime(t);
	for (const table of ["vital_history_state", "vital_history_tasks", "vital_history_ranges"]) {
		const columns = r.db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((x) => x.name);
		assert.equal(columns.includes("device_id"), false);
	}
});
test("planner includes all retained history and aligns newest query to next minute", async (t) => {
	const r = await setup(t);
	const tasks = await r.progress.plan("device", 46861);
	assert.equal(tasks[0].cursorSec, 46920); // 13:01:01 -> 13:02
	assert.ok(tasks.some((x) => x.kind === "archive" && x.fromSec > 1));
});
test("history planning and page persistence work without modern SQLite upsert syntax", async (t) => {
	const r = await setup(t);
	// Android's embedded SQLite rejects `ON CONFLICT ... DO UPDATE`; retain support for it.
	r.failSql = (sql) => sql.includes("ON CONFLICT");
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	assert.equal(await r.progress.savePage(task, page(task.cursorSec - 120), task.cursorSec), 120);
	assert.equal((await r.progress.getTask(task.id)).cursorSec, task.cursorSec - 120);
});
test("page data and cursor commit together; zero values are queued for upload", async (t) => {
	const r = await setup(t);
	const tasks = await r.progress.plan("device", 100000);
	const task = tasks.find((x) => x.kind === "archive");
	const end = task.cursorSec;
	assert.equal(await r.progress.savePage(task, page(end - 120), end), 120);
	const saved = await r.progress.getTask(task.id);
	assert.equal(saved.cursorSec, end - 120);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE hr=0 AND ppi=0 AND uploaded=0").get()
			.n,
		120
	);
});
test("clearing an app session removes repair bookkeeping but keeps collected seconds", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.savePage(task, page(task.cursorSec - 120), task.cursorSec);
	await r.manager.clearHistorySession();
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_tasks").get().n, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_state").get().n, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges").get().n, 0);
});
test("reopening the session schema keeps the current app cursor", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.savePage(task, page(task.cursorSec - 120), task.cursorSec);
	const cursor = (await r.progress.getTask(task.id)).cursorSec;
	assert.equal(await r.progress.initializeSessionSchema(), true);
	assert.equal((await r.progress.getTask(task.id)).cursorSec, cursor);
});
test("session diagnostics show pending repair and the oldest unuploaded second", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.savePage(task, page(task.cursorSec - 120), task.cursorSec);
	const diagnostic = await r.manager.getHistorySessionDiagnostics();
	assert.ok(diagnostic.pendingTasks >= 1);
	assert.equal(diagnostic.unuploadedCount, 120);
	assert.equal(diagnostic.earliestUnuploadedSec, task.cursorSec - 120);
});
test("completed session tasks are removed when the next planning pass starts", async (t) => {
	const r = await setup(t);
	await r.database.execute(
		"INSERT INTO vital_history_tasks VALUES ('completed','archive',1,2,1,'done',0,0,'')"
	);
	await r.progress.plan("device", 47461);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_tasks WHERE status='done'").get().n,
		0
	);
});
test("cursor write failure rolls back page rows and allows retry", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	r.failSql = (sql) => sql.startsWith("UPDATE vital_history_tasks");
	await assert.rejects(r.progress.savePage(task, page(task.cursorSec - 120), task.cursorSec));
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 0);
	assert.equal((await r.progress.getTask(task.id)).cursorSec, task.cursorSec);
});
test("unproduced newest seconds are never confirmed; new stable time gets its own task", async (t) => {
	const r = await setup(t);
	const recent = (await r.progress.plan("device", 46861))[0];
	await r.progress.savePage(recent, page(46800), 46740);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges WHERE to_sec>46740").get().n,
		0
	);
	const later = await r.progress.plan("device", 47461);
	assert.ok(later.some((x) => x.kind === "incremental" && x.fromSec >= 46740));
});
test("a device jump becomes deferred verification rather than confirmed coverage", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.savePage(task, page(task.cursorSec - 600), task.cursorSec);
	const verify = r.db
		.prepare("SELECT from_sec,to_sec FROM vital_history_tasks WHERE kind='verify'")
		.get();
	assert.equal(verify.to_sec, task.cursorSec);
	assert.equal(verify.from_sec, task.cursorSec - 480);
	assert.equal(
		r.db.prepare("SELECT MAX(to_sec) AS n FROM vital_history_ranges").get().n,
		task.cursorSec - 480
	);
});
test("database transaction excludes interleaved writes and rolls back only its own changes", async (t) => {
	const r = await createRuntime(t);
	r.failSql = (sql) => sql === "INVALID";
	const tx = r.database.transaction(["INSERT INTO ppi_data VALUES ('1',1,0,0,0,0)", "INVALID"]);
	const concurrent = r.database.execute("INSERT INTO ppi_data VALUES ('2',2,0,0,0,0)");
	assert.equal(await tx, false);
	assert.equal(await concurrent, true);
	assert.deepEqual(
		r.db
			.prepare("SELECT id FROM ppi_data")
			.all()
			.map((x) => x.id),
		["2"]
	);
});
function attach(r, task, failAfter = Infinity, beforeContinue = () => {}) {
	let cursor = task.cursorSec,
		count = 0;
	const queries = [];
	const send = () => {
		if (count >= failAfter) return false;
		count++;
		cursor -= 120;
		reader.latestVitalDataResponse = page(cursor);
		reader.vitalDataResponseSeqValue++;
		return true;
	};
	const device = {
		boundDeviceId: task.deviceId,
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData(query) {
				queries.push(query);
				cursor = query.startSec;
				return send();
			},
			async continueReadVitalData(minutes) {
				assert.equal(minutes, 2);
				beforeContinue();
				return send();
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	return { reader, queries };
}
test("manual vital reading commits a page before requesting the next page", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const originalStore = r.manager.storeHistoricalHeartRateRecordsBatch.bind(r.manager);
	let storedPages = 0;
	r.manager.storeHistoricalHeartRateRecordsBatch = async (records) => {
		storedPages++;
		return await originalStore(records);
	};
	const connected = attach(r, task, 2, () => assert.equal(storedPages, 1));
	const result = await connected.reader.readVitalDataAuto({
		startSec: task.cursorSec,
		direction: 0,
		minutes: 2,
		maxPages: 2,
		uploadAfterSave: false
	});
	assert.equal(result.savedRecords, 240);
	assert.equal(storedPages, 2);
});
test("zero maxPages leaves test reads running until the caller stops them", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const connected = attach(r, task, 101);
	let resultPages = 0;
	const result = await connected.reader.readVitalDataAuto({
		startSec: task.cursorSec,
		direction: 0,
		minutes: 2,
		maxPages: 0,
		persistData: false,
		onPage: (_response, pageNumber) => {
			resultPages = pageNumber;
		},
		shouldStop: () => resultPages >= 101
	});
	assert.equal(result.status, "STOPPED");
	assert.equal(result.pages, 101);
});
test("disconnect after one page preserves rows and restart resumes with a new 3A", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const first = attach(r, task, 1);
	const failed = await first.reader.readVitalTaskGroup([task]);
	assert.equal(failed.status, "SEND_FAILED");
	assert.equal(failed.savedRecords, 120);
	const resume = await r.progress.getTask(task.id);
	assert.equal(resume.cursorSec, task.cursorSec - 120);
	assert.ok(resume.retryAt > Date.now());
	const second = attach(r, resume, 1);
	await second.reader.readVitalTaskGroup([resume]);
	assert.equal(second.queries[0].startSec, task.cursorSec - 120);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 240);
});
test("a page newer than its query anchor is skipped and 0x3B continues toward the target", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	let reader;
	let continues = 0;
	const device = {
		boundDeviceId: task.deviceId,
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData(query) {
				reader.latestVitalDataResponse = page(query.startSec + 480);
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				continues++;
				if (continues > 1) return false;
				reader.latestVitalDataResponse = page(task.cursorSec - 120);
				reader.vitalDataResponseSeqValue++;
				return true;
			}
		}
	};
	reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const result = await reader.readVitalTaskGroup([task]);
	assert.equal(result.saveOk, true);
	assert.equal(result.savedRecords, 120);
	assert.equal(continues, 2);
	assert.equal((await r.progress.getTask(task.id)).cursorSec, task.cursorSec - 120);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
});
test("a device page older than the whole target window ends the gap as no-data", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	let reader;
	let continues = 0;
	const device = {
		boundDeviceId: task.deviceId,
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				// 设备的最新数据早于整个目标窗口：它已经越过窗口，这段区间没有数据。
				reader.latestVitalDataResponse = page(task.fromSec - 600, 2);
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				continues++;
				return false;
			}
		}
	};
	reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const result = await reader.readVitalTaskGroup([task]);
	// 不是失败，否则同一次连接里排在后面的缺口会被一起放弃。
	assert.equal(result.saveOk, true);
	assert.equal(result.status, "DONE");
	assert.equal(result.message, "target window complete");
	assert.equal(continues, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 0);
	// 未返回的秒按“没有”处理：不制造覆盖证明，也不留下 6 小时后重查的 verify 任务。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges").get().n, 0);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_tasks WHERE kind='verify'").get().n,
		0
	);
	const after = await r.progress.getTask(task.id);
	assert.equal(after.status, "done");
	assert.equal(after.retryAt, 0);
	assert.equal(after.attempts, 0);
});
test("time budget pauses between pages while retaining the committed cursor", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const { reader } = attach(r, task);
	const deadline = Date.now() + 9000;
	// Spend the remaining budget in the native inter-page delay, without real waiting.
	let advanced = false;
	reader.sleep = async () => {
		advanced = true;
	};
	const original = Date.now;
	Date.now = () => (advanced ? deadline : original());
	try {
		const result = await reader.readVitalTaskGroup([task], deadline);
		assert.equal(result.message, "history repair budget reached");
		assert.ok(result.savedRecords > 0);
		assert.equal((await r.progress.getTask(task.id)).cursorSec < task.cursorSec, true);
	} finally {
		Date.now = original;
	}
});
test("no-more marker does not manufacture coverage or retry in the same app session", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.noMore(task);
	assert.equal((await r.progress.getTask(task.id)).status, "done");
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges").get().n, 0);
	const next = await r.progress.plan("device", 100000);
	assert.equal(
		next.some((item) => item.id === task.id),
		false
	);
});
test("new recent window replaces a delayed old window without losing stable backlog", async (t) => {
	const r = await setup(t);
	const recent = (await r.progress.plan("device", 46861))[0];
	await r.progress.defer(recent, "older device segment");
	const tasks = await r.progress.plan("device", 47461);
	assert.equal(tasks[0].kind, "recent");
	assert.equal(tasks[0].cursorSec, 47520);
	assert.ok(tasks.some((x) => x.kind === "incremental" && x.fromSec === 46740));
	await assert.rejects(r.progress.savePage(recent, page(46800), 47340));
	assert.equal((await r.progress.getTask(recent.id)).cursorSec, 47520);
});
test("adjacent confirmed pages merge without bridging unread gaps", async (t) => {
	const r = await setup(t);
	let task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const end = task.cursorSec;
	await r.progress.savePage(task, page(end - 120), end);
	task = await r.progress.getTask(task.id);
	await r.progress.savePage(task, page(end - 240), end);
	assert.deepEqual(
		r.db
			.prepare("SELECT from_sec,to_sec FROM vital_history_ranges")
			.all()
			.map((x) => ({ ...x })),
		[{ from_sec: end - 240, to_sec: end }]
	);
	task = await r.progress.getTask(task.id);
	await r.progress.savePage(task, page(end - 480), end);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges").get().n, 2);
});

test("an invalid second never overwrites an existing ppi_data row", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const start = task.cursorSec - 120;
	// 先写入一段真实数据，并标记为已上传。
	const good = page(start, 120);
	assert.equal(await r.progress.savePage(task, good, task.cursorSec), 120);
	r.db.prepare("UPDATE ppi_data SET hr=70, ppi=1234, uploaded=1").run();
	const before = r.db
		.prepare("SELECT COUNT(*) AS n, SUM(hr) AS hr, SUM(ppi) AS ppi, SUM(uploaded) AS up FROM ppi_data")
		.get();
	assert.equal(before.n, 120);

	// 重读同一段，这次设备返回全 FF 秒（valid=false），并混入其它无效值。
	const invalid = page(start, 120);
	for (let i = 0; i < invalid.vitalData.length; i++) {
		invalid.vitalData[i] = { hr: 255, ppi: 65535, valid: false };
	}
	const next = await r.progress.getTask(task.id);
	assert.equal(await r.progress.savePage(next, invalid, next.cursorSec), 0);

	const after = r.db
		.prepare("SELECT COUNT(*) AS n, SUM(hr) AS hr, SUM(ppi) AS ppi, SUM(uploaded) AS up FROM ppi_data")
		.get();
	// 行数、数值、上传标记都不得被无效数据改动。
	assert.deepEqual(after, before);
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE hr=255 OR ppi=65535").get().n,
		0
	);
});

test("a valid re-read repairs only legacy placeholder rows, never real values", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const start = task.cursorSec - 120;
	// 模拟旧版占位记录与一条真实记录并存。
	r.db
		.prepare(
			"INSERT INTO ppi_data (id,timestamp,hr,spo2,ppi,uploaded) VALUES " +
				`('${start}',${start},255,0,65535,1),` +
				`('${start + 1}',${start + 1},70,0,1234,1)`
		)
		.run();
	const saved = await r.progress.savePage(task, page(start, 120), task.cursorSec);
	// 返回值是"本页提交的秒数"（INSERT OR IGNORE 会静默忽略已存在的行），不是新增行数。
	assert.equal(saved, 120);
	// 因此这里要按落库结果断言：窗口内仍然只有 120 行，没有重复插入。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
	const repaired = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();
	// 占位行被补全并重新排队上传。
	assert.deepEqual({ ...repaired }, { hr: 0, ppi: 0, uploaded: 0 });
	const untouched = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start + 1}'`)
		.get();
	// 真实值不被重读改写。
	assert.deepEqual({ ...untouched }, { hr: 70, ppi: 1234, uploaded: 1 });
});

test("an FF re-read never touches a second the broadcast already stored", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const start = task.cursorSec - 120;
	// 广播先落了真实值（每秒广播走 storeBroadcastPpiData）。
	assert.equal(await r.manager.storeBroadcastPpiData(start, 72, 980, 4321), true);
	const before = r.db
		.prepare(`SELECT hr, spo2, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();

	// 之后历史补录对同一秒返回全 FF。
	const ff = page(start, 120);
	for (let i = 0; i < ff.vitalData.length; i++) {
		ff.vitalData[i] = { hr: 255, ppi: 65535, valid: false };
	}
	assert.equal(await r.progress.savePage(task, ff, task.cursorSec), 0);

	const after = r.db
		.prepare(`SELECT hr, spo2, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();
	assert.deepEqual({ ...after }, { ...before });
	assert.deepEqual({ ...after }, { hr: 72, spo2: 980, ppi: 4321, uploaded: 0 });
});

test("a fully valid re-read repairs a broadcast all-FF second", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const start = task.cursorSec - 120;
	// 广播把设备给的 FF 原始值照存（广播不按有效性过滤）。
	assert.equal(await r.manager.storeBroadcastPpiData(start, 255, 0, 65535), true);
	// 历史补录给出真实值。
	const valid = page(start, 120);
	valid.vitalData[0] = { hr: 68, status: 0, pitch: 0, acc: 0, ppi: 999, valid: true };
	await r.progress.savePage(task, valid, task.cursorSec);
	const repaired = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();
	assert.deepEqual({ ...repaired }, { hr: 68, ppi: 999, uploaded: 0 });
});

test("a partially invalid broadcast row is not repaired by a valid re-read", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind == "archive");
	const start = task.cursorSec - 120;
	// 广播的 hr 与 ppi 各自独立取原始值：心率有效但 PPI 缺失时是混合行。
	assert.equal(await r.manager.storeBroadcastPpiData(start, 70, 0, 65535), true);
	const valid = page(start, 120);
	valid.vitalData[0] = { hr: 68, status: 0, pitch: 0, acc: 0, ppi: 999, valid: true };
	await r.progress.savePage(task, valid, task.cursorSec);
	const row = r.db.prepare(`SELECT hr, ppi FROM ppi_data WHERE id='${start}'`).get();
	// 占位修复要求整行都是 FF，混合行落不进这个条件，只能保留广播的原值。
	assert.deepEqual({ ...row }, { hr: 70, ppi: 65535 });
});
