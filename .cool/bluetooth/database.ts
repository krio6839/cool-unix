//#ifdef APP-ANDROID
import {
	openDatabase,
	executeSql,
	selectSql,
	closeDatabase,
	type OpenDatabaseOptions,
	type ExecuteSqlOptions,
	type SelectSqlOptions,
	type CloseDatabaseOptions,
	type SelectSqlResult
	//@ts-ignore
} from "@/uni_modules/meibao-Sqlite";

const DB_NAME = "bluetooth_db";

class BluetoothDatabase {
	private isOpen: boolean = false;

	// 打开数据库
	open(): Promise<boolean> {
		return new Promise((resolve) => {
			const options: OpenDatabaseOptions = {
				name: DB_NAME,
				success: (_res) => {
					console.log("数据库打开成功");
					this.isOpen = true;
					this.initTables();
					resolve(true);
				},
				fail: (err) => {
					console.error("数据库打开失败:", err.errMsg);
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
					console.log("数据库关闭成功");
					this.isOpen = false;
					resolve(true);
				},
				fail: (err) => {
					console.error("数据库关闭失败:", err.errMsg);
					resolve(false);
				}
			};
			closeDatabase(options);
		});
	}

	// 初始化表结构
	private initTables(): void {
		this.execute(`CREATE TABLE IF NOT EXISTS bluetooth_data (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        value REAL NOT NULL,
        ppi INTEGER,
        uploaded INTEGER DEFAULT 0
      )`);

		this.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON bluetooth_data(timestamp)");
		this.execute("CREATE INDEX IF NOT EXISTS idx_uploaded ON bluetooth_data(uploaded)");
		this.execute("CREATE INDEX IF NOT EXISTS idx_type ON bluetooth_data(type)");

		this.execute(`CREATE TABLE IF NOT EXISTS sleep_data (
        id TEXT PRIMARY KEY,
        report_timestamp INTEGER NOT NULL,
        bedtime INTEGER NOT NULL,
        sleep_time INTEGER NOT NULL,
        wake_time INTEGER NOT NULL,
        getup_time INTEGER NOT NULL,
        record_count INTEGER NOT NULL,
        uploaded INTEGER DEFAULT 0
      )`);

		this.execute("CREATE INDEX IF NOT EXISTS idx_sleep_report ON sleep_data(report_timestamp)");
		this.execute("CREATE INDEX IF NOT EXISTS idx_sleep_uploaded ON sleep_data(uploaded)");

		this.execute(`CREATE TABLE IF NOT EXISTS sleep_status (
        id TEXT PRIMARY KEY,
        sleep_id TEXT NOT NULL,
        minute_index INTEGER NOT NULL,
        status INTEGER NOT NULL
      )`);

		this.execute("CREATE INDEX IF NOT EXISTS idx_sleep_id ON sleep_status(sleep_id)");
	}

	// 执行 SQL 语句
	execute(sql: string): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.isOpen == false) {
				console.error("数据库未打开");
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
					console.error("SQL执行失败:", err.errMsg);
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
				console.error("数据库未打开");
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
					console.error("查询失败:", err.errMsg);
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
