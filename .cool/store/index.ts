import { Dict, dict } from "./dict";
import { User, user } from "./user";
import { Device, device } from "./device";
import { Home, home } from "./home";

type Store = {
	user: User;
	dict: Dict;
	device: Device;
	home: Home;
};

export function useStore(): Store {
	return {
		user,
		dict,
		device,
		home
	};
}

export * from "./dict";
export * from "./user";
export * from "./device";
export * from "./home";
