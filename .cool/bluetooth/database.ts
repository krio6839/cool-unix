//#ifdef APP-ANDROID
import {
	openDatabase,
	executeSql,
	selectSql,
	closeDatabase,
	deleteDatabase
	//@ts-ignore
} from "@/uni_modules/meibao-Sqlite";
import type {
	OpenDatabaseOptions,
	ExecuteSqlOptions,
	SelectSqlOptions,
	CloseDatabaseOptions,
	DeleteDatabaseOptions,
	SelectSqlResult
	//@ts-ignore
} from "@/uni_modules/meibao-Sqlite";
import { logger } from "../service/logger";

const DB_NAME = "bluetooth_db";

/** sleep_data 的当前结构。重建旧表时复用同一份 DDL，避免两处定义漂移。 */
const sleepTableSql = (tableName: string): string => `CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        report_timestamp INTEGER NOT NULL,
        sleep_onset_time INTEGER,
        awake_time INTEGER,
        light_sleep_period INTEGER,
        deep_sleep_period INTEGER,
        other_sleep_period INTEGER,
        heart_rate_rest INTEGER,
        uploaded INTEGER DEFAULT 0
      )`;

class BluetoothDatabase {
	private isOpen: boolean = false;
	private operations: Promise<void> = Promise.resolve();

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operations.then(operation);
		this.operations = result.then(
			() => {},
			() => {}
		);
		return result;
	}

	/** UTS 对泛型 Promise 的联合返回值推断不稳定，查询走显式类型队列。 */
	private serializeQuery(
		operation: () => Promise<SelectSqlResult | null>
	): Promise<SelectSqlResult | null> {
		return new Promise((resolve) => {
			const run: Promise<void> = this.operations.then(async () => {
				try {
					const result: SelectSqlResult | null = await operation();
					resolve(result);
				} catch (error) {
					logger.error("bluetooth", "查询队列执行异常", error);
					resolve(null);
				}
			});
			this.operations = run.then(
				() => {},
				() => {}
			);
		});
	}

	/** 所有普通读写也使用同一队列，不能插入页面事务中。 */
	transaction(statements: string[], guardSql: string = ""): Promise<boolean> {
		return this.serialize(async () => {
			if ((await this.executeRaw("BEGIN IMMEDIATE")) == false) return false;
			try {
				if (guardSql != "") {
					const guard = await this.queryRaw(guardSql);
					if (guard == null || guard.rows.length == 0)
						throw new Error("历史任务已变化，拒绝旧页面提交");
				}
				for (let i = 0; i < statements.length; i++) {
					if ((await this.executeRaw(statements[i])) == false)
						throw new Error("事务写入失败");
				}
				if ((await this.executeRaw("COMMIT")) == false) throw new Error("事务提交失败");
				return true;
			} catch (error) {
				await this.executeRaw("ROLLBACK");
				logger.error("bluetooth", "历史页面事务回滚", error);
				return false;
			}
		});
	}

	// 打开数据库
	open(): Promise<boolean> {
		return new Promise((resolve) => {
			const options: OpenDatabaseOptions = {
				name: DB_NAME,
				success: (_res) => {
					logger.info("bluetooth", "数据库打开成功");
					this.isOpen = true;
					this.initTables()
						.then(() => {
							resolve(true);
						})
						.catch((e) => {
							logger.error("bluetooth", "数据库初始化失败:", e);
							resolve(false);
						});
				},
				fail: (err) => {
					logger.error("bluetooth", "数据库打开失败:", err.errMsg);
					this.isOpen = false;
					resolve(false);
				}
			};
			openDatabase(options);
		});
	}

	// 关闭数据库
	close(): Promise<boolean> {
		return this.serialize(() => this.closeRaw());
	}

	private closeRaw(): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.isOpen == false) {
				resolve(true);
				return;
			}

			const options: CloseDatabaseOptions = {
				name: DB_NAME,
				success: () => {
					logger.info("bluetooth", "数据库关闭成功");
					this.isOpen = false;
					resolve(true);
				},
				fail: (err) => {
					logger.error("bluetooth", "数据库关闭失败:", err.errMsg);
					resolve(false);
				}
			};
			closeDatabase(options);
		});
	}

	// 删除数据库
	delete(): Promise<boolean> {
		return this.serialize(() => this.deleteRaw());
	}

	private deleteRaw(): Promise<boolean> {
		return new Promise((resolve) => {
			const options: DeleteDatabaseOptions = {
				name: DB_NAME,
				success: () => {
					logger.info("bluetooth", "数据库删除成功");
					this.isOpen = false;
					resolve(true);
				},
				fail: (err) => {
					logger.error("bluetooth", "数据库删除失败:", err.errMsg);
					resolve(false);
				}
			};
			deleteDatabase(options);
		});
	}

	// 初始化表结构
	private async initTables(): Promise<void> {
		await this.execute("DROP TABLE IF EXISTS bluetooth_data");

		await this.execute(sleepTableSql("sleep_data"));
		await this.migrateSleepTable();

		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_sleep_report ON sleep_data(report_timestamp)"
		);
		await this.execute("CREATE INDEX IF NOT EXISTS idx_sleep_uploaded ON sleep_data(uploaded)");

		await this.execute(`CREATE TABLE IF NOT EXISTS ppi_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        hr INTEGER NOT NULL,
        spo2 INTEGER NOT NULL,
        ppi INTEGER NOT NULL,
        activity INTEGER,
        uploaded INTEGER DEFAULT 0
      )`);
		await this.migratePpiActivityColumn();

		await this.execute("CREATE INDEX IF NOT EXISTS idx_ppi_timestamp ON ppi_data(timestamp)");
		await this.execute("CREATE INDEX IF NOT EXISTS idx_ppi_uploaded ON ppi_data(uploaded)");

		// activity 已随 ppi_data 保存；旧逐秒睡眠暂存表不再有消费者。
		await this.execute("DROP TABLE IF EXISTS sleep_status_data");

		await this.recreateRealtimeBroadcastTableIfLegacy();
		await this.createRealtimeBroadcastTable();

		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_realtime_broadcast_timestamp ON realtime_broadcast_data(timestamp)"
		);
		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_realtime_broadcast_received ON realtime_broadcast_data(received_at)"
		);
	}

	private async createRealtimeBroadcastTable(): Promise<boolean> {
		return await this.execute(`CREATE TABLE IF NOT EXISTS realtime_broadcast_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        utc INTEGER NOT NULL,
        voltage_mv INTEGER NOT NULL,
        ppg_attached INTEGER NOT NULL,
        behavior INTEGER NOT NULL,
        activity INTEGER NOT NULL,
        hr INTEGER NOT NULL,
        ppi INTEGER NOT NULL,
        spo2 INTEGER NOT NULL,
        bhr INTEGER NOT NULL,
        event_seq INTEGER NOT NULL DEFAULT 0,
        has_new_event INTEGER NOT NULL DEFAULT 0,
        battery_status INTEGER NOT NULL DEFAULT 0,
        rmssd INTEGER NOT NULL DEFAULT 0,
        steps_everyday INTEGER NOT NULL DEFAULT 0,
        calorie_everyday INTEGER NOT NULL DEFAULT 0,
        raw_hex TEXT NOT NULL DEFAULT '',
        v_hex TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL DEFAULT ''
      )`);
	}

	private async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		const result = await this.query("PRAGMA table_info(" + tableName + ")");
		if (result == null) return false;
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			const name = row[1] as string;
			if (name == columnName) return true;
		}
		return false;
	}

	/** 旧版 PPI 保留原值与 uploaded 状态，新 activity 默认 NULL。 */
	private async migratePpiActivityColumn(): Promise<void> {
		if ((await this.hasColumn("ppi_data", "activity")) == true) return;
		if ((await this.execute("ALTER TABLE ppi_data ADD COLUMN activity INTEGER")) == false)
			throw new Error("ppi_data activity 字段迁移失败");
	}

	/**
	 * 把旧结构的 sleep_data 迁到当前结构。
	 *
	 * 不能用 `ALTER TABLE ... DROP COLUMN`：那需要 SQLite 3.35+（Android 14 才带），
	 * minSdk 21 的机器上会直接语法报错。旧表一旦带着 `record_count INTEGER NOT NULL`
	 * 留在原地，`storeSleepData` 的 `INSERT OR IGNORE` 会把 NOT NULL 冲突当成"可忽略"
	 * 静默跳过——行没写进去，SQL 却算执行成功，表现为「事件里明明有睡眠、saved 也涨，
	 * 但睡眠库始终为空，且日志里一条错都没有」。
	 *
	 * 所以改成整表重建。旧结构没有设备原始睡眠统计，只有已经上传的数据保留作审计；
	 * 未上传旧行不能构造新接口报文，迁移时丢弃。
	 * 全程只用 CREATE / INSERT SELECT / DROP / RENAME，不依赖高版本语法。
	 */
	private async migrateSleepTable(): Promise<void> {
		const columns = await this.sleepTableColumns();
		if (columns.length == 0) return;
		const currentColumns = [
			"id",
			"report_timestamp",
			"sleep_onset_time",
			"awake_time",
			"light_sleep_period",
			"deep_sleep_period",
			"other_sleep_period",
			"heart_rate_rest",
			"uploaded"
		];
		let upToDate = columns.length == currentColumns.length;
		for (let i = 0; i < currentColumns.length; i++) {
			if (columns.includes(currentColumns[i]) == false) upToDate = false;
		}
		if (upToDate == true) return;

		logger.info("bluetooth", `[DB] sleep_data 结构过旧,重建: 现有列=${columns.join(",")}`);
		const targets = currentColumns;
		const sources: string[] = [];
		for (let i = 0; i < targets.length; i++) {
			const name = targets[i];
			if (columns.includes(name) == true) sources.push(name);
			else if (name == "id") sources.push("CAST(report_timestamp AS TEXT)");
			else if (name == "report_timestamp" || name == "uploaded") sources.push("0");
			else sources.push("NULL");
		}
		let rowFilter = " WHERE 0";
		if (columns.includes("uploaded") == true) {
			rowFilter = " WHERE uploaded=1";
			const statisticColumns = [
				"sleep_onset_time",
				"awake_time",
				"light_sleep_period",
				"deep_sleep_period",
				"other_sleep_period",
				"heart_rate_rest"
			];
			let hasStatistics = true;
			for (let i = 0; i < statisticColumns.length; i++) {
				if (columns.includes(statisticColumns[i]) == false) hasStatistics = false;
			}
			if (hasStatistics == true)
				rowFilter =
					" WHERE uploaded=1 OR (sleep_onset_time IS NOT NULL AND awake_time IS NOT NULL AND light_sleep_period IS NOT NULL AND deep_sleep_period IS NOT NULL AND other_sleep_period IS NOT NULL AND heart_rate_rest IS NOT NULL)";
		}

		const rebuilt = await this.transaction([
			"DROP TABLE IF EXISTS sleep_data_migrating",
			sleepTableSql("sleep_data_migrating"),
			`INSERT INTO sleep_data_migrating (${targets.join(", ")}) SELECT ${sources.join(", ")} FROM sleep_data${rowFilter}`,
			"DROP TABLE sleep_data",
			"ALTER TABLE sleep_data_migrating RENAME TO sleep_data"
		]);
		if (rebuilt == false) {
			// 重建失败时旧表还在（事务已回滚）。这里必须抛：留着旧结构继续跑，
			// 睡眠会一直"保存成功"却一行都写不进去。
			throw new Error("sleep_data 结构重建失败");
		}
		logger.info("bluetooth", "[DB] sleep_data 结构重建完成");
	}

	private async sleepTableColumns(): Promise<string[]> {
		const result = await this.query("PRAGMA table_info(sleep_data)");
		if (result == null) return [];
		const names: string[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			names.push(result.rows[i][1] as string);
		}
		return names;
	}

	/** realtime_broadcast_data 只是实时缓存；旧结构直接丢弃重建，避免无意义迁移。 */
	private async recreateRealtimeBroadcastTableIfLegacy(): Promise<void> {
		const hasStatus = await this.hasColumn("realtime_broadcast_data", "status");
		const hasStatus2 = await this.hasColumn("realtime_broadcast_data", "status2");
		if (hasStatus == false && hasStatus2 == false) return;

		logger.info("bluetooth", "[DB] 旧 realtime_broadcast_data 结构已丢弃并重建");
		await this.execute("DROP TABLE IF EXISTS realtime_broadcast_data");
	}

	// 执行 SQL 语句
	execute(sql: string): Promise<boolean> {
		return this.serialize(() => this.executeRaw(sql));
	}

	private executeRaw(sql: string): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.isOpen == false) {
				logger.error("bluetooth", "数据库未打开");
				resolve(false);
				return;
			}

			const executeOptions: ExecuteSqlOptions = {
				name: DB_NAME,
				sql: sql,
				success: (_res) => {
					resolve(true);
				},
				fail: (err) => {
					logger.error("bluetooth", "SQL执行失败:", err.errMsg);
					resolve(false);
				}
			};
			executeSql(executeOptions);
		});
	}

	// 查询数据
	query(sql: string): Promise<SelectSqlResult | null> {
		return this.serializeQuery((): Promise<SelectSqlResult | null> => {
			return this.queryRaw(sql);
		});
	}

	private queryRaw(sql: string): Promise<SelectSqlResult | null> {
		return new Promise((resolve) => {
			if (this.isOpen == false) {
				logger.error("bluetooth", "数据库未打开");
				resolve(null);
				return;
			}

			const selectOptions: SelectSqlOptions = {
				name: DB_NAME,
				sql: sql,
				success: (res) => {
					resolve(res);
				},
				fail: (err) => {
					logger.error("bluetooth", "查询失败:", err.errMsg);
					resolve(null);
				}
			};
			selectSql(selectOptions);
		});
	}

	// 获取数据库状态
	getIsOpen(): boolean {
		return this.isOpen;
	}
}

//@ts-ignore
export const bluetoothDatabase = new BluetoothDatabase();
// #endif
// #ifndef APP-ANDROID
//@ts-ignore
export const bluetoothDatabase = null;
// #endif
