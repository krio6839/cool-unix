export type TimeValuePair = {
	time: string;
	value: number;
};

export type DateValuePair = {
	date: string;
	value: number;
};

export type ZoneItem = {
	name: string;
	percentage: number;
	color?: string;
	rightText?: string;
};

export type DateRange = { startDate: string; endDate: string };
