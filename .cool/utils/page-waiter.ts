/**
 * 分页等待器
 * 用于等待 BLE 回调通知"下一页数据已到达"，超时则兜底返回。
 * 单一职责：只关心"通知/超时"两件事，不依赖任何业务字段，可在多处复用。
 */
export class PageWaiter {
	/** 当前等待的 resolver；notify()/超时 时被消费 */
	private resolver: (() => void) | null = null;

	/**
	 * 等待下一次 notify() 调用。
	 * @param timeoutMs 超时毫秒数；<= 0 表示不超时（直到 notify 触发）
	 * @returns true=超时，false=收到通知
	 */
	wait(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolver = () => {
				this.resolver = null;
				resolve(false);
			};

			if (timeoutMs <= 0) {
				return;
			}

			setTimeout(() => {
				if (this.resolver != null) {
					this.resolver = null;
					resolve(true);
				}
			}, timeoutMs);
		});
	}

	/**
	 * 通知等待者释放。多次调用安全：只有当前 wait() 的 resolver 会被消费。
	 * 若当前没有 wait()，调用会被忽略（不会保留到下次 wait）。
	 */
	onNotify(): void {
		if (this.resolver != null) {
			this.resolver();
		}
	}

	/**
	 * 重置状态，允许再次 wait()。
	 * 一般在新一轮分页开始前调用，确保旧 resolver 不会泄漏。
	 */
	reset(): void {
		this.resolver = null;
	}
}
