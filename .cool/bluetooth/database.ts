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
        record_count INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        uploaded INTEGER DEFAULT 0
      )`);

		// // 兼容老库：旧表若无 detail 列则补上
		// this.execute(`ALTER TABLE sleep_data ADD COLUMN detail TEXT NOT NULL DEFAULT ''`);

		// // 删除 sleep_status 表（已合并到 sleep_data.detail 字段）
		// this.execute(`DROP TABLE IF EXISTS sleep_status`);

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

		await this.execute(`CREATE TABLE IF NOT EXISTS realtime_broadcast_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        utc INTEGER NOT NULL,
        voltage_mv INTEGER NOT NULL,
        status INTEGER NOT NULL,
        ppg_attached INTEGER NOT NULL,
        behavior INTEGER NOT NULL,
        activity INTEGER NOT NULL,
        hr INTEGER NOT NULL,
        ppi INTEGER NOT NULL,
        spo2 INTEGER NOT NULL,
        bhr INTEGER NOT NULL,
        status2 INTEGER NOT NULL DEFAULT 0,
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
		await this.ensureColumn(
			"realtime_broadcast_data",
			"steps_everyday",
			"INTEGER NOT NULL DEFAULT 0"
		);
		await this.ensureColumn(
			"realtime_broadcast_data",
			"calorie_everyday",
			"INTEGER NOT NULL DEFAULT 0"
		);
		await this.ensureColumn("realtime_broadcast_data", "status2", "INTEGER NOT NULL DEFAULT 0");
		await this.ensureColumn(
			"realtime_broadcast_data",
			"event_seq",
			"INTEGER NOT NULL DEFAULT 0"
		);
		await this.ensureColumn(
			"realtime_broadcast_data",
			"has_new_event",
			"INTEGER NOT NULL DEFAULT 0"
		);
		await this.ensureColumn(
			"realtime_broadcast_data",
			"battery_status",
			"INTEGER NOT NULL DEFAULT 0"
		);
		await this.ensureColumn("realtime_broadcast_data", "rmssd", "INTEGER NOT NULL DEFAULT 0");

		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_realtime_broadcast_timestamp ON realtime_broadcast_data(timestamp)"
		);
		await this.execute(
			"CREATE INDEX IF NOT EXISTS idx_realtime_broadcast_received ON realtime_broadcast_data(received_at)"
		);
	}

	private async ensureColumn(
		tableName: string,
		columnName: string,
		definition: string
	): Promise<void> {
		const result = await this.query("PRAGMA table_info(" + tableName + ")");
		if (result == null) return;
		for (let i = 0; i < result.rows.length; i++) {
			const row = result.rows[i];
			const name = row[1] as string;
			if (name == columnName) return;
		}
		await this.execute(
			"ALTER TABLE " + tableName + " ADD COLUMN " + columnName + " " + definition
		);
	}

	// 执行 SQL 语句
	execute(sql: string): Promise<boolean> {
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
