export type UserType = {
	label: string;
	value: string;
};

export type QuestionOption = {
	label: string;
	value: string;
};

export type Question = {
	field?: string;
	text: string;
	options: QuestionOption[];
};

export type Questionnaire = {
	userTypes: UserType[];
	questions: Question[];
};

export type Answer = {
	question: string;
	selected: string;
};

export type SubmitRequest = {
	userType: string;
	answers: Answer[];
};
