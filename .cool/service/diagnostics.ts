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

	init(): void {
		if (this.initialized) return;
		this.initialized = true;
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
		this.logs = [];
		storage.remove(LOG_STORAGE_KEY);
		if (this.dbReadyTask != null) {
			await this.dbReadyTask;
		}
		await this.writeTask;
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
