package com.fairswap.liveocr

import android.graphics.ImageFormat
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.ArrayDeque
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sqrt

/**
 * Live-frame analyzer for the FairSwap native camera screen.
 *
 * - Runs at most one analysis per ~200ms; if the previous analysis has
 *   not returned, the tick is DROPPED, never queued (no stale backlog).
 * - ML Kit Text Recognition v2, bundled models: Latin first, then
 *   alternating Latin/Japanese after 3 consecutive sampled frames with
 *   no stable Latin read, then stuck with the script that first yields
 *   a stable read for the session.
 * - ML Kit exposes no per-element confidence, so frame stability IS the
 *   confidence proxy (spec D5): confidence is reported as null and a
 *   string counts as READ only after 2 consecutive sampled frames.
 * - All ML Kit callbacks run on [analysisExecutor], so all tracker state
 *   lives on that single thread. [onFrame] is therefore also invoked on
 *   that thread; the activity must hop to main before touching views or
 *   calling Capacitor's notifyListeners.
 *
 * NOTE on coordinates: ML Kit text boxes are reported in the upright
 * (rotation-applied) image space, so they are normalized by the upright
 * dimensions (width/height swapped at 90°/270°). The contour-detected
 * card box starts in sensor orientation (Y plane) and is rotated into
 * the same upright space. If a real phone ever shows boxes rotated or
 * mirrored against the preview, this mapping is the first suspect —
 * verify on device (CI cannot run a camera).
 */
class LiveOcrAnalyzer(
    private val analysisExecutor: Executor,
    private val onFrame: (OcrFrameData) -> Unit,
) : ImageAnalysis.Analyzer {

    companion object {
        private const val TAG = "LiveOcr"
        private const val SAMPLE_INTERVAL_MS = 200L
        /**
         * Sharpness/box-detection sample width, in pixels. This
         * replicates lib/shotquality.js measureShot exactly (per the
         * iOS calibration correction): frame scaled to ~320px wide,
         * grayscale, 4-neighbor Laplacian, variance over interior
         * pixels only, rounded, floored at 0, compared against
         * SHARP_MIN=400. Laplacian variance is scale-dependent —
         * an 8-neighbor or full-resolution variant runs several-fold
         * higher for the same scene and would let blurry frames pass
         * the 400 bar — so the width here is load-bearing, not
         * cosmetic. (Caveat, see build report: the WebView preview's
         * own sampleFrame uses 160px wide, so preview-path values
         * read lower than this 320-scale value for the same scene;
         * 320 is the scale measureShot's thresholds were calibrated
         * at, and it is the scale iOS uses, so both native platforms
         * now agree.)
         */
        private const val SAMPLE_WIDTH = 320
        private const val STABLE_AGE_FOR_NUMBER_GUIDANCE = 4
    }

    private enum class Script { LATIN, JAPANESE }

    private enum class ScriptMode { LATIN_ONLY, ALTERNATING, STUCK_LATIN, STUCK_JAPANESE }

    private var latinRecognizer: TextRecognizer? = null
    private var japaneseRecognizer: TextRecognizer? = null

    private val busy = AtomicBoolean(false)
    @Volatile private var closed = false

    private var lastSampleMs: Long = 0L
    private var frameIdCounter: Int = 0
    private var sampleIndex: Int = 0

    private var scriptMode = ScriptMode.LATIN_ONLY
    private var latinMissStreak: Int = 0
    private var alternateJapaneseNext: Boolean = true
    private var lastStableScript: String? = null

    private val titleTracker = RegionTracker()
    private val numberTracker = RegionTracker()

    private fun recognizerFor(script: Script): TextRecognizer {
        return when (script) {
            Script.LATIN -> latinRecognizer ?: TextRecognition.getClient(
                TextRecognizerOptions.DEFAULT_OPTIONS,
            ).also { latinRecognizer = it }
            Script.JAPANESE -> japaneseRecognizer ?: TextRecognition.getClient(
                JapaneseTextRecognizerOptions.Builder().build(),
            ).also { japaneseRecognizer = it }
        }
    }

    override fun analyze(imageProxy: ImageProxy) {
        if (closed) {
            imageProxy.close()
            return
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastSampleMs < SAMPLE_INTERVAL_MS) {
            imageProxy.close()
            return
        }
        if (!busy.compareAndSet(false, true)) {
            // Previous analysis still running: DROP this tick, never queue.
            imageProxy.close()
            return
        }
        lastSampleMs = now

        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            busy.set(false)
            imageProxy.close()
            return
        }
        val rotation = imageProxy.imageInfo.rotationDegrees
        val uprightW = if (rotation == 90 || rotation == 270) imageProxy.height else imageProxy.width
        val uprightH = if (rotation == 90 || rotation == 270) imageProxy.width else imageProxy.height

        // Downscaled grayscale work (box detection + sharpness). Only for
        // YUV frames; anything else skips the gray pass but still OCRs.
        var cardBox: NormalizedBox? = null
        var graySharpness: Double? = null
        if (imageProxy.format == ImageFormat.YUV_420_888) {
            val gray = downscaleGray(imageProxy, mediaImage)
            if (gray != null) {
                graySharpness = laplacianVariance(gray.pixels, gray.width, gray.height)
                val sensorBox = detectCardBox(gray.pixels, gray.width, gray.height)
                if (sensorBox != null) {
                    cardBox = clampBox(rotateBoxToUpright(sensorBox, rotation))
                }
            }
        }

        // Null only on measurement failure (gray pass unavailable).
        // JS treats a non-number as not-sharp, so a null frame can
        // never fire — it fails closed, and the type stays honest.
        val sharpness: Double? = graySharpness

        val script = scriptForSample()
        val recognizer = try {
            recognizerFor(script)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to create $script recognizer", e)
            busy.set(false)
            imageProxy.close()
            return
        }
        val inputImage = try {
            InputImage.fromMediaImage(mediaImage, rotation)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to build InputImage", e)
            emitFrame(
                cardBox = cardBox,
                sharpness = sharpness,
                observations = emptyList(),
                titlePick = null,
                numberPick = null,
                scriptUsed = script,
            )
            busy.set(false)
            imageProxy.close()
            return
        }

        recognizer.process(inputImage)
            .addOnSuccessListener(analysisExecutor) { result ->
                if (closed) return@addOnSuccessListener
                val guideBox = cardBox ?: LiveOcrGuide.rectNormalized(uprightW, uprightH)
                val observations = ArrayList<OcrObservation>()
                for (block in result.textBlocks) {
                    for (line in block.lines) {
                        val rect = line.boundingBox ?: continue
                        val text = line.text
                        if (text.isBlank()) continue
                        val box = NormalizedBox(
                            x = rect.left.toDouble() / uprightW,
                            y = rect.top.toDouble() / uprightH,
                            w = rect.width().toDouble() / uprightW,
                            h = rect.height().toDouble() / uprightH,
                        )
                        val region = LiveOcrGuide.regionFor(box.centerX, box.centerY, guideBox)
                        observations.add(
                            OcrObservation(
                                text = text,
                                box = clampBox(box),
                                region = region,
                                script = script.name.lowercase(),
                            ),
                        )
                    }
                }
                val titlePick = observations
                    .filter { it.region == "title" }
                    .maxWithOrNull(compareBy<OcrObservation> { it.box.h }.thenBy { -it.box.y })
                val numberPick = observations
                    .filter { it.region == "number" && it.text.any { c -> c.isDigit() } }
                    .sortedWith(
                        compareByDescending<OcrObservation> { it.text.contains('/') }
                            .thenBy { it.box.x },
                    )
                    .firstOrNull()
                emitFrame(
                    cardBox = cardBox,
                    sharpness = sharpness,
                    observations = observations,
                    titlePick = titlePick,
                    numberPick = numberPick,
                    scriptUsed = script,
                )
            }
            .addOnFailureListener(analysisExecutor) { e ->
                Log.w(TAG, "ML Kit recognition failed", e)
                if (!closed) {
                    emitFrame(
                        cardBox = cardBox,
                        sharpness = sharpness,
                        observations = emptyList(),
                        titlePick = null,
                        numberPick = null,
                        scriptUsed = script,
                    )
                }
            }
            .addOnCompleteListener(analysisExecutor) {
                busy.set(false)
                imageProxy.close()
            }
    }

    /** Script chosen for the current sample under the alternation state machine. */
    private fun scriptForSample(): Script {
        return when (scriptMode) {
            ScriptMode.LATIN_ONLY -> Script.LATIN
            ScriptMode.ALTERNATING -> {
                val s = if (alternateJapaneseNext) Script.JAPANESE else Script.LATIN
                alternateJapaneseNext = !alternateJapaneseNext
                s
            }
            ScriptMode.STUCK_LATIN -> Script.LATIN
            ScriptMode.STUCK_JAPANESE -> Script.JAPANESE
        }
    }

    /**
     * Advances stability/script state and emits one frame. Called on the
     * analysis thread from both success and failure paths.
     */
    private fun emitFrame(
        cardBox: NormalizedBox?,
        sharpness: Double?,
        observations: List<OcrObservation>,
        titlePick: OcrObservation?,
        numberPick: OcrObservation?,
        scriptUsed: Script,
    ) {
        sampleIndex += 1
        val sample = sampleIndex
        frameIdCounter += 1

        titleTracker.update(
            titlePick?.let { LiveOcrNormalize.title(it.text) },
            titlePick?.text,
            sample,
        )
        numberTracker.update(
            numberPick?.let { LiveOcrNormalize.number(it.text) },
            numberPick?.text,
            sample,
        )
        val stableName = titleTracker.stableRaw
        // Reported RAW (e.g. '025/162'), not punctuation-stripped:
        // the web parseDeviceNumber extracts num + total from the
        // slash form, and stripping would lose the total. The
        // normalized form is used for stability comparison only.
        val stableNumber = numberTracker.stableRaw
        val stableExists = stableName != null || stableNumber != null
        if (stableExists) {
            lastStableScript = scriptUsed.name.lowercase()
        }

        when (scriptMode) {
            ScriptMode.LATIN_ONLY -> {
                if (stableExists) {
                    scriptMode = ScriptMode.STUCK_LATIN
                } else {
                    latinMissStreak += 1
                    if (latinMissStreak >= 3) {
                        // Latin struck out 3 samples running: start
                        // alternating, Japanese first (it just missed).
                        scriptMode = ScriptMode.ALTERNATING
                        alternateJapaneseNext = true
                    }
                }
            }
            ScriptMode.ALTERNATING -> {
                if (stableExists) {
                    scriptMode = if (scriptUsed == Script.LATIN) {
                        ScriptMode.STUCK_LATIN
                    } else {
                        ScriptMode.STUCK_JAPANESE
                    }
                }
            }
            ScriptMode.STUCK_LATIN, ScriptMode.STUCK_JAPANESE -> {
                // Stick with the winning script for the session.
            }
        }

        val guidance = when {
            cardBox == null -> "move closer"
            stableName != null && stableNumber == null &&
                titleTracker.stableSinceSample >= 0 &&
                sample - titleTracker.stableSinceSample >= STABLE_AGE_FOR_NUMBER_GUIDANCE ->
                "number not readable yet — tilt a little"
            else -> null
        }

        onFrame(
            OcrFrameData(
                frameId = frameIdCounter,
                cardBox = cardBox,
                observations = observations,
                stableName = stableName,
                stableNumber = stableNumber,
                stableScript = if (stableExists) lastStableScript else null,
                sharpness = sharpness,
                guidance = guidance,
            ),
        )
    }

    /** Stops analysis permanently and releases both recognizers. */
    fun close() {
        closed = true
        try {
            latinRecognizer?.close()
        } catch (ignored: Exception) {
        }
        try {
            japaneseRecognizer?.close()
        } catch (ignored: Exception) {
        }
        latinRecognizer = null
        japaneseRecognizer = null
    }

    // ---- Downscaled grayscale + sharpness + card-box detection ----

    private class GrayFrame(val pixels: IntArray, val width: Int, val height: Int)

    /**
     * Grayscale for measureShot parity: the Y plane of a YUV frame is
     * the camera's luma channel (BT.601 Y = 0.299R + 0.587G + 0.114B,
     * the exact measureShot weights, up to studio-swing scaling).
     * Deliberately NOT converted YUV -> RGB -> weighted gray per
     * frame: that round-trip goes through JPEG, whose block artifacts
     * would ADD high-frequency energy and inflate variance vs the
     * clean measureShot value. The Y plane is the closest artifact-free
     * equivalent of measureShot's weighted grayscale.
     */
    private fun downscaleGray(imageProxy: ImageProxy, mediaImage: android.media.Image): GrayFrame? {
        return try {
            val yPlane = mediaImage.planes[0]
            val srcW = imageProxy.width
            val srcH = imageProxy.height
            val rowStride = yPlane.rowStride
            val pixelStride = yPlane.pixelStride
            val buffer = yPlane.buffer
            val stride = max(1, ceil(srcW.toDouble() / SAMPLE_WIDTH).toInt())
            val dw = (srcW + stride - 1) / stride
            val dh = (srcH + stride - 1) / stride
            val pixels = IntArray(dw * dh)
            // Box-average each stride x stride source block (like the
            // web canvas drawImage downscale) instead of sampling one
            // pixel per block: stride sampling aliases high-frequency
            // detail and would inflate Laplacian variance vs
            // measureShot for the same scene.
            for (dy in 0 until dh) {
                val y0 = dy * stride
                val y1 = min(y0 + stride, srcH)
                for (dx in 0 until dw) {
                    val x0 = dx * stride
                    val x1 = min(x0 + stride, srcW)
                    var sum = 0L
                    var count = 0L
                    for (sy in y0 until y1) {
                        val rowBase = sy * rowStride
                        for (sx in x0 until x1) {
                            sum += buffer.get(rowBase + sx * pixelStride).toInt() and 0xFF
                            count += 1
                        }
                    }
                    pixels[dy * dw + dx] = if (count > 0) (sum / count).toInt() else 0
                }
            }
            GrayFrame(pixels, dw, dh)
        } catch (e: Exception) {
            Log.w(TAG, "Grayscale downscale failed", e)
            null
        }
    }

    /** Laplacian variance (raw value; JS compares it against its own bar). */
    private fun laplacianVariance(pixels: IntArray, w: Int, h: Int): Double {
        if (w < 3 || h < 3) return 0.0
        var sum = 0.0
        var sumSq = 0.0
        var n = 0L
        for (y in 1 until h - 1) {
            val row = y * w
            for (x in 1 until w - 1) {
                val c = pixels[row + x]
                // Literal measureShot kernel: -4c + neighbors.
                val r = (-4 * c + pixels[row - w + x] + pixels[row + w + x] +
                    pixels[row + x - 1] + pixels[row + x + 1]).toDouble()
                sum += r
                sumSq += r * r
                n += 1
            }
        }
        if (n == 0L) return 0.0
        val mean = sum / n
        val variance = sumSq / n - mean * mean
        // Web parity: measureShot returns Math.max(0, Math.round(...)).
        return if (variance.isFinite()) max(0.0, round(variance)) else 0.0
    }

    /**
     * Rectangle/contour detection on the downscaled frame, without OpenCV:
     * Sobel edges with an adaptive threshold, then the largest connected
     * edge component, gated on area fraction, aspect, and edge coverage.
     * Returns the box in SENSOR-orientation normalized coords (the caller
     * rotates it upright). Returns null on any miss — a box miss NEVER
     * vetoes capture; the caller reports cardBox null and keeps going.
     */
    private fun detectCardBox(pixels: IntArray, w: Int, h: Int): NormalizedBox? {
        if (w < 8 || h < 8) return null
        // Sobel magnitude.
        val mag = IntArray(w * h)
        var magSum = 0.0
        var magCount = 0L
        for (y in 1 until h - 1) {
            val row = y * w
            for (x in 1 until w - 1) {
                val gx = (pixels[row - w + x + 1] + 2 * pixels[row + x + 1] + pixels[row + w + x + 1]) -
                    (pixels[row - w + x - 1] + 2 * pixels[row + x - 1] + pixels[row + w + x - 1])
                val gy = (pixels[row + w + x - 1] + 2 * pixels[row + w + x] + pixels[row + w + x + 1]) -
                    (pixels[row - w + x - 1] + 2 * pixels[row - w + x] + pixels[row - w + x + 1])
                val m = abs(gx) + abs(gy)
                mag[row + x] = m
                magSum += m
                magCount += 1
            }
        }
        if (magCount == 0L) return null
        val mean = magSum / magCount
        var sqDiff = 0.0
        for (i in mag.indices) {
            if (mag[i] == 0) continue
            val d = mag[i] - mean
            sqDiff += d * d
        }
        val std = sqrt(sqDiff / magCount)
        val threshold = (mean + std).coerceIn(64.0, 256.0)

        // Largest connected edge component (4-connectivity, edge pixels only).
        val visited = ByteArray(w * h)
        var bestCount = 0
        var bestMinX = 0
        var bestMaxX = 0
        var bestMinY = 0
        var bestMaxY = 0
        val stack = ArrayDeque<Int>()
        for (start in mag.indices) {
            if (mag[start] <= threshold || visited[start] != 0.toByte()) continue
            var count = 0
            var minX = w
            var maxX = -1
            var minY = h
            var maxY = -1
            stack.clear()
            stack.add(start)
            visited[start] = 1
            while (stack.isNotEmpty()) {
                val idx = stack.removeFirst()
                val x = idx % w
                val y = idx / w
                count += 1
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
                if (x > 0) {
                    val n = idx - 1
                    if (mag[n] > threshold && visited[n] == 0.toByte()) {
                        visited[n] = 1; stack.add(n)
                    }
                }
                if (x < w - 1) {
                    val n = idx + 1
                    if (mag[n] > threshold && visited[n] == 0.toByte()) {
                        visited[n] = 1; stack.add(n)
                    }
                }
                if (y > 0) {
                    val n = idx - w
                    if (mag[n] > threshold && visited[n] == 0.toByte()) {
                        visited[n] = 1; stack.add(n)
                    }
                }
                if (y < h - 1) {
                    val n = idx + w
                    if (mag[n] > threshold && visited[n] == 0.toByte()) {
                        visited[n] = 1; stack.add(n)
                    }
                }
            }
            if (count > bestCount) {
                bestCount = count
                bestMinX = minX
                bestMaxX = maxX
                bestMinY = minY
                bestMaxY = maxY
            }
        }
        if (bestCount == 0) return null
        val bw = bestMaxX - bestMinX + 1
        val bh = bestMaxY - bestMinY + 1
        val areaFraction = (bw.toDouble() * bh) / (w.toDouble() * h)
        if (areaFraction < 0.04 || areaFraction > 0.95) return null
        val aspect = bw.toDouble() / bh
        if (aspect < 0.5 || aspect > 2.0) return null
        val perimeter = 2.0 * (bw + bh)
        if (bestCount < max(40.0, 0.20 * perimeter)) return null
        return NormalizedBox(
            x = bestMinX.toDouble() / w,
            y = bestMinY.toDouble() / h,
            w = bw.toDouble() / w,
            h = bh.toDouble() / h,
        )
    }
}
