import { parse, storage } from "./index";

export type BluetoothDataType = "heartRate" | "bloodOxygen" | "battery";

export type BluetoothData = {
	id: string;
	timestamp: number;
	type: BluetoothDataType;
	value: number;
	uploaded: boolean;
};

const STORAGE_KEY = "bluetooth_data";
const UPLOAD_INTERVAL = 10 * 1000; // 10秒上传一次
const MAX_DATA_AGE = 90 * 24 * 60 * 60 * 1000; // 90天
// 移除最大数据量限制

export class BluetoothDataManager {
	private uploadTimer: number | null = null;
	private isUploading: boolean = false;

	constructor() {
		uni.clearStorage();
		this.startUploadTimer();
		this.cleanupOldData();
	}

	// 生成唯一ID
	private generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2);
	}

	// 存储蓝牙数据
	storeData(type: BluetoothDataType, value: number): void {
		const data: BluetoothData = {
			id: this.generateId(),
			timestamp: Date.now(),
			type,
			value,
			uploaded: false
		};

		const existingData = this.getAllData();
		existingData.push(data);
		storage.set(STORAGE_KEY, existingData, 0);
	}

	// 获取所有数据
	getAllData(): BluetoothData[] {
		try {
			const data = storage.get(STORAGE_KEY);
			if (data == null) {
				return [];
			}
			// 确保数据是数组
			if (Array.isArray(data)) {
				return data
					.map((item) => parse<BluetoothData>(item))
					.filter((item) => item !== null) as BluetoothData[];
			}

			return [];
		} catch (error) {
			console.error("获取数据失败:", error);
			return [];
		}
	}

	// 获取未上传的数据
	getUnuploadedData(): BluetoothData[] {
		return this.getAllData().filter((item) => !item.uploaded);
	}

	// 标记数据为已上传
	markAsUploaded(ids: string[]): void {
		const existingData = this.getAllData();
		const updatedData = existingData.map((item) => {
			if (ids.includes(item.id)) {
				return { ...item, uploaded: true };
			}
			return item;
		});
		storage.set(STORAGE_KEY, updatedData, 0);
	}

	// 清理旧数据
	cleanupOldData(): void {
		const existingData = this.getAllData();
		const now = Date.now();
		const filteredData = existingData.filter((item) => {
			// 保留未上传的数据，即使超过时间
			if (!item.uploaded) {
				return true;
			}
			return now - item.timestamp < MAX_DATA_AGE;
		});

		if (filteredData.length !== existingData.length) {
			storage.set(STORAGE_KEY, filteredData, 0);
		}
	}

	// 上传数据
	async uploadData(): Promise<boolean> {
		if (this.isUploading) {
			return false;
		}

		const unuploadedData = this.getUnuploadedData();
		if (unuploadedData.length === 0) {
			return true;
		}

		// 按时间顺序排序
		const sortedData = unuploadedData.sort((a, b) => a.timestamp - b.timestamp);

		this.isUploading = true;

		try {
			// 这里实现实际的上传逻辑
			// 模拟上传成功
			console.log("上传蓝牙数据:", sortedData);

			// 模拟网络请求延迟
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					resolve();
				}, 1000);
			});

			// 标记为已上传
			const uploadedIds = sortedData.map((item) => item.id);
			this.markAsUploaded(uploadedIds);

			// 清理旧数据
			this.cleanupOldData();

			console.log("上传成功");
			return true;
		} catch (error) {
			console.error("上传失败:", error);
			return false;
		} finally {
			this.isUploading = false;
		}
	}

	// 开始定时上传
	startUploadTimer(): void {
		this.stopUploadTimer();
		//@ts-ignore
		this.uploadTimer = setInterval(() => {
			this.uploadData();
		}, UPLOAD_INTERVAL);
	}

	// 停止定时上传
	stopUploadTimer(): void {
		const timer = this.uploadTimer;
		if (timer != null) {
			clearInterval(timer);
			this.uploadTimer = null;
		}
	}

	// 销毁
	destroy(): void {
		this.stopUploadTimer();
	}
}

export const bluetoothDataManager = new BluetoothDataManager();
