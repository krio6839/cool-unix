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
	const m = await r.load(".cool/bluetooth/history-progress.ts");
	r.progress = m.historyProgress;
	return r;
}
test("only a complete all-FF second is invalid; zero and partial FF remain valid", async (t) => {
	const r = await createRuntime(t);
	assert.equal(r.parser.parseVitalDataPerSecond("ffffffffffff", 0).valid, false);
	assert.equal(r.parser.parseVitalDataPerSecond("000000000000", 0).valid, true);
	assert.equal(r.parser.parseVitalDataPerSecond("0000ff000000", 0).valid, true);
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
	assert.ok(tasks.some((x) => x.kind === "archive" && x.fromSec === 1));
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
	assert.ok(
		later.some((x) => x.kind === "incremental" && x.fromSec === 46740 && x.toSec === 47340)
	);
});
test("a device jump becomes deferred verification rather than confirmed coverage", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.savePage(task, page(task.cursorSec - 3720), task.cursorSec);
	const verify = r.db
		.prepare("SELECT from_sec,to_sec FROM vital_history_tasks WHERE kind='verify'")
		.get();
	assert.equal(verify.to_sec, task.cursorSec);
	assert.equal(verify.from_sec, task.cursorSec - 3600);
	assert.equal(
		r.db.prepare("SELECT MAX(to_sec) AS n FROM vital_history_ranges").get().n,
		task.cursorSec - 3600
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
test("disconnect after one page preserves rows and restart resumes with a new 3A", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	const first = attach(r, task, 1);
	const failed = await first.reader.readVitalWindow(task.fromSec, task.toSec, task);
	assert.equal(failed.status, "SEND_FAILED");
	assert.equal(failed.savedRecords, 120);
	const resume = await r.progress.getTask(task.id);
	assert.equal(resume.cursorSec, task.cursorSec - 120);
	assert.ok(resume.retryAt > Date.now());
	const second = attach(r, resume, 1);
	await second.reader.readVitalWindow(resume.fromSec, resume.toSec, resume);
	assert.equal(second.queries[0].startSec, task.cursorSec - 120);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 240);
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
		const result = await reader.readVitalWindow(task.fromSec, task.toSec, task, deadline);
		assert.equal(result.message, "history repair budget reached");
		assert.ok(result.savedRecords > 0);
		assert.equal((await r.progress.getTask(task.id)).cursorSec < task.cursorSec, true);
	} finally {
		Date.now = original;
	}
});
test("no-more marker does not manufacture coverage and exhausted task survives restart", async (t) => {
	const r = await setup(t);
	const task = (await r.progress.plan("device", 100000)).find((x) => x.kind === "archive");
	await r.progress.noMore(task);
	assert.equal((await r.progress.getTask(task.id)).status, "exhausted");
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_history_ranges").get().n, 0);
});
test("new recent window replaces a delayed old window without losing stable backlog", async (t) => {
	const r = await setup(t);
	const recent = (await r.progress.plan("device", 46861))[0];
	await r.progress.defer(recent, "older device segment", true);
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
