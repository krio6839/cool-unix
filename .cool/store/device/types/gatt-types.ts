export type GattQueueTaskKind =
	| "timeSync"
	| "readEvent"
	| "historyRepair"
	| "manualCommand";

export type GattQueuePriority = "urgent" | "normal" | "tail";
export type GattFlushReason = "urgent" | "timer" | "startup" | "manual";
export type GattTaskOutcome = "CONTINUE" | "STOP_DEVICE_UNRESPONSIVE";

/** 入队原因。只进日志与任务字段，不改变执行逻辑。 */
export type SyncReason = "startup" | "timer" | "manual";

export type GattTaskName =
	| "vitalAuto"
	| "vitalRecent"
	| "vitalGap"
	| "event"
	| "timeSync"
	| "unbind"
	| "manual"
	| "unknown";
