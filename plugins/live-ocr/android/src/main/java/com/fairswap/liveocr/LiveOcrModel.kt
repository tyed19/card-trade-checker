package com.fairswap.liveocr

import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * Normalized box in upright camera-frame coordinates (0..1 on both axes).
 * "Upright" means after applying the frame's rotationDegrees — the same
 * space ML Kit reports text boxes in (see LiveOcrAnalyzer; verify on
 * device if a phone ever shows mirrored/rotated boxes).
 */
data class NormalizedBox(
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
) {
    val centerX: Double get() = x + w / 2.0
    val centerY: Double get() = y + h / 2.0
}

data class OcrObservation(
    val text: String,
    val box: NormalizedBox,
    /** 'title' | 'number' | 'other' — assigned native-side from geometry. */
    val region: String,
    val script: String,
)

/** One analyzed frame, ready to be forwarded as an `ocrFrame` event. */
data class OcrFrameData(
    val frameId: Int,
    val cardBox: NormalizedBox?,
    val observations: List<OcrObservation>,
    /** Raw-cased latest title string for a stable read, else null. */
    val stableName: String?,
    /** Raw observed number string for a stable read (e.g. '025/162'), else null. */
    val stableNumber: String?,
    val stableScript: String?,
    /** Laplacian variance on the downscaled grayscale frame, else null. */
    val sharpness: Double?,
    /** Native-screen guidance line (native UI only; NOT part of ocrFrame). */
    val guidance: String?,
)

/** Guide geometry shared by the analyzer (frame space) and the overlay (view space). */
object LiveOcrGuide {
    /** Card aspect ratio (width / height) for a standard trading card, 63:88. */
    const val CARD_ASPECT = 63.0 / 88.0
    const val WIDTH_FRACTION = 0.86
    const val HEIGHT_FRACTION = 0.86

    /** Title strip: top ~18% of the card box. Number strip: bottom ~35%. */
    const val TITLE_STRIP_FRACTION = 0.18
    const val NUMBER_STRIP_FRACTION = 0.35

    /**
     * Centered guide rect in pixel coordinates for a frame/view of
     * [frameWidth] x [frameHeight] pixels.
     */
    fun rectPixels(frameWidth: Int, frameHeight: Int): NormalizedBox {
        var gw = WIDTH_FRACTION * frameWidth
        var gh = gw / CARD_ASPECT
        if (gh > HEIGHT_FRACTION * frameHeight) {
            gh = HEIGHT_FRACTION * frameHeight
            gw = gh * CARD_ASPECT
        }
        val gx = (frameWidth - gw) / 2.0
        val gy = (frameHeight - gh) / 2.0
        return NormalizedBox(gx, gy, gw, gh)
    }

    /** The same guide rect, normalized to 0..1 in each axis. */
    fun rectNormalized(frameWidth: Int, frameHeight: Int): NormalizedBox {
        val p = rectPixels(frameWidth, frameHeight)
        return NormalizedBox(
            p.x / frameWidth,
            p.y / frameHeight,
            p.w / frameWidth,
            p.h / frameHeight,
        )
    }

    /** Region for an element center, given a card box (or the guide when null). */
    fun regionFor(centerX: Double, centerY: Double, box: NormalizedBox): String {
        val titleTop = box.y
        val titleBottom = box.y + TITLE_STRIP_FRACTION * box.h
        val numberTop = box.y + (1.0 - NUMBER_STRIP_FRACTION) * box.h
        return when {
            centerY in titleTop..titleBottom -> "title"
            centerY >= numberTop && centerY <= box.y + box.h -> "number"
            else -> "other"
        }
    }
}

/** Normalization for stability comparison (spec D5). */
object LiveOcrNormalize {
    fun title(raw: String): String =
        raw.lowercase(Locale.ROOT).trim().replace(Regex("\\s+"), " ")

    /** Numbers: case-folded, punctuation- (and whitespace-) stripped. */
    fun number(raw: String): String =
        raw.lowercase(Locale.ROOT).filter { it.isLetterOrDigit() }
}

/**
 * Per-region stability tracker (spec D5): a string counts as READ only
 * when the same normalized string appears in the same region on
 * 2 consecutive sampled frames. A read goes stale if its region does
 * not re-observe it within 5 sampled frames. Single sightings are
 * candidates only and never fire anything.
 */
class RegionTracker {
    private var candidateNorm: String? = null
    private var candidateRaw: String? = null
    private var candidateStreak: Int = 0

    var stableNorm: String? = null
        private set
    var stableRaw: String? = null
        private set
    var stableLastSeenSample: Int = -1
        private set
    var stableSinceSample: Int = -1
        private set

    /** [observedNorm]/[observedRaw] null when the region had no usable line. */
    fun update(observedNorm: String?, observedRaw: String?, sample: Int) {
        if (observedNorm == null || observedRaw == null) {
            candidateNorm = null
            candidateRaw = null
            candidateStreak = 0
        } else {
            if (observedNorm == candidateNorm) {
                candidateStreak += 1
            } else {
                candidateNorm = observedNorm
                candidateRaw = observedRaw
                candidateStreak = 1
            }
            if (observedNorm == stableNorm) {
                // Re-observed: refreshes staleness even on a single sighting.
                stableRaw = observedRaw
                stableLastSeenSample = sample
            } else if (candidateStreak >= 2) {
                stableNorm = observedNorm
                stableRaw = observedRaw
                stableLastSeenSample = sample
                stableSinceSample = sample
            }
        }
        if (stableNorm != null && observedNorm != stableNorm &&
            sample - stableLastSeenSample > STALE_AFTER_SAMPLES
        ) {
            stableNorm = null
            stableRaw = null
            stableLastSeenSample = -1
            stableSinceSample = -1
        }
    }

    companion object {
        const val STALE_AFTER_SAMPLES = 5
    }
}

/**
 * Rotates a sensor-orientation normalized box into upright normalized
 * coordinates for a clockwise [rotationDegrees] (0/90/180/270), by
 * transforming its four corners. Used for the contour-detected card box
 * (the Y plane is in sensor orientation); ML Kit boxes are already
 * reported in the upright space.
 */
fun rotateBoxToUpright(box: NormalizedBox, rotationDegrees: Int): NormalizedBox {
    val corners = arrayOf(
        Pair(box.x, box.y),
        Pair(box.x + box.w, box.y),
        Pair(box.x, box.y + box.h),
        Pair(box.x + box.w, box.y + box.h),
    )
    val rotated = corners.map { (x, y) ->
        when ((rotationDegrees % 360 + 360) % 360) {
            90 -> Pair(1.0 - y, x)
            180 -> Pair(1.0 - x, 1.0 - y)
            270 -> Pair(y, 1.0 - x)
            else -> Pair(x, y)
        }
    }
    val minX = rotated.minOf { it.first }
    val maxX = rotated.maxOf { it.first }
    val minY = rotated.minOf { it.second }
    val maxY = rotated.maxOf { it.second }
    return NormalizedBox(
        minX.coerceIn(0.0, 1.0),
        minY.coerceIn(0.0, 1.0),
        (maxX - minX).coerceIn(0.0, 1.0),
        (maxY - minY).coerceIn(0.0, 1.0),
    )
}

/** Clamp helper used by the box detector. */
fun clampBox(box: NormalizedBox): NormalizedBox = NormalizedBox(
    x = box.x.coerceIn(0.0, 1.0),
    y = box.y.coerceIn(0.0, 1.0),
    w = max(0.0, min(box.w, 1.0 - box.x.coerceIn(0.0, 1.0))),
    h = max(0.0, min(box.h, 1.0 - box.y.coerceIn(0.0, 1.0))),
)
