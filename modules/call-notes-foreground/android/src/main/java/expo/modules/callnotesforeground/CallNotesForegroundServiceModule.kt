package expo.modules.callnotesforeground

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CallNotesForegroundServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CallNotesForegroundService")

    // Must be called while the app is in the foreground (Android 12+ rule) and after
    // RECORD_AUDIO is granted (Android 14+ rule for microphone services).
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
  }
}
