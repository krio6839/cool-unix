import type { VitalDataQueryResponse } from "../boom-types";

/** 将测试页读取到的生命体征原始秒数据转为可在表格软件中核对的 CSV。 */
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

function formatLocalTime(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	// 前置制表符令 Excel/WPS 按文本导入，避免其默认的“时:分”单元格格式隐藏秒。
	return `\t${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function two(value: number): string {
	return value < 10 ? `0${value}` : value.toString();
}
