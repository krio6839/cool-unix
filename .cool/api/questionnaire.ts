import { request } from "../service";
import type { Questionnaire, SubmitRequest } from "../types";

export const getQuestionnaireApi = (): Promise<any | null> => {
	return request({
		url: `/app/questionnaire`,
		method: "GET",
		showError: "none"
	}) as Promise<any | null>;
};

/** POST /app/questionnaire — 设置问卷问题（含生物识别题） */
export const setQuestionnaireApi = (data: Questionnaire): Promise<boolean> => {
	return request({
		url: `/app/questionnaire`,
		method: "POST",
		data: data
	}) as Promise<boolean>;
};

export const submitQuestionnaireApi = (data: SubmitRequest): Promise<boolean> => {
	return request({
		url: `/app/questionnaire/submit`,
		method: "POST",
		data: data
	}) as Promise<boolean>;
};
