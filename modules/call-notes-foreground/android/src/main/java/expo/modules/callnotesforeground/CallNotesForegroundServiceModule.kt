package expo.modules.callnotesforeground

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

class CallNotesForegroundServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  // created on the main thread, used by speechFeed() on the JS thread
  @Volatile private var speech: LiveSpeech? = null

  private fun liveSpeech(): LiveSpeech? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
    return speech ?: LiveSpeech(context) { event, body -> sendEvent(event, body) }.also { speech = it }
  }

  override fun definition() = ModuleDefinition {
    Name("CallNotesForegroundService")

    Events("onBubblePress", "onSpeechReady", "onSpeechPartial", "onSpeechSegment", "onSpeechEnd", "onSpeechError", "onSpeechDebug")

    OnDestroy {
      speech?.cancel()
      speech = null
    }

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

    // ---- device capacity (how many whisper contexts can run side by side)

    Function("deviceInfo") {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
      val mem = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
      mapOf("cores" to Runtime.getRuntime().availableProcessors(), "memoryMb" to (mem.totalMem / (1024 * 1024)).toInt())
    }

    // ---- Android on-device speech recognition (Android 13+), fed with our own PCM

    AsyncFunction("speechSupport") { locale: String, promise: Promise ->
      val s = liveSpeech()
      if (s == null) promise.resolve(mapOf("onDevice" to false)) else s.checkSupport(locale) { promise.resolve(it) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("speechDownload") { locale: String ->
      liveSpeech()?.download(locale)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("speechStart") { locale: String, mode: String, segmented: Boolean, resume: Boolean ->
      liveSpeech()?.start(locale, mode, segmented, resume) ?: throw IllegalStateException("on-device speech needs Android 13 or newer")
    }.runOnQueue(Queues.MAIN)

    Function("speechBytesWritten") {
      speech?.bytesWritten ?: 0L
    }

    Function("speechFeed") { pcm: Uint8Array ->
      val bytes = ByteArray(pcm.byteLength)
      pcm.read(bytes, 0, pcm.byteLength)
      speech?.feed(bytes)
    }

    AsyncFunction("speechStop") {
      speech?.stop()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("speechCancel") {
      speech?.cancel()
    }.runOnQueue(Queues.MAIN)
  }
}
