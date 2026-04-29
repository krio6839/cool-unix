export type BluetoothDataType = "heartRate" | "bloodOxygen" | "battery" | "ppi";

export type BluetoothData = {
	id: string;
	timestamp: number;
	type: BluetoothDataType;
	value: number;
	ppi: number | null;
	uploaded: boolean;
};

export type SleepData = {
	id: string;
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getupTime: number;
	recordCount: number;
	statuses: SleepStatus[];
	uploaded: boolean;
};

export type SleepDataInput = {
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getupTime: number;
	recordCount: number;
	statuses: SleepStatus[];
};

export type SleepStatus = {
	id: string;
	sleepId: string;
	minuteIndex: number;
	status: number; // -2: Deep sleep, -1: Light sleep, 0: REM, 1: WAKE
};

export type HeartRateRecord = {
	timestamp: number;
	heartRate: number;
	bloodOxygen: number;
	ppi: number;
};

export type DataReadyStatus = {
	heartRateCount: number;
	sleepCount: number;
};

export type ParserSleepData = {
	reportTimestamp: number;
	bedtime: number;
	sleepTime: number;
	wakeTime: number;
	getUpTime: number;
	totalRecords: number;
	sleepStages: Array<number>;
};
