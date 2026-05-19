import { Dict, dict } from "./dict";
import { User, user } from "./user";
import { Device, device } from "./device";
import { Home, home } from "./home";
import { Energy, energy } from "./energy";

type Store = {
	user: User;
	dict: Dict;
	device: Device;
	home: Home;
	energy: Energy;
};

export function useStore(): Store {
	return {
		user,
		dict,
		device,
		home,
		energy
	};
}

export * from "./dict";
export * from "./user";
export * from "./device";
export * from "./home";
export * from "./energy";
