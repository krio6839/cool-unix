import type { GattTaskName } from "./types";

export class DeviceGattTaskLock {
	private taskName: string = "";

	begin(name: GattTaskName): boolean {
		if (this.taskName != "") {
			console.log(`[BOOM-GATT] 通道忙: current=${this.taskName}, request=${name}`);
			return false;
		}
		this.taskName = name;
		console.log(`[BOOM-GATT] 通道占用: ${name}`);
		return true;
	}

	end(name: GattTaskName): void {
		if (this.taskName != name) return;
		console.log(`[BOOM-GATT] 通道释放: ${name}`);
		this.taskName = "";
	}

	isBusy(): boolean {
		return this.taskName != "";
	}

	getName(): string {
		return this.taskName;
	}
}
