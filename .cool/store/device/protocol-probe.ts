import { BOOM_CMD } from "../../bluetooth/boom-constants";
import { logger } from "../../service/logger";
import { sleepTimeout } from "../../utils";
import type { Device } from "./index";

export type ProtocolProbeStatus = "OK" | "SEND_FAILED" | "TIMEOUT" | "INVALID_RESPONSE";

export type ProtocolProbeResult = {
	status: ProtocolProbeStatus;
	latencyMs: number;
	deviceTimestamp: number;
};

/** 只验证设备协议是否会回应，不负责连接、重试、计数或 UI。 */
export class DeviceProtocolProbe {
	private target: Device;

	constructor(target: Device) {
		this.target = target;
	}

	async check(timeoutMs: number = 3000): Promise<ProtocolProbeResult> {
		const startedAt = Date.now();
		const beforeSeq = this.target.event.boomTimestampSeqValue;
		let sent = false;
		try {
			sent = await this.target.protocol.readTimestamp();
		} catch (error) {
			logger.warn("bluetooth", `[BOOM-PROBE] 探活发送异常: ${error}`);
			return this.result("SEND_FAILED", startedAt, 0);
		}
		if (sent == false) return this.result("SEND_FAILED", startedAt, 0);
		while (Date.now() - startedAt < timeoutMs) {
			if (this.target.event.boomTimestampSeqValue > beforeSeq) {
				const timestamp = this.target.event.boomTimestamp.value;
				// 协议规定 0x34 是读取请求，设备以 0x33 + UINT32 UTC 回应。
				const valid =
					this.target.event.boomTimestampLastT == BOOM_CMD.SET_BOOM_TIMESTAMP &&
					timestamp > 0;
				const result = this.result(valid ? "OK" : "INVALID_RESPONSE", startedAt, timestamp);
				logger.info(
					"bluetooth",
					`[BOOM-PROBE] 探活结束: status=${result.status}, latency=${result.latencyMs}ms, deviceTs=${timestamp}`
				);
				return result;
			}
			await sleepTimeout(120);
		}
		const result = this.result("TIMEOUT", startedAt, 0);
		logger.warn(
			"bluetooth",
			`[BOOM-PROBE] 探活结束: status=${result.status}, latency=${result.latencyMs}ms`
		);
		return result;
	}

	private result(
		status: ProtocolProbeStatus,
		startedAt: number,
		deviceTimestamp: number
	): ProtocolProbeResult {
		return {
			status,
			latencyMs: Date.now() - startedAt,
			deviceTimestamp
		} as ProtocolProbeResult;
	}
}
