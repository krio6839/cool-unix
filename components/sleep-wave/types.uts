export type RectInfo = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type LineInfo = {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
};

export type SleepSegment = {
	startTime: string;
	endTime: string;
	startTimestamp: number;
	endTimestamp: number;
	state: number;
	rect?: RectInfo;
	line?: LineInfo;
	left?: boolean;
	right?: boolean;
};

export type TouchValue = {
	startTime: string;
	endTime: string;
	sleepState: number;
	sleepStateText: string;
	touchX: number;
};

export type CurrentSegment = SleepSegment | null;
