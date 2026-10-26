package expo.modules.callnotesforeground

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import kotlin.math.hypot

/**
 * Picture-in-picture style mic bubble drawn over other apps ("Display over other apps").
 * Drag to move (snaps to the nearest screen edge, position is remembered), tap to start
 * or stop transcription, long-press to open Call Notes.
 */
object FloatingBubble {
  private const val PREFS = "call_notes_bubble"
  private var view: BubbleView? = null
  private var params: WindowManager.LayoutParams? = null

  var onPress: (() -> Unit)? = null
  var onLongPress: (() -> Unit)? = null

  fun canDraw(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  val isShowing: Boolean
    get() = view != null

  @SuppressLint("ClickableViewAccessibility")
  fun show(context: Context) {
    if (view != null || !canDraw(context)) return
    val app = context.applicationContext
    val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val metrics = app.resources.displayMetrics
    val density = metrics.density
    val size = (60 * density).toInt()
    val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    val lp = WindowManager.LayoutParams(
      size,
      size,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = prefs.getInt("x", metrics.widthPixels - size - (8 * density).toInt())
      y = prefs.getInt("y", (metrics.heightPixels * 0.45f).toInt())
    }

    val bubble = BubbleView(app)
    val slop = ViewConfiguration.get(app).scaledTouchSlop
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var handled = false
    val longPress = Runnable {
      if (!handled) {
        handled = true
        onLongPress?.invoke()
      }
    }

    bubble.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.rawX
          downY = e.rawY
          startX = lp.x
          startY = lp.y
          handled = false
          v.postDelayed(longPress, 600)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX
          val dy = e.rawY - downY
          if (!handled && hypot(dx, dy) > slop) {
            handled = true // it's a drag, not a tap or long-press
            v.removeCallbacks(longPress)
          }
          if (handled) {
            lp.x = startX + dx.toInt()
            lp.y = startY + dy.toInt()
            wm.updateViewLayout(v, lp)
          }
          true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          v.removeCallbacks(longPress)
          if (!handled && e.actionMasked == MotionEvent.ACTION_UP) {
            v.performClick()
            onPress?.invoke()
          } else {
            snapToEdge(app, wm, v, lp, size)
          }
          true
        }
        else -> false
      }
    }

    wm.addView(bubble, lp)
    view = bubble
    params = lp
  }

  fun hide(context: Context) {
    val v = view ?: return
    val wm = context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    try {
      wm.removeView(v)
    } catch (_: IllegalArgumentException) {
      // already detached
    }
    view = null
    params = null
  }

  fun setRecording(recording: Boolean) {
    view?.recording = recording
  }

  private fun snapToEdge(context: Context, wm: WindowManager, v: View, lp: WindowManager.LayoutParams, size: Int) {
    val metrics = context.resources.displayMetrics
    val margin = (6 * metrics.density).toInt()
    val targetX = if (lp.x + size / 2 < metrics.widthPixels / 2) margin else metrics.widthPixels - size - margin
    lp.y = lp.y.coerceIn((24 * metrics.density).toInt(), metrics.heightPixels - size - (48 * metrics.density).toInt())
    ValueAnimator.ofInt(lp.x, targetX).apply {
      duration = 180
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        if (view === v) {
          lp.x = it.animatedValue as Int
          wm.updateViewLayout(v, lp)
        }
      }
      start()
    }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("x", targetX).putInt("y", lp.y).apply()
  }
}

/** The bubble itself: gold disc with a mic when idle, dark disc with a stop square while recording. */
class BubbleView(context: Context) : View(context) {
  private val d = context.resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  private val rect = RectF()

  var recording = false
    set(value) {
      field = value
      contentDescription = if (value) "Stop transcript" else "Start transcript"
      invalidate()
    }

  init {
    contentDescription = "Start transcript"
    elevation = 6 * d
  }

  override fun performClick(): Boolean {
    super.performClick()
    return true
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val r = width / 2f - 3 * d
    if (!recording) {
      fill.color = GOLD
      canvas.drawCircle(cx, cy, r, fill)
      line.color = GOLD_LO
      line.strokeWidth = 2 * d
      canvas.drawCircle(cx, cy, r, line)
      // mic: capsule, holder arc, stem
      fill.color = EBONY
      rect.set(cx - 4.5f * d, cy - 13 * d, cx + 4.5f * d, cy + 2 * d)
      canvas.drawRoundRect(rect, 4.5f * d, 4.5f * d, fill)
      line.color = EBONY
      line.strokeWidth = 2.2f * d
      rect.set(cx - 9 * d, cy - 11 * d, cx + 9 * d, cy + 7 * d)
      canvas.drawArc(rect, 15f, 150f, false, line)
      canvas.drawLine(cx, cy + 7 * d, cx, cy + 12 * d, line)
    } else {
      fill.color = LACQUER
      canvas.drawCircle(cx, cy, r, fill)
      line.color = GOLD
      line.strokeWidth = 3 * d
      canvas.drawCircle(cx, cy, r - 1.5f * d, line)
      fill.color = REC
      val s = 8.5f * d
      rect.set(cx - s, cy - s, cx + s, cy + s)
      canvas.drawRoundRect(rect, 3 * d, 3 * d, fill)
    }
  }

  private companion object {
    const val GOLD = 0xFFC9A24B.toInt()
    const val GOLD_LO = 0xFF9C7A2E.toInt()
    const val EBONY = 0xFF1A1610.toInt()
    const val LACQUER = 0xFF231D14.toInt()
    const val REC = 0xFFE0574F.toInt()
  }
}
