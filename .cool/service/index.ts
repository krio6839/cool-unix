import { isDev, ignoreTokens, config } from "@/config";
import { locale, t } from "../locale";
import { isNull, isObject, parse, storage } from "../utils";
import { useStore } from "../store";
import { defaultErrorNotice, type ErrorNoticeShowType } from "./error-notice";

// 请求参数类型定义
export type RequestOptions = {
	url: string; // 请求地址
	method?: RequestMethod; // 请求方法
	data?: any; // 请求体数据
	params?: any; // URL参数
	header?: any; // 请求头
	timeout?: number; // 超时时间
	withCredentials?: boolean; // 是否携带凭证
	firstIpv4?: boolean; // 是否优先使用IPv4
	enableChunked?: boolean; // 是否启用分块传输
	showError?: ErrorNoticeShowType; // 错误提示方式：toast-轻提示, modal-确认弹窗, none-不显示，默认toast
};

// 响应数据类型定义
export type Response = {
	code?: number;
	message?: string;
	data?: any;
};

// 请求队列（用于等待token刷新后继续请求）
let requests: ((token: string) => void)[] = [];

// 标记token是否正在刷新
let isRefreshing = false;

// 判断当前url是否忽略token校验
const isIgnoreToken = (url: string) => {
	return ignoreTokens.some((e) => {
		const pattern = e.replace(/\*/g, ".*");
		return new RegExp(pattern).test(url);
	});
};

/**
 * 通用请求方法
 * @param options 请求参数
 * @returns Promise<T>
 */
export function request(options: RequestOptions): Promise<any | null> {
	let { url, method = "GET", data, header = {}, timeout = 60000, showError = "toast" } = options;

	const { user } = useStore();

	// 开发环境下打印请求信息
	if (isDev) {
		console.log(`[${method}] ${url}`);
	}

	// 拼接基础url
	if (!url.startsWith("http")) {
		url = config.baseUrl + url;
	}

	// 获取当前token
	let Authorization: string | null = user.token;

	// 如果是忽略token的接口，则不携带token
	if (isIgnoreToken(url)) {
		Authorization = null;
	}

	return new Promise((resolve, reject) => {
		// 带提示的拒绝函数
		const rejectWithNotice = (res: Response) => {
			defaultErrorNotice.show({
				message: res.message ?? t("请求失败"),
				showType: showError
			});
			reject(res);
		};

		// 发起请求的实际函数
		const next = () => {
			// uni-app x 在 APP 端要求 data 必须是 UTSJSONObject / string / ArrayBuffer
			// 这里统一把对象序列化为 string，避免含数组字段的强类型对象触发 errCode: 600008
			let payload: any | null = data;
			if (payload != null && typeof payload != "string") {
				payload = JSON.stringify(payload) as any;
			}

			uni.request({
				url,
				method,
				data: payload,
				header: {
					Authorization,
					language: locale.value,
					...(header as UTSJSONObject)
				},
				timeout,

				success(res) {
					console.log(res);

					// 401 无权限
					if (res.statusCode == 401) {
						user.logout();
						rejectWithNotice({ message: t("无权限") } as Response);
					}

					// 502 服务异常
					else if (res.statusCode == 502) {
						rejectWithNotice({ message: t("服务异常") } as Response);
					}

					// 404 未找到
					else if (res.statusCode == 404) {
						let message = `[404] ${url}`;
						if (
							typeof res.data == "object" &&
							!Array.isArray(res.data) &&
							!isNull(res.data)
						) {
							const detail = (res.data as UTSJSONObject)?.detail;
							if (detail != null && typeof detail === "string") {
								message = detail;
							}
						}
						return rejectWithNotice({ message } as Response);
					}

					// 200 正常响应
					else if (res.statusCode == 200) {
						if (res.data == null) {
							resolve(null);
						} else if (!isObject(res.data as any)) {
							resolve(res.data);
						} else {
							const obj = res.data as UTSJSONObject;
							// 优先识别标准 code 字段
							const codeVal = obj?.["code"];
							const statusVal = obj?.["status"];
							const hasCode = codeVal != null;
							// 兼容非标准响应（如上传接口：{ message, status: "success" }）
							const isSuccessStatus = statusVal == "success";
							console.log(isSuccessStatus, hasCode);
							if (hasCode) {
								// 标准响应：按原有 code 校验
								const { code, message, data } = parse<Response>(
									res.data ?? { code: 0 }
								)!;

								switch (code) {
									case 0:
										resolve(data);
										break;
									default:
										rejectWithNotice({ message, code } as Response);
										break;
								}
							} else if (isSuccessStatus) {
								// 非标准成功响应：原样返回
								resolve(res.data);
							} else {
								// 兜底：既无 code 也非 success，按成功处理并原样返回
								resolve(res.data);
							}
						}
					} else {
						rejectWithNotice({ message: t("服务异常") } as Response);
					}
				},

				// 网络请求失败
				fail(err) {
					console.error("[request fail]", method, url, err);
					rejectWithNotice({ message: err.errMsg } as Response);
				}
			});
		};

		// 非刷新token接口才进行token有效性校验
		if (!options.url.includes("/refreshToken")) {
			if (!isNull(Authorization)) {
				// 判断token是否过期
				if (storage.isExpired("token")) {
					// 判断refreshToken是否过期
					if (storage.isExpired("refreshToken")) {
						// 刷新token也过期，直接退出登录
						user.logout();
						return;
					}

					// 如果当前没有在刷新token，则发起刷新
					if (!isRefreshing) {
						isRefreshing = true;
						user.refreshToken()
							.then((token) => {
								// 刷新成功后，执行队列中的请求
								requests.forEach((cb) => cb(token));
								requests = [];
								isRefreshing = false;
							})
							.catch((err) => {
								const message = (err as Response)?.message ?? "刷新token失败";
								rejectWithNotice({ message } as Response);
								user.logout();
							});
					}

					// 将当前请求加入队列，等待token刷新后再执行
					new Promise((resolve) => {
						requests.push((token: string) => {
							// 重新设置token
							Authorization = token;
							next();
							resolve(true);
						});
					});
					// 此处return，等待token刷新
					return;
				}
			}
		}

		// token有效，直接发起请求
		next();
	});
}
