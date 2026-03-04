# kux-bluetooth
`kux-bluetooth` 是一个完全按照微信小程序蓝牙API设计标准实现的一个蓝牙操作插件，帮助开发者简化开发过程中操作蓝牙相关的逻辑，让开发者专注业务开发。

## 插件特色
+ 小程序标准API设计
+ 完全使用uni错误规范
+ 支持多设备连接
+ 支持各种状态监听
+ 支持安卓5.0以下版本
+ uts跨平台能力

## 目录结构
<ol>
	<li>基础
		<ol>
			<li><a href="#guide_config">初始化配置</a></li>
		</ol>
	</li>
	<li>蓝牙-通用
		<ol>
			<li><a href="#openBluetoothAdapter">openBluetoothAdapter</a></li>
			<li><a href="#getBluetoothAdapterState">getBluetoothAdapterState</a></li>
			<li><a href="#startBluetoothDevicesDiscovery">startBluetoothDevicesDiscovery</a></li>
			<li><a href="#onBluetoothDeviceFound">onBluetoothDeviceFound</a></li>
			<li><a href="#getBluetoothDevices">getBluetoothDevices</a></li>
			<li><a href="#stopBluetoothDevicesDiscovery">stopBluetoothDevicesDiscovery</a></li>
			<li><a href="#offBluetoothDeviceFound">offBluetoothDeviceFound</a></li>
			<li><a href="#closeBluetoothAdapter">closeBluetoothAdapter</a></li>
			<li><a href="#onBluetoothAdapterStateChange">onBluetoothAdapterStateChange</a></li>
		</ol>
	</li>
	<li>蓝牙-低功耗中心设备
		<ol>
			<li><a href="#createBLEConnection">createBLEConnection</a></li>
			<li><a href="#closeBLEConnection">closeBLEConnection</a></li>
			<li><a href="#onBLEConnectionStateChange">onBLEConnectionStateChange</a></li>
			<li><a href="#getBLEDeviceServices">getBLEDeviceServices</a></li>
			<li><a href="#getBLEDeviceCharacteristics">getBLEDeviceCharacteristics</a></li>
			<li><a href="#readBLECharacteristicValue">readBLECharacteristicValue</a></li>
			<li><a href="#onBLECharacteristicValueChange">onBLECharacteristicValueChange</a></li>
			<li><a href="#notifyBLECharacteristicValueChange">notifyBLECharacteristicValueChange</a></li>
			<li><a href="#onReadBLECharacteristicValue">onReadBLECharacteristicValue</a></li>
			<li><a href="#writeBLECharacteristicValue">writeBLECharacteristicValue</a></li>
			<li><a href="#onWriteBLECharacteristicValue">onWriteBLECharacteristicValue</a></li>
		</ol>
	</li>
	<li><a href="#interface">自定义类型</a>
	</li>
	<li><a href="#unierror">错误规范</a>
</ol>

<a id="guide_config"></a>
### 初始化配置
插件提供了简单的初始化配置，主要是为了兼容安卓低版本，因为安卓低版本中蓝牙必须要通过获取用户位置实现获取周围的设备需求。

```
import { useKuxBluetooth } from '@/uni_modules/kux-bluetooth';
import { InitConfig } from '@/uni_modules/kux-bluetooth/utssdk/interface';

const kuxBluetooth : BluetoothManager = useKuxBluetooth({
	/**
	 * 是否请求地理位置权限，可选参数
	 */
	needLocation: false,
	/**
	 * 是否需要在后台访问位置信息，可选参数
	 */
	accessBackgroundLocation: false
} as InitConfig);
```
> **注意**
> 
> + 因为插件需要自定义配置蓝牙使用相关权限，所以该插件需要自定义基座才能正常使用。
> + 目前没测试 `uniapp` 项目是否可以正常使用，各位开发者可以自行测试。

<a id="openBluetoothAdapter"></a>
### openBluetoothAdapter
#### 功能描述
初始化蓝牙模块。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| mode | string | central | 否 | 目前不需要该参数
| success | `(res: OpenBluetoothAdapterSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 注意
+ 其他蓝牙相关 API 必须在 [openBluetoothAdapter](#openBluetoothAdapter) 调用之后使用。否则 API 会返回错误（errCode=10000）。
+ 在用户蓝牙开关未开启或者手机不支持蓝牙功能的情况下，调用 [openBluetoothAdapter](#openBluetoothAdapter) 会返回错误（errCode=10001），表示手机蓝牙功能不可用。

#### 示例代码
```
kuxBluetooth.openBluetoothAdapter({
	success: ((res) => {
		console.log(`初始化蓝牙成功:${res.errMsg}`);
		console.log(JSON.stringify(res));
	})
} as OpenBluetoothAdapterOptions);
```

<a id="getBluetoothAdapterState"></a>
### getBluetoothAdapterState
#### 功能描述
获取本机蓝牙适配器状态。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| success | `(res: GetBluetoothAdapterStateSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### success 回调函数
#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| discovering | boolean | 是否正在搜索设备
| available | boolean | 蓝牙适配器是否可用

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.getBluetoothAdapterState({
	success: ((res) => {
		console.log(JSON.stringify(res));
	})
} as GetBluetoothAdapterStateOptions);
```

<a id="startBluetoothDevicesDiscovery"></a>
### startBluetoothDevicesDiscovery
#### 功能描述
开始搜寻附近的蓝牙外围设备。<br/>
**此操作比较耗费系统资源，请在搜索到需要的设备后及时调用 [stopBluetoothDevicesDiscovery](#stopBluetoothDevicesDiscovery) 停止搜索。**

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| success | `(res: GetBluetoothAdapterStateSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth. startBluetoothDevicesDiscovery({
	success: ((res) => {
		console.log('开始搜索蓝牙设备' + res.errMsg);
	}),
	fail: (e) => {
		console.log(e);
		console.log('搜索蓝牙设备失败，错误码' + e.errCode);
	}
} as StartBluetoothDevicesDiscoveryOptions);
```

<a id="onBluetoothDeviceFound"></a>
### onBluetoothDeviceFound
#### 功能描述
监听搜索到新设备的事件

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| listener | `callback: OnBluetoothDeviceFoundCallback` | - | 否 | 回调函数

#### 回调参数
| 属性 | 类型 | 说明
| --- | --- | ---
| devices | `DeviceInfo[]` | 新搜索到的设备列表

#### DeviceInfo 结构参数
| 结构属性 | 类型 | 说明
| --- | --- | ---
| name | string | 蓝牙设备名称，某些设备可能没有
| deviceId | string | 蓝牙设备 id
| RSSI | number | 当前蓝牙设备的信号强度，单位 dBm
| advertisData | `number[]` | 当前蓝牙设备的广播数据段中的 ManufacturerData 数据段。
| advertisServiceUUIDs | `string[]` | 当前蓝牙设备的广播数据段中的 ServiceUUIDs 数据段
| localName | string | 当前蓝牙设备的广播数据段中的 LocalName 数据段
| serviceData | Object | 当前蓝牙设备的广播数据段中的 ServiceData 数据段
| connectable | boolean | 当前蓝牙设备是否可连接（ Android 8.0 以下不支持返回该值 ）

#### 注意
+ 若在 `onBluetoothDeviceFound ` 回调了某个设备，则此设备会添加到 [getBluetoothDevices](#getBluetoothDevices) 获取到的数组中。
+ 可以通过 [offBluetoothDeviceFound](#offBluetoothDeviceFound) 移除搜索到新设备的事件的全部监听函数。

#### 示例代码
```
kuxBluetooth.onBluetoothDeviceFound((res) => {
	console.log(res);
	console.log('开始监听寻找到新设备的事件');
	getBluetoothDevices();
});
```


<a id="getBluetoothDevices"></a>
### getBluetoothDevices
#### 功能描述
获取在蓝牙模块生效期间所有搜索到的蓝牙设备。包括已经和本机处于连接状态的设备。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| success | `(res: GetBluetoothDevicesSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### success 回调函数
#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| devices | `DeviceInfo[]` | UUID 对应的已连接设备列表

#### DeviceInfo 结构参数
| 结构属性 | 类型 | 说明
| --- | --- | ---
| name | string | 蓝牙设备名称，某些设备可能没有
| deviceId | string | 蓝牙设备 id
| RSSI | number | 当前蓝牙设备的信号强度，单位 dBm
| advertisData | `number[]` | 当前蓝牙设备的广播数据段中的 ManufacturerData 数据段。
| advertisServiceUUIDs | `string[]` | 当前蓝牙设备的广播数据段中的 ServiceUUIDs 数据段
| localName | string | 当前蓝牙设备的广播数据段中的 LocalName 数据段
| serviceData | Object | 当前蓝牙设备的广播数据段中的 ServiceData 数据段
| connectable | boolean | 当前蓝牙设备是否可连接（ Android 8.0 以下不支持返回该值 ）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth. getBluetoothDevices({
	success: ((res) => {
		res.devices.map((item) => {
			const {
				deviceId,
				name,
				localName,
				RSSI
			} = item;
			// 其他业务逻辑
		});
	})
} as GetBluetoothDevicesOptions);
```

<a id="stopBluetoothDevicesDiscovery"></a>
### stopBluetoothDevicesDiscovery
#### 功能描述
停止搜寻附近的蓝牙外围设备。若已经找到需要的蓝牙设备并不需要继续搜索时，建议调用该接口停止蓝牙搜索。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| success | `(res: StopBluetoothDevicesDiscoverySuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.stopBluetoothDevicesDiscovery({
	success: ((res) => {
		console.log('停止搜索蓝牙设备' + res.errMsg);
	})
} as StopBluetoothDevicesDiscoveryOptions);
```

<a id="offBluetoothDeviceFound"></a>
### offBluetoothDeviceFound
#### 功能描述
移除搜索到新设备的事件的全部监听函数。

#### 示例代码
```
kuxBluetooth.offBluetoothDeviceFound();
```

<a id="createBLEConnection"></a>
### createBLEConnection
#### 功能描述
连接蓝牙低功耗设备。
若之前已有搜索过某个蓝牙设备，并成功建立连接，可直接传入之前搜索获取的 deviceId 直接尝试连接该设备，无需再次进行搜索操作。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id
| timeout | number | 否 |  | 超时时间，单位 ms，不填表示不会超时
| success | `(res: CreateBLEConnectionSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 注意
+ 请保证尽量成对的调用 [createBLEConnection](#createBLEConnection) 和 [closeBLEConnection](#createBLEConnection) 接口。安卓如果重复调用 [createBLEConnection](#createBLEConnection) 创建连接，有可能导致系统持有同一设备多个连接的实例，导致调用 closeBLEConnection 的时候并不能真正的断开与设备的连接。
+ 蓝牙连接随时可能断开，建议监听 [onBLEConnectionStateChange](#onBLEConnectionStateChange) 回调事件，当蓝牙设备断开时按需执行重连操作。

#### 示例代码
```
kuxBluetooth.createBLEConnection({
	// 这里的 deviceId 已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	success: (res) => {
		console.log(res);
		console.log('连接蓝牙成功:' + res.errMsg);
		// 连接设备后断开搜索 并且不能搜索设备
		stopBluetoothDevicesDiscovery(true);
		uni.hideToast();
		uni.showToast({
			title: '连接成功',
			icon: 'success',
			duration: 2000
		});
	},
	fail: (err) => {
		uni.hideToast();
		console.log('连接低功耗蓝牙失败，错误码：' + err.errCode);
	}
} as CreateBLEConnectionOptions);
```

<a id="closeBLEConnection"></a>
### closeBLEConnection
#### 功能描述
断开与蓝牙低功耗设备的连接。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id
| success | `(res: ApiCommonSuccessCallback) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.closeBLEConnection({
	deviceId,
	success: (res) => {
		console.log(res);
		console.log('断开低功耗蓝牙成功:' + res.errMsg);
	},
	fail: (err) => {
		console.log(err);
		console.log('断开低功耗蓝牙失败，错误码：' + err.errCode);
	}
} as CloseBLEConnectionOptions);
```

<a id="onBLEConnectionStateChange"></a>
### onBLEConnectionStateChange
#### 功能描述
监听蓝牙低功耗连接状态改变事件。包括开发者主动连接或断开连接，设备丢失，连接异常断开等等。

#### 参数
#### function listener
蓝牙低功耗连接状态改变事件的监听函数

#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| deviceId | string | 蓝牙设备id
| connected | boolean | 是否处于连接状态

#### 示例代码
```
kuxBluetooth.onBLEConnectionStateChange((res) => {
	// 该方法回调中可以用于处理连接意外断开等异常情况
	console.log(`蓝牙连接状态 -------------------------->`);
	console.log(JSON.stringify(res));
	if (!res.connected) {
		if (isStop.value) return;
		console.log('断开低功耗蓝牙成功:');
		toast('已经断开当前蓝牙连接');
		// uni.hideToast()
	}
});
```

<a id="getBLEDeviceServices"></a>
### getBLEDeviceServices
#### 功能描述
获取蓝牙低功耗设备所有服务 (service)。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id。需要已经通过 [createBLEConnection](#createBLEConnection) 建立连接
| success | `(res: GetBLEDeviceServicesSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### success 回调函数
#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| services | `GetBLEDeviceServicesSuccessService[]` | 设备服务列表

#### GetBLEDeviceServicesSuccessService 结构参数
| 结构属性 | 类型 | 说明
| --- | --- | ---
| uuid | string | 蓝牙设备服务的 UUID
| isPrimary | boolean | 该服务是否为主服务

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.getBLEDeviceServices({
	// 这里的 deviceId 需要已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	success: res => {
		console.log(JSON.stringify(res.services));
		console.log('获取设备服务成功:' + res.errMsg);
	},
	fail: e => {
		console.log('获取设备服务失败，错误码：' + e.errCode);
	}
} as GetBLEDeviceServicesOptions);
```

<a id="getBLEDeviceCharacteristics"></a>
### getBLEDeviceCharacteristics
#### 功能描述
获取蓝牙低功耗设备某个服务中所有特征 (characteristic)。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id。需要已经通过 [createBLEConnection](#createBLEConnection) 建立连接
| serviceId | string |  | 是 | 蓝牙服务 UUID。需要先调用 [getBLEDeviceServices](#getBLEDeviceServices) 获取
| success | `(res: GetBLEDeviceCharacteristicsSuccess) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### success 回调函数
#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| characteristics | `BLEDeviceCharacteristic[]` | 设备特征列表

#### BLEDeviceCharacteristic 结构参数
| 结构属性 | 类型 | 说明
| --- | --- | ---
| uuid | string | 蓝牙设备特征的 UUID
| properties | `CharacteristicProperties` | 该特征支持的操作类型

#### CharacteristicProperties 结构参数
| 结构属性 | 类型 | 说明
| --- | --- | ---
| read | boolean | 该特征是否支持 read 操作
| write | boolean | 该特征是否支持 write 操作
| notify | boolean | 该特征是否支持 notify 操作
| indicate | boolean | 该特征是否支持 indicate 操作
| writeNoResponse | boolean | 该特征是否支持无回复写操作
| writeDefault | boolean | 该特征是否支持有回复写操作

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.getBLEDeviceCharacteristics({
	// 这里的 deviceId 需要已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	// 这里的 serviceId 需要在 getBLEDeviceServices 接口中获取
	serviceId,
	success: res => {
		console.log(JSON.stringify(res));
		console.log('获取特征值成功');
	},
	fail: e => {
		console.log(e);
		console.log('获取特征值失败，错误码：' + e.errCode);
	}
} as GetBLEDeviceCharacteristicsOptions);
```

<a id="readBLECharacteristicValue"></a>
### readBLECharacteristicValue
#### 功能描述
读取蓝牙低功耗设备特征值的二进制数据。注意：必须设备的特征支持 read 才可以成功调用。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id。
| serviceId | string |  | 是 | 蓝牙特征对应服务的 UUID
| characteristicId | string |  | 是 | 蓝牙特征的 UUID
| success | `(res: ApiCommonSuccessCallback) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 注意
+ 并行调用多次会存在读失败的可能性。
+ 接口读取到的信息需要在 [onBLECharacteristicValueChange](#onBLECharacteristicValueChange) 方法注册的回调中获取。
+ 在未订阅的情况下也可以直接通过 [onReadBLECharacteristicValue](#onReadBLECharacteristicValue) 方法主动监听读取的数据。

#### 示例代码
```
// 必须在这里的回调才能获取
kuxBluetooth.onBLECharacteristicValueChange(characteristic => {
	console.log('监听低功耗蓝牙设备的特征值变化事件成功');
	console.log(JSON.stringify(characteristic));
});

kuxBluetooth.readBLECharacteristicValue({
	// 这里的 deviceId 需要已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	// 这里的 serviceId 需要在 getBLEDeviceServices 接口中获取
	serviceId,
	// 这里的 characteristicId 需要在 getBLEDeviceCharacteristics 接口中获取
	characteristicId,
	success (res) {
		console.log('读取设备数据值成功');
		// 订阅模式监听
		// notifyBLECharacteristicValueChange();
		// 主动监听
		// onReadBLECharacteristicValue();
	}
} as ReadBLECharacteristicValueOptions);
```

<a id="onBLECharacteristicValueChange"></a>
### onBLECharacteristicValueChange
#### 功能描述
监听蓝牙低功耗设备的特征值变化事件。必须先调用 [notifyBLECharacteristicValueChange](#notifyBLECharacteristicValueChange) 接口才能接收到设备推送的 notification。

#### 参数
#### function listener
蓝牙低功耗设备的特征值变化事件的监听函数。

#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| deviceId | string | 蓝牙设备 id
| serviceId | string | 蓝牙特征对应服务的 UUID
| characteristicId | string | 蓝牙特征的 UUID
| value | ArrayBuffer | 特征最新的值

#### 示例代码
```
kuxBluetooth.onBLECharacteristicValueChange(characteristic => {
	console.log('监听低功耗蓝牙设备的特征值变化事件成功');
	console.log(JSON.stringify(characteristic));
	// 下面为演示demo的示例代码，不要直接粘贴使用
	valueChangeData.value.deviceId = characteristic.deviceId;
	valueChangeData.value.serviceId = characteristic.serviceId;
	valueChangeData.value.characteristicId = characteristic.characteristicId;
	valueChangeData.value.value = characteristic.value;
});
```

<a id="notifyBLECharacteristicValueChange"></a>
### notifyBLECharacteristicValueChange
#### 功能描述
启用蓝牙低功耗设备特征值变化时的 notify 功能，订阅特征。注意：必须设备的特征支持 notify 或者 indicate 才可以成功调用。另外，必须先启用 [notifyBLECharacteristicValueChange](#notifyBLECharacteristicValueChange) 才能监听到设备 characteristicValueChange 事件

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id。
| serviceId | string |  | 是 | 蓝牙特征对应服务的 UUID
| characteristicId | string |  | 是 | 蓝牙特征的 UUID
| state | boolean |  | 是 | 是否启用 notify。IOS平台无效。
| type | `'notification' | 'indication'` | indication | 否 | 设置特征订阅类型，有效值有 `notification ` 和 `indication `。IOS平台无效。
| success | `(res: ApiCommonSuccessCallback) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 注意
+ 订阅操作成功后需要设备主动更新特征的 value，才会触发 [onBLECharacteristicValueChange](#onBLECharacteristicValueChange) 回调。
+ 安卓平台上，在本接口调用成功后立即调用 [writeBLECharacteristicValue](#writeBLECharacteristicValue) 接口，在部分机型上会发生 10008 系统错误

#### 示例代码
```
kuxBluetooth.notifyBLECharacteristicValueChange({
	state: true, // 启用 notify 功能
	// 这里的 deviceId 需要已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	// 这里的 serviceId 需要在 getBLEDeviceServices 接口中获取
	serviceId,
	// 这里的 characteristicId 需要在 getBLEDeviceCharacteristics 接口中获取
	characteristicId,
	success(res) {
		console.log('notifyBLECharacteristicValueChange success:' + res.errMsg);
		console.log(JSON.stringify(res));
	},
	fail: e => {
		console.log(e);
		console.log('订阅失败，错误码：' + e.errCode);
	}
} as NotifyBLECharacteristicValueChangeOptions);
```

<a id="onReadBLECharacteristicValue"></a>
### onReadBLECharacteristicValue
#### 功能描述
监听读取蓝牙低功耗设备特征值的二进制数据的事件。特征需支持 read 方可成功调用。IOS平台无效。

#### 参数
同 [notifyBLECharacteristicValueChange](#notifyBLECharacteristicValueChange)。

#### 示例代码
```
kuxBluetooth.onReadBLECharacteristicValue(characteristic => {
	console.log('监听读取蓝牙低功耗设备特征值的二进制数据事件成功');
	console.log(JSON.stringify(characteristic));
	// 下面为演示demo示例代码，不要粘贴使用
	valueChangeData.value.deviceId = characteristic.deviceId;
	valueChangeData.value.serviceId = characteristic.serviceId;
	valueChangeData.value.characteristicId = characteristic.characteristicId;
	valueChangeData.value.value = characteristic.value;
	console.log(valueChangeData.value);
	toast('主动监听读取事件成功');
})
```

<a id="writeBLECharacteristicValue"></a>
### writeBLECharacteristicValue
#### 功能描述
向蓝牙低功耗设备特征值中写入二进制数据。注意：必须设备的特征支持 write 才可以成功调用。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| deviceId | string |  | 是 | 蓝牙设备 id。
| serviceId | string |  | 是 | 蓝牙特征对应服务的 UUID
| characteristicId | string |  | 是 | 蓝牙特征的 UUID
| value | ArrayBuffer |  | 是 | 蓝牙设备特征对应的二进制值
| writeType | `'write' | 'writeNoResponse'` |  | 否 | 蓝牙特征值的写模式设置，有两种模式，iOS 优先 write，安卓优先 writeNoResponse
| success | `(res: ApiCommonSuccessCallback) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### writeType 参数说明
| 合法值 | 说明
| --- | ---
| write | 强制回复写，不支持时报错
| writeNoResponse | 	强制无回复写，不支持时报错

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 注意
+ 并行调用多次会存在写失败的可能性。
+ 插件本身不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，建议每次写入不超过 20 字节。
+ 安卓平台上，在调用 [notifyBLECharacteristicValueChange](#notifyBLECharacteristicValueChange) 成功后立即调用本接口，在部分机型上会发生 10008 系统错误
+ 在未订阅的情况下也可以直接通过 [onWriteBLECharacteristicValue](#onWriteBLECharacteristicValue) 方法主动监听读取的数据。

#### 示例代码
```
const buffer = new ArrayBuffer(1)
const dataView = new DataView(buffer)
dataView.setUint8(0, 0)

kuxBluetooth.writeBLECharacteristicValue({
	// 这里的 deviceId 需要已经通过 createBLEConnection 与对应设备建立链接
	deviceId,
	// 这里的 serviceId 需要在 getBLEDeviceServices 接口中获取
	serviceId,
	// 这里的 characteristicId 需要在 getBLEDeviceCharacteristics 接口中获取
	characteristicId,
	value: buffer,
	success: res => {
		console.log('写入设备数据值成功');
		console.log(JSON.stringify(res));
		// 订阅模式监听
		// notifyBLECharacteristicValueChange();
		// 主动写入监听
		// onWriteBLECharacteristicValue();
	},
	fail: e => {
		console.log(JSON.stringify(e));
		console.log('写入设备数据值失败，错误码：' + e.errCode);
	}
} as WriteBLECharacteristicValueOptions);
```

<a id="onWriteBLECharacteristicValue"></a>
### onWriteBLECharacteristicValue
#### 功能描述
监听写入蓝牙低功耗设备特征值的二进制数据的事件。特征需支持 write 方可成功调用。IOS平台无效。

#### function listener
监听写入蓝牙低功耗设备特征值的二进制数据的事件响应函数

#### 参数
| 属性 | 类型 | 说明
| --- | --- | ---
| success | boolean | 写入是否成功

#### 示例代码
```
kuxBluetooth.onWriteBLECharacteristicValue(success => {
	console.log('监听写入蓝牙低功耗设备特征值的二进制数据事件成功');
})
```

<a id="closeBluetoothAdapter"></a>
### closeBluetoothAdapter
#### 功能描述
关闭蓝牙模块。调用该方法将断开所有已建立的连接并释放系统资源。建议在使用蓝牙流程后，与 [openBluetoothAdapter](#openBluetoothAdapter) 成对调用。

#### 参数
| 属性 | 类型 | 默认值 | 必填 | 说明
| --- | --- | --- | --- | ---
| success | `(res: ApiCommonSuccessCallback) => void` | - | 否 | 接口调用成功的回调函数
| fail | `ApiFail` | - | 否 | 接口调用失败的回调函数
| complete | `ApiComplete` | - | 否 | 接口调用结束的回调函数（调用成功、失败都会执行）

#### 错误
| 错误码 | 错误信息 | 说明
| --- | --- | ---
| 0 | ok | 正常
| -1 | 已连接 | 已连接
| 10000 | 未初始化蓝牙适配器 | 未初始化蓝牙适配器
| 10001 | 当前蓝牙适配器不可用 | 当前蓝牙适配器不可用
| 10002 | 没有找到指定设备 | 没有找到指定设备
| 10003 | 连接失败 | 连接失败
| 10004 | 没有找到指定服务 | 没有找到指定服务
| 10005 | 没有找到指定特征 | 没有找到指定特征
| 10006 | 当前连接已断开 | 当前连接已断开
| 10007 | 当前特征不支持此操作 | 当前特征不支持此操作
| 10008 | 系统异常 | 系统异常
| 10009 | 设备不支持BLE | 设备不支持BLE
| 10012 | 连接超时 | 连接超时
| 10013 | 连接 deviceId 为空或者是格式不正确 | 连接 deviceId 为空或者是格式不正确

#### 示例代码
```
kuxBluetooth.onBLEConnectionStateChange((res) => {
	// 该方法回调中可以用于处理连接意外断开等异常情况
	console.log(`蓝牙连接状态 -------------------------->`);
	console.log(JSON.stringify(res));
});
```

<a id="onBluetoothAdapterStateChange"></a>

### onBluetoothAdapterStateChange
#### 功能描述
监听蓝牙适配器状态变化事件
> **提示**
>
> `v1.1.0` 及以上版本支持。

#### 参数
#### Object res
| 属性 | 类型 | 说明
| --- | --- | ---
| available | `boolean` | 蓝牙适配器是否可用
| discovering | `boolean`| 蓝牙适配器是否处于搜索状态

#### 示例代码
```
kuxBluetooth.onBluetoothAdapterStateChange((res) => {
	console.log('adapterState changed, now is', res)
});
```

<a id="interface"></a>
### 自定义类型
```
/**
 * 初始化配置项
 */
export type InitConfig = {
	/**
	 * 是否请求地理位置权限
	 */
	needLocation?: boolean;
	/**
	 * 是否需要在后台访问位置信息
	 */
	accessBackgroundLocation?: boolean;
};

export type ApiCommonSuccessCallback = {
	errCode: number,
	errMsg: string
}

export type ApiFail = (err: UniError) => void;

export type ApiComplete = (res: any) => void;

export type BluetoothAdapterMode = 'central' | 'peripheral';

export type OpenBluetoothAdapterSuccess = ApiCommonSuccessCallback;

export type OpenBluetoothAdapterOptions = {
	mode?: BluetoothAdapterMode,
	success?: (res: OpenBluetoothAdapterSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type CloseBluetoothAdapterSuccess = ApiCommonSuccessCallback;

export type CloseBluetoothAdapterOptions = {
	success?: (res: CloseBluetoothAdapterSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type GetBluetoothAdapterStateSuccess = {
	discovering: boolean,
	available: boolean
}

export type OnBluetoothAdapterStateChangeRes = {
	discovering: boolean,
	available: boolean
}


export type GetBluetoothAdapterStateOptions = {
	success?: (res: GetBluetoothAdapterStateSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type DeviceInfo = {
	deviceId: string,
	name: string,
	localName: string,
	RSSI: number,
	advertisData: number[],
	advertisServiceUUIDs: string[],
	serviceData: any | null,
	connectable: boolean | null
}

export type EnableBluetoothOptions = {
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type StartBluetoothDevicesDiscoveryOptions = {
	services?: string[],
	allowDuplicatesKey?: boolean,
	interval?: number,
	powerLevel?: 'low' | 'medium' | 'high',
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type OnBluetoothDeviceFoundCallback = (devices: DeviceInfo[]) => void;

export type ApiCommonOptions = {
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
};

export type StopBluetoothDevicesDiscoverySuccess = ApiCommonSuccessCallback;

export type StopBluetoothDevicesDiscoveryOptions = {
	success?: (res: StopBluetoothDevicesDiscoverySuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
};

export type CreateBLEConnectionSuccess = ApiCommonSuccessCallback;

export type CreateBLEConnectionOptions = {
	deviceId: string,
	timeout?: number,
	success?: (res: CreateBLEConnectionSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type OnBLEConnectionStateChangeCallbackRes = {
	deviceId: string,
	connected: boolean
}

export type OnBLEConnectionStateChangeCallback = (res: OnBLEConnectionStateChangeCallbackRes) => void;

export type GetBLEDeviceServicesSuccessService = {
	uuid: string,
	isPrimary: boolean
}

export type GetBLEDeviceServicesSuccess = {
	errCode: number,
	errMsg: string,
	services: GetBLEDeviceServicesSuccessService[]
}

export type GetBLEDeviceServicesOptions = {
	deviceId: string,
	success?: (res: GetBLEDeviceServicesSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type GetBluetoothDevicesSuccess = {
	devices: DeviceInfo[]
}

export type GetBluetoothDevicesOptions = {
	success?: (res: GetBluetoothDevicesSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type CloseBLEConnectionOptions = {
	deviceId: string,
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type CharacteristicProperties = {
	read: boolean,
	write: boolean,
	notify: boolean,
	indicate: boolean,
	writeNoResponse: boolean,
	writeDefault: boolean
}

export type BLEDeviceCharacteristic = {
	uuid: string,
	properties: CharacteristicProperties
}

export type GetBLEDeviceCharacteristicsSuccess = {
	characteristics: BLEDeviceCharacteristic[]
}

export type GetBLEDeviceCharacteristicsOptions = {
	deviceId: string,
	serviceId: string,
	success?: (res: GetBLEDeviceCharacteristicsSuccess) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}


export type ReadBLECharacteristicValueOptions = {
	deviceId: string,
	serviceId: string,
	characteristicId: string,
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type WriteBLECharacteristicValueOptions = {
	deviceId: string,
	serviceId: string,
	characteristicId: string,
	value: number[],
	writeType?: 'write' | 'writeNoResponse',
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type NotifyBLECharacteristicValueChangeOptions = {
	deviceId: string,
	serviceId: string,
	characteristicId: string,
	state: boolean,
	type?: 'notification' | 'indication',
	success?: (res: ApiCommonSuccessCallback) => void,
	fail?: ApiFail,
	complete?: ApiComplete
}

export type OnBLECharacteristicValueChangeRes = {
	deviceId: string,
	serviceId: string,
	characteristicId: string,
	value: number[]
}

export type OnBluetoothAdapterStateChangeCallback = (res: OnBluetoothAdapterStateChangeRes) => void
export type OnBLECharacteristicValueChangeCallback = (res: OnBLECharacteristicValueChangeRes) => void
export type OnReadBLECharacteristicValueCallback = (res: OnBLECharacteristicValueChangeRes) => void
export type OnWriteBLECharacteristicValueCallback = (success: boolean) => void

export type KuxBluetoothErrorCode = 
| -1
| 10000
| 10001
| 10002
| 10004
| 10005
| 10006
| 10007
| 10008
| 10009
| 10012
| 10013
| 9010001 
| 9010002 
| 9010003 
| 9010004 
| 9010005 
| 9010006 
| 9010007 
| 9010008
| 9010009
| 9010010
| 9010011

export interface KuxBluetoothFail extends IUniError {
	errCode: KuxBluetoothErrorCode
}
```

<a id="unierror"></a>
### 错误规范
```
/* 此规范为 uni 规范，可以按照自己的需要选择是否实现 */
import { KuxBluetoothErrorCode, KuxBluetoothFail } from "./interface.uts"
/**
 * 错误主题
 * 注意：错误主题一般为插件名称，每个组件不同，需要使用时请更改。
 * [可选实现]
 */
export const UniErrorSubject = 'kux-bluetooth';


/**
 * 错误信息
 * @UniError
 * [可选实现]
 */
export const UniErrors : Map<KuxBluetoothErrorCode, string> = new Map([
  /**
   * 错误码及对应的错误信息
   */
  [-1, '已连接'],
  [10000, '未初始化蓝牙适配器'],
  [10001, '当前蓝牙适配器不可用'],
  [10002, '没有找到指定设备'],
  [10004, '没有找到指定服务'],
  [10005, '没有找到指定特征'],
  [10006, '当前连接已断开'],
  [10007, '当前特征不支持此操作'],
  [10008, '系统异常'],
  [10009, '设备不支持BLE'],
  [10012, '连接超时'],
  [10013, '连接 deviceId 为空或者是格式不正确']
]);


/**
 * 错误对象实现
 */
export class KuxBluetoothFailImpl extends UniError implements KuxBluetoothFail {

  /**
   * 错误对象构造函数
   */
  constructor(errCode : KuxBluetoothErrorCode) {
    super();
    this.errSubject = UniErrorSubject;
    this.errCode = errCode;
    this.errMsg = UniErrors[errCode] ?? "";
  }
}
```

---
### 结语
#### kux 不生产代码，只做代码的搬运工，致力于提供uts 的 js 生态轮子实现，欢迎各位大佬在插件市场搜索使用 kux 生态插件：[https://ext.dcloud.net.cn/search?q=kux](https://ext.dcloud.net.cn/search?q=kux)

___
### 友情推荐
+ [TMUI4.0](https://ext.dcloud.net.cn/plugin?id=16369)：包含了核心的uts插件基类.和uvue组件库
+ [GVIM即时通讯模版](https://ext.dcloud.net.cn/plugin?id=16419)：GVIM即时通讯模版，基于uni-app x开发的一款即时通讯模版
+ [t-uvue-ui](https://ext.dcloud.net.cn/plugin?id=15571)：T-UVUE-UI是基于UNI-APP X开发的前端UI框架
+ [UxFrame 低代码高性能UI框架](https://ext.dcloud.net.cn/plugin?id=16148)：【F2图表、双滑块slider、炫酷效果tabbar、拖拽排序、日历拖拽选择、签名...】UniAppX 高质量UI库
+ [wx-ui 基于uni-app x开发的高性能混合UI库](https://ext.dcloud.net.cn/plugin?id=15579)：基于uni-app x开发的高性能混合UI库，集成 uts api 和 uts component，提供了一套完整、高效且易于使用的UI组件和API，让您以更少的时间成本，轻松完成高性能应用开发。
+ [firstui-uvue](https://ext.dcloud.net.cn/plugin?id=16294)：FirstUI（unix）组件库，一款适配 uni-app x 的轻量、简洁、高效、全面的移动端组件库。
+ [easyXUI 不仅仅是UI 更是为UniApp X设计的电商模板库](https://ext.dcloud.net.cn/plugin?id=15602)：easyX 不仅仅是UI库，更是一个轻量、可定制的UniAPP X电商业务模板库，可作为官方组件库的补充,始终坚持简单好用、易上手
