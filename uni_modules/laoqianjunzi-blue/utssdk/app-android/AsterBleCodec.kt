package uts.laoqianjunzi.bluecore

import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.le.ScanRecord
import android.bluetooth.le.ScanResult
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.Charset
import java.util.Locale

object AsterBleCodec {
    private val cccdUuid = java.util.UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    fun toCompactHex(bytes: ByteArray?): String? {
        if (bytes == null) {
            return null
        }
        val out = StringBuilder(bytes.size * 2)
        for (value in bytes) {
            out.append(String.format(Locale.US, "%02X", value.toInt() and 0xFF))
        }
        return out.toString()
    }

    fun hexToBytes(hexPayload: String): ByteArray {
        val clean = hexPayload.replace(" ", "").replace("\n", "").replace("\r", "")
        require(clean.length % 2 == 0) { "hex payload length must be even" }
        val out = ByteArray(clean.length / 2)
        var index = 0
        while (index < clean.length) {
            out[index / 2] = clean.substring(index, index + 2).toInt(16).toByte()
            index += 2
        }
        return out
    }

    fun bytesToNumbers(bytes: ByteArray?): JSONArray {
        val out = JSONArray()
        bytes?.forEach {
            out.put(it.toInt() and 0xFF)
        }
        return out
    }

    fun splitPayload(bytes: ByteArray, mtu: Int): List<ByteArray> {
        val safePayload = if (mtu > 3) mtu - 3 else 20
        if (bytes.size <= safePayload) {
            return listOf(bytes)
        }
        val list = ArrayList<ByteArray>()
        var cursor = 0
        while (cursor < bytes.size) {
            val end = kotlin.math.min(cursor + safePayload, bytes.size)
            list.add(bytes.copyOfRange(cursor, end))
            cursor = end
        }
        return list
    }

    fun scanResultToJson(result: ScanResult): JSONObject {
        val root = JSONObject()
        val peer = JSONObject()
        val record = JSONObject()
        val device = result.device
        val scanRecord = result.scanRecord

        peer.put("name", device?.name)
        peer.put("alias", null)
        peer.put("bondState", device?.bondState)
        peer.put("deviceKind", device?.type)
        peer.put("address", device?.address ?: "")

        record.put("deviceName", scanRecord?.deviceName)
        record.put("txPowerLevel", if (scanRecord != null) scanRecord.txPowerLevel else JSONObject.NULL)
        record.put("bytes", toCompactHex(scanRecord?.bytes))
        record.put("serviceData", flattenServiceData(scanRecord))
        record.put("serviceUuids", flattenUuids(scanRecord))
        record.put("advertiseFlags", if (scanRecord != null) scanRecord.advertiseFlags else JSONObject.NULL)
        record.put("manufacturerSpecificData", flattenManufacturer(scanRecord))
        record.put("serviceSolicitationUuids", flattenSolicitation(scanRecord))

        root.put("connectType", JSONObject.NULL)
        root.put("rssi", result.rssi)
        root.put("isLegacy", if (android.os.Build.VERSION.SDK_INT >= 26) result.isLegacy else JSONObject.NULL)
        root.put("advertisingSid", if (android.os.Build.VERSION.SDK_INT >= 26) result.advertisingSid else JSONObject.NULL)
        root.put("dataStatus", if (android.os.Build.VERSION.SDK_INT >= 26) result.dataStatus else JSONObject.NULL)
        root.put("isConnectable", if (android.os.Build.VERSION.SDK_INT >= 26) result.isConnectable else JSONObject.NULL)
        root.put("periodicAdvertisingInterval", if (android.os.Build.VERSION.SDK_INT >= 26) result.periodicAdvertisingInterval else JSONObject.NULL)
        root.put("primaryPhy", if (android.os.Build.VERSION.SDK_INT >= 26) result.primaryPhy else JSONObject.NULL)
        root.put("secondaryPhy", if (android.os.Build.VERSION.SDK_INT >= 26) result.secondaryPhy else JSONObject.NULL)
        root.put("timestampNanos", result.timestampNanos)
        root.put("advertiseFrame", record)
        root.put("peer", peer)
        return root
    }

    fun servicesToJson(services: List<BluetoothGattService>): JSONArray {
        val out = JSONArray()
        services.forEachIndexed { index, service ->
            val serviceJson = JSONObject()
            serviceJson.put("index", index)
            serviceJson.put("uuid", service.uuid.toString())
            val chars = JSONArray()
            service.characteristics.forEach { characteristic ->
                chars.put(characteristicToJson(characteristic))
            }
            serviceJson.put("characteristics", chars)
            out.put(serviceJson)
        }
        return out
    }

    fun channelBundleToJson(serviceId: String, writeId: String, notifyId: String): JSONObject {
        val root = JSONObject()
        root.put("serviceId", serviceId)
        root.put("writeId", writeId)
        root.put("notifyId", notifyId)
        return root
    }

    fun characteristicToJson(characteristic: BluetoothGattCharacteristic): JSONObject {
        val flagBits = characteristic.properties
        val flags = JSONObject()
        flags.put("canRead", flagBits and BluetoothGattCharacteristic.PROPERTY_READ != 0)
        flags.put("canWrite", flagBits and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 || flagBits and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0)
        flags.put("canNotify", flagBits and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0)
        flags.put("canIndicate", flagBits and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
        val root = JSONObject()
        root.put("uuid", characteristic.uuid.toString())
        root.put("flagBits", flagBits)
        root.put("flags", flags)
        return root
    }

    fun textToHex(text: String, charsetName: String): String {
        val charset = Charset.forName(charsetName)
        return toCompactHex(text.toByteArray(charset)) ?: ""
    }

    fun hexToText(hexPayload: String, charsetName: String): String {
        return String(hexToBytes(hexPayload), Charset.forName(charsetName))
    }

    fun hasNotifyPipe(characteristic: BluetoothGattCharacteristic): Boolean {
        val properties = characteristic.properties
        return properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 || properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
    }

    fun hasWritePipe(characteristic: BluetoothGattCharacteristic): Boolean {
        val properties = characteristic.properties
        return properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 || properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
    }

    fun cccdUuid() = cccdUuid

    private fun flattenManufacturer(scanRecord: ScanRecord?): String? {
        if (scanRecord == null) {
            return null
        }
        val builder = StringBuilder()
        for (index in 0 until scanRecord.manufacturerSpecificData.size()) {
            val key = scanRecord.manufacturerSpecificData.keyAt(index)
            val value = scanRecord.manufacturerSpecificData.valueAt(index)
            if (builder.isNotEmpty()) {
                builder.append("|")
            }
            builder.append(key)
            builder.append(":")
            builder.append(toCompactHex(value))
        }
        return if (builder.isEmpty()) null else builder.toString()
    }

    private fun flattenServiceData(scanRecord: ScanRecord?): String? {
        if (scanRecord == null) {
            return null
        }
        val builder = StringBuilder()
        scanRecord.serviceData?.forEach { entry ->
            if (builder.isNotEmpty()) {
                builder.append("|")
            }
            builder.append(entry.key)
            builder.append(":")
            builder.append(toCompactHex(entry.value))
        }
        return if (builder.isEmpty()) null else builder.toString()
    }

    private fun flattenUuids(scanRecord: ScanRecord?): String? {
        val uuids = scanRecord?.serviceUuids ?: return null
        return uuids.joinToString(",") { it.uuid.toString() }
    }

    private fun flattenSolicitation(scanRecord: ScanRecord?): String? {
        if (android.os.Build.VERSION.SDK_INT < 29) {
            return null
        }
        val uuids = scanRecord?.serviceSolicitationUuids ?: return null
        return uuids.joinToString(",") { it.uuid.toString() }
    }
}
