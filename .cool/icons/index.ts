import { iconfont } from "./iconfont";
import { remixicon } from "./remixicon";

/**
 * 图标库聚合
 *
 * 必须使用函数形式，不能用顶层常量。
 * UTS 编译到 Kotlin 时会把所有模块打平成一个文件，顶层 val 之间不允许前向引用，
 * 而 iconfont / remixicon 体积大，会被拆成 __uts_large_* 推迟到文件末尾 emit，
 * 常量形式会让 Android 端 kotlinc 报 "Variable 'iconfont' must be initialized"。
 * 函数是懒求值，调用时所有顶层 val 都已初始化完毕。
 */
export function icons(): UTSJSONObject {
	return {
		iconfont,
		remixicon
	} as UTSJSONObject;
}
