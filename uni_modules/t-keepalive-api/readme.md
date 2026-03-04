## Turbo UI 系列插件 - App保活（想咋活就咋活）

## 插件介绍

`t-keepalive-api` 是一个用于 uni-app 的应用保活插件，支持 Android 和 iOS 平台。该插件可以帮助应用在后台运行时保持活跃状态，并且支持在保活状态下执行自定义函数。

## 功能特点

- 支持 Android 和 iOS 平台
- 前台服务保活（Android）
- 后台任务保活（iOS）
- 支持在保活状态下执行自定义函数
- 支持设置执行间隔
- 提供电池优化和自启动权限申请
- 适配多种主流手机厂商

## 项目配置

- 根目录配置 `manifest.json` > `iOS App配置` > `后台运行能力`
	- 添加 `audio`


#### 完整使用代码

```vue
<template>
	<!-- #ifdef APP -->
	<scroll-view style="flex:1">
	<!-- #endif -->
		<view class="container">
			<view class="title">应用保活功能演示</view>
			
			<view class="card">
				<button class="card-btn" @click="handleRequestPermissions(1)" type="primary">忽略电池优化</button>
				<button class="card-btn" @click="handleRequestPermissions(2)" type="primary">悬浮窗权限</button>
				<button class="card-btn" @click="handleRequestPermissions(3)" type="primary">精确闹钟权限</button>
				<button class="card-btn" @click="handleRequestPermissions(4)" type="primary">自启动权限</button>
				<button class="card-btn" @click="handleStartKeepAlive()" type="primary">启动保活</button>
				<button class="card-btn" @click="handleStopKeepAlive()" type="primary">停止保活</button>
			</view>
		</view>
	<!-- #ifdef APP -->
	</scroll-view>
	<!-- #endif -->
</template>

<script setup>
	import * as TKeepAlive from "@/uni_modules/t-keepalive-api"
	let interv = ref(0)
	let num = ref(0)
	
	// 开启保活
  function handleStartKeepAlive() {
		TKeepAlive.start(() => {
			interv.value = setInterval(() => {
				num.value += 1
				console.log("Turbo Plugins 邀你活着：", num.value)
			},2000)
		})
	}
	
	// 停止保活
  function handleStopKeepAlive() {
		TKeepAlive.stop(() => {
			clearInterval(interv.value)
			num.value = 0
			console.log("Turbo Plugins 停止了")
		})
	}
	
	// 申请权限
	function handleRequestPermissions(tp: number) {
		if(tp == 1){
			TKeepAlive.requestBatteryOptimizationPermission()
		}
		if(tp == 2){
			TKeepAlive.requestOverlayPermission()
		}
		if(tp == 3){
			TKeepAlive.requestExactAlarmPermission()
		}
		if(tp == 4){
			TKeepAlive.showAutoStartGuide()
		}
	}
</script>

<style>
.container {
	padding: 20px;
}

.title {
	font-size: 20px;
	font-weight: bold;
	text-align: center;
	margin-bottom: 20px;
}

.card {
	background-color: #f8f8f8;
	border-radius: 8px;
	padding: 15px;
	margin-bottom: 20px;
}

.card-title {
	font-size: 18px;
	font-weight: bold;
	margin-bottom: 15px;
}

.status {
	margin-top: 15px;
	font-weight: bold;
	text-align: center;
}

.log-title {
	margin-top: 20px;
	margin-bottom: 5px;
	font-weight: bold;
}

.log-container {
	height: 200px;
	border: 1px solid #ddd;
	border-radius: 5px;
	padding: 10px;
	background-color: #fff;
}

.log-item {
	font-size: 14px;
	padding: 3px 0;
	border-bottom: 1px solid #eee;
}
.card-btn{
	margin-bottom: 5px;
}
</style>

```

## 暴露的类型

```ts
export type TKeepAliasCallback = () => void;

export declare function start(callback: TKeepAliasCallback): void;
export declare function stop(callback: TKeepAliasCallback): void;
```

## 插件 Info.plist 配置

```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- 后台模式配置 -->
    <key>UIBackgroundModes</key>
    <array>
        <string>audio</string>
        <string>fetch</string>
    </array>
    
    <!-- 网络传输安全 -->
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
</dict>
</plist>
```

## 插件AndroidManifest.xml配置

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"
	package="uts.sdk.modules.tKeepaliveApi">
	<!-- 基础权限 -->
	<uses-permission android:name="android.permission.INTERNET" />
	<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
	<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />

	<!-- 保活相关权限 -->
	<!-- 唤醒锁权限，防止设备进入深度睡眠 -->
	<uses-permission android:name="android.permission.WAKE_LOCK" />

	<!-- 前台服务权限 -->
	<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
	<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />

	<!-- 忽略电池优化权限 -->
	<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

	<!-- 系统弹窗权限（部分厂商需要） -->
	<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />

	<!-- 开机自启动权限 -->
	<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

	<!-- 通知权限 -->
	<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

	<!-- 查询已安装应用权限（Android 11+） -->
	<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" tools:ignore="QueryAllPackagesPermission" />

	<!-- 设备管理员权限（可选，增强保活效果） -->
	<uses-permission android:name="android.permission.BIND_DEVICE_ADMIN" />

	<!-- 写入系统设置权限（部分厂商跳转需要） -->
	<uses-permission android:name="android.permission.WRITE_SETTINGS" />
	
	<!-- 闹钟权限 -->
	<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />

	<!-- 修改系统设置权限 -->
	<uses-permission android:name="android.permission.WRITE_SECURE_SETTINGS" tools:ignore="ProtectedPermissions" />
	<!-- 厂商特殊权限查询 -->
	<queries>
		<!-- 小米 -->
		<package android:name="com.miui.securitycenter" />
		<!-- OPPO -->
		<package android:name="com.coloros.safecenter" />
		<package android:name="com.oppo.safe" />
		<!-- VIVO -->
		<package android:name="com.vivo.permissionmanager" />
		<!-- 华为 -->
		<package android:name="com.huawei.systemmanager" />
		<!-- 荣耀 -->
		<package android:name="com.hihonor.systemmanager" />
		<!-- 魅族 -->
		<package android:name="com.meizu.safe" />
		<!-- 一加 -->
		<package android:name="com.oneplus.security" />
		<!-- 三星 -->
		<package android:name="com.samsung.android.sm" />
		<!-- 联想 -->
		<package android:name="com.lenovo.safecenter" />
	</queries>
	<application>
		<!-- 主Activity -->
		<activity android:name="uts.sdk.modules.tKeepaliveApi.KeepAliveActivity" android:exported="true"></activity>

		<!-- 1像素保活Activity -->
		<activity android:name="uts.sdk.modules.tKeepaliveApi.OnePixelActivity" android:excludeFromRecents="true" android:exported="false"
			android:finishOnTaskLaunch="false" android:launchMode="singleInstance"
			android:theme="@android:style/Theme.Translucent.NoTitleBar" />

		<!-- 保活服务 -->
		<service android:name="uts.sdk.modules.tKeepaliveApi.KeepAliveService" />

		<!-- 定时唤醒接收器 -->
		<receiver android:name="uts.sdk.modules.tKeepaliveApi.AlarmReceiver" />

		<!-- 开机启动接收器 -->
		<receiver android:name="uts.sdk.modules.tKeepaliveApi.BootReceiver" android:enabled="true" android:exported="true">
			<intent-filter>
				<action android:name="android.intent.action.BOOT_COMPLETED" />
				<action android:name="android.intent.action.QUICKBOOT_POWERON" />
				<action android:name="com.htc.intent.action.QUICKBOOT_POWERON" />
			</intent-filter>
		</receiver>
	</application>
</manifest>
```


## 注意事项

1. iOS 系统对后台任务有严格限制，保活时间有限，建议结合推送通知等机制增强保活效果。
2. 不同厂商的 Android 设备对后台应用有不同的限制策略，可能需要用户手动设置。
3. 请合理使用保活功能，避免过度消耗用户设备电量。
