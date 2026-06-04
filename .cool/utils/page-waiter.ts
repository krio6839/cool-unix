/**
 * 分页等待器
 * 用于等待 BLE 回调通知"下一页数据已到达"，超时则兜底返回。
 * 单一职责：只关心"通知/超时/全空"三件事，不依赖任何业务字段，可在多处复用。
 */
export class PageWaiter {
	/** 当前等待的 resolver；notify()/超时 时被消费 */
	private resolver: (() => void) | null = null;

	/**
	 * 等待的代数。每次 wait() 自增；setTimeout 超时回调中只有当 generation 仍匹配
	 * 当前 wait() 的代数时，才会消费 resolver 并 resolve(true)。
	 * 避免旧的 setTimeout 在新一轮 wait() 之后误清空新 resolver（导致新 wait() 永远卡住）。
	 */
	private generation: number = 0;

	/** 本轮分页中是否收到"全 f"响应（说明后续无有效数据，可提前结束） */
	private allEmpty: boolean = false;

	/**
	 * 等待下一次 notify() 调用。
	 * @param timeoutMs 超时毫秒数；<= 0 表示不超时（直到 notify 触发）
	 * @returns true=超时，false=收到通知
	 */
	wait(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.generation++;
			const myGeneration = this.generation;
			this.resolver = () => {
				this.resolver = null;
				resolve(false);
			};

			if (timeoutMs <= 0) {
				return;
			}

			setTimeout(() => {
				// 关键：只有当 generation 仍是当前 wait() 的代数时，
				// 才消费 resolver 并 resolve(true)。否则说明期间已发生过新的
				// wait()（可能已被 onNotify 消费过），不能误清空新 resolver。
				if (this.generation === myGeneration && this.resolver != null) {
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
	 * 标记本轮分页已收到"全 f"响应（后续无有效数据）。
	 * 通常在解析出 records.length === 0 时调用。
	 */
	markAllEmpty(): void {
		this.allEmpty = true;
	}

	/** 当前是否已收到"全 f" */
	isAllEmpty(): boolean {
		return this.allEmpty;
	}

	/**
	 * 重置状态，允许再次 wait()。
	 * 一般在新一轮分页开始前调用，确保旧 resolver 与"全 f"标志不会泄漏。
	 */
	reset(): void {
		this.resolver = null;
		// 同时递增 generation，使任何尚未触发的 setTimeout 变为"陈旧"，避免影响下一轮
		this.generation++;
		this.allEmpty = false;
	}
}
