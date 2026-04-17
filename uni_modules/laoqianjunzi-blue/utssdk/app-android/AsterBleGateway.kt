package uts.laoqianjunzi.bluecore

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import io.dcloud.uts.UTSAndroid
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object AsterBleGateway {
    private const val enableRequestCode = 9426
    private const val codeOk = 0
    private const val codeBusy = 1000
    private const val codePermission = 10001
    private const val codeAdapterOff = 10002
    private const val codeConnectFail = 10003
    private const val codeAlreadyLinked = 10004
    private const val codeServiceFail = 10005
    private const val codeChannelFail = 10006
    private const val codeRuntime = 9011001

    private val mainHandler = Handler(Looper.getMainLooper())
    private var adapterWatch: ((String) -> Unit)? = null
    private var sweepRawWatch: ((String) -> Unit)? = null
    private var sweepNodeWatch: ((String) -> Unit)? = null
    private var linkWatch: ((String) -> Unit)? = null
    private var notifyWatch: ((String) -> Unit)? = null
    private var readWatch: ((String) -> Unit)? = null
    private var mtuWatch: ((String) -> Unit)? = null
    private var rssiWatch: ((String) -> Unit)? = null
    private var serviceWatch: ((String) -> Unit)? = null
    private var writeWatch: ((String) -> Unit)? = null
    private var subscribeWatch: ((String) -> Unit)? = null
    private var enableWatch: ((String) -> Unit)? = null

    private var sweepTimer: Runnable? = null
    private var retryTask: Runnable? = null
    private var scanCallback: ScanCallback? = null
    private var switchReceiver: BroadcastReceiver? = null

    private var currentGatt: BluetoothGatt? = null
    private var currentPeerIdValue: String = ""
    private var currentDevice: BluetoothDevice? = null
    private var currentMtu: Int = 23
    private var linkEstablished: Boolean = false
    private var linkTimeoutMs: Long = 15000
    private var retryGapMs: Long = 12000
    private var keepRetry: Boolean = false
    private var selectingIndex: Int = -1

    private var activeServiceIdValue: String = ""
    private var activeNotifyIdValue: String = ""
    private var activeWriteIdValue: String = ""

    private val discoveredBundles = ArrayList<JSONObject>()
    private val discoveredServices = ArrayList<BluetoothGattService>()
    private val scanCache = ConcurrentHashMap<String, JSONObject>()

    private var writeQueue = ArrayDeque<WriteSlice>()
    private var writing = false
    private var writePlanTotal = 0

    private data class WriteSlice(
        val serviceId: String,
        val characteristicId: String,
        val chunk: ByteArray,
        val writeType: Int,
        val totalParts: Int,
        val partIndex: Int
    )

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                currentGatt = gatt
                currentPeerIdValue = gatt.device.address ?: ""
                currentDevice = gatt.device
                linkEstablished = true
                mainHandler.postDelayed({ gatt.discoverServices() }, 300)
                linkWatch?.invoke(envelope(codeOk, "连接成功", JSONObject().put("peerId", currentPeerIdValue)))
                return
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val payload = JSONObject()
                payload.put("peerId", currentPeerIdValue)
                payload.put("status", status)
                currentGatt?.close()
                currentGatt = null
                linkEstablished = false
                activeServiceIdValue = ""
                activeNotifyIdValue = ""
                activeWriteIdValue = ""
                writing = false
                writePlanTotal = 0
                writeQueue.clear()
                linkWatch?.invoke(envelope(if (status == 0) codeBusy else codeConnectFail, "连接已断开", payload))
                if (keepRetry && currentPeerIdValue.isNotEmpty()) {
                    scheduleRetry()
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                serviceWatch?.invoke(envelope(codeServiceFail, "服务发现失败", JSONObject().put("status", status)))
                return
            }
            discoveredServices.clear()
            discoveredServices.addAll(gatt.services)
            rebuildBundles(gatt.services)
            val payload = JSONObject()
            payload.put("services", AsterBleCodec.servicesToJson(gatt.services))
            payload.put("bundles", bundlesArray())
            payload.put("active", activeBundleJson())
            serviceWatch?.invoke(envelope(codeOk, "服务发现完成", payload))
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            emitNotifyPacket(characteristic, value, "收到通知数据")
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            emitNotifyPacket(characteristic, characteristic.value, "收到通知数据")
        }

        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            val payload = dataPayload(characteristic, value)
            payload.put("status", status)
            readWatch?.invoke(envelope(if (status == BluetoothGatt.GATT_SUCCESS) codeOk else codeRuntime, "读取完成", payload))
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val payload = dataPayload(characteristic, characteristic.value)
            payload.put("status", status)
            readWatch?.invoke(envelope(if (status == BluetoothGatt.GATT_SUCCESS) codeOk else codeRuntime, "读取完成", payload))
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                writing = false
                drainWriteQueue()
            } else {
                writing = false
                writeQueue.clear()
                writeWatch?.invoke(envelope(codeRuntime, "写入失败", JSONObject().put("status", status)))
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            val payload = JSONObject()
            payload.put("serviceId", descriptor.characteristic.service.uuid.toString())
            payload.put("characteristicId", descriptor.characteristic.uuid.toString())
            payload.put("status", status)
            subscribeWatch?.invoke(envelope(if (status == BluetoothGatt.GATT_SUCCESS) codeOk else codeRuntime, "订阅状态已更新", payload))
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                currentMtu = mtu
            }
            val payload = JSONObject()
            payload.put("mtu", mtu)
            payload.put("status", status)
            mtuWatch?.invoke(envelope(if (status == BluetoothGatt.GATT_SUCCESS) codeOk else codeRuntime, "MTU 结果", payload))
        }

        override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
            val payload = JSONObject()
            payload.put("peerId", gatt.device.address ?: "")
            payload.put("rssi", rssi)
            payload.put("status", status)
            rssiWatch?.invoke(envelope(if (status == BluetoothGatt.GATT_SUCCESS) codeOk else codeRuntime, "RSSI 结果", payload))
        }
    }

    fun watchRadioSwitch(callback: (String) -> Unit) {
        adapterWatch = callback
        ensureSwitchReceiver()
        callback(envelope(codeOk, "已返回当前蓝牙状态", JSONObject().put("enabled", isRadioReady())))
    }

    fun promptRadioWake(callback: (String) -> Unit) {
        val activity = UTSAndroid.getUniActivity()
        val adapter = adapter() ?: run {
            callback(envelope(codeRuntime, "系统不支持蓝牙", null))
            return
        }
        if (adapter.isEnabled) {
            callback(envelope(codeOk, "蓝牙已经开启", JSONObject().put("enabled", true)))
            return
        }
        if (activity == null) {
            callback(envelope(codeRuntime, "当前没有可用 Activity", null))
            return
        }
        enableWatch = callback
        activity.startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), enableRequestCode)
        UTSAndroid.onAppActivityResult { requestCode: Int, resultCode: Int, _: Intent? ->
            if (requestCode == enableRequestCode) {
                val enabled = resultCode == Activity.RESULT_OK || adapter.isEnabled
                enableWatch?.invoke(envelope(if (enabled) codeOk else codeAdapterOff, if (enabled) "蓝牙已开启" else "用户取消开启蓝牙", JSONObject().put("enabled", enabled)))
                enableWatch = null
                UTSAndroid.offAppActivityResult()
            }
        }
    }

    fun isRadioReady(): Boolean {
        return adapter()?.isEnabled == true
    }

    fun setSweepFrameSink(callback: (String) -> Unit) {
        sweepRawWatch = callback
    }

    fun startSweep(nameKeyword: String?, includeNameless: Boolean, durationMs: Long, onNode: (String) -> Unit, onDone: (String) -> Unit) {
        sweepNodeWatch = onNode
        val appContext = UTSAndroid.getAppContext() ?: run {
            onDone(envelope(codeRuntime, "缺少应用上下文", null))
            return
        }
        if (!AsterPermissionDeck.hasAll(appContext, AsterPermissionDeck.requiredScanPermissions())) {
            onDone(envelope(codePermission, "缺少扫描权限", permissionsPayload(AsterPermissionDeck.requiredScanPermissions(), appContext)))
            return
        }
        val bleAdapter = adapter() ?: run {
            onDone(envelope(codeRuntime, "系统不支持蓝牙", null))
            return
        }
        if (!bleAdapter.isEnabled) {
            onDone(envelope(codeAdapterOff, "蓝牙未开启", null))
            return
        }
        val scanner = bleAdapter.bluetoothLeScanner ?: run {
            onDone(envelope(codeRuntime, "无法获取扫描器", null))
            return
        }

        stopSweep()
        scanCache.clear()
        val needle = nameKeyword?.trim()?.lowercase()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val filters = ArrayList<ScanFilter>()

        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handleScanResult(result, needle, includeNameless)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                results.forEach { handleScanResult(it, needle, includeNameless) }
            }

            override fun onScanFailed(errorCode: Int) {
                onDone(envelope(codeRuntime, "扫描失败", JSONObject().put("errorCode", errorCode)))
            }
        }

        scanner.startScan(filters, settings, scanCallback)
        val stopTask = Runnable {
            stopSweep()
            onDone(envelope(codeOk, "扫描完成", JSONObject().put("count", scanCache.size)))
        }
        sweepTimer = stopTask
        if (durationMs > 0) {
            mainHandler.postDelayed(stopTask, durationMs)
        }
    }

    fun stopSweep() {
        sweepTimer?.let { mainHandler.removeCallbacks(it) }
        sweepTimer = null
        adapter()?.bluetoothLeScanner?.let { scanner ->
            scanCallback?.let { scanner.stopScan(it) }
        }
        scanCallback = null
    }

    fun link(peerId: String, autoRetry: Boolean, callback: (String) -> Unit) {
        val appContext = UTSAndroid.getAppContext() ?: run {
            callback(envelope(codeRuntime, "缺少应用上下文", null))
            return
        }
        if (!AsterPermissionDeck.hasAll(appContext, AsterPermissionDeck.requiredConnectPermissions())) {
            callback(envelope(codePermission, "缺少连接权限", permissionsPayload(AsterPermissionDeck.requiredConnectPermissions(), appContext)))
            return
        }
        val bleAdapter = adapter() ?: run {
            callback(envelope(codeRuntime, "系统不支持蓝牙", null))
            return
        }
        if (!bleAdapter.isEnabled) {
            callback(envelope(codeAdapterOff, "蓝牙未开启", null))
            return
        }
        if (currentGatt != null && currentPeerIdValue == peerId) {
            callback(envelope(codeAlreadyLinked, "设备已经连接", JSONObject().put("peerId", peerId)))
            return
        }
        linkWatch = callback
        keepRetry = autoRetry
        currentPeerIdValue = peerId
        val device = bleAdapter.getRemoteDevice(peerId)
        currentDevice = device
        currentGatt?.close()
        currentGatt = null
        linkEstablished = false
        activeServiceIdValue = ""
        activeNotifyIdValue = ""
        activeWriteIdValue = ""
        mainHandler.removeCallbacks(retryTask ?: Runnable { })
        currentGatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(appContext, false, gattCallback)
        }
        mainHandler.postDelayed({
            if (!linkEstablished && currentPeerIdValue == peerId) {
                currentGatt?.disconnect()
                currentGatt?.close()
                currentGatt = null
                callback(envelope(codeConnectFail, "连接超时", JSONObject().put("peerId", peerId)))
                if (keepRetry) {
                    scheduleRetry()
                }
            }
        }, linkTimeoutMs)
    }

    fun setLinkTimeout(durationMs: Long) {
        linkTimeoutMs = durationMs.coerceAtLeast(3000)
    }

    fun setRetryPause(durationMs: Long) {
        retryGapMs = durationMs.coerceAtLeast(1000)
    }

    fun abortRetry() {
        keepRetry = false
        retryTask?.let { mainHandler.removeCallbacks(it) }
        retryTask = null
    }

    fun linked(): Boolean {
        return currentGatt != null && linkEstablished
    }

    fun currentPeerId(): String {
        return currentPeerIdValue
    }

    fun setNotifySink(callback: (String) -> Unit) {
        notifyWatch = callback
    }

    fun inspectProfile(callback: (String) -> Unit) {
        serviceWatch = callback
        val gatt = currentGatt
        if (gatt == null) {
            callback(envelope(codeConnectFail, "当前没有连接设备", null))
            return
        }
        if (!gatt.discoverServices()) {
            callback(envelope(codeServiceFail, "触发服务发现失败", null))
        }
    }

    fun chooseProfile(index: Int): String {
        if (index < 0 || index >= discoveredBundles.size) {
            return envelope(codeChannelFail, "索引超出范围", null)
        }
        selectingIndex = index
        val target = discoveredBundles[index]
        activeServiceIdValue = target.optString("serviceId", "")
        activeNotifyIdValue = target.optString("notifyId", "")
        activeWriteIdValue = target.optString("writeId", "")
        return envelope(codeOk, "通道已切换", activeBundleJson())
    }

    fun listProfilesJson(): String {
        return bundlesArray().toString()
    }

    fun activeServiceId(): String = activeServiceIdValue

    fun activeNotifyId(): String = activeNotifyIdValue

    fun activeWriteId(): String = activeWriteIdValue

    fun togglePipe(serviceId: String, characteristicId: String, enabled: Boolean, callback: (String) -> Unit) {
        subscribeWatch = callback
        val gatt = currentGatt ?: run {
            callback(envelope(codeConnectFail, "当前没有连接设备", null))
            return
        }
        val characteristic = locateCharacteristic(serviceId, characteristicId) ?: run {
            callback(envelope(codeChannelFail, "未找到特征值", null))
            return
        }
        if (!AsterBleCodec.hasNotifyPipe(characteristic)) {
            callback(envelope(codeChannelFail, "该特征值不支持通知/指示", null))
            return
        }
        if (!gatt.setCharacteristicNotification(characteristic, enabled)) {
            callback(envelope(codeRuntime, "设置通知开关失败", null))
            return
        }
        val descriptor = characteristic.getDescriptor(AsterBleCodec.cccdUuid()) ?: run {
            callback(envelope(codeRuntime, "未找到 CCCD 描述符", null))
            return
        }
        descriptor.value = if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
            if (enabled) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        } else {
            if (enabled) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        }
        gatt.writeDescriptor(descriptor)
    }

    fun pullValue(serviceId: String, characteristicId: String, callback: (String) -> Unit) {
        readWatch = callback
        val gatt = currentGatt ?: run {
            callback(envelope(codeConnectFail, "当前没有连接设备", null))
            return
        }
        val characteristic = locateCharacteristic(serviceId, characteristicId) ?: run {
            callback(envelope(codeChannelFail, "未找到特征值", null))
            return
        }
        if (!gatt.readCharacteristic(characteristic)) {
            callback(envelope(codeRuntime, "发起读取失败", null))
        }
    }

    fun pushValue(serviceId: String, characteristicId: String, payload: ByteArray, writeType: Int, split: Boolean, callback: (String) -> Unit) {
        writeWatch = callback
        val characteristic = locateCharacteristic(serviceId, characteristicId) ?: run {
            callback(envelope(codeChannelFail, "未找到写入特征值", null))
            return
        }
        if (!AsterBleCodec.hasWritePipe(characteristic)) {
            callback(envelope(codeChannelFail, "该特征值不支持写入", null))
            return
        }
        val slices = if (split) AsterBleCodec.splitPayload(payload, currentMtu) else listOf(payload)
        writeQueue.clear()
        writePlanTotal = slices.size
        slices.forEachIndexed { index, bytes ->
            writeQueue.add(
                WriteSlice(
                    serviceId = serviceId,
                    characteristicId = characteristicId,
                    chunk = bytes,
                    writeType = writeType,
                    totalParts = slices.size,
                    partIndex = index + 1
                )
            )
        }
        drainWriteQueue()
    }

    fun pushHex(serviceId: String, characteristicId: String, hexPayload: String, writeType: Int, split: Boolean, callback: (String) -> Unit) {
        pushValue(serviceId, characteristicId, AsterBleCodec.hexToBytes(hexPayload), writeType, split, callback)
    }

    fun adjustMtu(size: Int, callback: (String) -> Unit) {
        mtuWatch = callback
        val gatt = currentGatt ?: run {
            callback(envelope(codeConnectFail, "当前没有连接设备", null))
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            callback(envelope(codeRuntime, "当前系统不支持 MTU 调整", null))
            return
        }
        if (!gatt.requestMtu(size)) {
            callback(envelope(codeRuntime, "发起 MTU 请求失败", null))
        }
    }

    fun inspectRssi(callback: (String) -> Unit) {
        rssiWatch = callback
        val gatt = currentGatt ?: run {
            callback(envelope(codeConnectFail, "当前没有连接设备", null))
            return
        }
        if (!gatt.readRemoteRssi()) {
            callback(envelope(codeRuntime, "发起 RSSI 请求失败", null))
        }
    }

    fun severLink() {
        abortRetry()
        currentGatt?.disconnect()
        currentGatt?.close()
        currentGatt = null
        currentPeerIdValue = ""
        currentDevice = null
        linkEstablished = false
        activeServiceIdValue = ""
        activeNotifyIdValue = ""
        activeWriteIdValue = ""
        writing = false
        writePlanTotal = 0
        writeQueue.clear()
    }

    fun hasPermission(permissionName: String): Boolean {
        val appContext = UTSAndroid.getAppContext() ?: return false
        return AsterPermissionDeck.hasPermission(appContext, permissionName)
    }

    fun requiredScanPermissionsJson(): String {
        return JSONArray(AsterPermissionDeck.requiredScanPermissions().toList()).toString()
    }

    fun requiredConnectPermissionsJson(): String {
        return JSONArray(AsterPermissionDeck.requiredConnectPermissions().toList()).toString()
    }

    fun openBluetoothPanel() {
        val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        UTSAndroid.getAppContext()?.startActivity(intent)
    }

    fun bytesToHexText(bytes: ByteArray): String {
        return AsterBleCodec.toCompactHex(bytes) ?: ""
    }

    fun textToHexSeed(text: String, charset: String): String {
        return AsterBleCodec.textToHex(text, charset)
    }

    fun hexSeedToText(hexPayload: String, charset: String): String {
        return AsterBleCodec.hexToText(hexPayload, charset)
    }

    private fun emitNotifyPacket(characteristic: BluetoothGattCharacteristic, value: ByteArray?, detail: String) {
        val payload = dataPayload(characteristic, value)
        notifyWatch?.invoke(envelope(codeOk, detail, payload))
    }

    private fun dataPayload(characteristic: BluetoothGattCharacteristic, value: ByteArray?): JSONObject {
        val payload = JSONObject()
        payload.put("serviceId", characteristic.service.uuid.toString())
        payload.put("characteristicId", characteristic.uuid.toString())
        payload.put("bytes", AsterBleCodec.bytesToNumbers(value))
        payload.put("hex", AsterBleCodec.toCompactHex(value))
        payload.put("part", JSONObject.NULL)
        return payload
    }

    private fun rebuildBundles(services: List<BluetoothGattService>) {
        discoveredBundles.clear()
        services.forEach { service ->
            val notifyChar = service.characteristics.firstOrNull { AsterBleCodec.hasNotifyPipe(it) }
            val writeChar = service.characteristics.firstOrNull { AsterBleCodec.hasWritePipe(it) }
            if (notifyChar != null && writeChar != null) {
                discoveredBundles.add(AsterBleCodec.channelBundleToJson(service.uuid.toString(), writeChar.uuid.toString(), notifyChar.uuid.toString()))
            }
        }
        if (discoveredBundles.isNotEmpty()) {
            if (selectingIndex < 0 || selectingIndex >= discoveredBundles.size) {
                selectingIndex = 0
            }
            val target = discoveredBundles[selectingIndex]
            activeServiceIdValue = target.optString("serviceId", "")
            activeNotifyIdValue = target.optString("notifyId", "")
            activeWriteIdValue = target.optString("writeId", "")
        }
    }

    private fun locateCharacteristic(serviceId: String, characteristicId: String): BluetoothGattCharacteristic? {
        val gatt = currentGatt ?: return null
        val service = gatt.getService(UUID.fromString(serviceId)) ?: return null
        return service.getCharacteristic(UUID.fromString(characteristicId))
    }

    private fun handleScanResult(result: ScanResult, needle: String?, includeNameless: Boolean) {
        val json = AsterBleCodec.scanResultToJson(result)
        val address = json.optJSONObject("peer")?.optString("address") ?: return
        val alias = json.optJSONObject("peer")?.optString("name") ?: ""
        if (!includeNameless && alias.isBlank()) {
            return
        }
        if (!needle.isNullOrBlank()) {
            val advName = json.optJSONObject("advertiseFrame")?.optString("deviceName") ?: ""
            if (!alias.lowercase().contains(needle) && !advName.lowercase().contains(needle)) {
                return
            }
        }
        if (scanCache.putIfAbsent(address, json) == null) {
            sweepNodeWatch?.invoke(envelope(codeOk, "扫描到设备", json))
        }
        val raw = JSONObject()
        raw.put("peerId", address)
        raw.put("alias", if (alias.isBlank()) JSONObject.NULL else alias)
        raw.put("rssi", result.rssi)
        raw.put("packetHex", json.optJSONObject("advertiseFrame")?.optString("bytes"))
        raw.put("vendorHex", json.optJSONObject("advertiseFrame")?.optString("manufacturerSpecificData"))
        sweepRawWatch?.invoke(envelope(codeOk, "广播帧", raw))
    }

    private fun envelope(code: Int, detail: String, payload: JSONObject?): String {
        val root = JSONObject()
        root.put("code", code)
        root.put("detail", detail)
        root.put("payload", payload ?: JSONObject.NULL)
        return root.toString()
    }

    private fun permissionsPayload(permissions: Array<String>, context: Context): JSONObject {
        val root = JSONObject()
        val list = JSONArray()
        permissions.forEach {
            val item = JSONObject()
            item.put("name", it)
            item.put("granted", AsterPermissionDeck.hasPermission(context, it))
            list.put(item)
        }
        root.put("items", list)
        return root
    }

    private fun adapter(): BluetoothAdapter? {
        val context = UTSAndroid.getAppContext() ?: return null
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        return manager.adapter
    }

    private fun ensureSwitchReceiver() {
        if (switchReceiver != null) {
            return
        }
        val context = UTSAndroid.getAppContext() ?: return
        switchReceiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
                    val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.STATE_OFF)
                    val payload = JSONObject()
                    payload.put("enabled", state == BluetoothAdapter.STATE_ON)
                    payload.put("state", state)
                    adapterWatch?.invoke(envelope(codeOk, "蓝牙开关状态变化", payload))
                }
            }
        }
        context.registerReceiver(switchReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
    }

    private fun scheduleRetry() {
        val peer = currentPeerIdValue
        val callback = linkWatch ?: return
        if (peer.isBlank()) {
            return
        }
        retryTask?.let { mainHandler.removeCallbacks(it) }
        retryTask = Runnable {
            if (keepRetry && currentGatt == null) {
                link(peer, true, callback)
            }
        }
        mainHandler.postDelayed(retryTask!!, retryGapMs)
    }

    private fun activeBundleJson(): JSONObject {
        val root = JSONObject()
        root.put("serviceId", activeServiceIdValue)
        root.put("notifyId", activeNotifyIdValue)
        root.put("writeId", activeWriteIdValue)
        return root
    }

    private fun bundlesArray(): JSONArray {
        val array = JSONArray()
        discoveredBundles.forEach { array.put(it) }
        return array
    }

    private fun drainWriteQueue() {
        if (writing) {
            return
        }
        val gatt = currentGatt ?: run {
            writeQueue.clear()
            return
        }
        val next = writeQueue.pollFirst() ?: run {
            val payload = JSONObject()
            payload.put("serviceId", activeServiceIdValue)
            payload.put("characteristicId", activeWriteIdValue)
            payload.put("chunkCount", writePlanTotal)
            writeWatch?.invoke(envelope(codeOk, "写入完成", payload))
            writePlanTotal = 0
            return
        }
        val characteristic = locateCharacteristic(next.serviceId, next.characteristicId) ?: run {
            writeQueue.clear()
            writeWatch?.invoke(envelope(codeChannelFail, "未找到写入特征值", null))
            return
        }
        characteristic.writeType = next.writeType
        characteristic.value = next.chunk
        writing = true
        if (!gatt.writeCharacteristic(characteristic)) {
            writing = false
            writePlanTotal = 0
            writeQueue.clear()
            writeWatch?.invoke(envelope(codeRuntime, "发起写入失败", null))
            return
        }
        val payload = JSONObject()
        payload.put("serviceId", next.serviceId)
        payload.put("characteristicId", next.characteristicId)
        payload.put("bytes", AsterBleCodec.bytesToNumbers(next.chunk))
        payload.put("hex", AsterBleCodec.toCompactHex(next.chunk))
        payload.put("part", next.partIndex)
        payload.put("totalParts", next.totalParts)
        writeWatch?.invoke(envelope(codeOk, "分片已发送", payload))
    }
}
