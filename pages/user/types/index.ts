export type LoginForm = {
	phone: string;
	password: string;
	smsCode: string;
};

export type LoginMode = "oneClick" | "password" | "sms";
