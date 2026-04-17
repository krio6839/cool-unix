# laoqianjunzi-blue

`laoqianjunzi-blue` 是一款面向 `uni-app x` / `uni-app` 的多端 BLE 插件，统一封装了蓝牙适配器状态、设备扫描、连接管理、服务发现、通知订阅、特征读写、RSSI、MTU 和编码转换等常用能力。

本插件当前包含两套入口：

- `createBlueFleet()`：推荐的新统一接口，适合多端项目直接使用
- `createAndroidCompatBlue()`：Android 兼容迁移接口，适合从旧 Android 风格调用平滑过渡

## 平台实现概览

- `app-android`：已接入原生 Kotlin 混编，支持扫描、连接、服务发现、订阅、读写、RSSI、MTU、权限申请与 Android 兼容迁移接口
- `app-ios`：已接入原生 Swift 混编，支持扫描、连接、服务发现、订阅、读写、RSSI、UTF-8 / GBK 编解码与已连接设备查询
- `app-harmony`：已接入 Harmony 侧 BLE 流程与权限配置，支持扫描、连接、服务发现、订阅、读写、RSSI、MTU 与地址校验
- `mp-weixin`：已接入微信小程序 BLE API，支持扫描、连接、服务发现、订阅、读写、RSSI、MTU
- `web`：为抹平多端导出差异，保留统一接口与 Android 兼容接口的占位实现；当前只保证导入和编译不报错，运行时返回“不支持”

## 安装方法

1. 将 `uni_modules/laoqianjunzi-blue` 放入项目
2. 通过插件根目录导入 API，不要直接导入某个平台目录

```uts
import { createBlueFleet } from "@/uni_modules/laoqianjunzi-blue"
```

如需 Android 迁移入口：

```uts
import { createAndroidCompatBlue } from "@/uni_modules/laoqianjunzi-blue"
```

3. App 平台请保留插件自带的平台配置文件：

- Android：`utssdk/app-android/AndroidManifest.xml`、`utssdk/app-android/config.json`
- iOS：`utssdk/app-ios/info.plist`、`utssdk/app-ios/config.json`
- Harmony：`utssdk/app-harmony/module.json5`、`utssdk/app-harmony/resources/base/element/string.json`

## 快速开始

```uts
import { createBlueFleet } from "@/uni_modules/laoqianjunzi-blue"

const blueFleet = createBlueFleet()

blueFleet.watchAdapterSwitch((packet) => {
	console.log('adapter', packet.code, packet.detail, packet.payload)
})

blueFleet.requestAdapterWake((packet) => {
	console.log('wake', packet)
})

blueFleet.beginSweep({
	duration: 8000,
	includeNameless: false,
	onNode: (packet) => {
		console.log('scan node', packet)
	},
	onDone: () => {
		console.log('scan done')
	}
})
```

完整页面示例见 `pages/blue/index.uvue`。

## 新统一 API 说明

### 创建实例

```uts
const blueFleet = createBlueFleet()
```

### 适配器能力

- `watchAdapterSwitch(callback)`：监听适配器状态变化
- `requestAdapterWake(callback)`：尝试初始化或唤起适配器
- `adapterReady()`：同步读取当前适配器状态
- `openAdapterPanel()`：跳转系统蓝牙设置；Android 实际支持，其它端可能为占位

### 扫描能力

- `beginSweep(plan)`：扫描设备
- `legacySweep(duration, callback)`：兼容简化扫描入口
- `watchSweepFrames(callback)`：监听广播帧
- `stopSweep()`：停止扫描

`BlueSweepPlan` 主要字段：

- `nameKeyword`：名称关键字过滤
- `duration`：扫描时长，毫秒
- `includeNameless`：是否返回无名称设备
- `onNode`：发现设备回调
- `onDone`：扫描结束回调

### 连接能力

- `attach(peerId, keepRetry, callback)`：连接设备
- `setAttachTimeout(duration)`：设置连接超时
- `setRetryGap(duration)`：设置自动重连间隔
- `stopRetry()`：取消自动重连
- `attached()`：当前是否连接
- `currentPeerId()`：当前连接的设备 ID
- `closePipe()`：断开连接

### 服务与通道

- `pullProfile(callback)`：读取服务和特征值
- `listProfiles()`：返回可用通道组合列表
- `pickProfile(index)`：切换当前通道组合
- `activeServiceId()` / `activeNotifyId()` / `activeWriteId()`：获取当前选中的 UUID

### 数据读写

- `pipeValue(serviceId, characteristicId, enabled, callback)`：开启/关闭通知订阅
- `readOnce(serviceId, characteristicId, callback)`：读取特征值
- `emitPacket(plan, callback)`：统一写入入口
- `emitBytes(...)`：按字节数组写入
- `emitBytesWithMode(...)`：按字节数组写入并指定模式
- `emitHex(...)`：按十六进制字符串写入
- `emitHexWithMode(...)`：按十六进制字符串写入并指定模式
- `setTunnelSize(size, callback)`：请求设置 MTU
- `probeSignal(callback)`：读取 RSSI

### 工具能力

- `bytesToHexText(bytes)`：字节转 HEX 文本
- `textToHexSeed(text, charset)`：文本转 HEX
- `hexSeedToText(hexPayload, charset)`：HEX 转文本
- `setDebug(enabled)`：打开或关闭调试日志
- `setDispatchLabel(label)`：设置原生分发标签，主要用于原生调度场景

## Android 兼容迁移入口

```uts
const blueCompat = createAndroidCompatBlue()
```

兼容入口保留了旧 Android 风格的方法名，适合逐步迁移：

- 扫描：`onStartScanBle`、`scanBle`、`startScanBleDevice`、`stopScanBle`
- 连接：`connect`、`connectDevices`、`startAutoConnectBt`、`cancelAutoConnectBt`
- 服务：`scanServices`、`getUUIDs`、`setSelectUUID`
- 读写：`writeDataToBle`、`writeStringDataToBle`、`sendData`
- 订阅：`onNotityReadBleData`、`onNotityReadBleDataMore`、`onIndicate`
- 辅助：`readRssi`、`setMtu`、`byte2HexString`、`string2ByteStrWithCharset`、`byte2StringWithCharset`

详细迁移说明见 `uni_modules/laoqianjunzi-blue/ANDROID_MIGRATION.md`。

## Web 端说明

Web 端当前为了抹平多端差异，已经补齐以下导出：

- `createBlueFleet()`
- `createAndroidCompatBlue()`

但是 Web 端没有接入浏览器专属蓝牙对象，也不依赖 `window` / `navigator.bluetooth`。因此它的定位是：

- 可安全导入
- 可安全调用
- 可避免编译报错
- 运行时统一返回“不支持”或空结果

这意味着你可以在多端工程里直接写统一导入，不需要额外为 Web 写条件导入。

## 页面示例

示例页面位于：

- `pages/blue/index.uvue`

页面演示了以下流程：

- 检查适配器
- 开始扫描
- 选择设备并连接
- 读取服务与默认通道
- 订阅通知
- 发送示例 HEX
- 输出调试日志

如果在 Web 端运行，页面会正常加载，但插件调用会给出“不支持”提示，这属于当前设计预期。

## 各端注意事项

### Android

- 需要自定义基座或正确的运行配置，原生混编与权限配置才能生效
- 插件已内置 Android 权限和清单配置，但项目运行环境仍需正确设置

### iOS

- 需要签名基座或自定义基座才能在真机完整验证
- `requestAdapterWake` 不会像 Android 那样主动打开系统蓝牙开关
- 编码转换支持 `utf-8` 和 `gbk`

### HarmonyOS

- 需要本机正确配置 DevEco Studio 路径后才能做编译验证
- 插件已附带 Harmony 权限声明与文案资源文件

### 微信小程序

- 建议在真机和开发者工具结合验证 BLE 行为
- 小程序端写入模式与原生端可能存在平台差异

### Web

- 当前是编译占位端，不是实际 BLE 运行端
- 只保证导入、调用和页面演示不报错

## 常见问题

### 1. 为什么 Android 编译时提示需要自定义基座？

因为 Android 端接入了原生混编文件和原生配置，这属于正常提示，不是插件语法错误。

### 2. 为什么 iOS 或 HarmonyOS 没法在当前电脑直接编译通过？

通常是本机运行环境未配置完成，例如 iOS 签名基座缺失、Harmony 工具链未设置。这不是插件源码本身的语法问题。

### 3. 为什么 Web 页面能打开但蓝牙操作失败？

因为 Web 端目前只保留了占位实现，用于抹平导出差异和避免编译错误，不承担实际 BLE 连接能力。

### 4. 为什么 `listProfiles()` 为空？

目标设备可能没有同时提供可写和可通知特征，请先打印服务结构确认设备 GATT 能力。

### 5. 哪里可以看完整调用示例？

直接查看 `pages/blue/index.uvue`，它已经演示了从适配器检测到收发数据的整套基本流程。
