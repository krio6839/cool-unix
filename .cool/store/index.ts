import { Dict, dict } from "./dict";
import { User, user } from "./user";
import { Device, device } from "./device/index";
import { Home, home } from "./home";
import { Energy, energy } from "./energy";
import { Status, status } from "./status";
import { Load, load } from "./load";
import { Sleep, sleep } from "./sleep";
import { Recovery, recovery } from "./recovery";
import { Metrics, metrics } from "./metrics";
import { Realtime, realtime } from "./realtime";

type Store = {
	user: User;
	dict: Dict;
	device: Device;
	home: Home;
	energy: Energy;
	status: Status;
	load: Load;
	sleep: Sleep;
	recovery: Recovery;
	metrics: Metrics;
	realtime: Realtime;
};

export function useStore(): Store {
	return {
		user,
		dict,
		device,
		home,
		status,
		energy,
		load,
		sleep,
		recovery,
		metrics,
		realtime
	};
}

export * from "./dict";
export * from "./user";
export * from "./device/index";
export * from "./home";
export * from "./energy";
export * from "./status";
export * from "./load";
export * from "./sleep";
export * from "./recovery";
export * from "./metrics";
export * from "./realtime";
