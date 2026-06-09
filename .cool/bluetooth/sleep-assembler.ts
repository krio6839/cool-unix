import type { SleepData } from "./types";
import { parseStatusBytesToDetail, parseUint32LE } from "./parser";

/**
 * 睡眠响应装配器
 * 设备一次 sendCommand('s', N) 后会自动分多包推送：先 1 个 24 字节头部，后 recordCount 字节状态。
 * 该类负责状态机管理：识别头部 → 累积状态 → 装配完整 SleepData。
 * 单一职责：只关心"头部已识别 / 状态累积中 / 装配完成 / 装配超时"四件事，不依赖任何 BLE 字段。
 *
 * 内部超时机制：每次 push 时重启 timer，timeoutMs 内无后续包则自动 reset，
 * 避免头部已收但状态包丢失导致装配器永久卡在 WAITING_STATUS。
 */
export class SleepResponseAssembler {
	private _state: "IDLE" | "WAITING_STATUS" = "IDLE";
	private _statusBuffer: string = "";
	private _header: SleepData | null = null;
	private _timeoutHandle: number | null = null;
	private _timeoutMs: number;

	/**
	 * @param timeoutMs 装配超时（头部到达后等状态字节的最长时间）；默认 3000ms
	 */
	constructor(timeoutMs: number = 3000) {
		this._timeoutMs = timeoutMs;
	}

	/** 动态调整超时阈值 */
	setTimeoutMs(timeoutMs: number): void {
		this._timeoutMs = timeoutMs;
	}

	/** 当前是否在累积状态字节（即头部已收，等状态数据中） */
	isAssembling(): boolean {
		return this._state == "WAITING_STATUS";
	}

	/**
	 * 接收一个 Notify 包的 hexString，按状态机推进。
	 * - IDLE 状态：必须是 48 hex chars（24 字节）头部，解析后切换到 WAITING_STATUS 并启动 timer
	 * - WAITING_STATUS 状态：追加 hexChunk 到状态缓冲，到 recordCount 时装配完成
	 * 每次 push 都重启 timer，timer 到期自动 reset 避免永久卡死。
	 * @param hexChunk 当前 BLE Notify 包的 hex 字符串
	 * @returns 装配完成的 SleepData；未到齐返回 null
	 */
	push(hexChunk: string): SleepData | null {
		// 1. 每次 push 重启 timer
		this._armTimeout();

		// 2. IDLE 状态：仅接受 48 hex chars 的头部
		if (this._state == "IDLE") {
			if (hexChunk.length != 48) {
				return null;
			}
			const header = this._parseHeader(hexChunk);
			if (header == null) {
				this._clearState();
				return null;
			}
			this._header = header;
			this._state = "WAITING_STATUS";
			return null;
		}

		// 3. WAITING_STATUS 状态：累积状态字节
		this._statusBuffer += hexChunk;
		if (this._header == null) {
			this._clearState();
			return null;
		}
		const needBytes = this._header.recordCount;
		const haveBytes = this._statusBuffer.length / 2;
		if (haveBytes < needBytes) return null;

		// 4. 装配完成
		const statusHex = this._statusBuffer.substring(0, needBytes * 2);
		const detail = parseStatusBytesToDetail(statusHex);
		const result: SleepData = {
			reportTimestamp: this._header.reportTimestamp,
			bedtime: this._header.bedtime,
			sleepTime: this._header.sleepTime,
			wakeTime: this._header.wakeTime,
			getupTime: this._header.getupTime,
			recordCount: this._header.recordCount,
			detail
		};
		this._clearState();
		return result;
	}

	/**
	 * 解析 24 字节头部（48 hex chars）为 SleepData 的前 6 个字段。
	 * @returns 解析失败的脏数据返回 null（由调用方重置）
	 */
	private _parseHeader(hexHeader: string): SleepData | null {
		const bytes: number[] = [];
		for (let i = 0; i < hexHeader.length; i += 2) {
			bytes.push(parseInt(hexHeader.substring(i, i + 2), 16));
		}
		const reportTimestamp = parseUint32LE(bytes, 0);
		const bedtime = parseUint32LE(bytes, 4);
		const sleepTime = parseUint32LE(bytes, 8);
		const wakeTime = parseUint32LE(bytes, 12);
		const getupTime = parseUint32LE(bytes, 16);
		const recordCount = parseUint32LE(bytes, 20);

		// recordCount 合理范围：0..1440（24h × 60min）
		if (recordCount < 0 || recordCount > 1440) {
			console.error("[SLEEP] 异常 recordCount:", recordCount);
			return null;
		}
		return {
			reportTimestamp,
			bedtime,
			sleepTime,
			wakeTime,
			getupTime,
			recordCount,
			detail: ""
		};
	}

	/** 启动/重启 timer；到 _timeoutMs 自动 reset */
	private _armTimeout(): void {
		this._clearTimeout();
		//@ts-ignore
		const handle: number = setTimeout(() => {
			console.error("[SLEEP] 装配超时（" + this._timeoutMs + "ms 未到齐），自动 reset");
			this._clearState();
			this._timeoutHandle = null;
		}, this._timeoutMs);
		this._timeoutHandle = handle;
	}

	/** 取消 timer */
	private _clearTimeout(): void {
		const handle = this._timeoutHandle;
		if (handle != null) {
			clearTimeout(handle);
			this._timeoutHandle = null;
		}
	}

	/** 清状态 + 字段（不清 timer；由 push/reset/destroy 控制） */
	private _clearState(): void {
		this._state = "IDLE";
		this._statusBuffer = "";
		this._header = null;
	}

	/** 重置装配器（外部强制复位；fetchAllSleepData 循环开头/超时分支调用） */
	reset(): void {
		this._clearState();
		this._clearTimeout();
	}

	/** 销毁（彻底清理 timer；Device.destroy 中调用） */
	destroy(): void {
		this.reset();
	}
}
