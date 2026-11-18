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
 * broadcast_data：一行 = 设备给的一秒（广播秒，或历史补录补回来的秒）。
 *
 * 广播到达时整行写入设备给的**原始值**，不做生理范围过滤、不换算单位；页面展示时才
 * 决定哪些值能用。历史补录只填 `hr / spo2 / ppi / activity` 四列，其余保持默认——
 * 补录那条链路本来就没有静息心率、电量、步数，缺的就是缺的。
 *
 * `received_at` 兼作来源标记：广播行是手机接收毫秒（>0），补录行是 0。
 * 「取最近一条有效广播」靠它过滤：补录补的是刚过去的秒，时间戳可能比最后一条广播更晚，
 * 不过滤就会取到一条只有四个字段的补录行，首页的 bhr / rmssd 直接变 0。
 *
 * **不存原始 hex**：协议 24 字节已经全部解析成列，`raw_hex / v_hex` 每行要 84 字节，
 * 而它们的唯一用途是诊断时「看一眼原始帧」。诊断改成读内存里最近 20 帧
 * （`broadcastDebug`），既够用又不用为每一秒付这个钱。协议真改了，旧帧本来也解析不出来。
 *
 * `extra_1..3` 是给协议扩展留的：可空 INTEGER，没值时 SQLite 只在行头占 1 字节，
 * 不占数据区。**不是垃圾桶**——真加字段时应该把它改名成有语义的列，而不是一直往里塞。
 */
const BROADCAST_TABLE_SQL = `CREATE TABLE IF NOT EXISTS broadcast_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL DEFAULT 0,
        voltage_mv INTEGER NOT NULL DEFAULT 0,
        ppg_attached INTEGER NOT NULL DEFAULT 0,
        behavior INTEGER NOT NULL DEFAULT 0,
        activity INTEGER NOT NULL DEFAULT 0,
        hr INTEGER NOT NULL DEFAULT 0,
        ppi INTEGER NOT NULL DEFAULT 0,
        spo2 INTEGER NOT NULL DEFAULT 0,
        bhr INTEGER NOT NULL DEFAULT 0,
        event_seq INTEGER NOT NULL DEFAULT 0,
        has_new_event INTEGER NOT NULL DEFAULT 0,
        battery_status INTEGER NOT NULL DEFAULT 0,
        rmssd INTEGER NOT NULL DEFAULT 0,
        steps_everyday INTEGER NOT NULL DEFAULT 0,
        calorie_everyday INTEGER NOT NULL DEFAULT 0,
        rssi INTEGER NOT NULL DEFAULT 0,
        device_id TEXT NOT NULL DEFAULT '',
        uploaded INTEGER NOT NULL DEFAULT 0,
        extra_1 INTEGER,
        extra_2 INTEGER,
        extra_3 INTEGER
      )`;

/** `BROADCAST_TABLE_SQL` 的列名（顺序一致），用于判断已有表是不是当前结构。 */
const BROADCAST_TABLE_COLUMNS =
	"id,timestamp,received_at,voltage_mv,ppg_attached,behavior,activity,hr,ppi,spo2,bhr,event_seq,has_new_event,battery_status,rmssd,steps_everyday,calorie_everyday,rssi,device_id,uploaded,extra_1,extra_2,extra_3";

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

		await this.recreateBroadcastTableIfStale();
		await this.execute(BROADCAST_TABLE_SQL);

		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_broadcast_timestamp ON broadcast_data(timestamp)"
		);
		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_broadcast_uploaded ON broadcast_data(uploaded)"
		);

		// activity 已随 broadcast_data 保存；旧逐秒睡眠暂存表不再有消费者。
		await this.execute("DROP TABLE IF EXISTS sleep_status_data");

		// 单行广播缓存已并入 broadcast_data：整表连同两个时间索引一起丢掉。
		await this.execute("DROP TABLE IF EXISTS realtime_broadcast_data");
		await this.execute("DROP INDEX IF EXISTS idx_realtime_broadcast_timestamp");
		await this.execute("DROP INDEX IF EXISTS idx_realtime_broadcast_received");

		// ppi_data 已改名为 broadcast_data，旧表只在升级时存在一次。
		await this.execute("DROP TABLE IF EXISTS ppi_data");
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

	/**
	 * broadcast_data 是待上传队列 + 广播留档，只认当前结构：列集合对不上、或 `activity`
	 * 还是可空的，一律丢表重建。
	 *
	 * 缺 `activity` 的表是按「睡眠详情还不在每秒数据里」的版本建的，那些行既没有睡眠详情
	 * 也没法补出来；可空则意味着旧行会以 `NULL` 进入上传报文。两种都不值得留——留一种，
	 * 就得在每次写入前挂一条「回填 activity」的语句，而当天写进去的行永远用不上它。
	 */
	private async recreateBroadcastTableIfStale(): Promise<void> {
		const columns = await this.tableColumns("broadcast_data");
		if (columns.length == 0) return;
		let stale = columns.join(",") != BROADCAST_TABLE_COLUMNS;
		if (stale == false) stale = await this.columnIsNullable("broadcast_data", "activity");
		if (stale == false) return;

		logger.info(
			"bluetooth",
			`[DB] broadcast_data 结构已变,丢弃重建: 现有列=${columns.join(",")}`
		);
		await this.execute("DROP TABLE IF EXISTS broadcast_data");
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
