package expo.modules.callnotesforeground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service of type "microphone" that keeps the app's process (and its
 * microphone capture) alive while a transcription session runs with the screen off.
 * It does no work itself; the JS recorder owns the audio stream.
 */
class RecordingService : Service() {
  companion object {
    const val CHANNEL_ID = "call_notes_recording"
    const val NOTIFICATION_ID = 4711
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"

    fun buildNotification(context: Context, title: String, text: String): Notification {
      ensureChannel(context)
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val contentIntent = launch?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(context.applicationInfo.icon)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(contentIntent)
        .build()
    }

    fun notify(context: Context, title: String, text: String) {
      context.getSystemService(NotificationManager::class.java)
        ?.notify(NOTIFICATION_ID, buildNotification(context, title, text))
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Transcription", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while Call Notes is transcribing"
          setShowBadge(false)
        },
      )
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call Notes is transcribing"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Listening on this device"
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this, title, text), type)
    // if the system kills the process, the JS side recovers the session on next launch
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
}
