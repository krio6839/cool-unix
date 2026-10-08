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

/**
 * sleep_data：一行 = 一条设备睡眠事件。
 *
 * 主键就是事件结算时刻，不再另造 `id`——两者是同一个值，留两份只多一条翻译路径。
 * 六个统计值由设备事件整体给出，要么一起有、要么这条事件无效，所以都是 NOT NULL：
 * 表结构自己就能保证「查出来的行一定构造得出上传报文」。
 */
const SLEEP_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sleep_data (
        report_timestamp INTEGER PRIMARY KEY,
        sleep_onset_time INTEGER NOT NULL,
        awake_time INTEGER NOT NULL,
        light_sleep_period INTEGER NOT NULL,
        deep_sleep_period INTEGER NOT NULL,
        other_sleep_period INTEGER NOT NULL,
        heart_rate_rest INTEGER NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0
      )`;

/** `SLEEP_TABLE_SQL` 的列名（顺序一致），用于判断已有表是不是当前结构。 */
const SLEEP_TABLE_COLUMNS =
	"report_timestamp,sleep_onset_time,awake_time,light_sleep_period,deep_sleep_period,other_sleep_period,heart_rate_rest,uploaded";

/**
 * ppi_data：一行 = 设备给的一秒。
 *
 * `activity`（设备 `status` 的低 3 位，睡眠详情就靠它）是 NOT NULL：每条广播和每个历史秒
 * 都带着它，没有「这一秒不知道活动状态」的情况。
 */
const PPI_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ppi_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        hr INTEGER NOT NULL,
        spo2 INTEGER NOT NULL,
        ppi INTEGER NOT NULL,
        activity INTEGER NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0
      )`;

/** `PPI_TABLE_SQL` 的列名（顺序一致），用于判断已有表是不是当前结构。 */
const PPI_TABLE_COLUMNS = "id,timestamp,hr,spo2,ppi,activity,uploaded";

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

		await this.recreateSleepTableIfStale();
		await this.execute(SLEEP_TABLE_SQL);

		await this.execute("CREATE INDEX IF NOT EXISTS idx_sleep_uploaded ON sleep_data(uploaded)");

		await this.recreatePpiTableIfStale();
		await this.execute(PPI_TABLE_SQL);

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

	/** 表的现有列名；表不存在时返回空数组。 */
	private async tableColumns(tableName: string): Promise<string[]> {
		const result = await this.query("PRAGMA table_info(" + tableName + ")");
		if (result == null) return [];
		const names: string[] = [];
		for (let i = 0; i < result.rows.length; i++) {
			names.push(result.rows[i][1] as string);
		}
		return names;
	}

	private async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		return (await this.tableColumns(tableName)).includes(columnName);
	}

	/**
	 * ppi_data 是待上传队列，只认当前结构：列集合对不上、或 `activity` 还是可空的，
	 * 一律丢表重建。
	 *
	 * 缺 `activity` 的表是按「睡眠详情还不在每秒数据里」的版本建的，那些行既没有睡眠详情
	 * 也没法补出来；可空则意味着旧行会以 `NULL` 进入上传报文。两种都不值得留——留一种，
	 * 就得在每次写入前挂一条「回填 activity」的语句，而当天写进去的行永远用不上它。
	 */
	private async recreatePpiTableIfStale(): Promise<void> {
		const columns = await this.tableColumns("ppi_data");
		if (columns.length == 0) return;
		let stale = columns.join(",") != PPI_TABLE_COLUMNS;
		if (stale == false) stale = await this.columnIsNullable("ppi_data", "activity");
		if (stale == false) return;

		logger.info("bluetooth", `[DB] ppi_data 结构已变,丢弃重建: 现有列=${columns.join(",")}`);
		await this.execute("DROP TABLE IF EXISTS ppi_data");
	}

	/** 该列是否可空（`PRAGMA table_info` 的 notnull 位为 0）；列不存在时返回 false。 */
	private async columnIsNullable(tableName: string, columnName: string): Promise<boolean> {
		const result = await this.query("PRAGMA table_info(" + tableName + ")");
		if (result == null) return false;
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			if ((row[1] as string) != columnName) continue;
			return parseInt(row[3] as string) == 0;
		}
		return false;
	}

	/**
	 * sleep_data 是纯本地的事件缓存，没有迁移价值：六个统计值只存在于设备事件里，
	 * 旧结构的行既缺列也缺值，拼不出现在的上传报文。所以结构不一致就整表丢掉重建，
	 * 不做列对列的搬运。
	 *
	 * 必须直接 DROP 重建、不能把旧表留在原地：旧表带着 `record_count INTEGER NOT NULL`
	 * 这类列时，`storeSleepData` 的 `INSERT OR IGNORE` 会把 NOT NULL 冲突当成「可忽略」
	 * 静默跳过——行没写进去，SQL 却算执行成功，表现为「事件里明明有睡眠、saved 也在涨，
	 * 但睡眠库始终为空，且日志里一条错都没有」。
	 */
	private async recreateSleepTableIfStale(): Promise<void> {
		const columns = await this.tableColumns("sleep_data");
		if (columns.length == 0) return;
		if (columns.join(",") == SLEEP_TABLE_COLUMNS) return;

		logger.info("bluetooth", `[DB] sleep_data 结构已变,丢弃重建: 现有列=${columns.join(",")}`);
		await this.execute("DROP TABLE IF EXISTS sleep_data");
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
