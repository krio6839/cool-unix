import { ref } from "vue";
import { storage } from "../utils";

export class Device {
	isPaired = ref<boolean>(false);

	constructor() {
		const devicePaired = storage.get("devicePaired");
		if (devicePaired == "Y") {
			this.isPaired.value = true;
		} else {
			this.isPaired.value = false;
		}
	}

	setPaired(paired: boolean) {
		this.isPaired.value = paired;
		storage.set("devicePaired", paired ? "Y" : "N", 0);
	}

	getPaired(): boolean {
		return this.isPaired.value;
	}

	clear() {
		this.isPaired.value = false;
		storage.remove("devicePaired");
	}
}

export const device = new Device();
