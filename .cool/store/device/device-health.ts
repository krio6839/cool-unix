import { ref } from "vue";
import { storage } from "../../utils/storage";

const DEVICE_HEALTH_STORAGE_KEY = "boom_device_protocol_health";
const DEVICE_UNRESPONSIVE_WARNING_THRESHOLD = 3;

/** 只管理设备级协议健康状态，不发送命令、不控制连接、不触发 UI。 */
export class DeviceHealth {
	failureCount = ref<number>(0);
	warningActive = ref<boolean>(false);
	modalPending = ref<boolean>(false);
	private deviceId: string = "";
	private modalAcknowledged: boolean = false;

	bind(deviceId: string): void {
		this.deviceId = deviceId;
		const raw = this.readStoredHealth();
		if (raw == null || this.readString(raw, "deviceId") != deviceId) {
			this.clearValues();
			this.persist();
			return;
		}
		this.failureCount.value = Math.max(0, this.readNumber(raw, "failureCount"));
		this.warningActive.value = this.readBoolean(raw, "warningActive");
		this.modalAcknowledged = this.readBoolean(raw, "modalAcknowledged");
		this.modalPending.value = this.warningActive.value && this.modalAcknowledged == false;
	}

	recordUnresponsive(): void {
		this.failureCount.value = this.failureCount.value + 1;
		if (this.failureCount.value >= DEVICE_UNRESPONSIVE_WARNING_THRESHOLD) {
			this.warningActive.value = true;
			this.modalPending.value = this.modalAcknowledged == false;
		}
		this.persist();
	}

	recordHealthyConnection(): void {
		this.clearValues();
		this.persist();
	}

	acknowledgeModal(): void {
		this.modalAcknowledged = true;
		this.modalPending.value = false;
		this.persist();
	}

	reset(): void {
		this.deviceId = "";
		this.clearValues();
		storage.remove(DEVICE_HEALTH_STORAGE_KEY);
	}

	private clearValues(): void {
		this.failureCount.value = 0;
		this.warningActive.value = false;
		this.modalPending.value = false;
		this.modalAcknowledged = false;
	}

	private persist(): void {
		if (this.deviceId == "") return;
		storage.set(
			DEVICE_HEALTH_STORAGE_KEY,
			JSON.stringify({
				deviceId: this.deviceId,
				failureCount: this.failureCount.value,
				warningActive: this.warningActive.value,
				modalAcknowledged: this.modalAcknowledged
			} as UTSJSONObject),
			0
		);
	}

	/** Android 会把 setStorageSync 的对象恢复成字符串；存储边界统一转成 UTSJSONObject。 */
	private readStoredHealth(): UTSJSONObject | null {
		const stored = storage.get(DEVICE_HEALTH_STORAGE_KEY);
		if (stored == null || stored == "") return null;
		try {
			if (typeof stored == "string") return JSON.parse(stored as string) as UTSJSONObject;
			return stored as UTSJSONObject;
		} catch (_error) {
			return null;
		}
	}

	private readString(value: UTSJSONObject, key: string): string {
		const raw = value[key];
		return raw == null ? "" : `${raw}`;
	}

	private readNumber(value: UTSJSONObject, key: string): number {
		const parsed = parseInt(this.readString(value, key));
		return isNaN(parsed) == true ? 0 : parsed;
	}

	private readBoolean(value: UTSJSONObject, key: string): boolean {
		const raw = value[key];
		return raw == true || raw == 1 || raw == "true" || raw == "1";
	}
}
