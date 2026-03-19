import { ref } from "vue";
import { storage } from "../utils";

export class Device {
	isPaired = false;

	constructor() {
		const devicePaired = storage.get("devicePaired");
		this.isPaired = devicePaired == "Y";
	}

	updatePairedStatus(paired: boolean) {
		this.isPaired = paired;
		storage.set("devicePaired", paired ? "Y" : "N", 0);
	}

	getPaired(): boolean {
		return this.isPaired;
	}

	clear() {
		this.isPaired = false;
		storage.remove("devicePaired");
	}
}

export const device = new Device();
