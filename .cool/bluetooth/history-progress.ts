import { bluetoothDatabase } from "./database";
import type { VitalDataQueryResponse } from "./boom-types";
import { logger } from "../service/logger";

/**
 * SQLite 会话补录队列。数据库每次打开时重建，确保不会跨 App 会话保留任务。
 * 它只描述“还要读什么”，有效秒和上传状态始终保存在 ppi_data。
 */
export const HISTORY_SCHEMA: string[] = [
	"DROP TABLE IF EXISTS vital_history_ranges",
	"DROP TABLE IF EXISTS vital_history_tasks",
	"DROP TABLE IF EXISTS vital_history_state",
	`CREATE TABLE vital_history_state (id INTEGER PRIMARY KEY CHECK(id=1), planned_until INTEGER NOT NULL)`,
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
	 * 会话表由数据管理器在数据库打开后初始化。
	 * 此处故意不让 database.ts 反向导入本模块，避免数据库与进度模块形成循环依赖。
	 */
	async initializeSessionSchema(): Promise<boolean> {
		const initialized = await bluetoothDatabase.transaction(HISTORY_SCHEMA);
		if (initialized == false) {
			logger.error("bluetooth", "[BOOM-HISTORY] 初始化会话补录表失败");
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
		// 已完成任务在当前会话内不再承担状态，下一次规划前回收，避免长期运行时积累。
		const statements: string[] = ["DELETE FROM vital_history_tasks WHERE status='done'"];
		if (stable > previous)
			statements.push(
				this.taskSql(state.rows.length == 0 ? "archive" : "incremental", previous, stable)
			);
		// Android 内置 SQLite 不支持 `ON CONFLICT ... DO UPDATE`，先更新再 INSERT OR IGNORE。
		// 同一事务串行执行，因此这两句与 UPSERT 有相同的最终状态。
		statements.push(`UPDATE vital_history_state SET planned_until=MAX(planned_until,${stable}) WHERE id=1`);
		statements.push(`INSERT OR IGNORE INTO vital_history_state (id,planned_until) VALUES (1,${stable})`);
		// 最新窗口随分钟滚动；已经稳定的旧窗口由增量任务接管。旧响应用事务内条件校验拦截。
		statements.push(`UPDATE vital_history_tasks SET from_sec=${stable},to_sec=${anchor},cursor_sec=${anchor},status='pending',retry_at=0,attempts=0
   WHERE id='recent' AND to_sec<${anchor}`);
		statements.push(`INSERT OR IGNORE INTO vital_history_tasks (${TASK_COLUMNS}) VALUES ('recent','recent',${stable},${anchor},${anchor},'pending',0,0)`);
		if ((await bluetoothDatabase.transaction(statements)) == false)
			throw this.fail("历史同步规划保存失败");
		const tasks = await bluetoothDatabase.query(`SELECT ${TASK_COLUMNS} FROM vital_history_tasks
   WHERE status!='done' AND retry_at<=${Date.now()}
   ORDER BY CASE kind WHEN 'recent' THEN 0 WHEN 'incremental' THEN 1 WHEN 'archive' THEN 2 ELSE 3 END, to_sec ASC LIMIT 32`);
		if (tasks == null) throw this.fail("历史待处理任务读取失败");
		const result: HistoryTask[] = [];
		for (let i = 0; i < tasks.rows.length; i++) result.push(this.parse(tasks.rows[i]));
		return result;
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
			await this.defer(task, "设备返回段早于目标，保留待确认", true);
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
				if (!item.valid || timestamp < task.fromSec || timestamp >= task.toSec || timestamp >= nowSec)
					continue;
				if (item.hr != 255 || item.ppi != 65535)
					statements.push(`UPDATE ppi_data SET hr=${item.hr},ppi=${item.ppi},uploaded=0
   WHERE id='${timestamp}' AND hr=255 AND ppi=65535`);
			}
			statements.push(`INSERT OR IGNORE INTO ppi_data (id,timestamp,hr,spo2,ppi,uploaded) VALUES ${values.join(",")}`);
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
		if (task.kind != "recent" && missingTo > missingFrom)
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
	async defer(task: HistoryTask, message: string, uncertain: boolean = false): Promise<void> {
		const delay = uncertain
			? VERIFY_DELAY_MS
			: Math.min(60 * 60 * 1000, 600000 * Math.pow(2, Math.min(task.attempts, 3)));
		const kind = uncertain && task.kind != "recent" ? "verify" : task.kind;
		const sql = `UPDATE vital_history_tasks SET kind=${quote(kind)},retry_at=${Date.now() + delay},attempts=attempts+1,message=${quote(message)} WHERE ${this.taskGuard(task)}`;
		if ((await bluetoothDatabase.execute(sql)) == false)
			throw this.fail("历史重试状态保存失败");
	}
	async noMore(task: HistoryTask): Promise<void> {
		// 终止标记只表示本次查询已到设备历史末端，不作为任何区间的数据覆盖证明。
		const status = task.kind == "recent" ? "done" : "exhausted";
		if (
			(await bluetoothDatabase.execute(
				`UPDATE vital_history_tasks SET status=${quote(status)},retry_at=${Date.now() + VERIFY_DELAY_MS},message='device no more data' WHERE ${this.taskGuard(task)}`
			)) == false
		)
			throw this.fail("历史结束状态保存失败");
	}
}
export const historyProgress = new HistoryProgress();
