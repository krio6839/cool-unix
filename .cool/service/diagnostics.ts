import { config } from "@/config";
import { router } from "../router";
import { storage } from "../utils/storage";
//#ifdef APP-ANDROID
import {
	openDatabase,
	executeSql,
	selectSql
	//@ts-ignore
} from "@/uni_modules/meibao-Sqlite";
import type {
	OpenDatabaseOptions,
	ExecuteSqlOptions,
	SelectSqlOptions,
	SelectSqlResult
	//@ts-ignore
} from "@/uni_modules/meibao-Sqlite";
//@ts-ignore
import { saveLogToDownloads } from "@/uni_modules/boom-csv-saver";
//#endif

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticRequestContext = {
	method: string;
	url: string;
	statusCode?: number;
	code?: number;
	message?: string;
	duration?: number;
	detail?: any | null;
};

const LOG_STORAGE_KEY = "boom_diagnostic_logs";
const DB_NAME = "diagnostics_db";
const MAX_LOGS = 1000;
/**
 * 累积多少条就自动落盘一个 txt。
 *
 * 内存和 SQLite 都只保留最近 MAX_LOGS 条，长时间运行的详细日志会被覆盖掉。
 * 落盘的是另一条不受上限约束的路径：攒够一批就写进 Download/BOOM/logs，
 * 排查时按时间取文件即可，不再受“1000 行缓冲区”限制。
 *
 * 500 条约 100KB：一轮 120 秒补录（约 82 页）大致就是一个文件，既能一次看完整轮，
 * 又不会大到打不开。
 */
const ARCHIVE_FLUSH_COUNT = 500;
/**
 * 即使没攒够，每隔这么久也落盘一次（前提是已有 ARCHIVE_FLUSH_MIN_COUNT 条）。
 *
 * 只按数量触发的话，空闲期那点零散日志会一直留在内存里，进程被杀就没了；
 * 这条时间线保证“每隔一段时间存成一个文件”在空闲时也成立。
 * 下限用于避免空闲时每 5 分钟写出一个只有几行的碎文件。
 */
const ARCHIVE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const ARCHIVE_FLUSH_MIN_COUNT = 30;
/** 落盘缓冲的上限，防止写文件持续失败时内存无限增长。 */
const ARCHIVE_BUFFER_LIMIT = 5000;

function stringify(value: any | null): string {
	if (value == null) return "";
	if (typeof value == "string") return value;
	if (typeof value == "number" || typeof value == "boolean") return `${value}`;

	try {
		return JSON.stringify(value);
	} catch (_e) {
		return `${value}`;
	}
}

function getCurrentRoute(): string {
	try {
		return router.path();
	} catch (_e) {
		return "";
	}
}

function readLogs(): string[] {
	const logs = storage.get(LOG_STORAGE_KEY);
	if (!Array.isArray(logs)) return [];
	return (logs as any[]).map((item) => stringify(item));
}

function escapeSqlText(value: string): string {
	return value.replace(/'/g, "''");
}

class Diagnostics {
	private initialized = false;
	private logs: string[] = [];
	private dbReady = false;
	private dbAvailable = false;
	private dbReadyTask: Promise<boolean> | null = null;
	private writeTask: Promise<void> = Promise.resolve();
	/** 待落盘的日志。攒够一批或超时就写一个 txt 文件。 */
	private archiveBuffer: string[] = [];
	/** 已落盘的文件数，用于文件名去重。 */
	private archiveSeq = 0;
	/** 上次落盘的时间，用于空闲期定时落盘。 */
	private lastArchiveAt = 0;

	init(): void {
		if (this.initialized) return;
		this.initialized = true;
		// 时间线从启动开始算：空转的进程不会因为“距上次落盘很久”立刻写出碎文件。
		this.lastArchiveAt = new Date().getTime();
		const legacyLogs = readLogs();
		this.logs = legacyLogs;
		this.dbReadyTask = this.initDatabase(legacyLogs);
		this.record("info", "diagnostics", "诊断日志已启动", this.getDeviceSummary());
	}

	record(
		level: DiagnosticLogLevel,
		tag: string,
		message: string,
		detail: any | null = null
	): void {
		const time = new Date().toISOString();
		const route = getCurrentRoute();
		const detailText = stringify(detail);
		let item = `[${time}] [${level}] [${tag}] ${route}\n${message}`;
		if (detailText != "") {
			item = `${item}\n${detailText}`;
		}

		this.logs.push(item);
		if (this.logs.length > MAX_LOGS) {
			this.logs = this.logs.slice(this.logs.length - MAX_LOGS);
		}
		this.appendArchive(item);

		try {
			if (this.dbAvailable) {
				this.enqueueWrite(item);
			} else {
				storage.set(LOG_STORAGE_KEY, this.logs, 0);
			}
		} catch (_e) {
			// Storage full or unavailable. Keep the in-memory buffer for this session.
		}
	}

	/**
	 * 把日志追加进落盘缓冲，攒够一批就异步写文件。
	 *
	 * 这里不 await：record 会被 BLE 回调高频调用，同步写文件会拖住调用方。
	 * 写失败只丢这一批缓冲，不影响内存与 SQLite 里的日志。
	 */
	private appendArchive(item: string): void {
		this.archiveBuffer.push(item);
		if (this.archiveBuffer.length > ARCHIVE_BUFFER_LIMIT) {
			this.archiveBuffer = this.archiveBuffer.slice(
				this.archiveBuffer.length - ARCHIVE_BUFFER_LIMIT
			);
		}
		this.maybeFlushArchive();
	}

	/**
	 * 攒够 ARCHIVE_FLUSH_COUNT 条，或距上次落盘超过 ARCHIVE_FLUSH_INTERVAL_MS
	 * 且已有 ARCHIVE_FLUSH_MIN_COUNT 条，就落盘一批。
	 *
	 * 时间条件在每条日志上顺带检查，不用另起定时器：缓冲区里有内容，说明日志正在
	 * 流动，下一条日志自然会来做这次检查。
	 */
	private maybeFlushArchive(): void {
		if (this.archiveBuffer.length == 0) return;
		if (this.archiveBuffer.length >= ARCHIVE_FLUSH_COUNT) return this.flushArchive();
		const overdue =
			this.archiveBuffer.length >= ARCHIVE_FLUSH_MIN_COUNT &&
			new Date().getTime() - this.lastArchiveAt >= ARCHIVE_FLUSH_INTERVAL_MS;
		if (overdue == true) this.flushArchive();
	}

	private flushArchive(): void {
		if (this.archiveBuffer.length == 0) return;
		const batch = this.archiveBuffer;
		this.archiveBuffer = [];
		try {
			//#ifdef APP-ANDROID
			saveLogToDownloads(`diagnostic-${this.archiveStamp()}.txt`, this.formatText(batch));
			//#endif
			this.lastArchiveAt = new Date().getTime();
		} catch (_e) {
			// 落盘失败不影响内存/数据库日志，也不重试：下一次攒够会再写一个新文件。
		}
	}

	/**
	 * 把尚未落盘的余量写成文件。App 切到后台时调用：进程随时可能被系统回收，
	 * 缓冲区里的日志还没进过磁盘，丢了就再也拿不回来。
	 */
	flushArchiveNow(): void {
		this.flushArchive();
	}

	/** 文件名用当天内的时刻，便于同一目录里按时间排序；日期已由目录表达。 */
	private archiveStamp(): string {
		this.archiveSeq = this.archiveSeq + 1;
		const now = new Date();
		const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
		return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${this.archiveSeq}`;
	}

	captureException(error: any | null, tag: string = "exception"): void {
		this.record("error", tag, stringify(error), error);
	}

	captureRequest(ctx: DiagnosticRequestContext): void {
		const message = [
			ctx.method,
			ctx.url,
			ctx.statusCode == null ? "" : `status=${ctx.statusCode}`,
			ctx.code == null ? "" : `code=${ctx.code}`,
			ctx.duration == null ? "" : `${ctx.duration}ms`,
			ctx.message ?? ""
		]
			.filter((e) => e != "")
			.join(" ");

		this.record("error", "request", message, ctx.detail == null ? null : ctx.detail);
	}

	getLogs(): string[] {
		return this.logs;
	}

	async getLogsAsync(limit: number = 0): Promise<string[]> {
		if (this.dbReadyTask != null) {
			await this.dbReadyTask;
			await this.writeTask;
		}

		if (this.dbAvailable && this.dbReady) {
			const sql =
				limit > 0
					? `SELECT message FROM (SELECT id, message FROM diagnostic_logs ORDER BY id DESC LIMIT ${limit}) ORDER BY id ASC`
					: "SELECT message FROM diagnostic_logs ORDER BY id ASC";
			const result = await this.query(sql);
			if (result != null) {
				const logs: string[] = [];
				for (let i = 0; i < result.rows.length; i++) {
					logs.push(result.rows[i][0] as string);
				}
				if (limit == 0) {
					this.logs = logs;
				}
				return logs;
			}
		}

		const logs = readLogs();
		return limit > 0 && logs.length > limit ? logs.slice(logs.length - limit) : logs;
	}

	getMaxLogs(): number {
		return MAX_LOGS;
	}

	async getLogCountAsync(): Promise<number> {
		if (this.dbReadyTask != null) {
			await this.dbReadyTask;
			await this.writeTask;
		}

		if (this.dbAvailable && this.dbReady) {
			return await this.getDbLogCount();
		}

		return readLogs().length;
	}

	async clear(): Promise<void> {
		// 清空前先把没落盘的余量写到文件：缓冲区里的内容还没进过磁盘，
		// 直接丢掉等于用户以为“清空的是屏幕上这些”，实际连同没看过的日志一起没了。
		this.flushArchive();
		// 先等初始化读完库再重置内存：initDatabase 结束时会把读到的历史日志回填进
		// logs，早于它清空就会被这次回填覆盖——刚启动就点清空会看起来没生效。
		if (this.dbReadyTask != null) {
			await this.dbReadyTask;
		}
		await this.writeTask;
		this.logs = [];
		storage.remove(LOG_STORAGE_KEY);
		if (this.dbAvailable && this.dbReady) {
			await this.execute("DELETE FROM diagnostic_logs");
		}
	}

	toText(limit: number = 0): string {
		const pickedLogs =
			limit > 0 && this.logs.length > limit
				? this.logs.slice(this.logs.length - limit)
				: this.logs;
		return this.formatText(pickedLogs);
	}

	async toTextAsync(limit: number = 0): Promise<string> {
		const logs = await this.getLogsAsync(limit);
		return this.formatText(logs);
	}

	private formatText(pickedLogs: string[]): string {
		const lines: string[] = [];

		lines.push(`${config.name} diagnostics`);
		lines.push(this.getDeviceSummary());
		lines.push(`logs=${pickedLogs.length}/${MAX_LOGS}`);
		lines.push("");

		pickedLogs.forEach((item) => {
			lines.push(item);
			lines.push("");
		});

		return lines.join("\n");
	}

	private enqueueWrite(message: string): void {
		this.writeTask = this.writeTask
			.then(async () => {
				if (this.dbReadyTask != null) {
					await this.dbReadyTask;
				}
				if (!this.dbAvailable || !this.dbReady) {
					storage.set(LOG_STORAGE_KEY, this.logs, 0);
					return;
				}
				await this.insertLog(message);
				await this.trimLogs();
			})
			.catch((_e) => {
				this.dbAvailable = false;
				storage.set(LOG_STORAGE_KEY, this.logs, 0);
			});
	}

	private async initDatabase(legacyLogs: string[]): Promise<boolean> {
		//#ifdef APP-ANDROID
		this.dbAvailable = true;
		const opened = await this.openDatabase();
		if (!opened) {
			this.dbAvailable = false;
			return false;
		}

		const tableReady = await this.execute(`CREATE TABLE IF NOT EXISTS diagnostic_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at INTEGER NOT NULL,
			message TEXT NOT NULL
		)`);
		if (!tableReady) {
			this.dbAvailable = false;
			return false;
		}

		this.dbReady = true;
		const count = await this.getDbLogCount();
		if (count == 0 && legacyLogs.length > 0) {
			for (let i = 0; i < legacyLogs.length; i++) {
				await this.insertLog(legacyLogs[i]);
			}
			await this.trimLogs();
			storage.remove(LOG_STORAGE_KEY);
		}

		const persistedLogs = await this.query(
			"SELECT message FROM diagnostic_logs ORDER BY id ASC"
		);
		if (persistedLogs != null) {
			const logs: string[] = [];
			for (let i = 0; i < persistedLogs.rows.length; i++) {
				logs.push(persistedLogs.rows[i][0] as string);
			}
			this.logs = logs;
		}
		return true;
		//#endif
		//#ifndef APP-ANDROID
		this.dbAvailable = false;
		return false;
		//#endif
	}

	private openDatabase(): Promise<boolean> {
		//#ifdef APP-ANDROID
		return new Promise((resolve) => {
			const options: OpenDatabaseOptions = {
				name: DB_NAME,
				success: (_res) => {
					resolve(true);
				},
				fail: (err) => {
					resolve(err.errCode == 9000002);
				}
			};
			openDatabase(options);
		});
		//#endif
		//#ifndef APP-ANDROID
		return Promise.resolve(false);
		//#endif
	}

	private execute(sql: string): Promise<boolean> {
		//#ifdef APP-ANDROID
		return new Promise((resolve) => {
			const options: ExecuteSqlOptions = {
				name: DB_NAME,
				sql,
				success: (_res) => {
					resolve(true);
				},
				fail: (_err) => {
					resolve(false);
				}
			};
			executeSql(options);
		});
		//#endif
		//#ifndef APP-ANDROID
		return Promise.resolve(false);
		//#endif
	}

	private query(sql: string): Promise<SelectSqlResult | null> {
		//#ifdef APP-ANDROID
		return new Promise((resolve) => {
			const options: SelectSqlOptions = {
				name: DB_NAME,
				sql,
				success: (res) => {
					resolve(res);
				},
				fail: (_err) => {
					resolve(null);
				}
			};
			selectSql(options);
		});
		//#endif
		//#ifndef APP-ANDROID
		return Promise.resolve(null);
		//#endif
	}

	private async insertLog(message: string): Promise<void> {
		const createdAt = new Date().getTime();
		await this.execute(
			`INSERT INTO diagnostic_logs (created_at, message) VALUES (${createdAt}, '${escapeSqlText(message)}')`
		);
	}

	private async trimLogs(): Promise<void> {
		await this.execute(
			`DELETE FROM diagnostic_logs WHERE id NOT IN (SELECT id FROM diagnostic_logs ORDER BY id DESC LIMIT ${MAX_LOGS})`
		);
	}

	private async getDbLogCount(): Promise<number> {
		const result = await this.query("SELECT COUNT(*) FROM diagnostic_logs");
		if (result == null || result.rows.length == 0) return 0;
		const value = parseInt(result.rows[0][0] as string);
		return isNaN(value) ? 0 : value;
	}

	private getDeviceSummary(): string {
		try {
			const info = uni.getSystemInfoSync();
			return stringify({
				app: config.name,
				platform: info.platform,
				system: info.system,
				model: info.model,
				brand: info.brand,
				SDKVersion: info.SDKVersion,
				appVersion: info.appVersion
			});
		} catch (_e) {
			return stringify({ app: config.name });
		}
	}
}

export const diagnostics = new Diagnostics();

export function setupDiagnostics(): void {
	diagnostics.init();
}
