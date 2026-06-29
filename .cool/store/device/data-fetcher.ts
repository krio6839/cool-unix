import { PageWaiter, loadResumeCount, storage } from "../../utils";
import { bluetoothDataManager } from "../../bluetooth";
import { SleepResponseAssembler } from "../../bluetooth";
import { KEY_PPI_SAVED_COUNT, KEY_SLEEP_SAVED_COUNT } from "./types";

import type { HeartRateRecord, SleepData } from "../../bluetooth";
import type { Device } from "./index";

export class DataFetcher {
	private device: Device;

	// 分页等待器：心率分页 / 睡眠分页各持一个，复用同一原语
	private _heartRatePageWaiter: PageWaiter = new PageWaiter();
	private _sleepPageWaiter: PageWaiter = new PageWaiter();
	// 睡眠响应装配器：封装"头部识别 + 状态累积 + 超时 reset"状态机
	private _sleepAssembler: SleepResponseAssembler = new SleepResponseAssembler();

	// 定时轮询相关
	private _dataQueryTimer: number = 0;
	private _isQueryingData = false;
	private _dataQueryInterval = 30000; // 30秒查询一次

	constructor(device: Device) {
		this.device = device;
	}

	/**
	 * 启动定时数据查询
	 * 连接成功后自动调用，循环查询数据就绪状态并按需获取历史数据
	 */
	startDataQueryTimer(): void {
		if (this._dataQueryTimer != 0) {
			console.log("[DATA_QUERY] 定时查询已在运行");
			return;
		}

		console.log("[DATA_QUERY] 启动定时数据查询，间隔", this._dataQueryInterval, "ms");
		this.queryDataStatusWithFetch();
		// 使用 setInterval 确保固定间隔执行
		// @ts-ignore
		this._dataQueryTimer = setInterval(() => {
			if (this._isQueryingData) {
				console.log("[DATA_QUERY] 上一次查询尚未完成，跳过本次");
				return;
			}
			this.queryDataStatusWithFetch();
		}, this._dataQueryInterval);
	}

	/**
	 * 停止定时数据查询
	 */
	stopDataQueryTimer(): void {
		if (this._dataQueryTimer != 0) {
			clearInterval(this._dataQueryTimer);
			this._dataQueryTimer = 0;
			console.log("[DATA_QUERY] 停止定时数据查询");
		}
	}

	/**
	 * 查询数据状态并按需获取历史数据
	 * 等待响应后根据 heartRateCount 和 sleepCount 判断是否需要获取数据
	 */
	async queryDataStatusWithFetch(): Promise<void> {
		if (this._isQueryingData == true) {
			return;
		}
		this._isQueryingData = true;
		console.log("[DATA_QUERY] 开始查询数据状态");

		try {
			// 发送查询命令
			await this.device.protocol.queryDataReadyStatus();

			// 等待响应更新（通过 onCharacteristicValueChange 异步更新 dataReadyStatus）
			// 短暂等待让响应有机会到达
			await new Promise<void>((resolve) => {
				setTimeout(() => resolve(), 500);
			});

			const status = this.device.dataReadyStatus.value;
			console.log("[DATA_QUERY] 数据状态:", status);

			// 按需获取历史数据
			if (status.heartRateCount > 0) {
				console.log("[DATA_QUERY] 发现心率血氧历史数据，开始获取...");
				await this.fetchAllHistoricalHeartRateData();
			}

			if (status.sleepCount > 0) {
				console.log("[DATA_QUERY] 发现睡眠数据，开始获取...");
				await this.fetchAllSleepData();
			}
		} finally {
			this._isQueryingData = false;
		}
	}

	/**
	 * 存储历史心率血氧记录到数据库（批量 INSERT）
	 * @param records 历史心率记录数组
	 */
	async storeHistoricalRecords(records: Array<HeartRateRecord>): Promise<void> {
		try {
			if (records.length > 0) {
				await bluetoothDataManager.storeHistoricalHeartRateRecordsBatch(records);
			}
		} catch (e) {
			console.error("[STORE] 批量存储历史心率记录失败:", e);
		}
	}

	/**
	 * 自动获取所有历史心率血氧数据（支持断点续传）
	 * 根据 dataReadyStatus.heartRateCount 自动遍历获取；
	 * 通过 KEY_PPI_SAVED_COUNT 持久化已保存条数，避免重复抓取；
	 * 如果设备历史被清空（已保存 > 设备总条数），自动清空 ppi_data 后重抓。
	 */
	async fetchAllHistoricalHeartRateData(): Promise<void> {
		const status = this.device.dataReadyStatus.value;
		if (status.heartRateCount <= 0) {
			console.log("没有历史心率血氧数据");
			return;
		}

		// 断点续传：校验已保存条数（跨平台类型守卫、边界重置、是否完成均在工具内）
		const { savedCount, isComplete } = loadResumeCount(
			KEY_PPI_SAVED_COUNT,
			status.heartRateCount
		);
		if (isComplete) {
			console.log("已全部保存，无需抓取");
			return;
		}
		console.log(
			savedCount > 0
				? `[FETCH] 断点续传：已保存 ${savedCount} 条，从第 ${savedCount} 条继续`
				: "[FETCH] 首次抓取，从头开始"
		);

		const startIndex = savedCount;
		this._heartRatePageWaiter.reset();

		// 计算总页数（每页16条）
		const remainingCount = status.heartRateCount - startIndex;
		const pageCount = Math.ceil(remainingCount / 16);
		// 单页响应的最长等待时间（兜底）
		const PAGE_RESPONSE_TIMEOUT_MS = 3000;
		console.log(
			`开始获取历史心率血氧数据，总共 ${status.heartRateCount} 条，已保存 ${startIndex} 条，剩余 ${remainingCount} 条，共 ${pageCount} 页`
		);

		for (let i = 0; i < pageCount; i++) {
			// 从 startIndex 对应的 page 开始累加，保证 recordIndex 与已保存数据严格连续
			const page = Math.floor(startIndex / 16) + i;
			const recordIndex = page * 16;
			console.log("获取第", page, "页，索引从", recordIndex, "开始");

			await this.device.protocol.getHistoricalHeartRateData(recordIndex);

			// 等待响应到达；超过超时时间则视为本页无响应，继续下一页
			const timeout = await this._heartRatePageWaiter.wait(PAGE_RESPONSE_TIMEOUT_MS);
			if (timeout == true) {
				console.log(`第 ${page} 页响应超时（${PAGE_RESPONSE_TIMEOUT_MS}ms），继续下一页`);
				continue;
			}

			// 同步存储本批记录并推进进度计数（storeHistoricalRecords 内部 await 批量 INSERT）
			// 注意：本页响应已到达，"全 f"标志已由 onCharacteristicValueChange 同步设置
			if (this._heartRatePageWaiter.isAllEmpty()) {
				console.log(`第 ${page} 页响应为全 f，无更多数据，提前结束获取`);
				break;
			}
		}

		// 全部完成后落盘"已保存条数"；异常退出时保持原 savedCount，下次进入续传
		storage.set(KEY_PPI_SAVED_COUNT, status.heartRateCount, 0);
		console.log(`[FETCH] 完成，ppi_data 已保存条数 = ${status.heartRateCount}`);
	}

	/**
	 * 自动获取所有睡眠数据（支持断点续传）
	 * 根据 dataReadyStatus.sleepCount 自动遍历获取；
	 * 通过 KEY_SLEEP_SAVED_COUNT 持久化已保存条数，避免重复抓取；
	 * 如果设备历史被清空（已保存 > 设备总条数），自动重置计数。
	 * 两层超时：装配器内部 3000ms（头部已收但状态包丢失）+ 外部 waiter 5000ms（极端情况兜底）
	 */
	async fetchAllSleepData(): Promise<void> {
		const status = this.device.dataReadyStatus.value;
		if (status.sleepCount <= 0) {
			console.log("没有睡眠数据");
			return;
		}

		// 断点续传：校验已保存条数（跨平台类型守卫、边界重置、是否完成均在工具内）
		const { savedCount, isComplete } = loadResumeCount(
			KEY_SLEEP_SAVED_COUNT,
			status.sleepCount
		);
		if (isComplete) {
			console.log("睡眠数据已全部保存，无需抓取");
			return;
		}
		console.log(
			savedCount > 0
				? `[FETCH] 断点续传：已保存 ${savedCount} 条，从第 ${savedCount} 条继续`
				: "[FETCH] 首次抓取，从头开始"
		);

		this._sleepPageWaiter.reset();
		this._sleepAssembler.reset();
		// 兜底 timeout：极端情况（设备未回头部）下保护循环不卡死
		// 正常情况由装配器内部 timer（3000ms）触发 reset
		const SLEEP_RESPONSE_TIMEOUT_MS = 5000;
		console.log("开始获取睡眠数据，总共", status.sleepCount, "条，已保存", savedCount, "条");

		// 每条睡眠单独 read/write，索引与已保存数据严格连续
		for (let i = savedCount; i < status.sleepCount; i++) {
			console.log("获取第", i, "条睡眠数据");
			await this.device.protocol.getSleepData(i);

			// 等待响应到达；超过超时时间则视为本条无响应
			const timeout = await this._sleepPageWaiter.wait(SLEEP_RESPONSE_TIMEOUT_MS);
			if (timeout == true) {
				console.log(`第 ${i} 条睡眠数据响应超时（${SLEEP_RESPONSE_TIMEOUT_MS}ms）`);
				this._sleepAssembler.reset();
				// 单条超时则中断本次循环，下次进入续传（避免半包数据"插队"已上传数据）
				break;
			}
			// 每条成功后推进进度计数（落盘保证下次进入即从此位置继续）
			storage.set(KEY_SLEEP_SAVED_COUNT, i + 1, 0);
		}
		console.log(`[FETCH] 睡眠数据获取完成，已保存 ${storage.get(KEY_SLEEP_SAVED_COUNT)} 条`);
	}

	// 存储睡眠数据到数据库
	storeSleepData(sleep: SleepData): void {
		bluetoothDataManager.storeSleepData(sleep);
	}

	// 暴露给 EventHandler 使用的内部方法
	get heartRatePageWaiter(): PageWaiter {
		return this._heartRatePageWaiter;
	}

	get sleepPageWaiter(): PageWaiter {
		return this._sleepPageWaiter;
	}

	get sleepAssembler(): SleepResponseAssembler {
		return this._sleepAssembler;
	}

	// 销毁资源
	destroy(): void {
		this.stopDataQueryTimer();
		this._sleepAssembler.destroy();
		bluetoothDataManager.destroy();
	}
}
