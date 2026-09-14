import { bluetoothDatabase } from "../database";
import { historyCoverage } from "./coverage-service";
import type { VitalDataQueryResponse } from "../boom-types";
import { logger } from "../../service/logger";

/**
 * SQLite 持久补录队列。表结构可安全地在数据库重开或 App 重启时复用；
 * 只有重新绑定时才随旧设备数据一并清空。
 * 它只描述“还要读什么”，有效秒和上传状态始终保存在 ppi_data。
 */
export const HISTORY_SCHEMA: string[] = [
	`CREATE TABLE IF NOT EXISTS vital_history_state (id INTEGER PRIMARY KEY CHECK(id=1), planned_until INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS vital_history_tasks (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL,
 from_sec INTEGER NOT NULL, to_sec INTEGER NOT NULL, cursor_sec INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', retry_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '')`,
	`CREATE INDEX IF NOT EXISTS idx_history_task_due ON vital_history_tasks(status,retry_at)`,
	`CREATE TABLE IF NOT EXISTS vital_history_ranges (
 from_sec INTEGER NOT NULL, to_sec INTEGER NOT NULL,
 PRIMARY KEY(from_sec,to_sec))`
];

export type HistoryTask = {
	id: string;
	deviceId: string;
	kind: string;
	fromSec: number;
	toSec: number;
	cursorSec: number;
	status: string;
	retryAt: number;
	attempts: number;
};
/** 一次 0x3A/0x3B 链路允许跨过的已存在数据秒数。设备按分钟页返回，120 秒不会增加额外请求。 */
export const HISTORY_GATT_READ_BRIDGE_SEC = 120;
/**
 * 单批补录的任务上限：一次 0x3A/0x3B 链路最多合并这么多任务。
 * 弹窗列出多少，一次点击就补多少；DB 里通常还有剩余，由 countPendingTasks 单独展示，
 * 否则“补完还显示”会被误读成补录失败。
 */
export const HISTORY_TASK_BATCH_LIMIT = 128;
/**
 * 每次调和最多比对多少秒的本地覆盖。
 * 无上限地比对一个 30 天的 archive 任务要读 86 万个时间戳、耗时数十秒，会把 plan() 卡住；
 * 因此每次只往前推进这么久，剩余部分留成 `scan` 任务下轮继续。它不代表确认缺数据。
 */
export const HISTORY_RECONCILE_SCAN_SEC = 6 * 60 * 60;
/** 设备一页（2 分钟）的链路成本：页间 250ms + 一轮 0x3A/0x3B 往返。 */
const HISTORY_PAGE_COST_MS = 1450;
/** 自动补录和测试页手动补录共用的连续读取窗口。 */
export type HistoryTaskGroup = {
	id: string;
	deviceId: string;
	kind: string;
	fromSec: number;
	toSec: number;
	cursorSec: number;
	retryAt: number;
	attempts: number;
	repairSeconds: number;
	bridgeSeconds: number;
	taskIds: string[];
	tasks: HistoryTask[];
};

function sortHistoryTasks(items: HistoryTask[]): HistoryTask[] {
	const sorted = items.slice();
	for (let i = 1; i < sorted.length; i++) {
		const value = sorted[i];
		let index = i - 1;
		while (index >= 0 && sorted[index].fromSec > value.fromSec) {
			sorted[index + 1] = sorted[index];
			index--;
		}
		sorted[index + 1] = value;
	}
	return sorted;
}

/**
 * 补录任务的读取优先级：最新窗口 → 增量 → 长历史 → 待核验 → 待扫描。
 * 这是补录顺序的唯一来源，SQL 排序和分组排序都由它派生，避免两处顺序漂移。
 * `scan` 排最后：它只是“本地还没比对过”，不代表确认缺数据，不该抢在真缺口前面。
 */
const HISTORY_TASK_KIND_ORDER: string[] = ["recent", "incremental", "archive", "verify", "scan"];

export function historyTaskKindPriority(kind: string): number {
	for (let i = 0; i < HISTORY_TASK_KIND_ORDER.length; i++) {
		if (HISTORY_TASK_KIND_ORDER[i] == kind) return i;
	}
	return HISTORY_TASK_KIND_ORDER.length;
}

function historyTaskKindOrderSql(): string {
	let sql = "CASE kind";
	for (let i = 0; i < HISTORY_TASK_KIND_ORDER.length; i++) {
		sql += ` WHEN ${quote(HISTORY_TASK_KIND_ORDER[i])} THEN ${i}`;
	}
	return `${sql} ELSE ${HISTORY_TASK_KIND_ORDER.length} END`;
}

/**
 * 分组前排序：先按读取优先级，再按起点。
 * 只按 fromSec 排会把 recent 窗口排到长历史后面，尾部预算会被最老的段吃光。
 */
function sortHistoryTasksForRead(items: HistoryTask[]): HistoryTask[] {
	const sorted = items.slice();
	for (let i = 1; i < sorted.length; i++) {
		const value = sorted[i];
		const valuePriority = historyTaskKindPriority(value.kind);
		let index = i - 1;
		while (index >= 0) {
			const previous = sorted[index];
			const previousPriority = historyTaskKindPriority(previous.kind);
			const outOfOrder =
				previousPriority > valuePriority ||
				(previousPriority == valuePriority && previous.fromSec > value.fromSec);
			if (outOfOrder == false) break;
			sorted[index + 1] = previous;
			index--;
		}
		sorted[index + 1] = value;
	}
	return sorted;
}

function countHistoryTaskSeconds(items: HistoryTask[]): number {
	const sorted = sortHistoryTasks(items);
	let total = 0;
	let coveredTo = 0;
	for (let i = 0; i < sorted.length; i++) {
		const item = sorted[i];
		const fromSec = Math.max(item.fromSec, coveredTo);
		if (item.toSec > fromSec) total += item.toSec - fromSec;
		if (item.toSec > coveredTo) coveredTo = item.toSec;
	}
	return total;
}

/**
 * 将相近的真实缺秒任务折叠为一次设备连续读取窗口。
 * SQLite 任务仍只保存真实缺秒；窗口中跨过的秒已有本地数据，因此不重复入库。
 */
export function groupHistoryTasksForRead(items: HistoryTask[]): HistoryTaskGroup[] {
	const sorted = sortHistoryTasksForRead(items);
	const result: HistoryTaskGroup[] = [];
	const nowMs = Date.now();
	for (let i = 0; i < sorted.length; i++) {
		const task = sorted[i];
		const last = result.length == 0 ? null : result[result.length - 1];
		const sameKind = last != null && last.kind == task.kind;
		const sameReadyState =
			last != null && (last.retryAt <= nowMs) == (task.retryAt <= nowMs);
		const nearEnough =
			last != null && task.fromSec <= last.toSec + HISTORY_GATT_READ_BRIDGE_SEC;
		if (last != null && sameKind && sameReadyState && nearEnough) {
			if (task.toSec > last.toSec) last.toSec = task.toSec;
			if (task.cursorSec > last.cursorSec) last.cursorSec = task.cursorSec;
			last.attempts += task.attempts;
			last.taskIds.push(task.id);
			last.tasks.push(task);
			last.repairSeconds = countHistoryTaskSeconds(last.tasks);
			last.bridgeSeconds = Math.max(0, last.toSec - last.fromSec - last.repairSeconds);
			continue;
		}
		result.push({
			id: task.id,
			deviceId: task.deviceId,
			kind: task.kind,
			fromSec: task.fromSec,
			toSec: task.toSec,
			cursorSec: task.cursorSec,
			retryAt: task.retryAt,
			attempts: task.attempts,
			repairSeconds: task.toSec - task.fromSec,
			bridgeSeconds: 0,
			taskIds: [task.id],
			tasks: [task]
		});
	}
	return result;
}

/** 防御性校验：任务只校验时间范围；设备归属始终由 Device store 的当前绑定决定。 */
export function canReadHistoryTaskGroup(items: HistoryTask[]): boolean {
	if (items.length == 0) return false;
	const sorted = sortHistoryTasks(items);
	let coveredTo = sorted[0].toSec;
	if (sorted[0].fromSec >= sorted[0].toSec) return false;
	for (let i = 1; i < sorted.length; i++) {
		const item = sorted[i];
		if (
			item.fromSec >= item.toSec ||
			item.fromSec > coveredTo + HISTORY_GATT_READ_BRIDGE_SEC
		)
			return false;
		if (item.toSec > coveredTo) coveredTo = item.toSec;
	}
	return true;
}
export function historyQueryAnchor(nowSec: number): number {
	return (Math.floor(nowSec / 60) + 1) * 60;
}
/** 最新两分钟可能尚未完整写入 Flash，只重读，不永久确认。 */
export function historyStableBefore(nowSec: number): number {
	return Math.max(1, Math.floor(nowSec / 60) * 60 - 120);
}
const VERIFY_DELAY_MS = 6 * 60 * 60 * 1000;
const TASK_COLUMNS = "id,kind,from_sec,to_sec,cursor_sec,status,retry_at,attempts";
function quote(value: string): string {
	return "'" + value.replace(/'/g, "''") + "'";
}

class HistoryProgress {
	/** 单设备会话标识只用于 GATT 绑定校验，不写入 SQLite。 */
	private activeDeviceId: string = "";
	/** 所有补录进度错误进入诊断日志，再交给调用方停止当前页。 */
	private fail(message: string): Error {
		logger.error("bluetooth", `[BOOM-HISTORY] ${message}`);
		return new Error(message);
	}
	/**
	 * 持久补录表由数据管理器在数据库打开后初始化。
	 * 此处故意不让 database.ts 反向导入本模块，避免数据库与进度模块形成循环依赖。
	 */
	async initializeSessionSchema(): Promise<boolean> {
		const initialized = await bluetoothDatabase.transaction(HISTORY_SCHEMA);
		if (initialized == false) {
			logger.error("bluetooth", "[BOOM-HISTORY] 初始化补录表失败");
		}
		return initialized;
	}
	private taskSql(kind: string, from: number, to: number, retryAt: number = 0): string {
		const id = kind + ":" + from + ":" + to;
		return `INSERT OR IGNORE INTO vital_history_tasks (${TASK_COLUMNS}) VALUES (${quote(id)},${quote(kind)},${from},${to},${to},'pending',${retryAt},0)`;
	}
	private taskGuard(task: HistoryTask): string {
		return `id=${quote(task.id)} AND to_sec=${task.toSec} AND cursor_sec=${task.cursorSec}`;
	}
	private parse(row: string[]): HistoryTask {
		return {
			id: row[0] as string,
			deviceId: this.activeDeviceId,
			kind: row[1] as string,
			fromSec: parseInt(row[2] as string),
			toSec: parseInt(row[3] as string),
			cursorSec: parseInt(row[4] as string),
			status: row[5] as string,
			retryAt: parseInt(row[6] as string),
			attempts: parseInt(row[7] as string)
		};
	}
	async getTask(id: string): Promise<HistoryTask> {
		const result = await bluetoothDatabase.query(
			`SELECT ${TASK_COLUMNS} FROM vital_history_tasks WHERE id=${quote(id)}`
		);
		if (result == null || result.rows.length == 0) throw this.fail("历史任务读取失败");
		return this.parse(result.rows[0]);
	}
	/** 待处理缺口总数，不截断。弹窗用它区分“本批列出的”和“队列里还剩的”。 */
	async countPendingTasks(): Promise<number> {
		const result = await bluetoothDatabase.query(
			"SELECT COUNT(*) FROM vital_history_tasks WHERE status != 'done'"
		);
		if (result == null || result.rows.length == 0) throw this.fail("历史缺口统计失败");
		return parseInt(result.rows[0][0] as string);
	}
	/** 测试页展示仍待补或待核验的实际 SQLite 任务，不重新规划也不修改进度。 */
	async listPendingTasks(limit: number = HISTORY_TASK_BATCH_LIMIT): Promise<HistoryTask[]> {
		const safeLimit = Math.max(1, Math.min(limit, HISTORY_TASK_BATCH_LIMIT));
		const result =
			await bluetoothDatabase.query(`SELECT ${TASK_COLUMNS} FROM vital_history_tasks
   WHERE status != 'done' ORDER BY retry_at ASC, from_sec ASC LIMIT ${safeLimit}`);
		if (result == null) throw this.fail("历史缺口读取失败");
		const tasks: HistoryTask[] = [];
		for (let i = 0; i < result.rows.length; i++) tasks.push(this.parse(result.rows[i]));
		return tasks;
	}
	/** 测试页显示与自动调度完全相同的连续读取窗口。 */
	async listPendingTaskGroups(
		limit: number = HISTORY_TASK_BATCH_LIMIT
	): Promise<HistoryTaskGroup[]> {
		return groupHistoryTasksForRead(await this.listPendingTasks(limit));
	}
	/**
	 * 把待处理意图调和为本地真实缺口。最新窗口仍由固件稳定性策略重复读取，
	 * 旧历史则跳过已存在 PPI 秒和已确认但无有效 PPI 的秒，避免无意义 GATT。
	 *
	 * 每次最多比对 HISTORY_RECONCILE_SCAN_SEC：比对的区间里没有本地 PPI 的秒并不等于
	 * 缺口（可能只是那段时间没佩戴），未比对的部分留成 `scan` 任务下轮继续。
	 * 否则一个 archive 任务会被当成“待补 30 天”，既显示错误也会浪费一次完整 GATT 链路。
	 */
	async reconcilePendingTasks(nowSec: number): Promise<HistoryTask[]> {
		const candidates = await this.listPendingTasks(64);
		const retentionStart = historyCoverage.retentionStartSec(nowSec);
		for (let i = 0; i < candidates.length; i++) {
			const task = candidates[i];
			if (task.kind == "recent" || task.retryAt > Date.now()) continue;
			if (task.toSec <= retentionStart) {
				await bluetoothDatabase.execute(
					`UPDATE vital_history_tasks SET status='done',message='outside local retention window' WHERE ${this.taskGuard(task)}`
				);
				continue;
			}
			const lower = Math.max(task.fromSec, retentionStart);
			// 每次只比对最近 HISTORY_RECONCILE_SCAN_SEC，余量留成 scan 任务下轮继续。
			const scanFrom = Math.max(lower, task.cursorSec - HISTORY_RECONCILE_SCAN_SEC);
			if (scanFrom >= task.cursorSec) continue;
			const snapshot = await historyCoverage.inspect({ fromSec: scanFrom, toSec: task.cursorSec });
			const statements: string[] = [`DELETE FROM vital_history_tasks WHERE ${this.taskGuard(task)}`];
			// scan 任务比对出真缺口就升级为 archive；其余保留原类型，避免 incremental/recent
			// 的优先级和展示文案在调和后被改写。
			const gapKind = task.kind == "scan" ? "archive" : task.kind;
			for (let j = 0; j < snapshot.repairRanges.length; j++) {
				const gap = snapshot.repairRanges[j];
				statements.push(this.taskSql(gapKind, gap.fromSec, gap.toSec, task.retryAt));
			}
			// 本次没比对到的更早部分：保持“待扫描”语义，不代表确认缺数据。
			// retry_at 必须留 0：调和候选只取 retry_at 最早的 64 条，而规划出的 recent /
			// incremental 都是 0。给 scan 一个真实时间戳会让它永远排在这批 0 后面，
			// 任务一堆积就被挤出候选集，调和窗口在那段时间停止向前推进。
			if (scanFrom > lower) {
				statements.push(this.taskSql("scan", lower, scanFrom, 0));
			}
			if (snapshot.checkedWithoutPpiSeconds > 0) {
				logger.info(
					"bluetooth",
					`[BOOM-HISTORY] 本地缺失但设备已检查: task=${task.id}, seconds=${snapshot.checkedWithoutPpiSeconds}`
				);
			}
			if ((await bluetoothDatabase.transaction(statements)) == false)
				throw this.fail("历史缺口调和保存失败");
		}
		const result = await bluetoothDatabase.query(`SELECT ${TASK_COLUMNS} FROM vital_history_tasks
   WHERE status!='done' AND retry_at<=${Date.now()}
   ORDER BY ${historyTaskKindOrderSql()}, to_sec ASC LIMIT ${HISTORY_TASK_BATCH_LIMIT}`);
		if (result == null) throw this.fail("调和后历史任务读取失败");
		const tasks: HistoryTask[] = [];
		for (let i = 0; i < result.rows.length; i++) tasks.push(this.parse(result.rows[i]));
		return tasks;
	}
	/**
	 * 按一次 GATT 链路的时间预算挑选本轮要读的任务。
	 *
	 * 每个连续窗口（相邻任务相距在 HISTORY_GATT_READ_BRIDGE_SEC 内即合并）各自开一条链路，
	 * 所以预算是**按组**算的，不是全局最早到最晚：`recent` 和一段很久以前的 `scan`
	 * 之间隔着几天没有任务，把它们当成一个跨度会把两者都判成超预算而一起丢弃。
	 * 链路只发一次 0x3A、之后 0x3B 连续向更早走，所以一组的耗时取决于该组跨度，
	 * 而不是组内各缺口秒数之和——后者会严重低估。
	 *
	 * 每一组至少入选一次：一旦累计页数已经超出预算，就不再取下一组，但**当前这一组照常取**。
	 * 读取会在预算处停下并推进该组游标，下轮从新游标继续。若因为“加上它就超预算”而丢弃，
	 * 跨度大于单次预算的缺口会永远排在队尾、永远读不到——这正是“补完再刷新还显示同一个缺口”
	 * 的成因。判断依据是累计值而非“加上它之后的值”，否则队头的小组会把后面的大组一直挡掉。
	 * 排序与到期过滤与调和收尾完全一致，不会挑到还在退避里的任务。
	 */
	async listBudgetedTasks(deadlineAt: number): Promise<HistoryTask[]> {
		const result = await bluetoothDatabase.query(`SELECT ${TASK_COLUMNS} FROM vital_history_tasks
   WHERE status!='done' AND retry_at<=${Date.now()}
   ORDER BY ${historyTaskKindOrderSql()}, to_sec ASC LIMIT ${HISTORY_TASK_BATCH_LIMIT}`);
		if (result == null) throw this.fail("调和后历史任务读取失败");
		const candidates: HistoryTask[] = [];
		for (let i = 0; i < result.rows.length; i++) candidates.push(this.parse(result.rows[i]));
		if (candidates.length == 0) return candidates;
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) return [];
		const maxPages = Math.max(1, Math.floor(remainingMs / HISTORY_PAGE_COST_MS));
		// 先按读取顺序切组：与上一组的窗口相距过远就另开一条链路。
		const groups = groupHistoryTasksForRead(candidates);
		const picked: HistoryTask[] = [];
		let pages = 0;
		for (let i = 0; i < groups.length; i++) {
			// 预算已经用满：当前组仍要取（它可能在预算内跑完并推进游标），之后的组留给下一轮。
			if (i > 0 && pages >= maxPages) break;
			const group = groups[i];
			pages += Math.ceil(Math.max(0, group.toSec - group.fromSec) / 120);
			for (let j = 0; j < group.tasks.length; j++) picked.push(group.tasks[j]);
		}
		return picked;
	}
	async plan(device: string, nowSec: number): Promise<HistoryTask[]> {
		if (device == "") return [];
		this.activeDeviceId = device;
		const stable = historyStableBefore(nowSec);
		const anchor = historyQueryAnchor(nowSec);
		const state = await bluetoothDatabase.query(
			"SELECT planned_until FROM vital_history_state WHERE id=1"
		);
		if (state == null) throw this.fail("历史同步状态读取失败");
		const previous = state.rows.length == 0 ? 1 : parseInt(state.rows[0][0] as string);
		// 已完成任务不再承担状态，下一次规划前回收，避免长期运行时积累。
		const statements: string[] = ["DELETE FROM vital_history_tasks WHERE status='done'"];
		if (stable > previous)
			statements.push(
				this.taskSql(state.rows.length == 0 ? "archive" : "incremental", previous, stable)
			);
		// Android 内置 SQLite 不支持 `ON CONFLICT ... DO UPDATE`，先更新再 INSERT OR IGNORE。
		// 同一事务串行执行，因此这两句与 UPSERT 有相同的最终状态。
		statements.push(
			`UPDATE vital_history_state SET planned_until=MAX(planned_until,${stable}) WHERE id=1`
		);
		statements.push(
			`INSERT OR IGNORE INTO vital_history_state (id,planned_until) VALUES (1,${stable})`
		);
		// 最新窗口随分钟滚动；已经稳定的旧窗口由增量任务接管。旧响应用事务内条件校验拦截。
		statements.push(`UPDATE vital_history_tasks SET from_sec=${stable},to_sec=${anchor},cursor_sec=${anchor},status='pending',retry_at=0,attempts=0
   WHERE id='recent' AND to_sec<${anchor}`);
		statements.push(
			`INSERT OR IGNORE INTO vital_history_tasks (${TASK_COLUMNS}) VALUES ('recent','recent',${stable},${anchor},${anchor},'pending',0,0)`
		);
		if ((await bluetoothDatabase.transaction(statements)) == false)
			throw this.fail("历史同步规划保存失败");
		return await this.reconcilePendingTasks(nowSec);
	}
	/** 页面和游标一起提交。短页/跳跃产生待确认任务，而非伪造已读区间。 */
	async savePage(
		task: HistoryTask,
		page: VitalDataQueryResponse,
		stableBefore: number
	): Promise<number> {
		if (page.startSec <= 0 || page.n <= 0 || page.n > 2 || page.rmssdSdnn.length != page.n)
			throw this.fail("历史页面结构无效");
		const actualEnd =
			page.startSec + (page.vitalData.length == 0 ? page.n * 60 : page.vitalData.length);
		if (page.vitalData.length > page.n * 60) throw this.fail("历史页面秒数超出声明范围");
		if (actualEnd <= task.fromSec) {
			// 整段早于任务范围的页面由调用方过滤；这里只防御游标被回退。
			logger.warn("bluetooth", `[BOOM-HISTORY] 历史页面早于任务范围: task=${task.id}`);
			return 0;
		}
		const statements: string[] = [];
		const values: string[] = [];
		const nowSec = Math.floor(Date.now() / 1000);
		for (let i = 0; i < page.vitalData.length; i++) {
			const timestamp = page.startSec + i;
			const item = page.vitalData[i];
			if (
				!item.valid ||
				timestamp < task.fromSec ||
				timestamp >= task.toSec ||
				timestamp >= nowSec
			)
				continue;
			values.push(`('${timestamp}',${timestamp},${item.hr},0,${item.ppi},0)`);
		}
		if (values.length > 0) {
			// 先补全曾保存的占位值，再写入此前不存在的秒数据；两步均兼容旧版 Android SQLite。
			for (let i = 0; i < page.vitalData.length; i++) {
				const timestamp = page.startSec + i;
				const item = page.vitalData[i];
				if (
					!item.valid ||
					timestamp < task.fromSec ||
					timestamp >= task.toSec ||
					timestamp >= nowSec
				)
					continue;
				if (item.hr != 255 || item.ppi != 65535)
					statements.push(`UPDATE ppi_data SET hr=${item.hr},ppi=${item.ppi},uploaded=0
   WHERE id='${timestamp}' AND hr=255 AND ppi=65535`);
			}
			statements.push(
				`INSERT OR IGNORE INTO ppi_data (id,timestamp,hr,spo2,ppi,uploaded) VALUES ${values.join(",")}`
			);
		}
		const from = Math.max(task.fromSec, page.startSec);
		const to = Math.min(task.toSec, actualEnd, stableBefore);
		if (to > from) {
			const overlap = `from_sec<=${to} AND to_sec>=${from}`;
			statements.push(`INSERT OR IGNORE INTO vital_history_ranges SELECT MIN(from_sec),MAX(to_sec)
    FROM (SELECT from_sec,to_sec FROM vital_history_ranges WHERE ${overlap} UNION ALL SELECT ${from},${to})`);
			statements.push(`DELETE FROM vital_history_ranges WHERE ${overlap} AND NOT (
    from_sec=(SELECT MIN(from_sec) FROM vital_history_ranges WHERE ${overlap}) AND
    to_sec=(SELECT MAX(to_sec) FROM vital_history_ranges WHERE ${overlap}))`);
		}
		const missingFrom = Math.max(task.fromSec, actualEnd);
		const missingTo = Math.min(task.cursorSec, stableBefore);
		// scan 任务本身就是在确认这段区间，不需要再排一个 6 小时后的核验任务。
		if (task.kind != "recent" && task.kind != "scan" && missingTo > missingFrom)
			statements.push(
				this.taskSql("verify", missingFrom, missingTo, Date.now() + VERIFY_DELAY_MS)
			);
		const next = Math.max(task.fromSec, Math.min(task.cursorSec, page.startSec));
		statements.push(
			`UPDATE vital_history_tasks SET cursor_sec=${next},status=${quote(next <= task.fromSec ? "done" : "pending")},attempts=0,retry_at=0,message='' WHERE ${this.taskGuard(task)}`
		);
		if (
			(await bluetoothDatabase.transaction(
				statements,
				`SELECT id FROM vital_history_tasks WHERE ${this.taskGuard(task)}`
			)) == false
		)
			throw this.fail("历史页面落库失败，进度未推进");
		return values.length;
	}
	/** 失败重试：按已尝试次数退避，最多 60 分钟。 */
	async defer(task: HistoryTask, message: string): Promise<void> {
		const delay = Math.min(60 * 60 * 1000, 600000 * Math.pow(2, Math.min(task.attempts, 3)));
		const sql = `UPDATE vital_history_tasks SET retry_at=${Date.now() + delay},attempts=attempts+1,message=${quote(message)} WHERE ${this.taskGuard(task)}`;
		if ((await bluetoothDatabase.execute(sql)) == false)
			throw this.fail("历史重试状态保存失败");
	}
	async noMore(task: HistoryTask): Promise<void> {
		// 终止标记不作为数据覆盖证明，但代表当前绑定已读到设备历史末端，无需重复查询。
		if (
			(await bluetoothDatabase.execute(
				`UPDATE vital_history_tasks SET status='done',retry_at=0,message='device no more data for current binding' WHERE ${this.taskGuard(task)}`
			)) == false
		)
			throw this.fail("历史结束状态保存失败");
	}
}
export const historyProgress = new HistoryProgress();
