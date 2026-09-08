import test from "node:test";
import assert from "node:assert/strict";
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
	r.executeFailure = true;
	const read = await reader.readVitalWindow(1000, 1300);
	assert.equal(read.saveOk, false);
	assert.equal(read.savedRecords, 0);
	assert.equal(read.uploadAttempted, false);
	assert.equal(r.posts.length, 0);
	assert.equal(released, true);
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
	const reading = reader.readVitalWindow(1000, 1300);
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
	const reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {}; // Omit native inter-command delay; keep the real read loop.
	const read = await reader.readVitalWindow(100000, 101200);
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

test("recent history queries next minute and excludes future seconds", async (t) => {
	const r = await createRuntime(t);
	let query;
	const device = {
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
				reader.latestVitalDataResponse = page(value.startSec - 120, 2);
				reader.vitalDataResponseSeqValue++;
				return true;
			}
		}
	};
	const reader = new r.DeviceHistoryReader(device);
	const before = Math.floor(Date.now() / 1000);
	const read = await reader.readRecentVitalWindow();
	const after = Math.floor(Date.now() / 1000);
	assert.ok(query.startSec >= before && query.startSec <= after + 60);
	assert.equal(query.direction, 0);
	assert.ok(read.savedRecords >= 60 && read.savedRecords <= 120);
});
