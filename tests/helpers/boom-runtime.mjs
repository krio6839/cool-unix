import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Execute production TS with real SQLite; replace only native App/BLE/network boundaries.
export async function createRuntime(t) {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const state = {
		db,
		posts: [],
		logs: [],
		timers: [],
		storage: {},
		archived: [],
		/** 测试拨动时钟用，单位毫秒。 */
		dateOffsetMs: 0,
		response: { status: "success" },
		executeFailure: false,
		queryFailure: false,
		expired: false,
		refreshExpired: false,
		user: {
			token: null,
			logout() {},
			async refreshToken() {
				return "new-token";
			}
		},
		async sleep() {}
	};
	const logger = {
		info(...items) {
			state.logs.push({ level: "info", items });
		},
		warn(...items) {
			state.logs.push({ level: "warn", items });
		},
		error(...items) {
			state.logs.push({ level: "error", items });
		},
		requestError() {}
	};
	/**
	 * 可拨动的时钟。默认偏移为 0，行为与原生 Date 完全一致；
	 * 需要验证“隔一段时间才发生”的逻辑时，测试改 state.dateOffsetMs 即可，不用真的等。
	 */
	class OffsetDate extends Date {
		constructor(...args) {
			if (args.length === 0) super(Date.now() + state.dateOffsetMs);
			else super(...args);
		}
		static now() {
			return Date.now() + state.dateOffsetMs;
		}
	}
	const context = {
		console: { log() {} },
		Date: OffsetDate,
		Map,
		Math,
		JSON,
		setInterval: () => 1,
		clearInterval() {},
		clearTimeout() {},
		setTimeout: (fn) => {
			state.timers.push(fn);
			return state.timers.length;
		},
		uni: {
			request(options) {
				const data = options.data == null ? null : JSON.parse(options.data);
				state.posts.push({ ...options, data });
				if (state.respond) return state.respond(options);
				options.success({ statusCode: 200, data: state.response });
			}
		}
	};
	const cache = new Map();
	const mocks = {
		"@/uni_modules/meibao-Sqlite": {
			openDatabase: (o) => o.success({}),
			closeDatabase: (o) => o.success({}),
			deleteDatabase: (o) => o.success({}),
			executeSql: (o) => {
				if (state.executeFailure || (state.failSql && state.failSql(o.sql)))
					return o.fail({ errMsg: "injected write failure" });
				try {
					db.exec(o.sql);
					o.success({});
				} catch (e) {
					o.fail({ errMsg: e.message });
				}
			},
			selectSql: (o) => {
				if (state.queryFailure) return o.fail({ errMsg: "injected read failure" });
				try {
					o.success({
						rows: db
							.prepare(o.sql)
							.all()
							.map((row) => Object.values(row))
					});
				} catch (e) {
					o.fail({ errMsg: e.message });
				}
			}
		},
		"@/config": {
			isDev: false,
			ignoreTokens: [],
			config: { name: "BOOM", baseUrl: "https://test.invalid" }
		},
		"../locale": { locale: { value: "zh" }, t: (x) => x },
		"../utils": {
			getErrorMessage: (e, fallback) => e?.message ?? fallback,
			isNull: (x) => x == null,
			isObject: (x) => x != null && typeof x === "object" && !Array.isArray(x),
			parse: (x) => x,
			storage: {
				isExpired: (key) => (key === "token" ? state.expired : state.refreshExpired)
			}
		},
		"../store": { useStore: () => ({ user: state.user }) },
		"./error-notice": { defaultErrorNotice: { show() {} } },
		"../../bluetooth/kux": {
			onCharacteristicValueChange() {},
			disconnect() {},
			closeAdapter() {}
		},
		"./logger": { logger },
		"../../service/logger": { logger },
		"../service/logger": { logger },
		"../router": { router: { path: () => "/device" } },
		"../utils/storage": {
			storage: {
				get: (key) => state.storage[key] ?? null,
				set: (key, value) => {
					state.storage[key] = value;
				},
				remove: (key) => {
					delete state.storage[key];
				}
			}
		},
		"@/uni_modules/boom-csv-saver": {
			saveLogToDownloads: (fileName, content) => {
				state.archived.push({ fileName, content });
				return "Download/BOOM/logs/" + fileName;
			}
		},
		"../utils/day": { dayUts: (ms) => ({ format: () => new Date(ms).toISOString() }) },
		"./constants": {
			UPLOAD_INTERVAL: 30000,
			UPLOAD_PPI_URL: "/ppi",
			UPLOAD_SLEEP_URL: "/sleep"
		},
		vue: { ref: (value) => ({ value }) },
		"../../utils": { sleepTimeout: (ms) => state.sleep(ms) }
	};
	async function load(path) {
		if (cache.has(path)) return cache.get(path);
		let source = await readFile(new URL("../../" + path, import.meta.url), "utf8");
		if (path.endsWith("/database.ts"))
			source = source.replace(/\/\/ #ifndef APP-ANDROID[\s\S]*$/, "");
		source = stripTypeScriptTypes(source);
		const args = Object.keys(context),
			values = Object.values(context);
		const imports = [
			...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];?/g)
		];
		for (const match of imports) {
			const specifier = match[2];
			let dependency;
			if (
				[
					"./database",
					"../database",
					"./history-schema",
					"./history-progress",
					"./history-coverage",
					"./history-coverage-service",
					"./coverage",
					"./coverage-service",
					"../boom-types",
					"./history/progress",
					"./history/coverage-service",
					"../../bluetooth/history-progress",
					"../../bluetooth/history/progress",
					"./boom-parser",
					"./boom-bytes",
					"./boom-constants"
				].includes(specifier)
			) {
				dependency = (
					await load(posix.normalize(posix.join(posix.dirname(path), specifier + ".ts")))
				).namespace;
			} else if (specifier === "../service")
				dependency = (await load(".cool/service/index.ts")).namespace;
			else if (specifier === "../../bluetooth/data-manager")
				dependency = (await load(".cool/bluetooth/data-manager.ts")).namespace;
			else {
				if (!(specifier in mocks))
					throw new Error(`Unmocked native import ${specifier} in ${path}`);
				dependency = mocks[specifier];
			}
			const depName = "__dep" + args.length;
			args.push(depName);
			values.push(dependency);
			source = source.replace(
				match[0],
				"const {" + match[1].replace(/\bas\b/g, ":") + "} = " + depName + ";"
			);
		}
		const exports = [
			...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)
		].map((x) => x[1]);
		source = source.replace(/\bexport\s+/g, "");
		const namespace = new Function(
			...args,
			source + "\nreturn {" + exports.join(",") + "};\n//# sourceURL=" + path
		)(...values);
		const mod = { namespace, status: "evaluated", async evaluate() {} };
		cache.set(path, mod);
		return mod;
	}
	const managerModule = await load(".cool/bluetooth/data-manager.ts");
	await managerModule.evaluate();
	const manager = managerModule.namespace.bluetoothDataManager;
	manager.setDeviceInfo("BOOM", "AA:BB");
	await manager.databaseReady;
	const parserModule = await load(".cool/bluetooth/boom-parser.ts");
	await parserModule.evaluate();
	state.parser = parserModule.namespace;
	state.database = cache.get(".cool/bluetooth/database.ts").namespace.bluetoothDatabase;
	state.load = async (path) => {
		const mod = await load(path);
		if (mod.status !== "evaluated") await mod.evaluate();
		return mod.namespace;
	};
	// 事件类型/命令码与解析函数用真实实现：桩成空对象会让 LOG_EVENT_TYPE.SleepResult
	// 变成 undefined，睡眠事件在测试里被全部跳过，掩盖真实链路；解析函数桩成空壳则
	// 让事件读取永远拿到空批次，同样测不出东西。
	const btConstants = (await load(".cool/bluetooth/boom-constants.ts")).namespace;
	const btParser = (await load(".cool/bluetooth/boom-parser.ts")).namespace;
	mocks["../../bluetooth"] = {
		bluetoothDataManager: manager,
		BOOM_CMD: btConstants.BOOM_CMD,
		LOG_EVENT_NAMES: btConstants.LOG_EVENT_NAMES,
		LOG_EVENT_TYPE: btConstants.LOG_EVENT_TYPE,
		parseEventDataHeader: btParser.parseEventDataHeader,
		parseLogDataList: btParser.parseLogDataList,
		parseVitalDataResponse: btParser.parseVitalDataResponse
	};
	const readerModule = await load(".cool/store/device/history-reader.ts");
	await readerModule.evaluate();
	state.DeviceHistoryReader = readerModule.namespace.DeviceHistoryReader;
	const syncModule = await load(".cool/store/device/sync.ts");
	await syncModule.evaluate();
	state.diagnostics = (await load(".cool/service/diagnostics.ts")).namespace.diagnostics;
	state.manager = manager;
	state.DeviceSync = syncModule.namespace.DeviceSync;
	state.request = cache.get(".cool/service/index.ts").namespace.request;
	state.seed = (count) => {
		const insert = db.prepare("INSERT INTO ppi_data VALUES (?, ?, 60, 0, 1000, 0)");
		const base = Math.floor(Date.now() / 1000) - count - 10;
		for (let i = 1; i <= count; i++) {
			const timestamp = base + i;
			insert.run(String(timestamp), timestamp);
		}
	};
	return state;
}
