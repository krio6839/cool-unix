import { request } from "../service";
import type { QuestionnaireResponse, SubmitRequest } from "../types";

export const getQuestionnaireApi = (): Promise<QuestionnaireResponse | null> => {
	return request({
		url: `/app/questionnaire`,
		method: "GET"
	}) as Promise<QuestionnaireResponse | null>;
};

export const submitQuestionnaireApi = (data: SubmitRequest): Promise<boolean> => {
	return request({
		url: `/app/questionnaire/submit`,
		method: "POST",
		data: data
	}) as Promise<boolean>;
};
