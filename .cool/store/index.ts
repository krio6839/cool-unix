import { Dict, dict } from "./dict";
import { User, user } from "./user";
import { Device, device } from "./device";

type Store = {
	user: User;
	dict: Dict;
	device: Device;
};

export function useStore(): Store {
	return {
		user,
		dict,
		device
	};
}

export * from "./dict";
export * from "./user";
export * from "./device";
