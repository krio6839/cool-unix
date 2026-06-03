export function sleepTimeout(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve()
		}, ms)
	});
}
