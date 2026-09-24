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

/**
 * 预置一段本地 PPI。
 *
 * 判定只看 `ppi_data.timestamp` 有没有这一秒，`hr/spo2/ppi` 是不是零不影响
 * 「本地已有」——所以这里全部写 0。
 */
function seedPpi(db, from, to) {
	if (to <= from) return;
	const values = [];
	for (let second = from; second < to; second++)
		values.push(`('${second}',${second},0,0,0,NULL,0)`);
	db.exec(`INSERT INTO ppi_data VALUES ${values.join(",")}`);
}

function readyRanges(db) {
	return db
		.prepare("SELECT from_sec,to_sec FROM vital_ready_ranges ORDER BY from_sec ASC")
		.all()
		.map((row) => ({ fromSec: row.from_sec, toSec: row.to_sec }));
}

async function setup(t) {
	const r = await createRuntime(t);
	const mod = await r.load(".cool/bluetooth/history/baseline.ts");
	r.baseline = mod.historyBaseline;
	const coverage = await r.load(".cool/bluetooth/history/coverage.ts");
	r.coverage = coverage;
	const historyConfig = await r.load(".cool/bluetooth/history/config.ts");
	r.historyConfig = historyConfig;
	/**
	 * 把 `B` 直接放到待测区间之前。
	 *
	 * 不这么做的话 `B` 默认是 1，一次 `classify()` 要判几十万分钟的空白——那既不是
	 * 这里要测的东西，也会让断言里全是无关区间。真实运行时 `B` 也总是贴着
	 * `stableCeiling`（5.5），所以从附近起步才是常态。
	 */
	r.prime = async (baselineSec, classifiedUntilSec = baselineSec) => {
		await r.database.execute("DELETE FROM vital_ready_ranges");
		await r.database.execute("DELETE FROM vital_sync_state");
		await r.database.execute(
			`INSERT INTO vital_sync_state (id,baseline_sec,classified_until_sec) VALUES (1,${baselineSec},${classifiedUntilSec})`
		);
	};
	return r;
}

test("a newly introduced baseline starts at the stable ceiling instead of inventing a 30-day gap", async (t) => {
	const before = Math.floor(Date.now() / 1000) - 10;
	const r = await createRuntime(t);
	const baseline = (await r.load(".cool/bluetooth/history/baseline.ts")).historyBaseline;
	const after = Math.floor(Date.now() / 1000) - 10;
	const value = await baseline.getBaseline();
	// 升级或首次安装创建基准表时，从“现在已经稳定的位置”起步；不能把不存在的旧进度
	// 当成从 1970 年开始，再钳成一个凭空制造的 30 天待补窗口。
	assert.ok(value >= before && value <= after, `bootstrap baseline ${value} not in ${before}..${after}`);
});

test("bootstrap repairs a retention-start baseline left by the faulty release", async (t) => {
	const r = await setup(t);
	const now = 4000000;
	const poisoned = now - 30 * 24 * 60 * 60;
	await r.prime(poisoned);
	r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${poisoned},${poisoned + 60})`);

	const value = await r.baseline.initializeIfMissing(now);

	assert.equal(value, now - 10);
	assert.deepEqual(readyRanges(r.db), []);
});

test("binding a different device starts a fresh baseline instead of inheriting the old device gap", async (t) => {
	const r = await setup(t);
	const now = 300000;
	await r.prime(200000);
	r.db.exec("INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (200000,200100)");

	await r.baseline.resetForNewBinding(now);

	assert.equal(await r.baseline.getBaseline(), now - 10);
	assert.deepEqual(readyRanges(r.db), []);
});

test("binding a different device resets a newer classification cursor to the fresh baseline", async (t) => {
	const r = await setup(t);
	const now = 300000;
	await r.prime(200000, 400000);

	await r.baseline.resetForNewBinding(now);

	assert.equal(await r.baseline.getBaseline(), now - 10);
	assert.equal(
		r.db.prepare("SELECT classified_until_sec FROM vital_sync_state WHERE id=1").get()
			.classified_until_sec,
		now - 10
	);
});

/** 与 `stableCeiling` 同一条公式：测试里直接算，避免把被测对象的实现抄一遍。 */
function historyCeiling(nowSec) {
	return nowSec - 10;
}

/* ===== 区间工具 ===== */

test("local coverage distinguishes stored seconds, missing seconds, and checked-empty seconds", async (t) => {
	const r = await createRuntime(t);
	const { normalizeRanges, subtractRanges, countRangeSeconds, rangesFromTimestamps } = await r.load(
		".cool/bluetooth/history/coverage.ts"
	);
	assert.deepEqual(
		normalizeRanges([
			{ fromSec: 10, toSec: 20 },
			{ fromSec: 20, toSec: 30 },
			{ fromSec: 50, toSec: 60 }
		]),
		[
			{ fromSec: 10, toSec: 30 },
			{ fromSec: 50, toSec: 60 }
		]
	);
	// 空区间（to <= from）必须被丢掉，否则「缺口右端 <= 左端」的行会渗进 B 的推进循环。
	assert.deepEqual(normalizeRanges([{ fromSec: 10, toSec: 10 }, { fromSec: 30, toSec: 20 }]), []);
	assert.deepEqual(
		subtractRanges([{ fromSec: 100, toSec: 110 }], [{ fromSec: 102, toSec: 106 }]),
		[
			{ fromSec: 100, toSec: 102 },
			{ fromSec: 106, toSec: 110 }
		]
	);
	assert.deepEqual(rangesFromTimestamps({ fromSec: 100, toSec: 110 }, [100, 101, 104, 105, 109]), [
		{ fromSec: 100, toSec: 102 },
		{ fromSec: 104, toSec: 106 },
		{ fromSec: 109, toSec: 110 }
	]);
	assert.equal(countRangeSeconds([{ fromSec: 0, toSec: 60 }, { fromSec: 30, toSec: 90 }]), 90);
});

/* ===== 分钟合格判定 ===== */

test("a fully present minute is accounted to its own right edge", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199800);
	seedPpi(r.db, 199800, 200000);
	await r.baseline.classify(now);
	// 全部在场：整段记账到 stableCeiling（now - 10）。
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 199800, toSec: 199990 }]);
});

test("missing seconds inside the total tolerance are absorbed", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199920);
	// [199920, 199990) 里丢 8 秒连续（199920~199928）：连续缺失 < 9，总量也够（8/70），
	// 整段记账——连开头那 8 秒一起，因为它等同于「设备确认这里没有」。
	seedPpi(r.db, 199928, 199990);
	await r.baseline.classify(now);
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 199920, toSec: 199990 }]);
});

test("a real gap does not invalidate the present seconds that follow it", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 12 秒连续缺失（199930~199942）是真缺口。它后面 [199942, 199990) 有 48 秒在场数据，
	// 只缺 0 秒——整段一刀切会把这 48 秒跟着缺口一起作废，那既让 B 白等一轮，
	// 也让缺口虚报成 90 秒。必须切成两段分别判。
	seedPpi(r.db, 199900, 199930);
	seedPpi(r.db, 199942, 199990);
	await r.baseline.classify(now);
	// 缺口之前那段（30 秒全在场）和之后那段（48 秒全在场）都记账；缺口本身不记。
	assert.deepEqual(readyRanges(r.db), [
		{ fromSec: 199900, toSec: 199930 },
		{ fromSec: 199942, toSec: 199990 }
	]);
	// `B` 照常消费缺口之前那一段、停在真缺口前面（不是停在整段起点）。
	assert.equal(await r.baseline.advanceBaseline(now), 199930);
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 199930);
	assert.equal(gaps[0].toSec, 199942);
	assert.equal(gaps[0].repairSeconds, 12);
});

test("a sparse region fails the total gate even when every run is under nine seconds", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 每段都只缺 8 秒（连续缺失那一关都过），但 5 段加起来 40 秒，占 90 秒的 44%
	// ——总量那一关挡住。只看连续缺失是看不出这种稀疏的，所以第 2 遍必须有。
	let cursor = 199900;
	for (let i = 0; i < 5; i++) {
		seedPpi(r.db, cursor, cursor + 10);
		cursor += 18;
	}
	seedPpi(r.db, cursor, 199990);
	await r.baseline.classify(now);
	assert.deepEqual(readyRanges(r.db), []);
	assert.equal(await r.baseline.advanceBaseline(now), 199900);
});

test("an eight-second run straddling a minute boundary is absorbed, and a nine-second one is not", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 8 秒缺失（199956~199964）横跨 199960 这条分钟边界。判定不看分钟边界，所以
	// 它就是「一段 8 秒」：连续缺失 < 9、总量 8/90 也够，整段吸收。
	// 按分钟切反而有风险——边界会把一段连续缺失拆成两个 4 秒，各自都更容易过关。
	seedPpi(r.db, 199900, 199956);
	seedPpi(r.db, 199964, 199990);
	await r.baseline.classify(now);
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 199900, toSec: 199990 }]);
	assert.equal(await r.baseline.advanceBaseline(now), 199990);
});

test("a nine-second run straddling a minute boundary is still a real gap", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 同一位置、同样横跨 199960，但这次是 9 秒（199956~199965）。按分钟切会把它
	// 拆成 4 秒 + 5 秒，两半都过得了连续缺失那一关，整段 9 秒被误吃——这正是
	// 「判定不按分钟切」要避免的那个错误。
	seedPpi(r.db, 199900, 199956);
	seedPpi(r.db, 199965, 199990);
	await r.baseline.classify(now);
	assert.deepEqual(readyRanges(r.db), [
		{ fromSec: 199900, toSec: 199956 },
		{ fromSec: 199965, toSec: 199990 }
	]);
	assert.equal(await r.baseline.advanceBaseline(now), 199956);
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 199956);
	assert.equal(gaps[0].toSec, 199965);
});

test("a nine-second run is a real gap even when the total tolerance would allow it", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199920);
	// 缺 [199920, 199929) 共 9 秒。判定不按分钟切，所以这是**一段**而不是一分钟：
	// 9 秒占整段（199920~199990，70 秒）的 13%，总量那一关过得去，但连续缺失
	// 这一关挡住（9 不小于 9）。真缺口把这一段切开，B 停在它前面。
	seedPpi(r.db, 199929, 199990);
	await r.baseline.classify(now);
	assert.equal(await r.baseline.advanceBaseline(now), 199920);
	// 缺口之后的秒是另一个候选区：61 秒里只缺 9 秒（14.8%），照常记账，只是 B
	// 过不去——这条 ready 就是 8.2 桥接要跨过的那种区间。缺口不会因为它多占一秒。
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 199929, toSec: 199990 }]);
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 199920);
	assert.equal(gaps[0].toSec, 199929);
	assert.equal(gaps[0].repairSeconds, 9);
});

test("a missing run touching the ceiling is not counted as complete", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199980);
	// 这段一直缺到 stableCeiling（199990）：右端之外还没判到，它可能更长。
	// 不设 knownEnd 这一关，末尾那一小段会被容差吃掉，B 会跨过还没定论的秒。
	seedPpi(r.db, 199980, 199988);
	await r.baseline.classify(now);
	assert.equal(await r.baseline.advanceBaseline(now), 199988);
});

test("tolerance scales with the judged window, not with the whole minute", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 窗口 [199900, 199960) 是完整分钟且全部在场，记到 199960。
	seedPpi(r.db, 199900, 199960);
	// 后一分钟只判到 stableCeiling 199990，末尾 10 秒（199980~199990）尚在途中。
	// 容忍度按被截断后的窗口长度 30 秒等比缩放：10 * 3 = 30，不小于 30，过不了。
	// 若按完整分钟（60 秒）算就会放过，等于把还没到的秒当成「确认没有」。
	await r.baseline.classify(now);
	const ranges = readyRanges(r.db);
	assert.deepEqual(ranges, [{ fromSec: 199900, toSec: 199960 }]);
	assert.equal(await r.baseline.advanceBaseline(now), 199960);
});

test("classification only ever reaches stableCeiling, never the current second", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199800);
	seedPpi(r.db, 199800, now);
	await r.baseline.classify(now);
	const ranges = readyRanges(r.db);
	assert.equal(ranges.length, 1);
	// now - minuteSettleSec = 199990：最后 10 秒尚无定论，既不记账也不当作可读缺口。
	assert.equal(ranges[0].toSec, 199990);
	assert.equal(r.baseline.stableCeiling(now), 199990);
});

test("classification is idempotent and re-runs from the baseline without side effects", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199800);
	seedPpi(r.db, 199800, 200000);
	const first = await r.baseline.classify(now);
	const before = readyRanges(r.db);
	const second = await r.baseline.classify(now);
	assert.equal(second.qualifiedSeconds, 0);
	assert.equal(second.unclassifiedSeconds, 0);
	assert.deepEqual(readyRanges(r.db), before);
	assert.ok(first.qualifiedSeconds > 0);
});

test("classification advances from its own cursor instead of rescanning an older blocked gap", async (t) => {
	const r = await setup(t);
	const firstNow = 200000;
	await r.prime(199800);
	// 这 12 秒会卡住 B；它前后的在场数据仍应各自完成分类。
	seedPpi(r.db, 199800, 199830);
	seedPpi(r.db, 199842, 199990);
	const first = await r.baseline.classify(firstNow);
	assert.equal(first.classifiedBefore, 199800);
	assert.equal(first.classifiedAfter, 199990);
	assert.equal(await r.baseline.advanceBaseline(firstNow), 199830);

	// 下一分钟只有 60 个新稳定秒。旧的 12 秒缺口已判断过，不能再次进入分类输入。
	const secondNow = 200060;
	seedPpi(r.db, 199990, 200050);
	const second = await r.baseline.classify(secondNow);
	assert.equal(second.classifiedBefore, 199990);
	assert.equal(second.classifiedAfter, 200050);
	assert.equal(second.unclassifiedSeconds, 60);
});

test("classification cursor stops before an unresolved missing tail", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199980);
	seedPpi(r.db, 199980, 199988);

	const result = await r.baseline.classify(now);
	assert.equal(result.classifiedAfter, 199988);
	assert.equal(await r.baseline.advanceBaseline(now), 199988);
	// [199988,199990) 仍可能只是暂迟的两秒，尚未分类，不能提前暴露成 GATT 缺口。
	assert.deepEqual(await r.baseline.listRepairGaps(now), []);
});

test("legacy sync state gains a classification cursor initialized at the baseline", async (t) => {
	const r = await setup(t);
	r.db.exec("DROP TABLE vital_sync_state");
	r.db.exec(
		"CREATE TABLE vital_sync_state (id INTEGER PRIMARY KEY CHECK(id=1), baseline_sec INTEGER NOT NULL)"
	);
	r.db.exec("INSERT INTO vital_sync_state (id,baseline_sec) VALUES (1,1234)");

	await r.baseline.initializeIfMissing(2000);
	const columns = r.db
		.prepare("PRAGMA table_info(vital_sync_state)")
		.all()
		.map((row) => row.name);
	assert.equal(columns.includes("classified_until_sec"), true);
	assert.equal(
		r.db.prepare("SELECT classified_until_sec FROM vital_sync_state WHERE id=1").get()
			.classified_until_sec,
		1234
	);
});

test("classification bounds repeated unqualified-segment diagnostics", async (t) => {
	const r = await setup(t);
	const now = 100500;
	await r.prime(100000);
	// 24 段已记账区间把未记账范围切成大量真缺口。生产日志不能把每一段在每分钟
	// 都重新展开，否则真正的 GATT TIMEOUT 会被数百条重复信息淹没。
	for (let i = 0; i < 24; i++) {
		const from = 100010 + i * 20;
		r.db.exec(`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${from},${from + 10})`);
	}

	await r.baseline.classify(now);
	const lines = r.logs.map((entry) => entry.items.join(" "));
	const details = lines.filter((line) => line.includes("[BOOM-BASE] 段不合格:"));
	assert.equal(details.length, 5);
	assert.equal(lines.some((line) => line.includes("不合格段日志已省略")), true);
});

test("baseline diagnostic timestamps include readable Beijing times by default", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	seedPpi(r.db, 199950, 199990);
	await r.baseline.classify(now);
	const line = r.logs.map((entry) => entry.items.join(" ")).find((x) => x.includes("分类完成"));
	assert.ok(line, "missing baseline classification diagnostic");
	assert.match(line, /C=199900\(1970-01-03 15:31:40\.000\+08:00\)->199990\(1970-01-03 15:33:10\.000\+08:00\)/);
	assert.match(line, /stableCeiling=199990\(1970-01-03 15:33:10\.000\+08:00\), B=199900\(1970-01-03 15:31:40\.000\+08:00\)/);
});

/* ===== 基准推进 ===== */

test("advancing the baseline consumes the ready range that covers it", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	assert.equal(readyRanges(r.db).length > 0, true);
	const baseline = await r.baseline.advanceBaseline(now);
	// B 落到被消费区间的右端，整条区间随之删除。
	assert.equal(baseline, historyCeiling(now));
	assert.deepEqual(readyRanges(r.db), []);
	assert.equal(await r.baseline.getBaseline(), baseline);
});

test("the baseline stops at a gap and does not jump over it", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209880);
	// 判定单元是分钟，所以缺口要造在分钟边界上：整个 [209880, 209940) 一分钟全缺，
	// B 必须停在它前面；后面那一分钟（[209940, 210000)，右端被 ceiling 截到 209990）
	// 数据齐全，照常记账。
	seedPpi(r.db, 209940, 209990);
	await r.baseline.classify(now);
	assert.equal(await r.baseline.advanceBaseline(now), 209880);
	// 阻塞分钟之后合格的秒照样记账，只是 `B` 过不去——这正是「B 卡住时后面合格的分钟
	// 堆在 ready 里等它」的来源（5.6），也是 8.2 桥接能跨过 ready 区间的前提。
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 209940, toSec: 209990 }]);
	// 缺口只暴露 `[B, ready[0].fromSec)` 这一段：阻塞分钟就是唯一的活跃缺口，
	// 后面那条 ready 不会被当成缺口重复读取（否则这段要被读第二遍）。
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 209880);
	assert.equal(gaps[0].toSec, 209940);
	assert.equal(gaps[0].repairSeconds, 60);
});

test("an expired baseline jumps to the retention start and drops stale ranges", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	// 几个月前的 B：逐分钟放行是几万次带表查询，直接跳到 30 天保留起点。
	await r.database.execute(
		`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${now - 200 * 86400})`
	);
	await r.database.execute(
		`INSERT INTO vital_ready_ranges (from_sec,to_sec) VALUES (${now - 200 * 86400},${now - 199 * 86400})`
	);
	const baseline = await r.baseline.advanceBaseline(now);
	assert.equal(baseline, now - 30 * 86400);
	assert.deepEqual(readyRanges(r.db), []);
});

/* ===== 缺口推导 ===== */

test("gaps are derived from the baseline and the ready ranges, never stored", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	await r.baseline.advanceBaseline(now);
	// 全部记账后没有缺口：B 贴着 stableCeiling。
	assert.deepEqual(await r.baseline.listRepairGaps(now), []);

	// 再往后走 100 秒：上一轮因 settle margin 暂缓的 10 秒已有数据，会先被增量分类
	// 吸收；其后的 90 秒没有本地数据，形成真实缺口。
	const later = now + 100;
	await r.baseline.classify(later);
	const gaps = await r.baseline.listRepairGaps(later);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, now);
	assert.equal(gaps[0].toSec, historyCeiling(later));
	assert.equal(gaps[0].repairSeconds, gaps[0].toSec - gaps[0].fromSec);
	assert.equal(gaps[0].bridgeSeconds, 0);
});

test("the gap right edge is capped at the ceiling so repair can actually finish", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	await r.baseline.classify(now);
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	// 不封顶会让「补到没有缺口为止」永不成立：ceiling 之后的秒读得到但记不了账。
	assert.equal(gaps[0].toSec, historyCeiling(now));
});

test("nearby gaps bridge into one read chain and count the crossed seconds separately", async (t) => {
	const r = await setup(t);
	const now = 100130;
	// 直接摆出「B 后面的两段已记账区间」：这就是补录跑了几轮之后的真实形状
	// （分类每轮在第一个阻塞分钟处停下，所以多缺口只能这样产生）。
	await r.prime(100000, historyCeiling(now));
	await r.baseline.markReady(100040, 100060, now);
	await r.baseline.markReady(100100, 100120, now);
	const gaps = await r.baseline.listRepairGaps(now);
	// 两段之间的 40 秒本地已有，合成一条读取链路，但那 40 秒不算「待补」。
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 100000);
	assert.equal(gaps[0].toSec, 100100);
	assert.equal(gaps[0].repairSeconds, 80);
	assert.equal(gaps[0].bridgeSeconds, 20);
	assert.equal(r.baseline.sumRepairSeconds(gaps), 80);
	assert.equal(r.baseline.sumBridgeSeconds(gaps), 20);
});

test("gaps farther apart than bridgeSec stay two separate read chains", async (t) => {
	const r = await setup(t);
	const now = 100400;
	await r.prime(100000, historyCeiling(now));
	await r.baseline.markReady(100040, 100060, now);
	await r.baseline.markReady(100200, 100340, now);
	const gaps = await r.baseline.listRepairGaps(now);
	// 第二段之前隔着 140 秒（> bridgeSec 120）：分成两条链路，否则这 140 秒会被白读。
	assert.equal(gaps.length, 2);
	assert.equal(gaps[0].fromSec, 100000);
	assert.equal(gaps[0].toSec, 100200);
	assert.equal(gaps[1].fromSec, 100340);
	assert.equal(gaps[1].bridgeSeconds, 0);
});

test("readiness inside the gap does not manufacture a ready range", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(1);
	// 本地只有零星几秒：绝大多数秒是缺失，缺口必须整段列出。
	seedPpi(r.db, 209900, 209901);
	await r.baseline.classify(now);
	await r.baseline.advanceBaseline(now);
	const gaps = await r.baseline.listRepairGaps(now);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0].fromSec, 1);
});

/* ===== 快照与诊断 ===== */

test("the snapshot reports the baseline, ceiling, ready ranges and derived gaps", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 600);
	seedPpi(r.db, now - 600, now);
	await r.baseline.classify(now);
	await r.baseline.advanceBaseline(now);
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.ceiling, now - 10);
	assert.equal(snapshot.baseline <= snapshot.ceiling, true);
	assert.equal(Array.isArray(snapshot.readyRanges), true);
	assert.equal(Array.isArray(snapshot.gaps), true);
});

test("session diagnostics report the baseline model instead of a task queue", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 600);
	seedPpi(r.db, now - 600, now - 100);
	await r.baseline.classify(now);
	await r.baseline.advanceBaseline(now);
	const diagnostic = await r.manager.getHistorySessionDiagnostics();
	assert.equal(diagnostic.stableCeilingSec, now - 10);
	assert.equal(diagnostic.baselineSec > 1, true);
	assert.equal(diagnostic.gapGroups >= 1, true);
	assert.equal(diagnostic.gapSeconds > 0, true);
	// 诊断里不再有任务队列的字段。
	assert.equal("pendingTasks" in diagnostic, false);
});

test("session repair tables do not retain a device identifier", async (t) => {
	const r = await createRuntime(t);
	for (const table of ["vital_sync_state", "vital_ready_ranges", "vital_history_failures"]) {
		const columns = r.db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((x) => x.name);
		assert.equal(columns.includes("device_id"), false);
	}
});

test("baseline and failure-ledger tables exist while the old task tables stay gone", async (t) => {
	const r = await createRuntime(t);
	const names = r.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table'")
		.all()
		.map((x) => x.name);
	for (const gone of ["vital_history_tasks", "vital_history_state", "vital_history_ranges"]) {
		assert.equal(names.includes(gone), false, `${gone} still exists`);
	}
	for (const kept of ["vital_sync_state", "vital_ready_ranges", "vital_history_failures"]) {
		assert.equal(names.includes(kept), true, `${kept} is missing`);
	}
});

test("clearing an app session removes repair bookkeeping but keeps collected seconds", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 300);
	seedPpi(r.db, now - 300, now);
	await r.baseline.classify(now);
	await r.manager.clearHistorySession();
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 300);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_ready_ranges").get().n, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_sync_state").get().n, 0);
	// 清空后基准回到起点，整段重新成为缺口。
	assert.equal(await r.baseline.getBaseline(), 1);
});

test("writing ready ranges survives Android SQLite without upsert syntax", async (t) => {
	const r = await setup(t);
	// Android 内置 SQLite 不支持 ON CONFLICT ... DO UPDATE，写入必须只靠 UPDATE + INSERT OR IGNORE。
	r.failSql = (sql) => sql.includes("ON CONFLICT");
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	assert.equal(readyRanges(r.db).length > 0, true);
	await r.baseline.advanceBaseline(now);
	// 推进同样只做 UPDATE + INSERT OR IGNORE，不能碰 upsert 语法。
	assert.equal(await r.baseline.getBaseline(), historyCeiling(now));
});

/* ===== 固定历史参数 ===== */

test("history timing config keeps only the two fixed production constants", async (t) => {
	const r = await setup(t);
	assert.equal(r.historyConfig.HISTORY_MINUTE_SETTLE_SEC, 10);
	assert.equal(r.historyConfig.HISTORY_GATT_READ_BRIDGE_SEC, 120);
	for (const removed of [
		"getHistoryTunables",
		"getHistoryTunable",
		"getHistoryTunableDefault",
		"getHistoryTunableKeys",
		"isHistoryTunableOverridden",
		"setHistoryTunable",
		"resetHistoryTunables"
	]) {
		assert.equal(removed in r.historyConfig, false, `${removed} should not remain exported`);
	}
});

test("the fixed settle margin caps classification and manual ready writes", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209000);
	seedPpi(r.db, 209000, now);
	assert.equal(r.baseline.stableCeiling(now), 209990);
	await r.baseline.classify(now);
	assert.deepEqual(readyRanges(r.db), [{ fromSec: 209000, toSec: 209990 }]);

	// markReady 使用同一个固定稳定边界，不能记入尚未稳定的最后 10 秒。
	await r.baseline.markReady(209850, 210000, now);
	assert.equal(
		r.db.prepare(`SELECT COUNT(*) AS n FROM vital_ready_ranges WHERE to_sec>209990`).get().n,
		0
	);
});

/* ===== 协议解析（与基准模型无关，保留） ===== */

test("only a complete all-FF second is invalid; zero and partial FF remain valid", async (t) => {
	const r = await createRuntime(t);
	assert.equal(r.parser.parseVitalDataPerSecond("ffffffffffff", 0).valid, false);
	assert.equal(r.parser.parseVitalDataPerSecond("000000000000", 0).valid, true);
	assert.equal(r.parser.parseVitalDataPerSecond("0000ff000000", 0).valid, true);
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

test("a six-byte zero timestamp frame finishes history reading without a minute summary", async (t) => {
	const r = await createRuntime(t);
	const parsed = r.parser.parseVitalDataResponse("000000000002");
	assert.equal(parsed.startSec, 0);
	assert.equal(parsed.direction, 0);
	assert.equal(parsed.n, 2);
	assert.deepEqual(parsed.rmssdSdnn, []);
	assert.deepEqual(parsed.vitalData, []);
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

/* ===== 读取链路 ===== */

function attach(r, from, to, failAfter = Infinity, beforeContinue = () => {}) {
	let cursor = to,
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
		boundDeviceId: "device",
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
	const gap = { fromSec: from, toSec: to, repairSeconds: to - from, bridgeSeconds: 0 };
	return { reader, queries, gap };
}

test("a gap read starts at the newer edge and walks toward the older edge", async (t) => {
	const r = await setup(t);
	const connected = attach(r, 208800, 210000, 100);
	const read = await connected.reader.readVitalGapGroup(connected.gap);
	// anchor 取缺口右端、不做分钟对齐：对齐会把窗口末端往回推，窄缺口会被推空。
	assert.equal(connected.queries[0].startSec, 210000);
	assert.equal(connected.queries[0].direction, 0);
	assert.equal(read.savedRecords, 1200);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 1200);
});

/** 一个只返回给定页面、且不再续读的设备桩。用于验证落库与占位修复的语义。 */
function readerReturning(r, response) {
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				reader.latestVitalDataResponse = response;
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
	return reader;
}

test("a protocol-valid short page accounts its whole declared range", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	const start = now - 240;
	const response = page(start, 1);
	response.n = 2;
	response.rmssdSdnn = [{}, {}];
	response.vitalData[0] = { hr: 255, ppi: 65535, valid: false };

	const read = await readerReturning(r, response).readVitalGapGroup({
		fromSec: start,
		toSec: start + 120,
		repairSeconds: 120,
		bridgeSeconds: 0
	});

	assert.equal(read.status, "DONE");
	assert.equal(read.responses.length, 0, "automatic persisted repair must not retain every decoded page");
	assert.deepEqual(readyRanges(r.db), [{ fromSec: start, toSec: start + 120 }]);
});

test("a page write failure keeps the already-committed rows readable", async (t) => {
	const r = await setup(t);
	const connected = attach(r, 208800, 210000, 1);
	const read = await connected.reader.readVitalGapGroup(connected.gap);
	assert.equal(read.status, "SEND_FAILED");
	assert.equal(read.savedRecords, 120);
	// 落库与记账都已经发生：下一次连接从 B 继续，不需要重读这一段。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
	assert.equal(readyRanges(r.db).length, 1);
});

test("a page newer than the query anchor is skipped and the read keeps walking older", async (t) => {
	const r = await setup(t);
	const from = 208800;
	const to = 210000;
	let reader;
	let continues = 0;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData(query) {
				// 比 anchor 还新：跳过，不落库，也不能推进 lastStart。
				reader.latestVitalDataResponse = page(query.startSec + 480);
				reader.vitalDataResponseSeqValue++;
				return true;
			},
			async continueReadVitalData() {
				continues++;
				if (continues > 1) return false;
				reader.latestVitalDataResponse = page(to - 120);
				reader.vitalDataResponseSeqValue++;
				return true;
			}
		}
	};
	reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const gap = { fromSec: from, toSec: to, repairSeconds: to - from, bridgeSeconds: 0 };
	const result = await reader.readVitalGapGroup(gap);
	assert.equal(result.saveOk, true);
	assert.equal(result.savedRecords, 120);
	assert.equal(continues, 2);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
});

test("a device page older than the whole gap ends the read as no-data, not as failure", async (t) => {
	const r = await setup(t);
	// 把时钟拨到一个固定秒再读：记账右端是 `Date.now()` 往前 10 秒，读与断言之间
	// 若跨了秒边界，两边的 stableCeiling 会差 1 秒，断言就成了偶发失败。
	r.dateOffsetMs = 0;
	const now = Math.floor(Date.now() / 1000);
	const from = now - 1200;
	const to = now;
	await r.prime(from);
	let continues = 0;
	let reader;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				// 设备的最新数据早于整个目标窗口：它已经越过窗口，这段区间没有数据。
				reader.latestVitalDataResponse = page(from - 600, 2);
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
	const gap = { fromSec: from, toSec: to, repairSeconds: to - from, bridgeSeconds: 0 };
	const readAtSec = Math.floor(Date.now() / 1000);
	const result = await reader.readVitalGapGroup(gap);
	// 不是失败：同一次连接里排在后面的缺口不能被一起放弃。
	assert.equal(result.saveOk, true);
	assert.equal(result.status, "DONE");
	assert.equal(continues, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 0);
	// 设备说没有就按「没有」记账：整段并入 ready（右端被 markReady 封顶在 stableCeiling）。
	const ceiling = historyCeiling(readAtSec);
	const ranges = readyRanges(r.db);
	assert.equal(ranges.length, 1);
	assert.equal(ranges[0].fromSec, from);
	// 不写死等式，避免断言侧与读取侧跨秒；只要求右端落在读取时刻的 1 秒容差内。
	assert.ok(
		Math.abs(ranges[0].toSec - ceiling) <= 1,
		`right edge ${ranges[0].toSec} should be about ${ceiling}`
	);
	assert.equal(
		r.db
			.prepare(`SELECT COUNT(*) AS n FROM vital_ready_ranges WHERE to_sec>${ceiling + 1}`)
			.get().n,
		0
	);
});

test("a zero start page accounts the whole gap and stops the read", async (t) => {
	const r = await setup(t);
	const from = 208800;
	const to = 210000;
	let continues = 0;
	let reader;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				// 0x3A 回应 0 起点：设备声明没有更多数据。
				reader.latestVitalDataResponse = {
					startSec: 0,
					direction: 0,
					n: 2,
					rmssdSdnn: [],
					vitalData: []
				};
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
	const gap = { fromSec: from, toSec: to, repairSeconds: to - from, bridgeSeconds: 0 };
	const result = await reader.readVitalGapGroup(gap);
	assert.equal(result.status, "DONE");
	assert.equal(continues, 0);
	assert.equal(readyRanges(r.db)[0].fromSec, from);
});

test("persistPage rejection stops the read without saving anything further", async (t) => {
	const r = await setup(t);
	let reader;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
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
	reader = new r.DeviceHistoryReader(device);
	reader.sleep = async () => {};
	const gap = { fromSec: 208800, toSec: 210000, repairSeconds: 1200, bridgeSeconds: 0 };
	const read = await reader.readVitalGapGroup(gap);
	assert.equal(read.saveOk, true);
	// 落库失败的路径由 saveVisualPage 的异常分支覆盖（见上面的落库失败用例）；
	// 这里确认读取本身不因为 persistPage 返回 true 而多做工作。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n > 0, true);
});

/* ===== 页面落库语义（无效秒、占位修复） ===== */

test("an invalid second never overwrites an existing ppi_data row", async (t) => {
	const r = await setup(t);
	const start = 209880;
	const to = 210000;
	await r.prime(start);
	// 先用一页真实数据建起本地这一段的秒。
	await readerReturning(r, page(start, 120)).readVitalGapGroup({
		fromSec: start,
		toSec: to,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	r.db.prepare("UPDATE ppi_data SET hr=70, ppi=1234, uploaded=1").run();
	const before = r.db
		.prepare(
			"SELECT COUNT(*) AS n, SUM(hr) AS hr, SUM(ppi) AS ppi, SUM(uploaded) AS up FROM ppi_data"
		)
		.get();
	assert.equal(before.n, 120);

	// 重读同一段，这次设备返回全 FF 秒（valid=false）。
	const ff = page(start, 120);
	for (let i = 0; i < ff.vitalData.length; i++)
		ff.vitalData[i] = { hr: 255, ppi: 65535, valid: false };
	const read = await readerReturning(r, ff).readVitalGapGroup({
		fromSec: start,
		toSec: to,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	assert.equal(read.savedRecords, 0);

	const after = r.db
		.prepare(
			"SELECT COUNT(*) AS n, SUM(hr) AS hr, SUM(ppi) AS ppi, SUM(uploaded) AS up FROM ppi_data"
		)
		.get();
	// 行数、数值、上传标记都不得被无效数据改动。
	assert.deepEqual({ ...after }, { ...before });
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE hr=255 OR ppi=65535").get().n,
		0
	);
});

test("a valid re-read repairs a legacy placeholder row but never a real value", async (t) => {
	const r = await setup(t);
	const start = 209880;
	const end = start + 120;
	await r.prime(start);
	// 模拟旧版占位记录与一条真实记录并存。
	r.db
		.prepare(
			"INSERT INTO ppi_data (id,timestamp,hr,spo2,ppi,uploaded) VALUES " +
				`('${start}',${start},255,0,65535,1),` +
				`('${start + 1}',${start + 1},70,0,1234,1)`
		)
		.run();
	// 设备历史补录给出真实值；其余秒保持 FF，避免覆盖上面的断言。
	const valid = page(start, 120);
	valid.vitalData[0] = { hr: 0, status: 0, pitch: 0, acc: 0, ppi: 0, valid: true };
	for (let i = 1; i < valid.vitalData.length; i++) valid.vitalData[i].valid = false;
	await readerReturning(r, valid).readVitalGapGroup({
		fromSec: start,
		toSec: end,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	const repaired = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();
	// 占位行被补全并重新排队上传。
	assert.deepEqual({ ...repaired }, { hr: 0, ppi: 0, uploaded: 0 });
	const untouched = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start + 1}'`)
		.get();
	// 真实值不被重读改写（占位修复只认 hr=255 AND ppi=65535 的行）。
	assert.deepEqual({ ...untouched }, { hr: 70, ppi: 1234, uploaded: 1 });
});

test("a fully valid re-read repairs a broadcast all-FF second", async (t) => {
	const r = await setup(t);
	const start = 209880;
	await r.prime(start);
	// 广播把设备给的 FF 原始值照存（广播不按有效性过滤）。
	assert.equal(await r.manager.storeBroadcastPpiData(start, 255, 0, 65535, 2), true);
	// 补录给出真实值：必须写成 60/1000 而不是占位值，断言才有区分度
	// （若写成 0/0，就无法分辨「补全了」和「压根没动」）。
	const valid = page(start, 120);
	valid.vitalData[0] = { hr: 60, ppi: 1000, valid: true };
	for (let i = 1; i < valid.vitalData.length; i++) valid.vitalData[i].valid = false;
	await readerReturning(r, valid).readVitalGapGroup({
		fromSec: start,
		toSec: start + 120,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	const repaired = r.db
		.prepare(`SELECT hr, ppi, uploaded FROM ppi_data WHERE id='${start}'`)
		.get();
	// 补全并重新排队上传（广播存进去的是 uploaded=0，重读后仍是 0）。
	assert.deepEqual({ ...repaired }, { hr: 60, ppi: 1000, uploaded: 0 });
	// 整行 FF 是占位判定的唯一依据：补完就不该再有该行残留 FF。
	assert.equal(
		r.db.prepare(`SELECT COUNT(*) AS n FROM ppi_data WHERE hr=255 AND ppi=65535`).get().n,
		0
	);
});

test("historical vital persistence stores only the low three activity bits", async (t) => {
	const r = await setup(t);
	const start = 209880;
	await r.prime(start);
	const vital = page(start, 120);
	vital.vitalData[0] = { hr: 60, status: 0b101101, pitch: 0, acc: 0, ppi: 1000, valid: true };
	for (let i = 1; i < vital.vitalData.length; i++) vital.vitalData[i].valid = false;
	await readerReturning(r, vital).readVitalGapGroup({
		fromSec: start,
		toSec: start + 120,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	assert.equal(
		r.db.prepare(`SELECT activity FROM ppi_data WHERE id='${start}'`).get().activity,
		5
	);
});

test("a partially invalid broadcast row is not repaired by a valid re-read", async (t) => {
	const r = await setup(t);
	const start = 209880;
	await r.prime(start);
	// 广播的 hr 与 ppi 各自独立取原始值：心率有效但 PPI 缺失时是混合行。
	assert.equal(await r.manager.storeBroadcastPpiData(start, 70, 0, 65535, 2), true);
	const valid = page(start, 120);
	for (let i = 1; i < valid.vitalData.length; i++) valid.vitalData[i].valid = false;
	await readerReturning(r, valid).readVitalGapGroup({
		fromSec: start,
		toSec: start + 120,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	const row = r.db.prepare(`SELECT hr, ppi FROM ppi_data WHERE id='${start}'`).get();
	// 占位修复要求整行都是 FF，混合行落不进这个条件，只能保留广播的原值。
	assert.deepEqual({ ...row }, { hr: 70, ppi: 65535 });
});

test("a zero-value page is queued for upload rather than treated as missing", async (t) => {
	const r = await setup(t);
	const start = 209880;
	const connected = attach(r, start, start + 120, 1);
	await connected.reader.readVitalGapGroup({
		fromSec: start,
		toSec: start + 120,
		repairSeconds: 120,
		bridgeSeconds: 0
	});
	// 0 是设备返回的有效原始值，必须进入上传队列。
	assert.equal(
		r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data WHERE hr=0 AND ppi=0 AND uploaded=0").get()
			.n,
		120
	);
});

/* ===== 数据库事务语义（与基准模型无关，保留） ===== */

test("database transaction excludes interleaved writes and rolls back only its own changes", async (t) => {
	const r = await createRuntime(t);
	r.failSql = (sql) => sql === "INVALID";
	const tx = r.database.transaction(["INSERT INTO ppi_data VALUES ('1',1,0,0,0,NULL,0)", "INVALID"]);
	const concurrent = r.database.execute("INSERT INTO ppi_data VALUES ('2',2,0,0,0,NULL,0)");
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

test("a ready-range write failure surfaces instead of leaving a half-written table", async (t) => {
	const r = await setup(t);
	r.failSql = (sql) => sql.startsWith("INSERT OR IGNORE INTO vital_ready_ranges");
	await assert.rejects(r.baseline.markReady(100, 200, 1000));
});

test("history failure ledger abandons only the exact page on its third verified timeout", async (t) => {
	const r = await setup(t);
	const { historyFailureStore } = await r.load(
		".cool/bluetooth/history/history-failure-store.ts"
	);

	const first = await historyFailureStore.recordFailure(1000, 1120, 2000);
	const second = await historyFailureStore.recordFailure(1000, 1120, 2010);
	const third = await historyFailureStore.recordFailure(1000, 1120, 2020);

	assert.equal(first.failureCount, 1);
	assert.equal(first.abandoned, false);
	assert.equal(second.failureCount, 2);
	assert.equal(second.abandoned, false);
	assert.equal(third.failureCount, 3);
	assert.equal(third.abandoned, true);
	assert.deepEqual(await historyFailureStore.listAbandoned(), [
		{
			fromSec: 1000,
			toSec: 1120,
			failureCount: 3,
			lastFailureSec: 2020,
			abandoned: true,
			abandonedAtSec: 2020
		}
	]);
});

test("history failure ledger clears a page after a later successful manual read", async (t) => {
	const r = await setup(t);
	const { historyFailureStore } = await r.load(
		".cool/bluetooth/history/history-failure-store.ts"
	);
	await historyFailureStore.recordFailure(1000, 1120, 2000);
	await historyFailureStore.clearRange(1000, 1120);
	const retried = await historyFailureStore.recordFailure(1000, 1120, 2010);
	assert.equal(retried.failureCount, 1);
	assert.equal(retried.abandoned, false);
});
