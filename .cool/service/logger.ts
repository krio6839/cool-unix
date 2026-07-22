import {
	diagnostics,
	type DiagnosticLogLevel,
	type DiagnosticRequestContext
} from "./diagnostics";

class Logger {
	record(level: DiagnosticLogLevel, tag: string, title: string, detail: string = ""): void {
		diagnostics.record(level, tag, title, detail);
	}

	info(tag: string, ...items: (any | null)[]): void {
		const message = this.format(items);
		console.log(message);
		this.record("info", tag, message);
	}

	warn(tag: string, ...items: (any | null)[]): void {
		const message = this.format(items);
		console.warn(message);
		this.record("warn", tag, message);
	}

	error(tag: string, ...items: (any | null)[]): void {
		const message = this.format(items);
		console.error(message);
		this.record("error", tag, message);
	}

	consoleInfo(...items: (any | null)[]): void {
		console.log(this.format(items));
	}

	requestError(ctx: DiagnosticRequestContext): void {
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

		console.error("[request error]", message, ctx.detail ?? "");
		diagnostics.captureRequest(ctx);
	}

	private format(items: (any | null)[]): string {
		return items.map((item) => this.stringify(item)).join(" ");
	}

	private stringify(value: any | null): string {
		if (value == null) return "";
		if (typeof value == "string") return value;
		if (typeof value == "number" || typeof value == "boolean") return `${value}`;
		try {
			return JSON.stringify(value);
		} catch (_e) {
			return `${value}`;
		}
	}
}

export const logger = new Logger();
