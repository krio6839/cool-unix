import { diagnostics, type DiagnosticLogLevel } from "./diagnostics";

class Logger {
	record(level: DiagnosticLogLevel, tag: string, title: string, detail: string = ""): void {
		diagnostics.record(level, tag, title, detail);
	}

	info(tag: string, title: string, detail: string = ""): void {
		if (detail == "") {
			console.log(title);
		} else {
			console.log(title, detail);
		}
		this.record("info", tag, title, detail);
	}

	warn(tag: string, title: string, detail: string = ""): void {
		if (detail == "") {
			console.warn(title);
		} else {
			console.warn(title, detail);
		}
		this.record("warn", tag, title, detail);
	}

	error(tag: string, title: string, detail: string = ""): void {
		if (detail == "") {
			console.error(title);
		} else {
			console.error(title, detail);
		}
		this.record("error", tag, title, detail);
	}
}

export const logger = new Logger();
