import {
	BOOM_CMD,
	bluetoothDataManager,
	LOG_EVENT_NAMES,
	LOG_EVENT_TYPE,
	parseEventDataHeader,
	parseLogDataList,
	parseVitalDataResponse
} from "../../bluetooth";
import type {
	EventDataHeaderResponse,
	HeartRateRecord,
	LogDataItem,
	SleepData,
	VitalDataPerSecond,
	VitalDataQueryResponse
} from "../../bluetooth";
import { ref } from "vue";
import type { Device } from "./index";
import { logger } from "../../service/logger";

export type HistoryReadStatus = "DONE" | "STOPPED" | "LIMIT" | "TIMEOUT" | "SEND_FAILED";

export type HistoryReadProgress = {
	phase: string;
	page: number;
	message: string;
};

export type VitalAutoReadOptions = {
	startSec: number;
	direction: number;
	minutes: number;
	maxPages?: number;
	pageDelayMs?: number;
	timeoutMs?: number;
	persistData?: boolean;
	uploadAfterSave?: boolean;
	shouldStop?: () => boolean;
	onProgress?: (progress: HistoryReadProgress) => void;
	onPage?: (response: VitalDataQueryResponse, page: number) => void;
};

export type VitalAutoReadResult = {
	status: HistoryReadStatus;
	message: string;
	pages: number;
	responses: VitalDataQueryResponse[];
	done: boolean;
	stoppedByLimit: boolean;
	savedRecords: number;
	saveOk: boolean;
	uploadAttempted: boolean;
	uploadOk: boolean;
};

export type EventAutoReadOptions = {
	type: number;
	startSec: number;
	endSec: number;
	maxCount: number;
	maxPages?: number;
	pageDelayMs?: number;
	timeoutMs?: number;
	persistSleepData?: boolean;
	uploadAfterSave?: boolean;
	shouldStop?: () => boolean;
	onProgress?: (progress: HistoryReadProgress) => void;
	onHeader?: (header: EventDataHeaderResponse) => void;
	onBatch?: (items: LogDataItem[], page: number) => void;
};

export type EventAutoReadResult = {
	status: HistoryReadStatus;
	message: string;
	header: EventDataHeaderResponse | null;
	pages: number;
	items: LogDataItem[];
	done: boolean;
	stoppedByLimit: boolean;
	savedSleepRecords: number;
	saveOk: boolean;
	uploadAttempted: boolean;
	uploadOk: boolean;
};

/** 等待一帧 0x3A/0x3B/0x3C/0x3D 响应的默认超时时间。 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 手动/自动续读的默认最大页数兜底，防止设备异常时无限续读。 */
const DEFAULT_MAX_PAGES = 100;
/** 连续发送 0x3B/0x3D 前的短暂停顿，给设备一点处理时间。 */
const DEFAULT_PAGE_DELAY_MS = 250;
/** 0x3D 一次续读可能连续吐多个 TLVC，收到首批后等待短暂静默再认为本次响应结束。 */
const EVENT_BATCH_SETTLE_MS = 600;

/* ===== 最近窗口生命体征补拉 ===== */
/** GATT 任务结束前后补最近 120 秒，填补连接期间漏掉的广播数据。 */
const RECENT_VITAL_WINDOW_SECONDS = 120;
/** 0x3A 查询方向：0=向前读，1=向后读。这里按时间向后续页推进。 */
const RECENT_VITAL_DIRECTION = 0;
/** 最近窗口每页读 2 分钟，响应体积较小。 */
const RECENT_VITAL_MINUTES = 2;
/** 历史缺口补拉每页读 5 分钟，符合设备限制，同时减少大缺口页数。 */
const VITAL_GAP_READ_MINUTES = 5;
/** 历史缺口补拉方向：0=向前读。 */
const VITAL_GAP_READ_DIRECTION = 0;
/** 最近窗口补拉最多续读 10 页，避免设备时间异常时追太远。 */
const RECENT_VITAL_MAX_PAGES = 10;
/** 如果设备返回窗口明显晚于目标窗口，用这个上限判断“别再追了”。 */
const RECENT_VITAL_MAX_FUTURE_DRIFT_SECONDS = RECENT_VITAL_MINUTES * RECENT_VITAL_MAX_PAGES * 60;
/** 调试弹窗展示历史明细时最多输出的行数。 */
const MAX_FORMAT_DETAIL_LINES = 260;

export class DeviceHistoryReader {
	/** 0x3A/0x3B 最近一次生命体征查询结果（多帧重组后） */
	vitalDataResponse = ref<VitalDataQueryResponse | null>(null);
	/** 0x3A/0x3B 生命体征响应序号（即使内容相同也递增） */
	vitalDataResponseSeq = ref<number>(0);
	/** 0x3C 事件头（最早/最晚 sn + ts） */
	eventDataHeader = ref<EventDataHeaderResponse | null>(null);
	/** 0x3C 事件头响应序号（即使内容相同也递增） */
	eventDataHeaderSeq = ref<number>(0);
	/** 0x3C/0x3D 累积事件列表（按到达顺序追加） */
	eventDataList = ref<LogDataItem[]>([]);
	/** 0x3D 最近一批事件数量 */
	lastEventBatchCount = ref<number>(0);
	/** 0x3D 事件列表响应序号（即使本批 0 条也递增） */
	eventDataListSeq = ref<number>(0);

	latestVitalDataResponse: VitalDataQueryResponse | null = null;
	vitalDataResponseSeqValue: number = 0;
	latestEventDataHeader: EventDataHeaderResponse | null = null;
	eventDataHeaderSeqValue: number = 0;
	eventDataListRaw: LogDataItem[] = [];
	lastEventBatchCountValue: number = 0;
	eventDataListSeqValue: number = 0;
	private displaySuspended: boolean = false;
	private eventGlobalSnSeen = new Map<number, boolean>();
	private eventReadActive: boolean = false;

	private device: Device;

	constructor(device: Device) {
		this.device = device;
	}

	setDisplaySuspended(suspended: boolean): void {
		this.displaySuspended = suspended;
		if (suspended == false) {
			this.publishSnapshot();
		}
	}

	private publishSnapshot(): void {
		if (this.latestVitalDataResponse != null) {
			this.vitalDataResponse.value = this.latestVitalDataResponse;
			this.vitalDataResponseSeq.value = this.vitalDataResponseSeqValue;
		}
		if (this.latestEventDataHeader != null) {
			this.eventDataHeader.value = this.latestEventDataHeader;
			this.eventDataHeaderSeq.value = this.eventDataHeaderSeqValue;
		}
		this.eventDataList.value = this.eventDataListRaw.slice();
		this.lastEventBatchCount.value = this.lastEventBatchCountValue;
		this.eventDataListSeq.value = this.eventDataListSeqValue;
	}

	/**
	 * 处理 0x3A/0x3B 响应（多帧重组由 EventHandler 完成，到这里 V 已完整）
	 */
	handleVitalData(vHex: string, t: number): void {
		const resp = parseVitalDataResponse(vHex);
		this.latestVitalDataResponse = resp;
		this.vitalDataResponseSeqValue = this.vitalDataResponseSeqValue + 1;
		if (this.displaySuspended == false) {
			this.vitalDataResponse.value = resp;
			this.vitalDataResponseSeq.value = this.vitalDataResponseSeqValue;
		}
		let validCount = 0;
		for (let i = 0; i < resp.vitalData.length; i++) {
			if (resp.vitalData[i].valid == true) validCount++;
		}
		logger.info(
			"bluetooth",
			`[BOOM] 生命体征响应: t=0x${t.toString(16)}, n=${resp.n}, vitalCount=${resp.vitalData.length}, validCount=${validCount}`
		);
	}

	/**
	 * 处理 0x3C/0x3D 响应
	 * - 0x3C: 17B 头（最早/最晚 sn + ts）
	 * - 0x3D: 多条 Log_Data_t 串联
	 */
	handleEventData(vHex: string, t: number): void {
		try {
			if (this.eventReadActive == false) {
				logger.warn(
					"bluetooth",
					`[BOOM] 忽略迟到/重复事件响应: t=0x${t.toString(16)}, vBytes=${vHex.length / 2}, 当前没有活跃事件读取`
				);
				return;
			}
			logger.info(
				"bluetooth",
				`[BOOM] handleEventData enter: t=0x${t.toString(16)}, vBytes=${vHex.length / 2}`
			);
			// 文档表格把续读响应写成 0x3C，示例则是 0x3D；17B 头长度可用于兼容判断。
			if (t == BOOM_CMD.READ_EVENT_DATA_START && vHex.length == 34) {
				const header = parseEventDataHeader(vHex);
				this.latestEventDataHeader = header;
				this.eventDataHeaderSeqValue = this.eventDataHeaderSeqValue + 1;
				if (this.displaySuspended == false) {
					this.eventDataHeader.value = header;
					this.eventDataHeaderSeq.value = this.eventDataHeaderSeqValue;
				}
				logger.info(
					"bluetooth",
					`[BOOM] 事件头(0x3C): type=${header.type}, snRange=${header.earliestSn}~${header.latestSn}, timeRange=${header.earliestSec} ${this.formatMaybeTime(header.earliestSec)} ~ ${header.latestSec} ${this.formatMaybeTime(header.latestSec)}`
				);
				this.logEventHeaderParse(vHex, header);
			} else {
				const r = parseLogDataList(vHex, 2);
				const items = this.filterDuplicateEventItems(r.items);
				this.lastEventBatchCountValue = items.length;
				this.eventDataListSeqValue = this.eventDataListSeqValue + 1;
				logger.info(
					"bluetooth",
					`[BOOM] 事件批次解析: t=0x${t.toString(16)}, vBytes=${vHex.length / 2}, count=${r.items.length}, unique=${items.length}, nextOff=${r.nextOff}`
				);
				this.logEventDataSegments(vHex, r.items, r.nextOff, 12);
				this.logEventItems("[BOOM] 事件批次明细(0x3D)", items, 12);
				if (items.length > 0) {
					this.eventDataListRaw = this.eventDataListRaw.concat(items);
					if (this.displaySuspended == false) {
						this.eventDataList.value = this.eventDataListRaw.slice();
					}
					logger.info(
						"bluetooth",
						`[BOOM] 事件追加: count=${items.length}, total=${this.eventDataListRaw.length}`
					);
				}
				if (this.displaySuspended == false) {
					this.lastEventBatchCount.value = this.lastEventBatchCountValue;
					this.eventDataListSeq.value = this.eventDataListSeqValue;
				}
			}
		} catch (e) {
			logger.error("bluetooth", "[BOOM] 事件响应解析异常:", e);
		}
	}

	private filterDuplicateEventItems(items: LogDataItem[]): LogDataItem[] {
		const result: LogDataItem[] = [];
		for (let i = 0; i < items.length; i++) {
			const globalSn = items[i].header.globalSn;
			if (globalSn > 0 && this.eventGlobalSnSeen.get(globalSn) == true) continue;
			if (globalSn > 0) this.eventGlobalSnSeen.set(globalSn, true);
			result.push(items[i]);
		}
		if (result.length != items.length) {
			logger.warn("bluetooth", `[BOOM] 事件去重: ${items.length} -> ${result.length}`);
		}
		return result;
	}

	private resetEventReadDeduplication(): void {
		this.eventGlobalSnSeen.clear();
	}

	async readVitalDataAuto(options: VitalAutoReadOptions): Promise<VitalAutoReadResult> {
		if (this.device.beginGattTask("vitalAuto") == false) {
			return this.makeVitalResult("STOPPED", "gatt busy", 0, []);
		}
		this.setDisplaySuspended(true);
		try {
			const result = await this.readVitalDataAutoInner(options);
			if (options.persistData == false) {
				return result;
			}
			const records = this.toHeartRateRecords(result.responses);
			result.savedRecords = records.length;
			result.saveOk =
				await bluetoothDataManager.storeHistoricalHeartRateRecordsBatch(records);
			if (result.savedRecords > 0 && options.uploadAfterSave != false) {
				result.uploadAttempted = true;
				result.uploadOk = await bluetoothDataManager.uploadData();
			}
			return result;
		} finally {
			this.setDisplaySuspended(false);
			this.device.endGattTask("vitalAuto");
		}
	}

	async readRecentVitalWindow(): Promise<VitalAutoReadResult> {
		if (this.device.beginGattTask("vitalRecent") == false) {
			return this.makeVitalResult("STOPPED", "gatt busy", 0, []);
		}
		this.setDisplaySuspended(true);
		try {
			const beforeVitalSeq = this.vitalDataResponseSeqValue;
			const beforeNotifySeq = this.device.event.notifySeqValue;
			const nowSec = Math.floor(Date.now() / 1000);
			const startSec = nowSec - RECENT_VITAL_WINDOW_SECONDS;
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 最近窗口补拉: nowSec=${nowSec} ${this.formatMaybeTime(nowSec)}, startSec=${startSec} ${this.formatMaybeTime(startSec)}, boomTimestamp=${this.device.event.boomTimestamp.value}, direction=${RECENT_VITAL_DIRECTION}, minutes=${RECENT_VITAL_MINUTES}, vitalSeq=${beforeVitalSeq}, notifySeq=${beforeNotifySeq}`
			);
			const targetEndSec = nowSec;
			let stopRecentRead = false;
			let lastResponseStartSec = -1;
			const result = await this.readVitalDataAutoInner({
				startSec,
				direction: RECENT_VITAL_DIRECTION,
				minutes: RECENT_VITAL_MINUTES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxPages: RECENT_VITAL_MAX_PAGES,
				pageDelayMs: DEFAULT_PAGE_DELAY_MS,
				shouldStop: () => stopRecentRead,
				onPage: (response, page) => {
					let validCount = 0;
					for (let i = 0; i < response.vitalData.length; i++) {
						if (response.vitalData[i].valid == true) validCount++;
					}
					logger.info(
						"bluetooth",
						`[BOOM-HISTORY] 最近窗口补拉段: page=${page}, responseStart=${response.startSec} ${this.formatMaybeTime(response.startSec)}, responseEnd=${this.getVitalWindowEndSec(response)}, n=${response.n}, valid=${validCount}/${response.vitalData.length}`
					);
					let stopReason = this.getRecentVitalStopReason(
						response,
						startSec,
						targetEndSec
					);
					if (
						stopReason == null &&
						page > 1 &&
						response.startSec > 0 &&
						response.startSec == lastResponseStartSec
					) {
						stopReason = "返回段与上一页重复，停止续读";
					}
					lastResponseStartSec = response.startSec;
					if (stopReason != null) {
						stopRecentRead = true;
						logger.warn(
							"bluetooth",
							`[BOOM-HISTORY] 最近窗口补拉停止续读: ${stopReason}, page=${page}, target=${startSec} ${this.formatMaybeTime(startSec)} ~ ${targetEndSec} ${this.formatMaybeTime(targetEndSec)}, response=${response.startSec} ${this.formatMaybeTime(response.startSec)} ~ ${this.getVitalWindowEndSec(response)} ${this.formatMaybeTime(this.getVitalWindowEndSec(response))}`
						);
					}
				}
			});
			if (result.status == "TIMEOUT") {
				const afterVitalSeq = this.vitalDataResponseSeqValue;
				const afterNotifySeq = this.device.event.notifySeqValue;
				logger.warn(
					"bluetooth",
					`[BOOM-HISTORY] 最近窗口补拉超时诊断: hadNotify=${afterNotifySeq > beforeNotifySeq}, beforeNotifySeq=${beforeNotifySeq}, afterNotifySeq=${afterNotifySeq}, lastNotifyAt=${this.device.event.lastNotifyAtValue}, beforeVitalSeq=${beforeVitalSeq}, afterVitalSeq=${afterVitalSeq}`
				);
			}
			const records = this.toHeartRateRecordsInWindow(
				result.responses,
				startSec,
				targetEndSec
			);
			result.savedRecords = records.length;
			result.saveOk =
				await bluetoothDataManager.storeHistoricalHeartRateRecordsBatch(records);
			if (result.savedRecords > 0) {
				result.uploadAttempted = true;
				result.uploadOk = await bluetoothDataManager.uploadData();
			}
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 最近窗口补拉完成: status=${result.status}, pages=${result.pages}, saved=${result.savedRecords}, upload=${result.uploadOk}`
			);
			return result;
		} finally {
			this.setDisplaySuspended(false);
			this.device.endGattTask("vitalRecent");
		}
	}

	/**
	 * 按指定窗口补拉生命体征历史。
	 *
	 * readRecentVitalWindow() 面向“GATT 任务结束前后补最近两分钟”；而设备同步调度层
	 * 需要按本地数据库 gap 精确补某一段，所以这里提供更通用的窗口入口。
	 * 入库仍使用 INSERT OR IGNORE，调用方可以放心传入带 overlap 的窗口。
	 */
	async readVitalWindow(startSec: number, endSec: number): Promise<VitalAutoReadResult> {
		if (this.device.beginGattTask("vitalGap") == false) {
			return this.makeVitalResult("STOPPED", "gatt busy", 0, []);
		}
		if (endSec <= startSec) {
			this.device.endGattTask("vitalGap");
			return this.makeVitalResult("STOPPED", "invalid vital window", 0, []);
		}
		this.setDisplaySuspended(true);
		try {
			const windowSeconds = endSec - startSec;
			// 设备协议不支持传 endSec；缺口窗口只用于本地判断何时停止续读。
			// 真正发给设备的仍然是 startSec + minutes，且 minutes 必须是 2 或 5。
			const pageSeconds = VITAL_GAP_READ_MINUTES * 60;
			const maxPages = Math.max(1, Math.ceil(windowSeconds / pageSeconds) + 2);
			let stopRead = false;
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 缺口补拉窗口: ${startSec} ${this.formatMaybeTime(startSec)} ~ ${endSec} ${this.formatMaybeTime(endSec)}, maxPages=${maxPages}`
			);
			const result = await this.readVitalDataAutoInner({
				startSec,
				direction: VITAL_GAP_READ_DIRECTION,
				minutes: VITAL_GAP_READ_MINUTES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxPages,
				pageDelayMs: DEFAULT_PAGE_DELAY_MS,
				shouldStop: () => stopRead,
				onPage: (response, page) => {
					const stopReason = this.getRecentVitalStopReason(response, startSec, endSec);
					if (stopReason != null) {
						stopRead = true;
						logger.info(
							"bluetooth",
							`[BOOM-HISTORY] 缺口补拉停止续读: ${stopReason}, page=${page}`
						);
					}
				}
			});
			const records = this.toHeartRateRecordsInWindow(result.responses, startSec, endSec);
			result.savedRecords = records.length;
			result.saveOk =
				await bluetoothDataManager.storeHistoricalHeartRateRecordsBatch(records);
			if (result.savedRecords > 0) {
				result.uploadAttempted = true;
				result.uploadOk = await bluetoothDataManager.uploadData();
			}
			logger.info(
				"bluetooth",
				`[BOOM-HISTORY] 缺口补拉完成: status=${result.status}, pages=${result.pages}, saved=${result.savedRecords}, upload=${result.uploadOk}`
			);
			return result;
		} finally {
			this.setDisplaySuspended(false);
			this.device.endGattTask("vitalGap");
		}
	}

	private async readVitalDataAutoInner(
		options: VitalAutoReadOptions
	): Promise<VitalAutoReadResult> {
		let timeoutMs = DEFAULT_TIMEOUT_MS;
		if (options.timeoutMs != null) timeoutMs = options.timeoutMs;
		if (timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
		let maxPages = DEFAULT_MAX_PAGES;
		if (options.maxPages != null) maxPages = options.maxPages;
		if (maxPages <= 0) maxPages = DEFAULT_MAX_PAGES;
		let pageDelayMs = DEFAULT_PAGE_DELAY_MS;
		if (options.pageDelayMs != null) pageDelayMs = options.pageDelayMs;
		if (pageDelayMs < 0) pageDelayMs = DEFAULT_PAGE_DELAY_MS;
		const responses: VitalDataQueryResponse[] = [];
		let page = 0;

		if (options.onProgress != null) {
			options.onProgress!({ phase: "0x3A", page, message: "start" });
		}
		this.device.event.resetDataIdentifierReassembler();
		let beforeSeq = this.vitalDataResponseSeqValue;
		let ok = await this.device.protocol.readVitalData({
			startSec: options.startSec,
			direction: options.direction,
			minutes: options.minutes
		});
		if (ok == false) {
			return this.makeVitalResult("SEND_FAILED", "0x3A send failed", page, responses);
		}

		while (true) {
			const response = await this.waitForVitalResponse(beforeSeq, timeoutMs);
			if (response == null) {
				return this.makeVitalResult(
					"TIMEOUT",
					"wait vital response timeout",
					page,
					responses
				);
			}

			page++;
			responses.push(response);
			if (options.onPage != null) {
				options.onPage!(response, page);
			}
			if (options.shouldStop != null && options.shouldStop!() == true) {
				return this.makeVitalResult("STOPPED", "stopped by caller", page, responses);
			}

			if (response.startSec == 0) {
				if (options.onProgress != null) {
					options.onProgress!({ phase: "done", page, message: "no-more-data" });
				}
				return this.makeVitalResult("DONE", "no more data", page, responses);
			}

			if (page >= maxPages) {
				if (options.onProgress != null) {
					options.onProgress!({ phase: "limit", page, message: "max-pages" });
				}
				return this.makeVitalResult("LIMIT", "max pages reached", page, responses);
			}

			beforeSeq = this.vitalDataResponseSeqValue;
			if (options.onProgress != null) {
				options.onProgress!({ phase: "0x3B", page, message: "continue" });
			}
			if (options.shouldStop != null && options.shouldStop!() == true) {
				return this.makeVitalResult("STOPPED", "stopped by caller", page, responses);
			}
			if (pageDelayMs > 0) {
				await this.sleep(pageDelayMs);
			}

			ok = await this.device.protocol.continueReadVitalData(options.minutes);
			if (ok == false) {
				return this.makeVitalResult("SEND_FAILED", "0x3B send failed", page, responses);
			}
		}
	}

	async readEventDataAuto(options: EventAutoReadOptions): Promise<EventAutoReadResult> {
		if (this.device.beginGattTask("event") == false) {
			return this.makeEventResult(
				"STOPPED",
				"gatt busy",
				null,
				0,
				this.eventDataListRaw.length
			);
		}
		this.setDisplaySuspended(true);
		this.eventReadActive = true;
		try {
			this.resetEventReadDeduplication();
			const result = await this.readEventDataAutoInner(options);
			this.eventReadActive = false;
			if (options.persistSleepData == false) {
				return result;
			}
			try {
				const saved = await this.persistSleepResultsFromEvents(result.items);
				result.savedSleepRecords = saved;
				result.saveOk = true;
				if (saved > 0 && options.uploadAfterSave != false) {
					result.uploadAttempted = true;
					result.uploadOk = await bluetoothDataManager.uploadSleepData();
				}
			} catch (e) {
				result.saveOk = false;
				logger.error("bluetooth", "[BOOM] 睡眠事件保存/上传异常:", e);
			}
			return result;
		} finally {
			this.eventReadActive = false;
			this.setDisplaySuspended(false);
			this.device.endGattTask("event");
		}
	}

	private async readEventDataAutoInner(
		options: EventAutoReadOptions
	): Promise<EventAutoReadResult> {
		let timeoutMs = DEFAULT_TIMEOUT_MS;
		if (options.timeoutMs != null) timeoutMs = options.timeoutMs;
		if (timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
		let maxPages = DEFAULT_MAX_PAGES;
		if (options.maxPages != null) maxPages = options.maxPages;
		if (maxPages <= 0) maxPages = DEFAULT_MAX_PAGES;
		let pageDelayMs = DEFAULT_PAGE_DELAY_MS;
		if (options.pageDelayMs != null) pageDelayMs = options.pageDelayMs;
		if (pageDelayMs < 0) pageDelayMs = DEFAULT_PAGE_DELAY_MS;
		let header: EventDataHeaderResponse | null = null;
		let page = 0;
		const startListCount = this.eventDataListRaw.length;

		if (options.onProgress != null) {
			options.onProgress!({ phase: "0x3C", page, message: "start" });
		}
		this.device.event.resetDataIdentifierReassembler();
		const beforeHeaderSeq = this.eventDataHeaderSeqValue;
		let ok = await this.device.protocol.readEventData({
			type: options.type,
			startSec: options.startSec,
			endSec: options.endSec
		});
		if (ok == false) {
			return this.makeEventResult(
				"SEND_FAILED",
				"0x3C send failed",
				header,
				page,
				startListCount
			);
		}

		header = await this.waitForEventHeader(beforeHeaderSeq, timeoutMs);
		if (header == null) {
			return this.makeEventResult(
				"TIMEOUT",
				"wait event header timeout",
				header,
				page,
				startListCount
			);
		}
		if (options.onHeader != null) {
			options.onHeader!(header);
		}
		if (header.earliestSn <= 0 || header.latestSn <= 0) {
			if (options.onProgress != null) {
				options.onProgress!({ phase: "done", page, message: "empty-header" });
			}
			return this.makeEventResult("DONE", "no event data", header, page, startListCount);
		}

		while (true) {
			if (options.shouldStop != null && options.shouldStop!() == true) {
				return this.makeEventResult(
					"STOPPED",
					"stopped by caller",
					header,
					page,
					startListCount
				);
			}

			if (page >= maxPages) {
				if (options.onProgress != null) {
					options.onProgress!({ phase: "limit", page, message: "max-pages" });
				}
				return this.makeEventResult(
					"LIMIT",
					"max pages reached",
					header,
					page,
					startListCount
				);
			}

			const beforeListSeq = this.eventDataListSeqValue;
			const beforeListCount = this.eventDataListRaw.length;
			if (options.onProgress != null) {
				options.onProgress!({ phase: "0x3D", page, message: "continue" });
			}
			if (options.shouldStop != null && options.shouldStop!() == true) {
				return this.makeEventResult(
					"STOPPED",
					"stopped by caller",
					header,
					page,
					startListCount
				);
			}
			if (pageDelayMs > 0) {
				await this.sleep(pageDelayMs);
			}

			ok = await this.device.protocol.continueReadEventData(options.maxCount);
			if (ok == false) {
				return this.makeEventResult(
					"SEND_FAILED",
					"0x3D send failed",
					header,
					page,
					startListCount
				);
			}

			const batchCount = await this.waitForEventBatch(
				beforeListSeq,
				beforeListCount,
				timeoutMs
			);
			if (batchCount == null) {
				return this.makeEventResult(
					"TIMEOUT",
					"wait event batch timeout",
					header,
					page,
					startListCount
				);
			}

			page++;
			const list = this.eventDataListRaw;
			const batch = list.slice(beforeListCount);
			if (options.onBatch != null) {
				options.onBatch!(batch, page);
			}

			if (options.shouldStop != null && options.shouldStop!() == true) {
				return this.makeEventResult(
					"STOPPED",
					"stopped by caller",
					header,
					page,
					startListCount
				);
			}

			if (batchCount <= 0 || batchCount < options.maxCount) {
				if (options.onProgress != null) {
					options.onProgress!({ phase: "done", page, message: "no-more-data" });
				}
				return this.makeEventResult("DONE", "no more data", header, page, startListCount);
			}
		}
	}

	private makeVitalResult(
		status: HistoryReadStatus,
		message: string,
		pages: number,
		responses: VitalDataQueryResponse[]
	): VitalAutoReadResult {
		return {
			status,
			message,
			pages,
			responses,
			done: status == "DONE",
			stoppedByLimit: status == "LIMIT",
			savedRecords: 0,
			saveOk: true,
			uploadAttempted: false,
			uploadOk: false
		};
	}

	private toHeartRateRecords(responses: VitalDataQueryResponse[]): HeartRateRecord[] {
		const records: HeartRateRecord[] = [];
		const seen = new Map<number, boolean>();
		for (let p = 0; p < responses.length; p++) {
			const response = responses[p];
			if (response.startSec <= 0) continue;
			for (let i = 0; i < response.vitalData.length; i++) {
				const item = response.vitalData[i];
				if (item.valid == false) continue;
				const timestamp = response.startSec + i;
				if (timestamp <= 0) continue;
				if (seen.has(timestamp)) continue;
				seen.set(timestamp, true);
				records.push({
					timestamp,
					heartRate: item.hr,
					bloodOxygen: 0,
					ppi: item.ppi
				} as HeartRateRecord);
			}
		}
		return records;
	}

	private toHeartRateRecordsInWindow(
		responses: VitalDataQueryResponse[],
		startSec: number,
		endSec: number
	): HeartRateRecord[] {
		const records: HeartRateRecord[] = [];
		const seen = new Map<number, boolean>();
		for (let p = 0; p < responses.length; p++) {
			const response = responses[p];
			if (response.startSec <= 0) continue;
			for (let i = 0; i < response.vitalData.length; i++) {
				const item = response.vitalData[i];
				if (item.valid == false) continue;
				const timestamp = response.startSec + i;
				if (timestamp < startSec || timestamp >= endSec) continue;
				if (seen.has(timestamp)) continue;
				seen.set(timestamp, true);
				records.push({
					timestamp,
					heartRate: item.hr,
					bloodOxygen: 0,
					ppi: item.ppi
				} as HeartRateRecord);
			}
		}
		return records;
	}

	private getVitalWindowEndSec(response: VitalDataQueryResponse): number {
		if (response.startSec <= 0) return 0;
		const minutes = response.n > 0 ? response.n : RECENT_VITAL_MINUTES;
		return response.startSec + minutes * 60;
	}

	private getRecentVitalStopReason(
		response: VitalDataQueryResponse,
		targetStartSec: number,
		targetEndSec: number
	): string | null {
		if (response.startSec <= 0) return null;
		const responseEndSec = this.getVitalWindowEndSec(response);
		if (responseEndSec <= 0) return null;
		if (responseEndSec <= targetStartSec) {
			return "返回段已早于目标窗口，继续 0x3B 只会读取更早数据";
		}
		if (response.startSec <= targetStartSec && responseEndSec >= targetEndSec) {
			return "返回段已覆盖目标窗口";
		}
		if (
			response.startSec > targetEndSec &&
			response.startSec - targetEndSec > RECENT_VITAL_MAX_FUTURE_DRIFT_SECONDS
		) {
			return "返回段明显晚于目标窗口，停止追读";
		}
		return null;
	}

	private makeEventResult(
		status: HistoryReadStatus,
		message: string,
		header: EventDataHeaderResponse | null,
		pages: number,
		startListCount: number
	): EventAutoReadResult {
		const items = this.eventDataListRaw.slice(startListCount);
		this.logEventReadResult(status, message, header, pages, items);
		return {
			status,
			message,
			header,
			pages,
			items,
			done: status == "DONE",
			stoppedByLimit: status == "LIMIT",
			savedSleepRecords: 0,
			saveOk: true,
			uploadAttempted: false,
			uploadOk: false
		};
	}

	private async persistSleepResultsFromEvents(items: LogDataItem[]): Promise<number> {
		let saved = 0;
		let found = 0;
		let skipped = 0;
		const seen = new Map<number, boolean>();
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.eventType != LOG_EVENT_TYPE.SleepResult) continue;
			found++;
			if (seen.get(item.ts) == true) continue;
			seen.set(item.ts, true);
			const sleepData = this.toSleepData(item);
			if (sleepData == null) {
				skipped++;
				logger.warn(
					"bluetooth",
					`[BOOM] 睡眠事件跳过: ts=${item.ts} ${this.formatMaybeTime(item.ts)}, data=${item.eventDataHex}, parsed=${this.formatEventParsedForDetail(item.eventType, item.parsedEvent)}`
				);
				continue;
			}
			await bluetoothDataManager.storeSleepData(sleepData);
			saved++;
		}
		if (found > 0 || saved > 0 || skipped > 0) {
			logger.info(
				"bluetooth",
				`[BOOM] 睡眠事件处理完成: found=${found}, saved=${saved}, skipped=${skipped}`
			);
		}
		return saved;
	}

	private toSleepData(item: LogDataItem): SleepData | null {
		const parsed = item.parsedEvent;
		const sleepOnsetSec = this.getParsedNumber(parsed, "sleepOnsetSec");
		const awakeSec = this.getParsedNumber(parsed, "awakeSec");
		const lightSleepSec = this.getParsedNumber(parsed, "lightSleepSec");
		const deepSleepSec = this.getParsedNumber(parsed, "deepSleepSec");
		const otherSleepSec = this.getParsedNumber(parsed, "otherSleepSec");
		const restHr = this.getParsedNumber(parsed, "restHr");
		if (item.ts <= 0 || sleepOnsetSec <= 0 || awakeSec <= 0) return null;
		const sleepSeconds = lightSleepSec + deepSleepSec + otherSleepSec;
		let recordCount = Math.ceil(sleepSeconds / 60);
		if (recordCount <= 0 && awakeSec > sleepOnsetSec) {
			recordCount = Math.ceil((awakeSec - sleepOnsetSec) / 60);
		}
		const detail = this.buildSleepResultDetail(
			lightSleepSec,
			deepSleepSec,
			otherSleepSec,
			restHr
		);
		return {
			reportTimestamp: item.ts,
			bedtime: sleepOnsetSec,
			sleepTime: sleepOnsetSec,
			wakeTime: awakeSec,
			getupTime: awakeSec,
			recordCount,
			detail
		} as SleepData;
	}

	private buildSleepResultDetail(
		lightSleepSec: number,
		deepSleepSec: number,
		otherSleepSec: number,
		restHr: number
	): string {
		const statuses = this.buildSleepStatusDetail(lightSleepSec, deepSleepSec, otherSleepSec);
		const detail: UTSJSONObject = {
			source: "boom_event_sleep_result",
			lightSleepSec,
			deepSleepSec,
			otherSleepSec,
			restHr,
			statuses
		};
		return JSON.stringify(detail);
	}

	private buildSleepStatusDetail(
		lightSleepSec: number,
		deepSleepSec: number,
		otherSleepSec: number
	): number[] {
		const statuses: number[] = [];
		this.appendSleepStatusMinutes(statuses, deepSleepSec, 0);
		this.appendSleepStatusMinutes(statuses, lightSleepSec, 1);
		this.appendSleepStatusMinutes(statuses, otherSleepSec, 2);
		return statuses;
	}

	private appendSleepStatusMinutes(statuses: number[], seconds: number, status: number): void {
		const minutes = Math.ceil(seconds / 60);
		for (let i = 0; i < minutes; i++) {
			statuses.push(status);
		}
	}

	private async waitForVitalResponse(
		beforeSeq: number,
		timeoutMs: number
	): Promise<VitalDataQueryResponse | null> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.vitalDataResponseSeqValue > beforeSeq) {
				return this.latestVitalDataResponse;
			}
			await this.sleep(120);
		}
		return null;
	}

	private async waitForEventHeader(
		beforeSeq: number,
		timeoutMs: number
	): Promise<EventDataHeaderResponse | null> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.eventDataHeaderSeqValue > beforeSeq) {
				return this.latestEventDataHeader;
			}
			await this.sleep(120);
		}
		return null;
	}

	private async waitForEventBatch(
		beforeSeq: number,
		beforeListCount: number,
		timeoutMs: number
	): Promise<number | null> {
		const start = Date.now();
		let seenFirstBatch = false;
		let lastSeq = beforeSeq;
		let lastChangedAt = start;
		while (Date.now() - start < timeoutMs) {
			if (this.eventDataListSeqValue > lastSeq) {
				seenFirstBatch = true;
				lastSeq = this.eventDataListSeqValue;
				lastChangedAt = Date.now();
			}
			if (seenFirstBatch == true && Date.now() - lastChangedAt >= EVENT_BATCH_SETTLE_MS) {
				return this.eventDataListRaw.length - beforeListCount;
			}
			await this.sleep(120);
		}
		return null;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, ms);
		});
	}

	formatVitalAutoDetail(responses: VitalDataQueryResponse[]): string {
		if (responses.length == 0) return "-";
		const lines: string[] = [];
		let total = 0;
		let valid = 0;
		let stopped = false;
		for (let p = 0; p < responses.length; p++) {
			const r = responses[p];
			let pageValid = 0;
			for (let i = 0; i < r.vitalData.length; i++) {
				if (r.vitalData[i].valid == true) pageValid++;
			}
			total += r.vitalData.length;
			valid += pageValid;
			lines.push(
				`page=${p + 1} startSec=${r.startSec} ${this.formatMaybeTime(r.startSec)} direction=${r.direction} n=${r.n} valid=${pageValid}/${r.vitalData.length}`
			);
			for (let i = 0; i < r.rmssdSdnn.length; i++) {
				const m = r.rmssdSdnn[i];
				lines.push(
					m.valid == true
						? `  minute=${i + 1} rmssd=${m.rmssd.toFixed(2)} sdnn=${m.sdnn.toFixed(2)}`
						: `  minute=${i + 1} rmssd/sdnn=FF`
				);
			}
			for (let i = 0; i < r.vitalData.length; i++) {
				if (lines.length >= MAX_FORMAT_DETAIL_LINES) {
					stopped = true;
					break;
				}
				lines.push("  " + this.formatVitalSecond(r.vitalData[i], p + 1, i, r.startSec));
			}
			if (stopped == true) break;
		}
		const head = `summary pages=${responses.length} valid=${valid}/${total}`;
		if (stopped == true) {
			lines.push("... 明细过长，已截断");
		}
		return [head].concat(lines).join("\n");
	}

	formatEventAutoDetail(items: LogDataItem[]): string {
		if (items.length == 0) return "-";
		const lines: string[] = [`summary items=${items.length}`];
		for (let i = 0; i < items.length && i < MAX_FORMAT_DETAIL_LINES; i++) {
			const it = items[i];
			const typeName = LOG_EVENT_NAMES[it.eventType] ?? "?";
			lines.push(
				`#${i} sn=${it.header.sn} globalSn=${it.header.globalSn} ts=${it.ts} ${this.formatMaybeTime(it.ts)} tick=${it.tick} type=${it.eventType}(${typeName}) len=${it.dataLen} data=${it.eventDataHex} parsed=${this.formatEventParsedForDetail(it.eventType, it.parsedEvent)}`
			);
		}
		if (items.length > MAX_FORMAT_DETAIL_LINES) {
			lines.push("... 明细过长，已截断");
		}
		return lines.join("\n");
	}

	formatEventAutoBrief(items: LogDataItem[], maxLines: number): string {
		if (items.length == 0) return "-";
		let limit = maxLines;
		if (limit <= 0) limit = 20;
		const lines: string[] = [
			`summary items=${items.length}, showing=${items.length < limit ? items.length : limit}`
		];
		for (let i = 0; i < items.length && i < limit; i++) {
			const it = items[i];
			const typeName = LOG_EVENT_NAMES[it.eventType] ?? "?";
			lines.push(
				`#${i} sn=${it.header.sn} globalSn=${it.header.globalSn} ts=${it.ts} ${this.formatMaybeTime(it.ts)} type=${it.eventType}(${typeName}) parsed=${this.formatEventParsedForDetail(it.eventType, it.parsedEvent)}`
			);
		}
		if (items.length > limit) {
			lines.push("... 还有更多事件，测试页可查看完整明细");
		}
		return lines.join("\n");
	}

	private logEventReadResult(
		status: HistoryReadStatus,
		message: string,
		header: EventDataHeaderResponse | null,
		pages: number,
		items: LogDataItem[]
	): void {
		let headerText = "header=null";
		if (header != null) {
			headerText = `header type=${header.type}, snRange=${header.earliestSn}~${header.latestSn}, timeRange=${this.formatMaybeTime(header.earliestSec)}~${this.formatMaybeTime(header.latestSec)}`;
		}
		logger.info(
			"bluetooth",
			`[BOOM] 事件读取结果: status=${status}, message=${message}, pages=${pages}, items=${items.length}, ${headerText}`
		);
		this.logEventItems("[BOOM] 事件最终明细", items, 20);
	}

	private logEventHeaderParse(vHex: string, header: EventDataHeaderResponse): void {
		const lines: string[] = [
			`[BOOM] 0x3C V解析: bytes=${vHex.length / 2}, raw=${vHex}`,
			`  Byte0 type=${header.type}`,
			`  Byte1~4 earliestSn=${header.earliestSn}`,
			`  Byte5~8 earliestTs=${header.earliestSec} ${this.formatMaybeTime(header.earliestSec)}`,
			`  Byte9~12 latestSn=${header.latestSn}`,
			`  Byte13~16 latestTs=${header.latestSec} ${this.formatMaybeTime(header.latestSec)}`
		];
		logger.info("bluetooth", lines.join("\n"));
	}

	private logEventDataSegments(
		vHex: string,
		items: LogDataItem[],
		nextOff: number,
		maxLines: number
	): void {
		let limit = maxLines;
		if (limit <= 0) limit = 10;
		const lines: string[] = [
			`[BOOM] 0x3D V分段: bytes=${vHex.length / 2}, byte0=${this.getHexByte(vHex, 0)}, logDataStartByte=1, count=${items.length}, nextOffByte=${Math.floor(nextOff / 2)}`
		];
		let cur = 2;
		for (let i = 0; i < items.length && i < limit; i++) {
			const item = items[i];
			const startByte = Math.floor(cur / 2);
			const fixedBytes = 20;
			const segmentBytes = fixedBytes + item.dataLen;
			const endByte = startByte + segmentBytes;
			const headerHex = vHex.substring(cur, cur + 20);
			const fixedHex = vHex.substring(cur + 20, cur + 40);
			const eventDataHex = vHex.substring(cur + 40, cur + 40 + item.dataLen * 2);
			lines.push(
				`  #${i} bytes[${startByte},${endByte}) total=${segmentBytes} header10=${headerHex} fixed10=${fixedHex} eventData=${eventDataHex}`
			);
			lines.push(
				`     header flag=0x${this.toByteHex(item.header.flag)}, payloadLen=${item.header.payloadLen}, sn=${item.header.sn}, globalSn=${item.header.globalSn}; fixed ts=${item.ts} ${this.formatMaybeTime(item.ts)}, tick=${item.tick}, type=${item.eventType}(${LOG_EVENT_NAMES[item.eventType] ?? "?"}), dataLen=${item.dataLen}`
			);
			cur = cur + segmentBytes * 2;
		}
		if (items.length > limit) {
			lines.push(`  ... truncated ${items.length - limit}`);
		}
		if (nextOff < vHex.length) {
			lines.push(
				`  tail bytes[${Math.floor(nextOff / 2)},${vHex.length / 2})=${vHex.substring(nextOff)}`
			);
		}
		logger.info("bluetooth", lines.join("\n"));
	}

	private getHexByte(hex: string, byteOffset: number): string {
		const start = byteOffset * 2;
		if (hex.length < start + 2) return "--";
		return "0x" + hex.substring(start, start + 2);
	}

	private toByteHex(value: number): string {
		const v = value & 0xff;
		const h = v.toString(16);
		return h.length == 1 ? "0" + h : h;
	}

	private logEventItems(title: string, items: LogDataItem[], maxLines: number): void {
		if (items.length == 0) {
			logger.info("bluetooth", `${title}: empty`);
			return;
		}
		let limit = maxLines;
		if (limit <= 0) limit = 10;
		const lines: string[] = [
			`${title}: count=${items.length}, showing=${items.length < limit ? items.length : limit}`
		];
		for (let i = 0; i < items.length && i < limit; i++) {
			lines.push(this.formatEventItemForLog(items[i], i));
		}
		if (items.length > limit) {
			lines.push(`... truncated ${items.length - limit}`);
		}
		logger.info("bluetooth", lines.join("\n"));
	}

	private formatEventItemForLog(item: LogDataItem, index: number): string {
		const typeName = LOG_EVENT_NAMES[item.eventType] ?? "?";
		return `#${index} globalSn=${item.header.globalSn}, sn=${item.header.sn}, ts=${item.ts} ${this.formatMaybeTime(item.ts)}, tick=${item.tick}, type=${item.eventType}(${typeName}), len=${item.dataLen}, data=${item.eventDataHex}, parsed=${this.formatEventParsedForDetail(item.eventType, item.parsedEvent)}`;
	}

	private formatEventParsedForDetail(eventType: number, parsed: UTSJSONObject): string {
		if (
			eventType == LOG_EVENT_TYPE.Text ||
			eventType == LOG_EVENT_TYPE.RemoteCmd ||
			eventType == LOG_EVENT_TYPE.SetDeviceSn
		) {
			return `text="${this.getParsedString(parsed, "text")}"`;
		}
		if (eventType == LOG_EVENT_TYPE.Reset) {
			return `reason=${this.getParsedNumber(parsed, "value")}`;
		}
		if (eventType == LOG_EVENT_TYPE.SetTime) {
			const oldSec = this.getParsedNumber(parsed, "oldSec");
			const newSec = this.getParsedNumber(parsed, "newSec");
			return `old=${oldSec} ${this.formatMaybeTime(oldSec)} -> new=${newSec} ${this.formatMaybeTime(newSec)}`;
		}
		if (eventType == LOG_EVENT_TYPE.FormatDS || eventType == LOG_EVENT_TYPE.SflashErase) {
			return `address=${this.getParsedNumber(parsed, "address")}`;
		}
		if (eventType == LOG_EVENT_TYPE.Wear) {
			const before = this.getParsedNumber(parsed, "before");
			const after = this.getParsedNumber(parsed, "after");
			return `wear ${before == 1 ? "佩戴" : "未佩戴"} -> ${after == 1 ? "佩戴" : "未佩戴"}`;
		}
		if (eventType == LOG_EVENT_TYPE.SleepResult) {
			const onset = this.getParsedNumber(parsed, "sleepOnsetSec");
			const awake = this.getParsedNumber(parsed, "awakeSec");
			const light = this.getParsedNumber(parsed, "lightSleepSec");
			const deep = this.getParsedNumber(parsed, "deepSleepSec");
			const other = this.getParsedNumber(parsed, "otherSleepSec");
			const restHr = this.getParsedNumber(parsed, "restHr");
			return `sleep onset=${onset} awake=${awake} light=${this.formatDurationSeconds(light)} deep=${this.formatDurationSeconds(deep)} other=${this.formatDurationSeconds(other)} restHr=${restHr}`;
		}
		if (eventType == LOG_EVENT_TYPE.Sedentary) {
			return `threshold=${this.formatDurationSeconds(this.getParsedNumber(parsed, "thresholdSec"))}`;
		}
		if (eventType == LOG_EVENT_TYPE.SetBiometricInfo) {
			return `gender=${this.getParsedNumber(parsed, "gender")} weight=${(this.getParsedNumber(parsed, "weight") / 100).toFixed(1)}kg height=${(this.getParsedNumber(parsed, "height") / 100).toFixed(1)}cm age=${this.getParsedNumber(parsed, "age")} ppg=${this.getParsedNumber(parsed, "ppgPosition")} bhr=${this.getParsedNumber(parsed, "bhr")}`;
		}
		const text = JSON.stringify(parsed);
		if (text == null || text == "") return "{}";
		return text;
	}

	private getParsedNumber(value: UTSJSONObject, key: string): number {
		const raw = value[key];
		if (raw == null) return 0;
		return raw as number;
	}

	private getParsedString(value: UTSJSONObject, key: string): string {
		const raw = value[key];
		if (raw == null) return "";
		return raw as string;
	}

	private formatDurationSeconds(sec: number): string {
		if (sec <= 0) return "0s";
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = sec % 60;
		if (h > 0) return `${h}h${m}m${s}s`;
		if (m > 0) return `${m}m${s}s`;
		return `${s}s`;
	}

	private formatMaybeTime(sec: number): string {
		if (sec <= 0) return "0";
		return new Date(sec * 1000).toLocaleString();
	}

	private formatVitalSecond(
		d: VitalDataPerSecond,
		page: number,
		index: number,
		baseSec: number
	): string {
		const behavior = (d.status >> 3) & 0x07;
		const activity = d.status & 0x07;
		const sec = baseSec > 0 ? baseSec + index : 0;
		return `p${page}#${index} ts=${sec} ${this.formatMaybeTime(sec)} hr=${d.hr} valid=${d.valid} status=${d.status} behavior=${behavior} activity=${activity} pitch=${d.pitch} acc=${d.acc} ppi=${d.ppi}`;
	}
}
