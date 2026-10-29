package com.fairswap.liveocr

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import kotlin.math.sin

/**
 * The native camera screen's single card outline, in the reset's
 * single-outline language: one outline, no zones, no dots, no percent,
 * no ring. Segments "fill" (mint edge) when live-read or server-banked:
 * top = title, sides = art (server confirmation only — art has no live
 * text), bottom = number. The stage segment pulses while it is the
 * missing piece; a null stage (fresh shot) pulses nothing.
 *
 * Stage mapping (stages come from lib/progress.js):
 * - 'number'   -> bottom segment (the collector-number corner)
 * - 'straight' -> top segment (reframe straight so the title reads)
 * - 'tilt'     -> no pulse (framing/angle stage, not a missing piece;
 *                   the guidance line covers the blocked state — matches iOS)
 * - null / anything else -> no pulse
 */
class LiveOcrOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    enum class Segment { NONE, TITLE, ART, NUMBER }

    private var stageSegment: Segment = Segment.NONE
    private var lockedPicture: Boolean = false
    private var lockedName: Boolean = false
    private var lockedNumber: Boolean = false
    private var liveName: Boolean = false
    private var liveNumber: Boolean = false

    private val guideRect = RectF()

    private val scrimPaint = Paint().apply {
        color = Color.parseColor("#80000000")
        style = Paint.Style.FILL
    }
    private val outlinePaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = dp(3f)
        isAntiAlias = true
    }
    private val filledPaint = Paint().apply {
        color = Color.parseColor("#00D6A1")
        style = Paint.Style.STROKE
        strokeWidth = dp(7f)
        strokeCap = Paint.Cap.ROUND
        isAntiAlias = true
    }
    private val pulsePaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = dp(7f)
        strokeCap = Paint.Cap.ROUND
        isAntiAlias = true
    }

    private fun dp(value: Float): Float = value * resources.displayMetrics.density

    fun setSessionState(
        stage: String?,
        lockedPicture: Boolean,
        lockedName: Boolean,
        lockedNumber: Boolean,
    ) {
        stageSegment = when (stage) {
            "number" -> Segment.NUMBER
            "straight" -> Segment.TITLE
            else -> Segment.NONE
        }
        this.lockedPicture = lockedPicture
        this.lockedName = lockedName
        this.lockedNumber = lockedNumber
        invalidate()
    }

    fun setLiveState(liveName: Boolean, liveNumber: Boolean) {
        this.liveName = liveName
        this.liveNumber = liveNumber
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) {
            val guide = LiveOcrGuide.rectPixels(w, h)
            guideRect.set(
                guide.x.toFloat(),
                guide.y.toFloat(),
                (guide.x + guide.w).toFloat(),
                (guide.y + guide.h).toFloat(),
            )
        }
    }

    private fun segmentFilled(segment: Segment): Boolean {
        return when (segment) {
            Segment.TITLE -> lockedName || liveName
            Segment.NUMBER -> lockedNumber || liveNumber
            Segment.ART -> lockedPicture
            Segment.NONE -> true
        }
    }

    private fun drawSegment(canvas: Canvas, segment: Segment, paint: Paint) {
        when (segment) {
            Segment.TITLE -> canvas.drawLine(
                guideRect.left, guideRect.top, guideRect.right, guideRect.top, paint,
            )
            Segment.NUMBER -> canvas.drawLine(
                guideRect.left, guideRect.bottom, guideRect.right, guideRect.bottom, paint,
            )
            Segment.ART -> {
                canvas.drawLine(
                    guideRect.left, guideRect.top, guideRect.left, guideRect.bottom, paint,
                )
                canvas.drawLine(
                    guideRect.right, guideRect.top, guideRect.right, guideRect.bottom, paint,
                )
            }
            Segment.NONE -> Unit
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (guideRect.isEmpty) return
        val w = width.toFloat()
        val h = height.toFloat()
        // Dim everything outside the guide.
        canvas.drawRect(0f, 0f, w, guideRect.top, scrimPaint)
        canvas.drawRect(0f, guideRect.bottom, w, h, scrimPaint)
        canvas.drawRect(0f, guideRect.top, guideRect.left, guideRect.bottom, scrimPaint)
        canvas.drawRect(guideRect.right, guideRect.top, w, guideRect.bottom, scrimPaint)
        // The single outline.
        canvas.drawRoundRect(guideRect, dp(16f), dp(16f), outlinePaint)
        // Filled segments (live-read or banked).
        if (lockedName || liveName) drawSegment(canvas, Segment.TITLE, filledPaint)
        if (lockedNumber || liveNumber) drawSegment(canvas, Segment.NUMBER, filledPaint)
        if (lockedPicture) drawSegment(canvas, Segment.ART, filledPaint)
        // Pulsing stage segment — only while it is still missing.
        if (stageSegment != Segment.NONE && !segmentFilled(stageSegment)) {
            val pulse = 0.55 + 0.45 * sin(SystemClock.uptimeMillis() / 300.0)
            pulsePaint.alpha = (pulse * 255).toInt().coerceIn(0, 255)
            drawSegment(canvas, stageSegment, pulsePaint)
            postInvalidateOnAnimation()
        }
    }
}
