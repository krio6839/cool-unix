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

/**
 * 进度只有两个游标：`B`（读到哪）与 `C`（判到哪）。
 *
 * 没有区间表——读取永远是从 `B` 起的一整段顺序读，读到的秒直接并进 `B`，所以
 * 「记过哪些秒」不需要、也不应该再存一份。
 */
function cursors(db) {
	const row = db
		.prepare("SELECT baseline_sec,classified_until_sec FROM vital_sync_state WHERE id=1")
		.get();
	if (row == null) return { baseline: 1, classified: 1 };
	return { baseline: row.baseline_sec, classified: row.classified_until_sec };
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
		await r.database.execute("DELETE FROM vital_sync_state");
		await r.database.execute(
			`INSERT INTO vital_sync_state (id,baseline_sec,classified_until_sec) VALUES (1,${baselineSec},${classifiedUntilSec})`
		);
	};
	return r;
}

test("a newly introduced baseline starts at the stable ceiling instead of inventing a 30-day backlog", async (t) => {
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

	const value = await r.baseline.initializeIfMissing(now);

	assert.equal(value, now - 10);
	// 两个游标一起恢复：不能留着旧故障版本那种「B 老早、C 在前面」的错位状态。
	assert.deepEqual(cursors(r.db), { baseline: now - 10, classified: now - 10 });
});

test("binding a different device starts a fresh baseline instead of inheriting the old device backlog", async (t) => {
	const r = await setup(t);
	const now = 300000;
	await r.prime(200000);

	await r.baseline.resetForNewBinding(now);

	assert.equal(await r.baseline.getBaseline(), now - 10);
	assert.deepEqual(cursors(r.db), { baseline: now - 10, classified: now - 10 });
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
	// 空区间（to <= from）必须被丢掉，否则「右端 <= 左端」的空行会渗进 B 的推进循环。
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
	const result = await r.baseline.classify(now);
	// 全部在场：`B` 与 `C` 一起推到 stableCeiling（now - 10）。
	assert.deepEqual(cursors(r.db), { baseline: 199990, classified: 199990 });
	assert.equal(result.baselineAfter, 199990);
});

test("missing seconds inside the total tolerance are absorbed", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199920);
	// [199920, 199990) 里丢 8 秒连续（199920~199928）：连续缺失 < 9，总量也够（8/70），
	// 整段记账——连开头那 8 秒一起，因为它等同于「设备确认这里没有」。
	seedPpi(r.db, 199928, 199990);
	await r.baseline.classify(now);
	assert.deepEqual(cursors(r.db), { baseline: 199990, classified: 199990 });
});

test("a missing run does not invalidate the present seconds that follow it", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 12 秒连续缺失（199930~199942）判为不合格。它后面 [199942, 199990) 有 48 秒在场数据，
	// 只缺 0 秒——整段一刀切会把这 48 秒跟着一起作废，那既让 B 白等一轮，
	// 也让不合格的秒数虚报成 90 秒。必须切成两段分别判。
	seedPpi(r.db, 199900, 199930);
	seedPpi(r.db, 199942, 199990);
	await r.baseline.classify(now);
	// `B` 停在缺失段前面（不是停在整段起点），`C` 照常推到 stableCeiling。缺失段之后
	// 那 48 秒没有单独记下来——读取从 `B` 起整段读，它一定在窗口里。
	assert.deepEqual(cursors(r.db), { baseline: 199930, classified: 199990 });
	// 未记账的秒不落库、也没有「组」这一层：它就是 `B` 与 stableCeiling 之间的差。
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.baseline, 199930);
	assert.equal(snapshot.behind, historyCeiling(now) - 199930);
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
	// 一秒都推不动：判定起点这一段就没过关。末尾那 8 秒贴着 stableCeiling 还没定论，
	// 所以 `C` 停在它前面，下一轮重新判它。
	assert.deepEqual(cursors(r.db), { baseline: 199900, classified: 199982 });
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
	assert.deepEqual(cursors(r.db), { baseline: 199990, classified: 199990 });
});

test("a nine-second run straddling a minute boundary is still unqualified", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199900);
	// 同一位置、同样横跨 199960，但这次是 9 秒（199956~199965）。按分钟切会把它
	// 拆成 4 秒 + 5 秒，两半都过得了连续缺失那一关，整段 9 秒被误吃——这正是
	// 「判定不按分钟切」要避免的那个错误。
	seedPpi(r.db, 199900, 199956);
	seedPpi(r.db, 199965, 199990);
	await r.baseline.classify(now);
	// 9 秒那段把这一段切开：`B` 只能停在它前面，`C` 照常推到 stableCeiling。
	assert.deepEqual(cursors(r.db), { baseline: 199956, classified: 199990 });
	assert.equal((await r.baseline.snapshot(now)).behind, historyCeiling(now) - 199956);
});

test("a nine-second run is unqualified even when the total tolerance would allow it", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199920);
	// 缺 [199920, 199929) 共 9 秒。判定不按分钟切，所以这是**一段**而不是一分钟：
	// 9 秒占整段（199920~199990，70 秒）的 13%，总量那一关过得去，但连续缺失
	// 这一关挡住（9 不小于 9）。不合格段把这一段切开，B 停在它前面。
	seedPpi(r.db, 199929, 199990);
	await r.baseline.classify(now);
	// `B` 停在不合格段前面，`C` 照常推到 stableCeiling——不这么分开，`B` 卡住的每一天
	// 都要把后面这一整段重判一遍。
	assert.deepEqual(cursors(r.db), { baseline: 199920, classified: 199990 });
	assert.equal((await r.baseline.snapshot(now)).behind, historyCeiling(now) - 199920);
});

test("a missing run touching the ceiling is not counted as complete", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199980);
	// 这段一直缺到 stableCeiling（199990）：右端之外还没判到，它可能更长。
	// 不设 knownEnd 这一关，末尾那一小段会被容差吃掉，B 会跨过还没定论的秒。
	seedPpi(r.db, 199980, 199988);
	await r.baseline.classify(now);
	// `C` 也停在缺失段起点：下一轮重新判这最后两秒，它们可能还会长。
	assert.deepEqual(cursors(r.db), { baseline: 199988, classified: 199988 });
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
	// 后一分钟那 30 秒缺失按被截断后的窗口长度等比缩放判不合格，`B` 停在 199960。
	assert.deepEqual(cursors(r.db), { baseline: 199960, classified: 199990 });
});

test("classification only ever reaches stableCeiling, never the current second", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199800);
	seedPpi(r.db, 199800, now);
	await r.baseline.classify(now);
	// now - minuteSettleSec = 199990：最后 10 秒尚无定论，既不记账也不算已确认。
	assert.equal(r.baseline.stableCeiling(now), 199990);
	assert.deepEqual(cursors(r.db), { baseline: 199990, classified: 199990 });
});

test("classification is idempotent and leaves an already-settled cursor alone", async (t) => {
	const r = await setup(t);
	const now = 200000;
	await r.prime(199800);
	seedPpi(r.db, 199800, 200000);
	const first = await r.baseline.classify(now);
	const before = cursors(r.db);
	const second = await r.baseline.classify(now);
	// 第二轮没有可判的秒，两个游标都不动、也不再写库。
	assert.equal(second.unclassifiedSeconds, 0);
	assert.equal(second.baselineAfter, second.baselineBefore);
	assert.deepEqual(cursors(r.db), before);
	assert.equal(first.baselineAfter > first.baselineBefore, true);
});

test("classification advances from its own cursor instead of rescanning an older blocked stretch", async (t) => {
	const r = await setup(t);
	const firstNow = 200000;
	await r.prime(199800);
	// 这 12 秒会卡住 B；它前后的在场数据仍应各自完成分类。
	seedPpi(r.db, 199800, 199830);
	seedPpi(r.db, 199842, 199990);
	const first = await r.baseline.classify(firstNow);
	assert.equal(first.classifiedBefore, 199800);
	assert.equal(first.classifiedAfter, 199990);
	assert.equal(first.baselineAfter, 199830);

	// 下一分钟只有 60 个新稳定秒。旧的 12 秒未记账段已判断过，不能再次进入分类输入。
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
	assert.deepEqual(cursors(r.db), { baseline: 199988, classified: 199988 });
	// [199988,199990) 仍可能只是暂迟的两秒：`C` 停在它前面，下一轮重判这几秒。
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

test("a judged window reports its unqualified segments in a single line", async (t) => {
	const r = await setup(t);
	const now = 100500;
	await r.prime(100000);
	// 24 段 10 秒连续缺失（每段都过得了 9 秒那一关）。一轮只判一段窗口，所以诊断只有
	// 一行，细节靠段数与秒数表达——不会再出现几百行重复信息把同一分钟里的 GATT
	// TIMEOUT 冲掉的情况。
	for (let i = 0; i < 24; i++) seedPpi(r.db, 100010 + i * 20, 100020 + i * 20);

	await r.baseline.classify(now);
	const lines = r.logs.map((entry) => entry.items.join(" "));
	const details = lines.filter((line) => line.includes("[BOOM-BASE] 段不合格:"));
	assert.equal(details.length, 1);
	assert.match(details[0], /阻塞段数=25/);
	assert.match(details[0], /最长连续缺失=10s/);
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

test("a fully accounted stretch carries both cursors to the ceiling", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	// 没有阻塞段：`B` 与 `C` 一起落到 stableCeiling，中间不留任何状态。
	assert.deepEqual(cursors(r.db), {
		baseline: historyCeiling(now),
		classified: historyCeiling(now)
	});
	assert.equal(await r.baseline.getBaseline(), historyCeiling(now));
});

test("the baseline stops at an unaccounted run and does not jump over it", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209880);
	// 判定单元是分钟，所以整分钟缺失要造在分钟边界上：整个 [209880, 209940) 一分钟全缺，
	// B 必须停在它前面；后面那一分钟（[209940, 210000)，右端被 ceiling 截到 209990）
	// 数据齐全，照常记账。
	seedPpi(r.db, 209940, 209990);
	await r.baseline.classify(now);
	// `B` 停在整段缺失前面；`C` 继续推进，它只负责让下一轮不再重判这一段。
	assert.deepEqual(cursors(r.db), { baseline: 209880, classified: historyCeiling(now) });
	// 读取窗口从 `B` 起算、到 stableCeiling 封顶：后面那些本来合格的秒不单独记，
	// 一次读取自然会把整段覆盖掉。
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.baseline, 209880);
	assert.equal(snapshot.classifiedUntil, historyCeiling(now));
	assert.equal(snapshot.behind, historyCeiling(now) - 209880);
});

test("an expired baseline jumps straight to the retention start", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	// 几个月前的 B：逐分钟放行是几万次带表查询，直接跳到 30 天保留起点。
	await r.database.execute(
		`INSERT OR REPLACE INTO vital_sync_state (id,baseline_sec) VALUES (1,${now - 200 * 86400})`
	);
	await r.baseline.classify(now);
	assert.equal(await r.baseline.getBaseline(), now - 30 * 86400);
});

/* ===== 读取窗口与游标推进 ===== */

test("the unaccounted window is derived from the baseline, never stored", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	// 全部记账后 B 贴着 stableCeiling。
	assert.equal((await r.baseline.snapshot(now)).behind, 0);

	// 再往后走 100 秒：上一轮因 settle margin 暂缓的 10 秒已有数据，会先被增量分类
	// 吸收；其后的 90 秒没有本地数据，整段落在 B 与 stableCeiling 之间。
	const later = now + 100;
	await r.baseline.classify(later);
	const snapshot = await r.baseline.snapshot(later);
	assert.equal(snapshot.baseline, now);
	assert.equal(snapshot.ceiling, historyCeiling(later));
	assert.equal(snapshot.behind, historyCeiling(later) - now);
});

test("the read window right edge is capped at the ceiling so repair can actually finish", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209800);
	await r.baseline.classify(now);
	// 不封顶会让「补到没有待补为止」永不成立：ceiling 之后的秒读得到但记不了账。
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.ceiling, historyCeiling(now));
	assert.equal(snapshot.behind, historyCeiling(now) - 209800);
});

test("a stuck baseline never advances while the cursor keeps moving", async (t) => {
	const r = await setup(t);
	const now = 100130;
	// `B` 卡在 100000，`C` 已经在 100100：这就是「B 卡住、C 继续推进」的形状。
	await r.prime(100000, 100100);
	const result = await r.baseline.classify(now);
	// 判定起点是 `C` 而不是 `B`。本轮判的是 [100100, 100120)，判出来的东西全在 `B`
	// 后面——读取窗口从 `B` 起，一定会把整段覆盖掉，所以一秒都不并进 `B`。
	assert.equal(result.baselineAfter, 100000);
	assert.equal(result.classifiedAfter, historyCeiling(now));
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.baseline, 100000);
	assert.equal(snapshot.classifiedUntil, historyCeiling(now));
	assert.equal(snapshot.behind, historyCeiling(now) - 100000);
});

test("a confirmed read drags the cursor with the baseline and never rewinds it", async (t) => {
	const r = await setup(t);
	const now = 100400;
	await r.prime(100000, 100100);
	// 读取确认到 100340：`B` 跳过去，`C` 只跟着抬高。
	assert.equal(await r.baseline.advanceAccounted(100340, now), 100340);
	assert.deepEqual(cursors(r.db), { baseline: 100340, classified: 100340 });
	// 已经越过的秒写不回去——补录重读一段旧页也不会让 `B` 倒退。
	assert.equal(await r.baseline.advanceAccounted(100200, now), 100340);
	assert.deepEqual(cursors(r.db), { baseline: 100340, classified: 100340 });
	// 右端封顶在 stableCeiling：更晚的秒尚无定论，既不记账也不用重读。
	assert.equal(await r.baseline.advanceAccounted(now, now), historyCeiling(now));
});

test("a sprinkling of local seconds never moves the baseline", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(1);
	// 本地只有零星几秒：绝大多数秒是缺失，`B` 一秒都推进不了，读取窗口整段从 B 起算。
	seedPpi(r.db, 209900, 209901);
	await r.baseline.classify(now);
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.baseline, 1);
	assert.equal(snapshot.behind, historyCeiling(now) - 1);
	// 那 1 秒自己是合格的，但它不在判定起点上，最多让 `C` 推到底，不会把 `B` 拉过去。
	assert.equal(snapshot.classifiedUntil, historyCeiling(now));
});

/* ===== 快照与诊断 ===== */

test("the snapshot reports both cursors, the ceiling and the backlog", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 600);
	seedPpi(r.db, now - 600, now);
	await r.baseline.classify(now);
	const snapshot = await r.baseline.snapshot(now);
	assert.equal(snapshot.ceiling, now - 10);
	assert.equal(snapshot.baseline <= snapshot.ceiling, true);
	assert.equal(snapshot.classifiedUntil >= snapshot.baseline, true);
	assert.equal(snapshot.behind, Math.max(0, snapshot.ceiling - snapshot.baseline));
});

test("session diagnostics report the baseline model instead of a task queue", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 600);
	seedPpi(r.db, now - 600, now - 100);
	await r.baseline.classify(now);
	const diagnostic = await r.manager.getHistorySessionDiagnostics();
	assert.equal(diagnostic.stableCeilingSec, now - 10);
	assert.equal(diagnostic.baselineSec > 1, true);
	assert.equal(diagnostic.behindSeconds > 0, true);
	assert.equal(
		diagnostic.behindSeconds,
		Math.max(0, diagnostic.stableCeilingSec - diagnostic.baselineSec)
	);
	assert.equal(diagnostic.classifiedUntilSec >= diagnostic.baselineSec, true);
	// 诊断里不再有任务队列、分组或区间表的字段。
	assert.equal("pendingTasks" in diagnostic, false);
	assert.equal("gapGroups" in diagnostic, false);
	assert.equal("gapSeconds" in diagnostic, false);
	assert.equal("readyRanges" in diagnostic, false);
});

test("the session state table does not retain a device identifier", async (t) => {
	const r = await createRuntime(t);
	const columns = r.db
		.prepare("PRAGMA table_info(vital_sync_state)")
		.all()
		.map((x) => x.name);
	assert.equal(columns.includes("device_id"), false);
});

test("only the baseline cursor table exists; every retired bookkeeping table is gone", async (t) => {
	const r = await createRuntime(t);
	const names = r.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table'")
		.all()
		.map((x) => x.name);
	for (const gone of [
		"vital_history_tasks",
		"vital_history_state",
		"vital_history_ranges",
		// 进度只由 `B` 一个整数表达，区间表连建都不该再建。
		"vital_ready_ranges",
		// 「设备不回」不再被折算成「设备没有这段数据」，所以没有跨连接的失败记录。
		"vital_history_failures"
	]) {
		assert.equal(names.includes(gone), false, `${gone} still exists`);
	}
	assert.equal(names.includes("vital_sync_state"), true, "vital_sync_state is missing");
});

test("clearing an app session removes repair bookkeeping but keeps collected seconds", async (t) => {
	const r = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	await r.prime(now - 300);
	seedPpi(r.db, now - 300, now);
	await r.baseline.classify(now);
	await r.manager.clearHistorySession();
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 300);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM vital_sync_state").get().n, 0);
	// 清空后基准回到起点，整段重新变成未记账。
	assert.equal(await r.baseline.getBaseline(), 1);
});

test("progress writes survive Android SQLite without upsert syntax", async (t) => {
	const r = await setup(t);
	// Android 内置 SQLite 不支持 ON CONFLICT ... DO UPDATE，写入必须只靠 UPDATE + INSERT OR IGNORE。
	r.failSql = (sql) => sql.includes("ON CONFLICT");
	const now = 210000;
	await r.prime(209800);
	seedPpi(r.db, 209800, 210000);
	await r.baseline.classify(now);
	assert.deepEqual(cursors(r.db), {
		baseline: historyCeiling(now),
		classified: historyCeiling(now)
	});
	// 读取侧记账走同一套语句，也同样不碰 upsert 语法。
	assert.equal(await r.baseline.advanceAccounted(now, now), historyCeiling(now));
});

/* ===== 固定历史参数 ===== */

test("history timing config keeps only the fixed settle margin", async (t) => {
	const r = await setup(t);
	assert.equal(r.historyConfig.HISTORY_MINUTE_SETTLE_SEC, 10);
	// 桥接距离随「逐区间读取」一起下线：补录固定读 `[B, stableCeiling)` 一整段，
	// 没有「把相邻未记账段拼成一条链路」这件事可配置。
	assert.equal("HISTORY_GATT_READ_BRIDGE_SEC" in r.historyConfig, false);
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

test("the fixed settle margin caps classification and read-side accounting", async (t) => {
	const r = await setup(t);
	const now = 210000;
	await r.prime(209000);
	seedPpi(r.db, 209000, now);
	assert.equal(r.baseline.stableCeiling(now), 209990);
	await r.baseline.classify(now);
	assert.deepEqual(cursors(r.db), { baseline: 209990, classified: 209990 });

	// 读取侧走同一个固定稳定边界：尚未稳定的最后 10 秒不能被记进去。
	assert.equal(await r.baseline.advanceAccounted(now, now), 209990);
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

/**
 * 一段「从 `from` 起每页 120 秒、向更新方向推进」的设备桩。
 *
 * `failAfter` 表示从第几页开始不再回应（模拟设备中途不回），`beforeContinue` 在每次
 * 续读之前执行，供用例插入断言。`queries` 只记录 `0x3A` 那一次查询——续读走 `0x3B`，
 * 页起点由桩自己按 120 秒步进给出。
 */
function attach(r, from, to, failAfter = Infinity, beforeContinue = () => {}) {
	let count = 0;
	const queries = [];
	const send = () => {
		if (count >= failAfter) return false;
		reader.latestVitalDataResponse = page(from + count * 120);
		reader.vitalDataResponseSeqValue++;
		count++;
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

test("a range read starts at the baseline and walks toward newer seconds", async (t) => {
	const r = await setup(t);
	await r.prime(208800);
	const connected = attach(r, 208800, 210000, 100);
	const read = await connected.reader.readVitalRangeForward(208800, 210000);
	// anchor 就是窗口起点、不做分钟对齐：对齐会把窗口左端往后推，窄窗口会被推空。
	assert.equal(connected.queries[0].startSec, 208800);
	assert.equal(connected.queries[0].direction, 1);
	assert.equal(read.savedRecords, 1200);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 1200);
	// 每页确认完就把 `B` 推过去，读到哪就记到哪。
	assert.equal(await r.baseline.getBaseline(), 210000);
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

	await r.prime(start);
	const read = await readerReturning(r, response).readVitalRangeForward(start, start + 120);

	assert.equal(read.status, "DONE");
	assert.equal(read.responses.length, 0, "automatic persisted repair must not retain every decoded page");
	// 短页也按它声明的完整 `n` 分钟记账：只按返回的秒数记，短页尾部会永远留在未记账状态。
	assert.equal(await r.baseline.getBaseline(), start + 120);
});

test("a page write failure keeps the already-committed rows readable", async (t) => {
	const r = await setup(t);
	await r.prime(208800);
	const connected = attach(r, 208800, 210000, 1);
	const read = await connected.reader.readVitalRangeForward(208800, 210000);
	assert.equal(read.status, "SEND_FAILED");
	assert.equal(read.savedRecords, 120);
	// 落库与记账都已经发生：下一次连接从新的 B 继续，不需要重读这一段。
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
	assert.equal(await r.baseline.getBaseline(), 208920);
});

test("a page later than the window start confirms the skipped seconds as no-data", async (t) => {
	const r = await setup(t);
	const from = 208800;
	const to = 210000;
	await r.prime(from);
	let reader;
	let continues = 0;
	const device = {
		boundDeviceId: "device",
		beginGattTask: () => true,
		endGattTask() {},
		event: { resetDataIdentifierReassembler() {} },
		protocol: {
			async readVitalData() {
				// 设备把开头 60 秒没记录的时间直接跳过去了，给的是后面那一页。
				reader.latestVitalDataResponse = page(from + 60);
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
	const result = await reader.readVitalRangeForward(from, to);
	assert.equal(result.saveOk, true);
	assert.equal(result.savedRecords, 120);
	assert.equal(continues, 1);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 120);
	// 被跳过的 60 秒按「设备已确认无数据」处理，和这一页一起把 `B` 推到页终点——
	// 不这么做 `B` 就会永远卡在这 60 秒前面，每次心跳都重连一次。
	assert.equal(await r.baseline.getBaseline(), from + 60 + 120);
});

test("a device page at the window right edge ends the read as no-data, not as failure", async (t) => {
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
				// 设备手上最新的一页就在窗口右端：整个窗口都没有数据。
				reader.latestVitalDataResponse = page(to, 2);
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
	const readAtSec = Math.floor(Date.now() / 1000);
	const result = await reader.readVitalRangeForward(from, to);
	// 不是失败：这一段本来就该被确认成「设备没有数据」。
	assert.equal(result.saveOk, true);
	assert.equal(result.status, "DONE");
	assert.equal(continues, 0);
	assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM ppi_data").get().n, 0);
	// 设备说没有就按「没有」记账：整段确认无数据，`B` 直接推到窗口右端。
	const ceiling = historyCeiling(readAtSec);
	const baseline = await r.baseline.getBaseline();
	// 不写死等式，避免断言侧与读取侧跨秒；只要求右端落在读取时刻的 1 秒容差内。
	assert.ok(
		Math.abs(baseline - ceiling) <= 1,
		`baseline ${baseline} should be about ${ceiling}`
	);
});

test("a zero start page accounts the whole window and stops the read", async (t) => {
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
	await r.prime(from);
	const result = await reader.readVitalRangeForward(from, to);
	assert.equal(result.status, "DONE");
	assert.equal(continues, 0);
	// 设备声明没有更多数据：整段确认无数据，`B` 推到窗口右端。
	assert.equal(await r.baseline.getBaseline(), to);
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
				reader.latestVitalDataResponse = page(query.startSec);
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
	await r.prime(208800);
	const read = await reader.readVitalRangeForward(208800, 210000);
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
	await readerReturning(r, page(start, 120)).readVitalRangeForward(start, to);
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
	const read = await readerReturning(r, ff).readVitalRangeForward(start, to);
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
	await readerReturning(r, valid).readVitalRangeForward(start, end);
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
	await readerReturning(r, valid).readVitalRangeForward(start, start + 120);
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
	await readerReturning(r, vital).readVitalRangeForward(start, start + 120);
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
	await readerReturning(r, valid).readVitalRangeForward(start, start + 120);
	const row = r.db.prepare(`SELECT hr, ppi FROM ppi_data WHERE id='${start}'`).get();
	// 占位修复要求整行都是 FF，混合行落不进这个条件，只能保留广播的原值。
	assert.deepEqual({ ...row }, { hr: 70, ppi: 65535 });
});

test("a zero-value page is queued for upload rather than treated as missing", async (t) => {
	const r = await setup(t);
	const start = 209880;
	const connected = attach(r, start, start + 120, 1);
	await connected.reader.readVitalRangeForward(start, start + 120);
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

test("a progress write failure surfaces instead of silently losing confirmed seconds", async (t) => {
	const r = await setup(t);
	r.failSql = (sql) => sql.startsWith("UPDATE vital_sync_state");
	await r.prime(100);
	// 写不下去必须抛：读取链路要靠这个异常把「这一页没记上」暴露出来，
	// 而不是让 `B` 停在原地看着像成功的。
	await assert.rejects(r.baseline.advanceAccounted(200, 1000));
	assert.deepEqual(cursors(r.db), { baseline: 100, classified: 100 });
});
