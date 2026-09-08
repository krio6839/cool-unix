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

		await this.execute(`CREATE TABLE IF NOT EXISTS sleep_data (
        id TEXT PRIMARY KEY,
        report_timestamp INTEGER NOT NULL,
        bedtime INTEGER NOT NULL,
        sleep_time INTEGER NOT NULL,
        wake_time INTEGER NOT NULL,
        getup_time INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        uploaded INTEGER DEFAULT 0
      )`);
		await this.removeSleepRecordCountColumn();

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
        uploaded INTEGER DEFAULT 0
      )`);

		await this.execute("CREATE INDEX IF NOT EXISTS idx_ppi_timestamp ON ppi_data(timestamp)");
		await this.execute("CREATE INDEX IF NOT EXISTS idx_ppi_uploaded ON ppi_data(uploaded)");

		// 广播每秒的 activity；睡眠上传时按事件窗口读取并组装 detail。
		await this.execute(`CREATE TABLE IF NOT EXISTS sleep_status_data (
        timestamp INTEGER PRIMARY KEY,
        activity INTEGER NOT NULL
      )`);
		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_sleep_status_timestamp ON sleep_status_data(timestamp)"
		);

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

	private async removeSleepRecordCountColumn(): Promise<void> {
		if ((await this.hasColumn("sleep_data", "record_count")) == false) return;
		await this.execute("ALTER TABLE sleep_data DROP COLUMN record_count");
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
