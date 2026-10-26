package expo.modules.callnotesforeground

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CallNotesForegroundServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CallNotesForegroundService")

    Events("onBubblePress")

    OnCreate {
      FloatingBubble.onPress = { sendEvent("onBubblePress", mapOf<String, Any?>()) }
      // long-press opens the app (allowed from the background while our overlay is visible)
      FloatingBubble.onLongPress = {
        appContext.reactContext?.let { ctx ->
          ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            ctx.startActivity(launch)
          }
        }
      }
    }

    // ---- foreground service

    // Must be called while the app is in the foreground (Android 12+ rule) and after
    // RECORD_AUDIO is granted (Android 14+ rule for microphone services). Calling it again
    // while the service runs just updates the notification.
    Function("start") { title: String, text: String ->
      val intent = Intent(context, RecordingService::class.java)
        .putExtra(RecordingService.EXTRA_TITLE, title)
        .putExtra(RecordingService.EXTRA_TEXT, text)
      ContextCompat.startForegroundService(context, intent)
    }

    // Updates the notification text without touching the service (safe from background).
    Function("update") { title: String, text: String ->
      RecordingService.notify(context, title, text)
    }

    Function("stop") {
      context.stopService(Intent(context, RecordingService::class.java))
    }

    // ---- floating mic bubble ("Display over other apps")

    Function("canDrawOverlays") {
      FloatingBubble.canDraw(context)
    }

    Function("openOverlaySettings") {
      val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("showBubble") {
      FloatingBubble.show(context)
      FloatingBubble.isShowing
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("hideBubble") {
      FloatingBubble.hide(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setBubbleRecording") { recording: Boolean ->
      FloatingBubble.setRecording(recording)
    }.runOnQueue(Queues.MAIN)
  }
}
