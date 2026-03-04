package uts.sdk.modules.tKeepaliveApi

import android.annotation.SuppressLint
import android.app.*
import android.content.*
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.os.*
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import io.dcloud.uts.console

interface PermissionCallback {
	fun onPermissionGranted()
	fun onPermissionDenied()
}

object PermissionManager {
	const val REQUEST_IGNORE_BATTERY_CODE = 1002
	const val REQUEST_OVERLAY_CODE = 1003
	const val REQUEST_ALARM_PERMISSION = 1004

	fun requestBatteryOptimizationPermission(context: Context) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
			if (!powerManager.isIgnoringBatteryOptimizations(context.packageName)) {
				val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
				intent.data = Uri.parse("package:${context.packageName}")
				try {
					if (context is Activity) {
						context.startActivityForResult(intent, REQUEST_IGNORE_BATTERY_CODE)
					} else {
						intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
						context.startActivity(intent)
					}
				} catch (e: Exception) {
					console.log("PermissionManager", "请求忽略电池优化失败", e)
				}
			}
		}
	}

	fun requestOverlayPermission(context: Context) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
			val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
			try {
				if (context is Activity) {
					context.startActivityForResult(intent, REQUEST_OVERLAY_CODE)
				} else {
					intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
					context.startActivity(intent)
				}
			} catch (e: Exception) {
				console.log("PermissionManager", "请求悬浮窗权限失败", e)
			}
		}
	}

	fun requestExactAlarmPermission(context: Context) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
			val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
			if (!alarmManager.canScheduleExactAlarms()) {
				val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
				intent.data = Uri.parse("package:${context.packageName}")
				if (context is Activity) {
					context.startActivityForResult(intent, REQUEST_ALARM_PERMISSION)
				} else {
					intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
					context.startActivity(intent)
				}
			}
		}
	}

	fun showAutoStartGuide(context: Context) {
		val manufacturer = Build.MANUFACTURER.lowercase()

		val message =
			when {
				manufacturer.contains("huawei") || manufacturer.contains("honor") ->
					"华为/荣耀：请进入手机管家 > 启动管理 > 允许应用自启动"
				manufacturer.contains("vivo") ->
					"VIVO：请进入i管家 > 软件管理 > 自启动管理 > 允许应用自启动"
				manufacturer.contains("oppo") || manufacturer.contains("realme") || manufacturer.contains("oneplus") ->
					"OPPO/Realme/一加：请进入手机管家 > 权限隐私 > 自启动管理 > 允许应用自启动"
				manufacturer.contains("xiaomi") || manufacturer.contains("redmi") ->
					"小米/Redmi：请进入安全中心 > 应用管理 > 权限 > 自启动管理 > 允许应用自启动"
				else -> null
			}

		message?.let {
			Toast.makeText(context, it, Toast.LENGTH_LONG).show()
		}
	}
}


object KeepAliveManager {
	private const val TAG = "KeepAlive"
	internal const val CHANNEL_ID = "keep_alive_channel"
	internal const val NOTIFICATION_ID = 10001
	private const val ALARM_INTERVAL = 5 * 60 * 1000L // 5分钟

	private var wakeLock: PowerManager.WakeLock? = null
	private var isRunning = false
	private var customTask: (() -> Unit)? = null
	private var onServiceStopped: (() -> Unit)? = null // 新增回调接口

	fun start(
		context: Context,
		task: () -> Unit,
	) {
		if (isRunning) return
		isRunning = true
		customTask = task

		startForegroundService(context)
		// requestNecessaryPermissions(context)
		registerScreenReceiver(context)
		scheduleAlarm(context)

		console.log(TAG, "保活服务已启动")
	}

	fun stop(
		context: Context,
		onServiceStopped: (() -> Unit)? = null,
	) {
		if (!isRunning) return
		isRunning = false

		this.onServiceStopped = onServiceStopped // 保存回调接口

		cancelAlarm(context)
		unregisterScreenReceiver(context)
		releaseWakeLock()
		context.stopService(Intent(context, KeepAliveService::class.java))

		// 执行回调接口
		this.onServiceStopped?.invoke()

		console.log(TAG, "保活服务已停止")
	}

	fun runCustomTask() {
		customTask?.invoke()
	}

	internal fun startForegroundService(context: Context) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			context.startForegroundService(Intent(context, KeepAliveService::class.java))
		} else {
			context.startService(Intent(context, KeepAliveService::class.java))
		}
	}

	internal fun createNotification(context: Context): Notification {
		createNotificationChannel(context)

		val intent = Intent(context, KeepAliveActivity::class.java)
		val pendingIntent =
			PendingIntent.getActivity(
				context,
				0,
				intent,
				PendingIntent.FLAG_IMMUTABLE,
			)

		return NotificationCompat
			.Builder(context, CHANNEL_ID)
			.setContentTitle(context.getString(R.string.app_name))
			.setContentText(context.getString(R.string.notification_content))
			.setSmallIcon(R.drawable.ic_launcher)
			.setContentIntent(pendingIntent)
			.setPriority(NotificationCompat.PRIORITY_LOW)
			.setColor(Color.BLUE)
			.setOngoing(true)
			.build()
	}

	private fun createNotificationChannel(context: Context) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			val channel =
				NotificationChannel(
					CHANNEL_ID,
					"保活服务",
					NotificationManager.IMPORTANCE_LOW,
				).apply {
					description = "确保应用在后台持续运行"
					enableLights(false)
					enableVibration(false)
					setShowBadge(false)
				}

			val manager = context.getSystemService(NotificationManager::class.java)
			manager.createNotificationChannel(channel)
		}
	}

	private fun requestNecessaryPermissions(context: Context) {
		PermissionManager.requestBatteryOptimizationPermission(context)
		PermissionManager.requestOverlayPermission(context)
		PermissionManager.requestExactAlarmPermission(context)
		PermissionManager.showAutoStartGuide(context)
	}
	fun requestBatteryOptimizationPermission(context: Context) {
		PermissionManager.requestBatteryOptimizationPermission(context)
	}
	fun requestOverlayPermission(context: Context) {
		PermissionManager.requestOverlayPermission(context)
	}
	fun requestExactAlarmPermission(context: Context) {
		PermissionManager.requestExactAlarmPermission(context)
	}
	fun showAutoStartGuide(context: Context) {
		PermissionManager.showAutoStartGuide(context)
	}

	internal fun scheduleAlarm(context: Context) {
		val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
		val intent = Intent(context, AlarmReceiver::class.java)
		val pendingIntent =
			PendingIntent.getBroadcast(
				context,
				0,
				intent,
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
			)

		val triggerTime = SystemClock.elapsedRealtime() + ALARM_INTERVAL

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			alarmManager.setExactAndAllowWhileIdle(
				AlarmManager.ELAPSED_REALTIME_WAKEUP,
				triggerTime,
				pendingIntent,
			)
		} else {
			alarmManager.setExact(
				AlarmManager.ELAPSED_REALTIME_WAKEUP,
				triggerTime,
				pendingIntent,
			)
		}

		console.log(TAG, "定时唤醒已设置，间隔: ${ALARM_INTERVAL / 1000}秒")
	}

	private fun cancelAlarm(context: Context) {
		val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
		val intent = Intent(context, AlarmReceiver::class.java)
		val pendingIntent =
			PendingIntent.getBroadcast(
				context,
				0,
				intent,
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
			)
		alarmManager.cancel(pendingIntent)
	}

	fun acquireWakeLock(context: Context) {
		if (wakeLock?.isHeld == true) return

		val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
		wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KeepAlive::WakeLock")
		wakeLock?.acquire(10 * 60 * 1000L /*10分钟*/)
		console.log(TAG, "WakeLock已获取")
	}

	fun releaseWakeLock() {
		wakeLock?.let {
			if (it.isHeld) {
				it.release()
				console.log(TAG, "WakeLock已释放")
			}
		}
		wakeLock = null
	}

	fun startOnePixelActivity(context: Context) {
		val intent = Intent(context, OnePixelActivity::class.java)
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
		context.startActivity(intent)
	}

	fun finishOnePixelActivity(context: Context) {
		context.sendBroadcast(Intent(ACTION_FINISH_ONE_PIXEL))
	}

	const val ACTION_FINISH_ONE_PIXEL = "uts.sdk.modules.tKeepaliveApi.FINISH_ONE_PIXEL"

	object ScreenReceiver : BroadcastReceiver() {
		override fun onReceive(
			context: Context,
			intent: Intent,
		) {
			when (intent.action) {
				Intent.ACTION_SCREEN_OFF -> {
					console.log(TAG, "屏幕关闭")
					KeepAliveManager.startOnePixelActivity(context)
				}
				Intent.ACTION_SCREEN_ON -> {
					console.log(TAG, "屏幕开启")
					KeepAliveManager.finishOnePixelActivity(context)
				}
				KeepAliveManager.ACTION_FINISH_ONE_PIXEL -> {
					console.log(TAG, "关闭1像素Activity")
					val onePixelIntent = Intent(context, OnePixelActivity::class.java)
					onePixelIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
					onePixelIntent.putExtra("finish", true)
					context.startActivity(onePixelIntent)
				}
			}
		}
	}

	private var screenReceiver: BroadcastReceiver? = null

	private fun registerScreenReceiver(context: Context) {
		screenReceiver = ScreenReceiver
		val filter =
			IntentFilter().apply {
				addAction(Intent.ACTION_SCREEN_OFF)
				addAction(Intent.ACTION_SCREEN_ON)
				addAction(ACTION_FINISH_ONE_PIXEL)
			}
		context.registerReceiver(screenReceiver, filter)
	}

	private fun unregisterScreenReceiver(context: Context) {
		screenReceiver?.let {
			try {
				context.unregisterReceiver(it)
			} catch (e: IllegalArgumentException) {
				console.log(TAG, "注销屏幕接收器失败", e)
			}
		}
	}
}

class KeepAliveService : Service() {
	override fun onCreate() {
		super.onCreate()
		console.log("KeepAliveService", "服务已创建")
		KeepAliveManager.acquireWakeLock(this)
	}

	override fun onStartCommand(
		intent: Intent?,
		flags: Int,
		startId: Int,
	): Int {
		console.log("KeepAliveService", "服务已启动")
		startForeground(KeepAliveManager.NOTIFICATION_ID, KeepAliveManager.createNotification(this))
		KeepAliveManager.runCustomTask()
		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		super.onDestroy()
		console.log("KeepAliveService", "服务已销毁")
		KeepAliveManager.releaseWakeLock()
	}
}

class OnePixelActivity : Activity() {
	private var onePixelView: View? = null

	@SuppressLint("ObsoleteSdkInt")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)

		// 检查是否需要关闭1像素Activity
		if (intent.getBooleanExtra("finish", false)) {
			console.log("检查是否需要关闭1像素Activity")
			finish()
			return
		}

		// 检查悬浮窗权限
		if (!hasOverlayPermission()) {
			requestOverlayPermission()
			finish()
			return
		}

		// 创建一个新的 View
		onePixelView =
			View(this).apply {
				setBackgroundColor(Color.TRANSPARENT)
			}

		val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
		val layoutParams =
			WindowManager
				.LayoutParams(
					1,
					1,
					if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
						WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
					} else {
						WindowManager.LayoutParams.TYPE_PHONE
					},
					WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
						WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
						WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
					PixelFormat.TRANSLUCENT,
				).apply {
					gravity = Gravity.START or Gravity.TOP
					x = 0
					y = 0
				}

		// 将新的 View 添加到 WindowManager
		try {
			windowManager.addView(onePixelView, layoutParams)
			console.log("OnePixelActivity", "1像素Activity已创建")
		} catch (e: Exception) {
			console.log("OnePixelActivity", "添加视图失败", e)
			Toast.makeText(this, "添加视图失败: ${e.message}", Toast.LENGTH_LONG).show()
			finish()
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent) // 更新当前 Activity 的 Intent
		if (intent.getBooleanExtra("finish", false)) {
			console.log("检查是否需要关闭1像素Activity")
			finish()
			return
		}
	}

	override fun onDestroy() {
		super.onDestroy()
		// 移除添加到 WindowManager 的视图
		onePixelView?.let {
			val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
			if (it.parent != null) {
				windowManager.removeView(it)
			}
		}
		console.log("OnePixelActivity", "1像素Activity已销毁")
	}

	private fun hasOverlayPermission(): Boolean =
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			Settings.canDrawOverlays(this)
		} else {
			true
		}

	private fun requestOverlayPermission() {
		val intent =
			Intent(
				Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
				Uri.parse("package:$packageName"),
			)
		startActivityForResult(intent, REQUEST_OVERLAY_CODE)
	}

	override fun onActivityResult(
		requestCode: Int,
		resultCode: Int,
		data: Intent?,
	) {
		super.onActivityResult(requestCode, resultCode, data)
		if (requestCode == REQUEST_OVERLAY_CODE) {
			if (!hasOverlayPermission()) {
				Toast.makeText(this, "悬浮窗权限未开启，无法继续", Toast.LENGTH_LONG).show()
				finish()
			} else {
				recreate() // 重新启动 Activity
			}
		}
	}

	companion object {
		const val REQUEST_OVERLAY_CODE = 1001
	}
}

class AlarmReceiver : BroadcastReceiver() {
	override fun onReceive(
		context: Context,
		intent: Intent,
	) {
		console.log("AlarmReceiver", "定时唤醒触发")
		KeepAliveManager.runCustomTask()
		KeepAliveManager.scheduleAlarm(context)
	}
}

class BootReceiver : BroadcastReceiver() {
	override fun onReceive(
		context: Context,
		intent: Intent,
	) {
		if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
			intent.action == "android.intent.action.QUICKBOOT_POWERON" ||
			intent.action == "com.htc.intent.action.QUICKBOOT_POWERON"
		) {
			console.log("BootReceiver", "设备已启动，重新启动保活服务")
			KeepAliveManager.start(context) {
				console.log("KeepAlive", "保活任务执行中...")
			}
		}
	}
}
