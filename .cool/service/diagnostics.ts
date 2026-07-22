import { config } from "@/config";
import { router } from "../router";
import { storage } from "../utils/storage";

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
const MAX_LOGS = 500;

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

class Diagnostics {
	private initialized = false;
	private logs: string[] = [];

	init(): void {
		if (this.initialized) return;
		this.initialized = true;
		this.logs = readLogs();
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
			storage.set(LOG_STORAGE_KEY, this.logs, 0);
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
		return readLogs();
	}

	getMaxLogs(): number {
		return MAX_LOGS;
	}

	clear(): void {
		this.logs = [];
		storage.remove(LOG_STORAGE_KEY);
	}

	toText(limit: number = 0): string {
		const lines: string[] = [];
		const logs = this.getLogs();
		const pickedLogs = limit > 0 && logs.length > limit ? logs.slice(logs.length - limit) : logs;

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
