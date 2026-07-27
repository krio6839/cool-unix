export type GattQueueTaskKind =
	| "timeSync"
	| "readEvent"
	| "historyRepair"
	| "manualCommand";

export type GattQueuePriority = "urgent" | "normal" | "tail";
export type GattFlushReason = "urgent" | "timer" | "startup" | "manual";

export type GattTaskName =
	| "vitalAuto"
	| "vitalRecent"
	| "vitalGap"
	| "event"
	| "timeSync"
	| "unbind"
	| "manual"
	| "unknown";
