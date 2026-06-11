import {
	HEART_RATE_SERVICE_UUID,
	BATTERY_SERVICE_UUID,
	UART_SERVICE_UUID,
	LED_BUTTON_SERVICE_UUID,
	LED_BUTTON_CHARACTERISTIC_UUID,
	arrayBufferToHexString,
	parseHeartRateData,
	parseBloodOxygenData,
	parseBatteryData,
	parseDataReadyStatus,
	parseRTCResponse,
	parseHistoricalHeartRateData
} from "../../bluetooth";

import type { SleepData } from "../../bluetooth";

//#ifndef H5
import {
	onCharacteristicValueChange,
	onReadCharacteristicValue
} from "../../bluetooth/kux";
//#endif

import type { Device } from "./index";

export class EventHandler {
	private device: Device;

	constructor(device: Device) {
		this.device = device;
	}

	onCharacteristicValueChange(): void {
		//#ifndef H5
		onCharacteristicValueChange((res) => {
			const hexData = arrayBufferToHexString(res.value);
			const serviceId = res.serviceId.toLowerCase();
			const characteristicId = res.characteristicId.toLowerCase();
			console.log("响应数据:", hexData, serviceId, characteristicId);

			if (serviceId == HEART_RATE_SERVICE_UUID) {
				const [heartRate, ppi] = parseHeartRateData(hexData);
				this.device.heartRate.value = heartRate;
				this.device.ppi.value = ppi;
			} else if (serviceId == LED_BUTTON_SERVICE_UUID) {
				const bloodOxygen = parseBloodOxygenData(hexData);
				this.device.bloodOxygen.value = bloodOxygen;
			} else if (serviceId == BATTERY_SERVICE_UUID) {
				const battery = parseBatteryData(hexData);
				this.device.battery.value = battery;
			} else if (serviceId == UART_SERVICE_UUID) {
				if (hexData.indexOf("2c") != -1 && hexData.length < 48) {
					const status = parseDataReadyStatus(hexData);
					this.device.dataReadyStatus.value = status;
					console.log("数据就绪状态:", status);
				} else if (hexData.indexOf("525443") != -1 || hexData.indexOf("RTC") != -1) {
					const rtc = parseRTCResponse(hexData);
					this.device.rtcTime.value = rtc;
					console.log("RTC时间:", rtc);
				} else if (hexData.length == 256) {
					// 心率数据：16组×8字节=128字节=256 hex chars（恰好256）
					const records = parseHistoricalHeartRateData(hexData);
					console.log("历史心率数据:", records);
					// 通知 fetchAllHistoricalHeartRateData 本页响应已到（先触发，再异步存储）
					this.device.data.heartRatePageWaiter.onNotify();
					// 当解析后无任何记录（说明原始数据为"全 f"），标记后续无数据
					if (records.length == 0) {
						this.device.data.heartRatePageWaiter.markAllEmpty();
						console.log("本次响应为全 f，无有效数据，标记停止获取");
					}
					// 批量存储历史心率血氧数据
					this.device.data.storeHistoricalRecords(records);
				} else if (hexData.length == 48) {
					// 睡眠数据头部（24 字节）—— 最明确的入口
					const sleep = this.device.data.sleepAssembler.push(hexData);
					if (sleep == null) {
						console.log("[SLEEP] 头部已接收，等待状态数据");
					} else {
						this._onSleepAssembled(sleep);
					}
				} else if (this.device.data.sleepAssembler.isAssembling()) {
					// 后续状态字节流（包大小不固定）—— 合并到已识别头部
					const sleep = this.device.data.sleepAssembler.push(hexData);
					if (sleep == null) {
						console.log("[SLEEP] 状态数据累积中");
					} else {
						this._onSleepAssembled(sleep);
					}
				}
			}
		});
		//#endif
	}

	onReadCharacteristicValue(): void {
		//#ifndef H5
		onReadCharacteristicValue((res) => {
			const buffer = res.value as ArrayBuffer | null;
			if (buffer == null) return;
			const hexString = arrayBufferToHexString(buffer);
			console.log("十六进制数据 hexString:", hexString);
			// kux 库返回的 characteristicId 大小写不固定,统一小写后再比较
			const charId = (res.characteristicId ?? "").toLowerCase();
			if (charId == LED_BUTTON_CHARACTERISTIC_UUID.toLowerCase()) {
				this.device._deviceOn = hexString == "01";
				console.log("[DEVICE] read 回调更新 _deviceOn=", this.device._deviceOn);
			}
		});
		//#endif
	}

	/**
	 * 睡眠响应装配完成后的统一处理：合法性校验 + 存储 + 通知 waiter
	 * 提取为私有方法避免在 UART 分支中重复 4 处
	 */
	private _onSleepAssembled(sleep: SleepData): void {
		if (sleep.bedtime == 0 && sleep.recordCount == 0) {
			console.error("[SLEEP] 数据不合法，跳过存储，释放 waiter");
		} else {
			this.device.sleepData.value = sleep;
			console.log("睡眠数据:", sleep);
			this.device.data.storeSleepData(sleep);
		}
		this.device.data.sleepPageWaiter.onNotify();
	}
}
