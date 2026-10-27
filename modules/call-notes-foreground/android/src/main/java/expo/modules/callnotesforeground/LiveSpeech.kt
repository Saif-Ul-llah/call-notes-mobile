package expo.modules.callnotesforeground

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Android's speech recognizer in offline mode (the engine behind Google voice typing),
 * fed with our own 16 kHz PCM through a pipe: the app keeps recording the WAV itself and
 * the recognizer never opens the microphone. Android 13+. Two ways to run it:
 *  - segmented: one session for the whole call, a segment result at every pause;
 *  - classic (voice-typing style): one sentence per session. Some recognizers only work
 *    this way (a Redmi's heard speech in segmented mode but never answered). The next
 *    session starts with the audio fed since the previous sentence ended, so nothing said
 *    in between is lost.
 *
 * All recognizer calls happen on the main thread; PCM is written on a background thread.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
class LiveSpeech(
  private val context: Context,
  private val emit: (event: String, body: Map<String, Any?>) -> Unit,
) {
  private var recognizer: SpeechRecognizer? = null
  // set on the main thread, read by feed() on the JS thread
  @Volatile private var sink: ParcelFileDescriptor.AutoCloseOutputStream? = null
  /** read end handed to the recognizer; the intent is parcelled only once the service is bound */
  private var source: ParcelFileDescriptor? = null
  private val writer = Executors.newSingleThreadExecutor()
  private val backlog = AtomicInteger(0)
  // audio fed recently (all sessions), to replay into the next classic session
  private val recent = ArrayDeque<Pair<Long, ByteArray>>()
  private var fedTotal = 0L
  /** fed position where the last sentence ended (classic sessions resume from here) */
  @Volatile private var sentenceEndAt = 0L
  /** bytes the recognizer accepted this session (diagnostics) */
  private val written = java.util.concurrent.atomic.AtomicLong(0)
  val bytesWritten: Long
    get() = written.get()
  private var session = 0

  /**
   * The dedicated on-device recognizer when the phone registers one (Pixels, many recent
   * phones); otherwise the default recognition service (Google's, on most phones), which
   * runs offline with EXTRA_PREFER_OFFLINE once the language pack is installed.
   */
  private fun create(mode: String = "auto"): SpeechRecognizer? {
    val onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    val hasDefault = SpeechRecognizer.isRecognitionAvailable(context)
    return when {
      mode != "default" && onDevice -> SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
      mode != "on-device" && hasDefault -> SpeechRecognizer.createSpeechRecognizer(context)
      else -> null
    }
  }

  private val kind: String
    get() = if (SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) "on-device" else "default"

  /** Which offline languages exist / are installed. Calls back on the main thread. */
  fun checkSupport(locale: String, done: (Map<String, Any?>) -> Unit) {
    val probe = create()
    if (probe == null) {
      done(mapOf("onDevice" to false))
      return
    }
    probe.checkRecognitionSupport(
      intent(locale, null),
      context.mainExecutor,
      object : RecognitionSupportCallback {
        override fun onSupportResult(support: RecognitionSupport) {
          probe.destroy()
          done(
            mapOf(
              "onDevice" to true,
              "kind" to kind,
              "hasDefault" to SpeechRecognizer.isRecognitionAvailable(context),
              "installed" to support.installedOnDeviceLanguages,
              "pending" to support.pendingOnDeviceLanguages,
              "supported" to support.supportedOnDeviceLanguages,
            ),
          )
        }

        override fun onError(error: Int) {
          probe.destroy()
          done(mapOf("onDevice" to true, "kind" to kind, "error" to error))
        }
      },
    )
  }

  /** Ask the recognizer to download a language pack (shows a system prompt on Android 13). */
  fun download(locale: String) {
    val r = create() ?: return
    r.triggerModelDownload(intent(locale, null))
    // the request is sent once the service binds: release the recognizer a bit later
    android.os.Handler(context.mainLooper).postDelayed({ r.destroy() }, 10_000)
  }

  /**
   * Starts a new session and returns its id; events carry the id so stale ones can be ignored.
   * `mode`: "on-device" (dedicated offline recognizer) or "default" (default service, offline preferred).
   */
  fun start(locale: String, mode: String, segmented: Boolean, resume: Boolean): Int {
    cancel()
    val id = ++session
    val pipe = ParcelFileDescriptor.createPipe()
    val out = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
    sink = out
    written.set(0)
    if (resume) replaySince(out, sentenceEndAt - REPLAY_OVERLAP_BYTES)
    val r = create(mode) ?: throw IllegalStateException("no $mode speech recognizer on this phone")
    r.setRecognitionListener(Listener(id))
    recognizer = r
    source = pipe[0]
    r.startListening(intent(locale, pipe[0], segmented))
    return id
  }

  /** Queue PCM16 mono 16 kHz for the recognizer. Never blocks the JS thread. */
  fun feed(bytes: ByteArray) {
    synchronized(recent) {
      recent.addLast(fedTotal to bytes)
      fedTotal += bytes.size
      while (recent.size > 1 && fedTotal - recent.first().first > REPLAY_MAX_BYTES) recent.removeFirst()
    }
    val out = sink ?: return
    // ~30 s of audio waiting means the recognizer stopped reading: drop instead of growing forever
    if (backlog.get() > 300) return
    backlog.incrementAndGet()
    writer.execute {
      try {
        out.write(bytes)
        written.addAndGet(bytes.size.toLong())
      } catch (_: IOException) {
        // pipe closed: the session ended; the JS side restarts it
      } finally {
        backlog.decrementAndGet()
      }
    }
  }

  /** Write the fed audio from position `from` on into a new session's pipe. */
  private fun replaySince(out: ParcelFileDescriptor.AutoCloseOutputStream, from: Long) {
    val chunks = synchronized(recent) {
      recent.filter { it.first + it.second.size > from }.map { (at, b) -> if (at >= from) b else b.copyOfRange((from - at).toInt(), b.size) }
    }
    if (chunks.isEmpty()) return
    backlog.addAndGet(chunks.size)
    writer.execute {
      for (b in chunks) {
        try {
          out.write(b)
          written.addAndGet(b.size.toLong())
        } catch (_: IOException) {
        } finally {
          backlog.decrementAndGet()
        }
      }
    }
  }

  /** End of audio: the recognizer finishes the last segment, then ends the session. */
  fun stop() {
    val out = sink ?: return
    sink = null
    writer.execute {
      try {
        out.close()
      } catch (_: IOException) {
      }
    }
  }

  /** Drop the session immediately (no more results). */
  fun cancel() {
    stop()
    recognizer?.let {
      try {
        it.cancel()
        it.destroy()
      } catch (_: Throwable) {
        // framework bug: unbindService can throw when the service already died
      }
    }
    recognizer = null
    try {
      source?.close()
    } catch (_: IOException) {
    }
    source = null
  }

  private fun intent(locale: String, audio: ParcelFileDescriptor?, segmented: Boolean = true): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      if (audio != null) {
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audio)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000)
        // segmented: keep going until our audio ends, one result per pause
        if (segmented) putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
      }
    }

  private inner class Listener(private val id: Int) : RecognitionListener {
    private fun text(b: Bundle?): String = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    override fun onPartialResults(partialResults: Bundle?) {
      val t = text(partialResults)
      if (t.isNotEmpty()) emit("onSpeechPartial", mapOf("session" to id, "text" to t))
    }

    override fun onSegmentResults(segmentResults: Bundle) {
      emit("onSpeechSegment", mapOf("session" to id, "text" to text(segmentResults)))
    }

    // only reached when the service ignored the segmented-session extra
    override fun onResults(results: Bundle?) {
      emit("onSpeechSegment", mapOf("session" to id, "text" to text(results)))
      emit("onSpeechEnd", mapOf("session" to id))
    }

    override fun onEndOfSegmentedSession() {
      emit("onSpeechEnd", mapOf("session" to id))
    }

    override fun onError(error: Int) {
      // nothing recognized (e.g. silence): the next session keeps only a short lead-in
      sentenceEndAt = maxOf(sentenceEndAt, synchronized(recent) { fedTotal } - 32000L)
      emit("onSpeechError", mapOf("session" to id, "code" to error, "message" to errorName(error)))
    }

    override fun onReadyForSpeech(params: Bundle?) {
      emit("onSpeechReady", mapOf("session" to id))
    }

    // the rest only feed the diagnostic log, so a silent recognizer shows how far it got
    private var rmsSeen = false

    private fun debug(what: String) = emit("onSpeechDebug", mapOf("session" to id, "message" to what))

    override fun onBeginningOfSpeech() = debug("beginning of speech")
    override fun onRmsChanged(rmsdB: Float) {
      if (!rmsSeen) {
        rmsSeen = true
        debug("hearing audio (rms $rmsdB dB)")
      }
    }
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {
      // a classic session's next one starts here (what it hadn't read yet is replayed)
      sentenceEndAt = synchronized(recent) { fedTotal }
      debug("end of speech")
    }
    override fun onEvent(eventType: Int, params: Bundle?) = debug("event $eventType")
  }

  companion object {
    /** 30 s of 16 kHz PCM16 kept for replay */
    const val REPLAY_MAX_BYTES = 30 * 32000L
    /** the recognizer may not have read the last moments before it saw the sentence end */
    const val REPLAY_OVERLAP_BYTES = 300 * 32L

    fun errorName(code: Int): String =
      when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        SpeechRecognizer.ERROR_CLIENT -> "client"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permissions"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        SpeechRecognizer.ERROR_NO_MATCH -> "no-match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "service"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech-timeout"
        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "too-many-requests"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "language-not-supported"
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "language-not-downloaded"
        SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "cannot-check-support"
        else -> "error-$code"
      }
  }
}
