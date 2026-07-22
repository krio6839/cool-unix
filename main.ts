import { createSSRApp } from "vue";
import App from "./App.uvue";
import { diagnostics, setupDiagnostics } from "./.cool";

export function createApp() {
	setupDiagnostics();
	const app = createSSRApp(App);
	app.config.errorHandler = (err, instance, info) => {
		diagnostics.captureException(
			{
				err,
				info,
				component: instance?.$options?.name ?? ""
			},
			"vue"
		);
	};

	return {
		app
	};
}
