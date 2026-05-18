export const proxy = {
	// 开发环境配置
	dev: {
		// 官方测试地址
		target: "http://47.100.30.18:18000",
		// 本地地址
		// target: "http://127.0.0.1:8001",
		changeOrigin: true,
		rewrite: (path: string) => path.replace("/dev", "")
	},

	// 生产环境配置
	prod: {
		// 官方测试地址
		target: "http://47.100.30.18:18000",
		changeOrigin: true,
		rewrite: (path: string) => path.replace("/prod", "/api")
	}
};

export const value = "dev";
