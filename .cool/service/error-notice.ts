import { useUi } from "@/uni_modules/cool-ui";
import type { ClConfirmOptions } from "@/uni_modules/cool-ui/types";

// 错误提示类型
export type ErrorNoticeShowType = "toast" | "modal" | "none";

// 错误提示选项
export type ErrorNoticeOptions = {
	message: string;
	showType?: ErrorNoticeShowType;
};

// 错误提示接口
export type ErrorNotice = {
	show: (options: ErrorNoticeOptions) => void;
};

// toast 实现
function toastNotice(message: string): void {
	useUi().showToast({
		message: message,
		icon: "none",
		duration: 2000
	});
}

// modal 实现
function modalNotice(message: string): void {
	useUi().showConfirm({
		title: "提示",
		message: message,
		showCancel: false
	} as ClConfirmOptions);
}

// 默认错误提示实现
export const defaultErrorNotice: ErrorNotice = {
	show(options: ErrorNoticeOptions): void {
		const message = options.message;
		const type = options.showType;
		if (type == "toast") {
			toastNotice(message);
		} else if (type == "modal") {
			modalNotice(message);
		}
		// none 不做任何处理
	}
};
