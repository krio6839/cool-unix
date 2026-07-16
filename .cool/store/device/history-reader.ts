import {
	BOOM_CMD,
	bluetoothDataManager,
	LOG_EVENT_NAMES,
	parseEventDataHeader,
	parseLogDataList,
	parseVitalDataResponse
} from "../../bluetooth";
import type {
	EventDataHeaderResponse,
	HeartRateRecord,
	LogDataItem,
	VitalDataPerSecond,
	VitalDataQueryResponse
} from "../../bluetooth";
import { ref } from "vue";
import type { Device } from "./index";

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
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_PAGE_DELAY_MS = 250;
const VITAL_POLL_INTERVAL_MS = 120000;
const VITAL_POLL_WINDOW_SECONDS = 120;
const VITAL_POLL_DIRECTION = 0;
const VITAL_POLL_MINUTES = 2;
const VITAL_POLL_MAX_PAGES = 10;
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
	private historyReadBusy: boolean = false;
	private vitalPollingTimer: number = 0;
	private vitalPollingEnabled: boolean = false;

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
		console.log(
			`[BOOM] 生命体征响应: t=0x${t.toString(16)}, n=${resp.n}, vitalCount=${resp.vitalData.length}, validCount=${validCount}`
		);
	}

	/**
	 * 处理 0x3C/0x3D 响应
	 * - 0x3C: 17B 头（最早/最晚 sn + ts）
	 * - 0x3D: 多条 Log_Data_t 串联
	 */
	handleEventData(vHex: string, t: number): void {
		// 文档表格把续读响应写成 0x3C，示例则是 0x3D；17B 头长度可用于兼容判断。
		if (t == BOOM_CMD.READ_EVENT_DATA_START && vHex.length == 34) {
			const header = parseEventDataHeader(vHex);
			this.latestEventDataHeader = header;
			this.eventDataHeaderSeqValue = this.eventDataHeaderSeqValue + 1;
			if (this.displaySuspended == false) {
				this.eventDataHeader.value = header;
				this.eventDataHeaderSeq.value = this.eventDataHeaderSeqValue;
			}
			console.log(
				`[BOOM] 事件头: type=${header.type}, earliestSn=${header.earliestSn}, latestSn=${header.latestSn}`
			);
		} else {
			const r = parseLogDataList(vHex, 2);
			this.lastEventBatchCountValue = r.items.length;
			this.eventDataListSeqValue = this.eventDataListSeqValue + 1;
			if (r.items.length > 0) {
				this.eventDataListRaw = this.eventDataListRaw.concat(r.items);
				if (this.displaySuspended == false) {
					this.eventDataList.value = this.eventDataListRaw.slice();
				}
				console.log(
					`[BOOM] 事件追加: count=${r.items.length}, total=${this.eventDataListRaw.length}`
				);
			}
			if (this.displaySuspended == false) {
				this.lastEventBatchCount.value = this.lastEventBatchCountValue;
				this.eventDataListSeq.value = this.eventDataListSeqValue;
			}
		}
	}

	async readVitalDataAuto(options: VitalAutoReadOptions): Promise<VitalAutoReadResult> {
		if (this.historyReadBusy == true) {
			return this.makeVitalResult("STOPPED", "history reader busy", 0, []);
		}
		this.historyReadBusy = true;
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
			this.historyReadBusy = false;
		}
	}

	startVitalHistoryPolling(): void {
		if (this.vitalPollingEnabled == true) return;
		this.vitalPollingEnabled = true;
		this.stopVitalHistoryPollingTimer();
		this.runVitalHistoryPoll();
		// @ts-ignore setInterval 在 UTS 不同平台返回类型不一，这里统一收敛为 number
		this.vitalPollingTimer = setInterval(() => {
			this.runVitalHistoryPoll();
		}, VITAL_POLL_INTERVAL_MS);
		console.log("[BOOM-HISTORY] 已启动生命体征历史自动补拉");
	}

	stopVitalHistoryPolling(): void {
		if (this.vitalPollingEnabled == false && this.vitalPollingTimer == 0) return;
		this.vitalPollingEnabled = false;
		this.stopVitalHistoryPollingTimer();
		console.log("[BOOM-HISTORY] 已停止生命体征历史自动补拉");
	}

	private stopVitalHistoryPollingTimer(): void {
		if (this.vitalPollingTimer != 0) {
			clearInterval(this.vitalPollingTimer);
			this.vitalPollingTimer = 0;
		}
	}

	private async runVitalHistoryPoll(): Promise<void> {
		if (this.vitalPollingEnabled == false) return;
		if (this.device.status.value != "CONNECTED") return;
		if (this.historyReadBusy == true) {
			console.log("[BOOM-HISTORY] 历史数据读取中，跳过本轮自动补拉");
			return;
		}
		try {
			await this.readRecentVitalWindow();
		} catch (e) {
			console.error("[BOOM-HISTORY] 自动补拉异常:", e);
		}
	}

	async readRecentVitalWindow(): Promise<VitalAutoReadResult> {
		if (this.historyReadBusy == true) {
			return this.makeVitalResult("STOPPED", "history reader busy", 0, []);
		}
		this.historyReadBusy = true;
		this.setDisplaySuspended(true);
		try {
			const beforeVitalSeq = this.vitalDataResponseSeqValue;
			const beforeNotifySeq = this.device.event.notifySeqValue;
			const nowSec = Math.floor(Date.now() / 1000);
			const startSec = nowSec - VITAL_POLL_WINDOW_SECONDS;
			console.log(
				`[BOOM-HISTORY] 自动补拉窗口: nowSec=${nowSec} ${this.formatMaybeTime(nowSec)}, startSec=${startSec} ${this.formatMaybeTime(startSec)}, boomTimestamp=${this.device.event.boomTimestamp.value}, direction=${VITAL_POLL_DIRECTION}, minutes=${VITAL_POLL_MINUTES}, vitalSeq=${beforeVitalSeq}, notifySeq=${beforeNotifySeq}`
			);
			const targetEndSec = nowSec;
			const result = await this.readVitalDataAutoInner({
				startSec,
				direction: VITAL_POLL_DIRECTION,
				minutes: VITAL_POLL_MINUTES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxPages: VITAL_POLL_MAX_PAGES,
				pageDelayMs: DEFAULT_PAGE_DELAY_MS,
				onPage: (response, page) => {
					let validCount = 0;
					for (let i = 0; i < response.vitalData.length; i++) {
						if (response.vitalData[i].valid == true) validCount++;
					}
					console.log(
						`[BOOM-HISTORY] 自动补拉段: page=${page}, responseStart=${response.startSec} ${this.formatMaybeTime(response.startSec)}, responseEnd=${this.getVitalWindowEndSec(response)}, n=${response.n}, valid=${validCount}/${response.vitalData.length}`
					);
				}
			});
			if (result.status == "TIMEOUT") {
				const afterVitalSeq = this.vitalDataResponseSeqValue;
				const afterNotifySeq = this.device.event.notifySeqValue;
				console.warn(
					`[BOOM-HISTORY] 自动补拉超时诊断: hadNotify=${afterNotifySeq > beforeNotifySeq}, beforeNotifySeq=${beforeNotifySeq}, afterNotifySeq=${afterNotifySeq}, lastNotifyAt=${this.device.event.lastNotifyAtValue}, beforeVitalSeq=${beforeVitalSeq}, afterVitalSeq=${afterVitalSeq}`
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
			console.log(
				`[BOOM-HISTORY] 自动补拉完成: status=${result.status}, pages=${result.pages}, saved=${result.savedRecords}, upload=${result.uploadOk}`
			);
			return result;
		} finally {
			this.setDisplaySuspended(false);
			this.historyReadBusy = false;
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
		if (this.historyReadBusy == true) {
			return this.makeEventResult(
				"STOPPED",
				"history reader busy",
				null,
				0,
				this.eventDataListRaw.length
			);
		}
		this.historyReadBusy = true;
		this.setDisplaySuspended(true);
		try {
			return await this.readEventDataAutoInner(options);
		} finally {
			this.setDisplaySuspended(false);
			this.historyReadBusy = false;
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

			const batchCount = await this.waitForEventBatch(beforeListSeq, timeoutMs);
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
		const minutes = response.n > 0 ? response.n : VITAL_POLL_MINUTES;
		return response.startSec + minutes * 60;
	}

	private makeEventResult(
		status: HistoryReadStatus,
		message: string,
		header: EventDataHeaderResponse | null,
		pages: number,
		startListCount: number
	): EventAutoReadResult {
		const items = this.eventDataListRaw.slice(startListCount);
		return {
			status,
			message,
			header,
			pages,
			items,
			done: status == "DONE",
			stoppedByLimit: status == "LIMIT"
		};
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

	private async waitForEventBatch(beforeSeq: number, timeoutMs: number): Promise<number | null> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (this.eventDataListSeqValue > beforeSeq) {
				return this.lastEventBatchCountValue;
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
				`#${i} sn=${it.header.sn} globalSn=${it.header.globalSn} ts=${it.ts} ${this.formatMaybeTime(it.ts)} tick=${it.tick} type=${it.eventType}(${typeName}) len=${it.dataLen} data=${it.eventDataHex}`
			);
		}
		if (items.length > MAX_FORMAT_DETAIL_LINES) {
			lines.push("... 明细过长，已截断");
		}
		return lines.join("\n");
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
