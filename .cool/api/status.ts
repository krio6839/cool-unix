import { request } from "../service";
import type { DateValuePair, StatusApiResponse } from "../types";

export const getStatusDataApi = (
	address: string,
	date?: string
): Promise<StatusApiResponse | null> => {
	const params: UTSJSONObject = {};
	if (date != null) {
		params["date"] = date;
	}

	return request({
		url: `/devices/${address}/status`,
		method: "GET",
		data: params
	}) as Promise<StatusApiResponse | null>;
};

export const getReadinessDataApi = (
	address: string,
	startDate: string,
	endDate: string
): Promise<DateValuePair | null> => {
	return request({
		url: `/devices/${address}/readiness`,
		method: "GET",
		data: {
			startDate,
			endDate
		} as UTSJSONObject
	}) as Promise<DateValuePair | null>;
};
