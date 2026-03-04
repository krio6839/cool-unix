# uck-LeBluetooth

`uck-LeBluetooth` 是一个低功率蓝牙解决方案实现，让开发者专注业务

## 插件特色
+ uts跨平台能力

## 使用

### 初始化配置
插件提供了简单的初始化配置
```
import { UckBluetoothConfig, UInitConfig } from "@/uni_modules/uck-LeBluetooth";
const le: UBluetoothManager = UckBluetoothConfig({
	type: "bluetooth"	// 标识
})
```

### requestPermission 初始化: 权限校验
提示: 建议在使用蓝牙(搜索，连接)业务前，检测应用是否已经获取到对应权限

```
le?.requestPermission({
	bluetooth: "蓝牙权限受限提示语",
	location: "位置授权提示语（在高版本的情况下使用到位置权限）"
	callback: () => {
		console.log("权限已授权完毕");
	}
} as RequestPermissionOptions)
```
##### 参数 RequestPermissionOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| bluetooth | string | - | 否 | 蓝牙权限受限提示语 |
| location | string | - | 否 | 位置授权提示语（在高版本的情况下使用到位置权限） |
| callback | () => void | - | 否 | 权限已授权成功回调 |


### initScanRule 配置扫描规则
```
let setting = uni.getSystemSetting();
if(!(setting.bluetoothEnabled ?? false)){
	uni.showModal({
		title: "系统提示",
		content: "请打开蓝牙或授权蓝牙给应用",
		confirmText: "我已知晓",
		showCancel: false
	})
	return;
}
le?.initScanRule({
	scanTimeOut: 10000,
	initBallback: () => {
		console.log("配置扫描规则成功");
	}
} as UInitScanRuleOptions)
```

##### 参数 UInitScanRuleOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| serviceUuids | string[] | - | 否 | 扫描指定的服务的设备 |
| deviceMac 	| string | - | 否 | 扫描指定mac的设备 |
| autoConnect 	| boolean | - | 否 | 连接时的autoConnect参数 |
| scanTimeOut 	| number | - | 是 | 扫描超时时间，小于等于0表示不限制扫描时间 |
| initBallback 	| () => void | - | 否 | 配置扫描规则成功的回调函数 |


### scanBluetooth 开始扫描低功耗蓝牙
```
le?.scanBluetooth({
	onScanStarted: (success: boolean) => {
		console.log("开始扫描: ", success)
	},
	onScanning: (device: UDevice) => {
		console.log("搜索到蓝牙: ", device);
	},
	onScanFinished: (device: UDevice[]) => {
		console.log("扫描结束: ", device.length);
	}
} as ScanLeBluetoothOptions)

```
##### 参数 ScanLeBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| onScanStarted | (success : boolean) => void | - | 否 | 开始扫描 |
| onScanning | (device: UDevice) => void | - | 否 | 扫描到一个符合扫描规则的BLE设备 |
| onScanFinished | (deviceList: UDevice[]) => void | - | 否 | 扫描结束，列出所有扫描到的符合扫描规则的BLE设备 |


### cancelScanBluetooth 停止扫描低功率蓝牙
```
le?.cancelScanBluetooth(() => {
	console.log("停止扫描低功率蓝牙");
})
```
##### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| callback | () => void | - | 否 | 停止扫描低功率蓝牙回调函数 |


### createBluetoothConnection 连接蓝牙
```
le?.createBluetoothConnection({
	deviceId: this.address,
	onStartConnect: () => {
		console.log("连接蓝牙-开始连接");
	},
	onConnectFail: (device: UDevice, message: LeException) => {
		console.log("连接蓝牙-连接失败:", device, message);
	},
	onConnectSuccess: (device: UDevice, status: number) => {
		console.log("连接蓝牙-连接成功:", device, status);
	},
	onDisConnected: (isActiveDisConnected: boolean, device: UDevice, status: number) => {
		console.log("连接蓝牙-连接中断:", isActiveDisConnected, device, status);
	}
} as CreateUBLEConnectionOptions)
```

##### 参数 CreateUBLEConnectionOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| onStartConnect | () => void | - | 否 | 开始连接 |
| onConnectFail | (device: UDevice, message: LeException) => void | - | 否 | 连接失败 |
| onConnectSuccess | (device: UDevice, status: number) => void | - | 否 | 连接成功 |
| onDisConnected | (isActiveDisConnected: boolean, device: UDevice, status: number) => void | - | 否 | 连接中断，isActiveDisConnected表示是否是主动调用了断开连接方法 |



### isCreateConnected 检测某个蓝牙是否已连接
```
let isConnected: boolean = le?.isCreateConnected(deviceId) ?? false;
```
##### 参数
```
// 蓝牙地址（必须）
deviceId

// 是否已连接: true)已连接  false)未连接
isConnected
```


### getBluetoothGattServices 获取某个已连接设备的所有Service
```
le?.getBluetoothGattServices({
	deviceId: deviceId,
	success: (services: string[]) => {
		console.log("获取某个已连接设备的所有Service", services.length);
		for(let i = 0; i < services.length; i++){
			console.log("Service UUID: ", services[i]);
		}
	}
} as GetBluetoothGattServicesOptions)
```

#### 参数 GetBluetoothGattServicesOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| success | (services: string[]) => void | - | 否 | 设备服务列表回调函数 |



### getBluetoothGattCharacteristics 获取某个Service的所有Characteristic
```
le?.getBluetoothGattCharacteristics({
	deviceId: deviecId,
	serviceId: serviceId,
	success: (res: GattCharacteristics[]) => {
		console.log("所有Characteristic === :", res.length);
		for(let i = 0; i < res.length; i++){
			console.log("所有Characteristic === item: ", res[i]);
		}
	}
} as GetBluetoothGattCharacteristicsOptions)
```

#### 参数 GetBluetoothGattCharacteristicsOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| serviceId | string | - | 是 | 服务uuid |
| success | (res: GattCharacteristics[]) => void | - | 否 | 某serviceuuid服务所有特征 (characteristic)回调函数 |


### notifyBluetooth 订阅通知notify
```
le?.notifyBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidNotify: this.notifyId,
	onNotifySuccess: () => {
		console.log("订阅通知notify-成功:");
	},
	onNotifyFailure: (message: LeException) => {
		console.log("订阅通知notify-失败:", message);
	},
	onCharacteristicChanged: (data: number[], value: string) => {
		console.log("订阅通知notify-数据:", data.length, value);
	},
} as NotifyBluetoothOptions)
```
#### 参数 NotifyBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务uuid |
| uuidNotify | string | - | 是 | 通知uuid |
| onNotifySuccess | () => void | - | 否 | 打开通知操作成功回调函数 |
| onNotifyFailure | (message: LeException) => void | - | 否 | 打开通知操作失败回调函数 |
| onCharacteristicChanged | (data: number[], value: string) => void | - | 否 | 打开通知后，设备发过来的数据将在这里出现 data:原始数据, value:经过处理的字符串 |

- 注意: 1.0.7版本以上将在蓝牙回调中添加设备地址
- onNotifySuccess(deviceId: string)，
- onNotifyFailure(deviceId: string, message: LeException)，
- onCharacteristicChanged(deviceId: string, data: number[], value: string)


### stopNotifyBluetooth 取消订阅通知notify
```
le?.stopNotifyBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidNotify: this.notifyId,
	notifyCallback: () => {
		console.log("取消订阅通知notify成功");
	}
} as StopnotifyBluetoothOptions)
```
#### 参数 StopnotifyBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务uuid |
| uuidNotify | string | - | 是 | 通知uuid |
| notifyCallback | () => void | - | 否 | 取消订阅通知notify成功回调函数 |



### indicateBluetooth 订阅通知indicate
```
le?.indicateBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidIndicate: this.indicateId,
	onIndicateSuccess: () => {
		console.log("订阅通知indicate成功:");
	},
	onIndicateFailure: (message: LeException) => {
		console.log("订阅通知indicate失败:", message);
	},
	onCharacteristicChanged: (data: number[], value: string) => {
		console.log("订阅通知indicate数据:", data.length, value);
	},
} as IndicateBluetoothOptions)
```
#### 参数 IndicateBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务uuid |
| uuidIndicate | string | - | 是 | 订阅通知indicate uuid |
| onIndicateSuccess | () => void | - | 否 | 打开通知操作成功回调函数 |
| onIndicateFailure | (message: LeException) => void | - | 否 | 打开通知操作失败回调函数 |
| onCharacteristicChanged | (data: number[], value: string) => void | - | 否 | 打开通知后，设备发过来的数据将在这里出现 data:原始数据, value:经过处理的字符串 |

- 注意: 1.0.7版本以上将在蓝牙回调中添加设备地址
- onIndicateSuccess(deviceId: string)，
- onIndicateFailure(deviceId: string, message: LeException)，
- onCharacteristicChanged(deviceId: string, data: number[], value: string)


### stopIndicateBluetooth 取消订阅通知indicate
```
le?.stopIndicateBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidIndicate: this.indicateId,
	notifyCallback: () => {
		console.log("取消订阅通知indicate成功");
	}
} as StopIndicateBluetoothOptions)
```
#### 参数 StopIndicateBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务service uuid |
| uuidIndicate | string | - | 是 | 通知indicate uuid |
| indicateCallback | () => void | - | 否 | 取消订阅通知indicate成功回调函数 |




### writeBluetooth 写
```
let writeData = "AAAA";
le?.writeBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidWrite: this.writeId,
	data: writeData,
	onWriteSuccess: (current: number, total: number, justWrite: number[], writeData: string) => {
		console.log("发送数据-成功:", current, total, justWrite.length);
	},
	onWriteFailure: (message: LeException) => {
		console.log("发送数据-失败:", message);
	}
} as WriteBluetoothOptions)
```
#### 参数 WriteBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务service uuid |
| uuidWrite | string | - | 是 | 服务write uuid |
| data | string | - | 是 | 写入数据 |
| onWriteSuccess |  (current: number, total: number, justWrite: number[], writeData: string) => void | - | 否 | 发送数据到设备成功函数回调 |
| onWriteFailure |  (message: LeException) => void | - | 否 | 发送数据到设备失败函数回调 |



### readBluetooth 读
```
le?.readBluetooth({
	deviceId: this.deviceId,
	uuidService: this.serviceId,
	uuidRead: this.readId,
	onReadSuccess: (data: number[], value: string) => {
		console.log("读-成功:", data.length, value);
	},
	onReadFailure: (message: LeException) => {
		console.log("读-失败:", message);
	}
} as ReadBluetoothOptions)
```
#### 参数 ReadBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| uuidService | string | - | 是 | 服务service uuid |
| uuidRead | string | - | 是 | 服务write uuid |
| onReadSuccess |  (data: number[], value: string) => void | - | 否 | 读特征值数据成功回调函数 data:原始数据, value:经过处理的字符串 |
| onReadFailure |  (message: LeException) => void | - | 否 | 读特征值数据失败 |


- 注意: 1.0.7版本以上将在蓝牙回调中添加设备地址
- onReadSuccess(deviceId: string, data: number[], value: string)
- onReadFailure(deviceId: string, message: LeException)


### readRssiBluetooth 获取设备的信号强度Rssi
```
le?.readRssiBluetooth({
	deviceId: this.deviceId,
	onRssiFailure: (message: LeException) => {
		console.log("获取Rssi-失败:", message);
	},
	onRssiSuccess: (rssi: number) => {
		console.log("获取Rssi-成功:", rssi);
	}
} as ReadRssiBluetoothOptions);
```

#### 参数 ReadRssiBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| onRssiFailure | (message: LeException) => void | - | 否 | 读取设备的信号强度失败 |
| onRssiSuccess | (rssi: number) => void | - | 否 | 读取设备的信号强度成功 |


### disconnectBluetooth 断开某个设备
```
le?.disconnectBluetooth({
	deviceId: this.deviceId,
	callback: () => {
		console.log("断开连接");
	}
} as DisconnectBluetoothOptions)
```
#### 参数 DisconnectBluetoothOptions
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| deviceId | string | - | 是 | 蓝牙地址 |
| callback | () => void | - | 否 | 断开某个设备成功回调 |



### disconnectAllDeviceBluetooth 断开所有设备
```
le?.disconnectBluetooth(() => {
	console.log("断开所有设备");
})
```
#### 参数 
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| callback | () => void | - | 否 | 断开所有设备成功回调 |



### destroyBluetooth 退出使用，清理资源
```
le?.destroyBluetooth(() => {
	console.log("退出使用，清理资源");
})
```
#### 参数 
| 属性 | 类型 | 默认值 | 必填 | 说明 |
|:---- |:---| :-----:|:---:|:------|
| callback | () => void | - | 否 | 退出使用，清理资源回调 |





### 其他属性

#### UDevice 设备
```
//设备名称
name: string | null,

// 蓝牙地址
deviceId: string,

// 蓝牙设备广播数据段中的 LocalName
localName: string | null,

// 蓝牙设备的信号强度，单位dBm
RSSI: number,

// 蓝牙设备广播数据段中的 ManufacturerData 
advertisData: number[]
```

注意: 后续还会扩充该属性字段


#### LeException 
```
// 状态码
code: number,

// 错误信息
description: string
```

#### GattCharacteristics
```
// 蓝牙设备特征的 UUID
uuid: string,

// 该特征是否支持 read 操作
read: boolean,

// 该特征是否支持 write 操作
write: boolean	

// 该特征是否支持 notify 操作
notify: boolean	

// 该特征是否支持 indicate 操作
indicate: boolean	

// 该特征是否支持无回复写操作
writeNoResponse: boolean	

// 该特征是否支持有回复写操作
writeDefault: boolean	
```
 

[UTS 语法](https://uniapp.dcloud.net.cn/tutorial/syntax-uts.html)
[UTS API插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)
[UTS uni-app兼容模式组件](https://uniapp.dcloud.net.cn/plugin/uts-component.html)
[UTS 标准模式组件](https://doc.dcloud.net.cn/uni-app-x/plugin/uts-vue-component.html)
[Hello UTS](https://gitcode.net/dcloud/hello-uts)