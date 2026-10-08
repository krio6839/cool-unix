/**
 * PPI 与睡眠的上传编排。
 *
 * 数据本身由 `data-manager.ts` 读写（它是纯数据库模块），这里只负责「什么时候传、
 * 怎么分批、失败了怎么办」。两者的边界是单向的：本文件 import 数据库方法，
 * 数据库不 import 本文件。
 *
 * **上传节奏由调用方决定**，这里没有条数与间隔阈值：`uploadData()` 是唯一入口，
 * 心跳（`device-tick.ts`）、补录落库后（`history-reader.ts`）、保活 tick
 * （`keepalive.ts`）三处都调它。早先的「攒够 30 条 或 距上次 30 秒」把节奏
 * 重新变成隐式的，已删除。
 */
import { bluetoothDataManager } from "./data-manager";
import { HISTORY_PPI_RETENTION_SEC } from "./history/coverage-service";
import { request } from "../service";
import { logger } from "../service/logger";
import {
	formatDateTimeInTimezone,
	getAppTimezone
} from "../utils/timezone";
import { UPLOAD_PPI_URL, UPLOAD_SLEEP_URL } from "./constants";
import type {
	SleepData,
	PpiUploadRequest,
	SleepUploadRequest,
	SleepUploadDataItem,
	PpiDataItem
} from "./types";

/**
 * 失败后的退避。失败批保持 `uploaded=0`，但不要随每次触发反复重试——
 * 触发点有心跳和保活 tick，不退避就会把失败请求打成密集重试。
 * 退避只作用于自动路径，测试页手动上传直接调 `uploadPpiData()`，不受影响。
 */
const UPLOAD_FAILURE_BACKOFF_MS = 60 * 1000;
/**
 * 每轮最多 10 批，防止长期占用上传通道。
 *
 * 单批的条数上限不在这里，而是 `data-manager.ts` 的 `PPI_UPLOAD_PAGE_SIZE`（SQL LIMIT）——
 * 分页是查询的属性，编排层再放一个同名的常量只会让人以为改它可以改批大小。
 */
const PPI_UPLOAD_MAX_BATCHES = 10;

export class BluetoothUploader {
	/**
	 * PPI 上传锁。
	 *
	 * 睡眠上传用它自己的锁，不复用这一把：两者写不同接口、不同表，互不冲突，
	 * 而 PPI 一轮最多连发 10 次请求；共用一个锁会让这期间的睡眠上传整段被丢掉。
	 */
	private isUploading: boolean = false;
	/** 睡眠上传锁。 */
	private sleepUploading: boolean = false;
	/** 上一次 PPI 上传失败发生的时刻，用于 `UPLOAD_FAILURE_BACKOFF_MS` 退避。 */
	private lastPpiUploadFailedAt: number = 0;
	private uploadScheduled: boolean = false;

	/**
	 * 设备名称与地址。
	 *
	 * 上传报文要带这两个字段，而它们是「设备身份」而不是「数据库状态」，所以随
	 * 上传一起走。调用方在扫描到绑定设备或建立连接时都要同步一次。
	 */
	private deviceName: string = "";
	private deviceAddress: string = "";

	/**
	 * 设置设备信息
	 * @param deviceName 设备显示名
	 * @param address 设备蓝牙地址
	 */
	setDeviceInfo(deviceName: string, address: string): void {
		this.deviceAddress = address;
		this.deviceName = deviceName + "-" + address.split(":").join("");
	}

	clearDeviceInfo(): void {
		this.deviceName = "";
		this.deviceAddress = "";
	}

	/**
	 * 上传PPI数据（心率、血氧、PPI）
	 * @returns 是否上传成功
	 */
	async uploadPpiData(): Promise<boolean> {
		if (this.isUploading == true) return false;
		// 查询前抢锁，避免广播、定时器和历史补拉同时取出同一批未上传记录。
		this.isUploading = true;
		try {
			const deviceName = this.deviceName;
			const deviceAddress = this.deviceAddress;
			// 冻结本轮的目标窗口。实时广播每秒仍在落库，若每批都按“当前所有未上传”取数，
			// 循环会被新到的实时秒一直喂饱，直到撞上批次上限仍在连发（每批只有 1~2 条）。
			const cutoff = await bluetoothDataManager.getLatestPpiTimestamp();
			for (let batch = 0; batch < PPI_UPLOAD_MAX_BATCHES; batch++) {
				const unuploadedData = await bluetoothDataManager.getUnuploadedPpiData(cutoff);
				if (unuploadedData.length == 0) return true;
				if (
					deviceAddress == "" ||
					this.deviceAddress != deviceAddress ||
					this.deviceName != deviceName
				) {
					return false;
				}
				const datas: PpiDataItem[] = [];
				const uploadedIds: string[] = [];
				const batchTimezone = getAppTimezone(unuploadedData[0].timestamp * 1000);
				for (let i = 0; i < unuploadedData.length; i++) {
					const item = unuploadedData[i];
					// 一个请求只有一个 timezone；系统模式跨夏令时边界时在这里截断，
					// 剩余记录由下一批发送，不能让同一请求里的时间解释互相矛盾。
					if (getAppTimezone(item.timestamp * 1000) != batchTimezone) break;
					datas.push({
						time: formatDateTimeInTimezone(item.timestamp * 1000, batchTimezone),
						hr: item.hr,
						spo2: item.spo2,
						ppi: item.ppi,
						activity: item.activity
					});
					uploadedIds.push(item.id);
				}
				const requestData: PpiUploadRequest = {
					device: deviceName,
					address: deviceAddress,
					timezone: batchTimezone,
					datas
				};
				logger.info(
					"bluetooth",
					`[BOOM-UPLOAD] 上传PPI数据: batch=${batch + 1}, count=${datas.length}, from=${unuploadedData[0].timestamp}, to=${unuploadedData[datas.length - 1].timestamp}, timezone=${batchTimezone}`
				);
				await request({
					url: UPLOAD_PPI_URL,
					method: "POST",
					data: requestData,
					strictSuccess: true,
					header: { "Content-Type": "application/json" }
				});
				// 请求期间如果切换/清除了设备，不修改当前数据库中的上传标记。
				if (this.deviceAddress != deviceAddress || this.deviceName != deviceName)
					return false;
				if ((await bluetoothDataManager.markPpiDataAsUploaded(uploadedIds)) == false) {
					throw new Error("PPI上传已确认，但本地上传标记保存失败");
				}
				await bluetoothDataManager.pruneUploadedPpiBefore(
					Math.floor(Date.now() / 1000) - HISTORY_PPI_RETENTION_SEC
				);
				this.lastPpiUploadFailedAt = 0;
				logger.info("bluetooth", `[BOOM-UPLOAD] PPI上传成功: count=${datas.length}`);
			}
			// 只对本轮窗口内的记录负责；窗口外新到的实时秒留给下一轮，不计入失败判定。
			const remaining = await bluetoothDataManager.getUnuploadedPpiCountUpTo(cutoff);
			logger.info("bluetooth", `[BOOM-UPLOAD] 本轮批次结束: remaining=${remaining}`);
			return remaining == 0;
		} catch (error) {
			this.lastPpiUploadFailedAt = Date.now();
			logger.error("bluetooth", "PPI上传失败，保留未上传数据:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	/**
	 * 有待传记录、且不处于失败退避时上传。
	 *
	 * true 表示无待传数据或本轮已传完；退避中、通道忙、仍有积压或失败返回 false。
	 */
	private async uploadPpiIfPending(): Promise<boolean> {
		if (this.isUploading == true) return false;
		try {
			const count = await bluetoothDataManager.getUnuploadedPpiCount();
			if (count == 0) return true;
			if (
				this.lastPpiUploadFailedAt > 0 &&
				Date.now() - this.lastPpiUploadFailedAt < UPLOAD_FAILURE_BACKOFF_MS
			)
				return false;
			return await this.uploadPpiData();
		} catch (error) {
			logger.error("bluetooth", "PPI上传检查失败:", error);
			return false;
		}
	}

	/**
	 * 上传睡眠数据
	 * @returns 是否上传成功
	 */
	async uploadSleepData(): Promise<boolean> {
		try {
			const unuploadedSleepData = await bluetoothDataManager.getUnuploadedSleepData();
			return await this.uploadSleepRecords(unuploadedSleepData);
		} catch (error) {
			logger.error("bluetooth", "睡眠上传检查失败:", error);
			return false;
		}
	}

	/** 测试用：重新上传最近的已上传睡眠记录，不改变其状态。 */
	async reuploadSleepData(count: number): Promise<number> {
		if (count <= 0) return 0;
		const uploadedSleepData = await bluetoothDataManager.getRecentSleepData(count, true);
		if (uploadedSleepData.length == 0) return 0;
		const ok = await this.uploadSleepRecords(uploadedSleepData);
		return ok ? uploadedSleepData.length : 0;
	}

	private async uploadSleepRecords(sleepDataList: SleepData[]): Promise<boolean> {
		// 没有待传数据不是失败。这条日志是“睡眠没上传”的第一个分岔：
		// 它出现说明本地压根没有待传记录，问题在事件读取/落库，不在上传。
		if (sleepDataList.length == 0) {
			logger.info("bluetooth", "[BOOM-UPLOAD] 无待上传睡眠数据");
			return true;
		}
		// 睡眠行主键就是 reportTimestamp，日志与上传标记都用它，不再引入一套 id。
		const timestamps = sleepDataList.map((item) => item.reportTimestamp);
		if (this.sleepUploading == true) {
			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠上传跳过: 原因=上一轮睡眠上传未结束, count=${sleepDataList.length}, times=${timestamps}`
			);
			return false;
		}
		if (this.deviceAddress == "") {
			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠上传跳过: 原因=设备未连接, count=${sleepDataList.length}, times=${timestamps}`
			);
			return false;
		}

		this.sleepUploading = true;
		try {
			// 一个请求只有一个 `timezone`，datas 里每条的 `time` 都按它格式化。
			// 睡眠链路原本用手机本地时区格式化、请求体却写固定时区，手机时区不是
			// +08:00 时同一个睡眠窗口在两份报文里会差几个小时，服务端切出来的
			// 逐秒曲线自然对不上；现在两条路都走 `getAppTimezone`。
			const batchTimezone = getAppTimezone(sleepDataList[0].reportTimestamp * 1000);
			const datas: SleepUploadDataItem[] = [];
			for (let i = 0; i < sleepDataList.length; i++) {
				const item = sleepDataList[i];
				datas.push({
					time: formatDateTimeInTimezone(item.reportTimestamp * 1000, batchTimezone),
					sleepOnsetTime: item.sleepOnsetTime,
					awakeTime: item.awakeTime,
					lightSleepPeriod: item.lightSleepPeriod,
					deepSleepPeriod: item.deepSleepPeriod,
					otherSleepPeriod: item.otherSleepPeriod,
					heartRateRest: item.heartRateRest
				});
			}
			// 只发设备给的东西：路由信息 + 事件字段。分数类字段原本是本地恒为 "1.0" 的
			// 假数据、请求级 `time` 原本是上传时刻，都不是设备来源，已删。
			const requestData: SleepUploadRequest = {
				address: this.deviceAddress,
				datas,
				device: this.deviceName,
				timezone: batchTimezone
			};

			logger.info(
				"bluetooth",
				`[BOOM-UPLOAD] 上传睡眠数据: count=${datas.length}, times=${timestamps}, ${this.describeSleepDatas(datas)}`
			);
			const response = await request({
				url: UPLOAD_SLEEP_URL,
				strictSuccess: true,
				method: "POST",
				data: requestData,
				header: { "Content-Type": "application/json" }
			});
			logger.info("bluetooth", `[BOOM-UPLOAD] 睡眠数据上传响应: ${response}`);

			if ((await bluetoothDataManager.markSleepAsUploadedByTimestamps(timestamps)) == false) {
				throw new Error("睡眠上传已确认，但本地上传标记保存失败");
			}
			logger.info("bluetooth", `[BOOM-UPLOAD] 睡眠数据上传成功: count=${datas.length}`);
			return true;
		} catch (error) {
			// 失败必须带时刻和原因：下一轮能不能补上，取决于这条记录是否还留在待传集合里。
			logger.error(
				"bluetooth",
				`[BOOM-UPLOAD] 睡眠数据上传失败: count=${sleepDataList.length}, times=${timestamps}`,
				error
			);
			return false;
		} finally {
			this.sleepUploading = false;
		}
	}

	/** 睡眠上传摘要直接展示设备事件给出的统计值。 */
	private describeSleepDatas(datas: SleepUploadDataItem[]): string {
		return datas
			.map(
				(item) =>
					`[time=${item.time}, sleepOnsetTime=${item.sleepOnsetTime}, awakeTime=${item.awakeTime}, light=${item.lightSleepPeriod}, deep=${item.deepSleepPeriod}, other=${item.otherSleepPeriod}, heartRateRest=${item.heartRateRest}]`
			)
			.join(" ");
	}

	/**
	 * 自动上传的**唯一入口**：PPI 与睡眠各走各的锁，都成功才返回 `true`。
	 *
	 * 三个触发点都调它：心跳、补录落库后的 `scheduleUpload()`、保活 tick。
	 * 手动路径（测试页）直接调 `uploadPpiData()` / `uploadSleepData()`，不经退避。
	 */
	async uploadData(): Promise<boolean> {
		const ppiOk = await this.uploadPpiIfPending();
		const sleepOk = await this.uploadSleepData();
		return ppiOk && sleepOk;
	}

	/** 历史落库后独立触发上传，不让网络请求阻塞 GATT 释放和广播恢复。 */
	scheduleUpload(): void {
		if (this.uploadScheduled == true) return;
		this.uploadScheduled = true;
		setTimeout(() => {
			this.uploadScheduled = false;
			this.uploadData()
				.then((ok) => {
					logger.info("bluetooth", `[BOOM-UPLOAD] 历史落库后上传检查完成: complete=${ok}`);
				})
				.catch((error) => {
					logger.error("bluetooth", "[BOOM-UPLOAD] 历史落库后上传异常:", error);
				});
		}, 0);
	}
}

export const bluetoothUploader = new BluetoothUploader();
