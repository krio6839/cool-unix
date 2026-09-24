import type { VitalDataQueryResponse } from "../boom-types";

/**
 * 将测试页读取到的生命体征响应转为 CSV。
 *
 * 每个已解析秒输出一行；`startSec <= 0` 的历史结束标记不输出。全零秒和无效秒都保留，
 * 由 `valid` 列区分，便于真机协议核对。返回文本始终带表头和末尾换行。
 */
export function buildVitalHistoryCsv(responses: VitalDataQueryResponse[]): string {
	const lines: string[] = [
		"timestamp,local_time,page_start_sec,page_index,second_index,hr,ppi,status,pitch,acc,valid"
	];
	for (let pageIndex = 0; pageIndex < responses.length; pageIndex++) {
		const page = responses[pageIndex];
		if (page.startSec <= 0) continue;
		for (let secondIndex = 0; secondIndex < page.vitalData.length; secondIndex++) {
			const item = page.vitalData[secondIndex];
			const timestamp = page.startSec + secondIndex;
			lines.push(
				`${timestamp},${formatLocalTime(timestamp)},${page.startSec},${pageIndex + 1},${secondIndex},${item.hr},${item.ppi},${item.status},${item.pitch},${item.acc},${item.valid ? 1 : 0}`
			);
		}
	}
	return lines.join("\n") + "\n";
}

/** 使用手机本地时区格式化，并以制表符前缀强制表格软件保留秒。 */
function formatLocalTime(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	// 前置制表符令 Excel/WPS 按文本导入，避免其默认的“时:分”单元格格式隐藏秒。
	return `\t${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** 两位十进制补零，只用于 CSV 日期时间字段。 */
function two(value: number): string {
	return value < 10 ? `0${value}` : value.toString();
}
