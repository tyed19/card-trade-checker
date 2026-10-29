package com.fairswap.liveocr

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.graphics.drawable.GradientDrawable
import android.media.Image
import android.os.Bundle
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max

/**
 * The native camera screen: CameraX PreviewView + ImageAnalysis on the
 * same stream, one card outline, SNAP, X, and ONE guidance line only
 * when blocked (derived native-side from live state in
 * [LiveOcrAnalyzer]).
 *
 * - NEVER falls back to the system camera from this path. If camera
 *   binding fails or permission is denied, the screen emits `closed`
 *   and finishes; JS takes the WebView preview path.
 * - Analysis runs only while this screen is open and foregrounded:
 *   onPause unbinds CameraX (preview + analysis stop); onResume
 *   rebinds if the session is still active.
 * - Capture (JS capture()) returns a JPEG <= 2400px at q90 with
 *   correct orientation, plus the current stable reads, and tears
 *   the session down WITHOUT a `closed` event.
 * - The X / back button emits `closed` and then finishes.
 * - stopCamera() (via [LiveOcrSession.endSilently]) finishes this
 *   activity silently, with no event.
 */
class LiveOcrActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var overlayView: LiveOcrOverlayView
    private lateinit var guidanceView: TextView

    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null
    private var analyzer: LiveOcrAnalyzer? = null
    private var cameraBound: Boolean = false
    private var suppressClosed: Boolean = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            bindCamera()
        } else {
            closeFromX()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!LiveOcrSession.active) {
            // No session to serve (e.g. restored without a plugin call).
            finish()
            return
        }
        LiveOcrSession.activity = this
        buildUi()
        overlayView.setSessionState(
            LiveOcrSession.stage,
            LiveOcrSession.lockedPicture,
            LiveOcrSession.lockedName,
            LiveOcrSession.lockedNumber,
        )
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    closeFromX()
                }
            },
        )
        if (hasCameraPermission()) {
            bindCamera()
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        if (LiveOcrSession.active && hasCameraPermission()) {
            bindCamera()
        }
    }

    override fun onPause() {
        // Backgrounding stops all analysis (and the preview) immediately.
        cameraProvider?.unbindAll()
        cameraBound = false
        imageCapture = null
        analyzer?.close()
        analyzer = null
        super.onPause()
    }

    override fun onDestroy() {
        cameraProvider?.unbindAll()
        cameraBound = false
        imageCapture = null
        analyzer?.close()
        analyzer = null
        analysisExecutor.shutdown()
        cameraExecutor.shutdown()
        LiveOcrSession.detachActivity(this)
        super.onDestroy()
    }

    /** Silent finish (stopCamera / after capture): no `closed` event. */
    fun finishSilently() {
        suppressClosed = true
        finish()
    }

    /** X / back: exactly one `closed` event, then finish. */
    private fun closeFromX() {
        if (!suppressClosed) {
            LiveOcrSession.emitClosed()
        }
        finish()
    }

    private fun hasCameraPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun bindCamera() {
        if (cameraBound || isFinishing || isDestroyed) return
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            {
                try {
                    val provider = future.get()
                    cameraProvider = provider
                    val preview = Preview.Builder().build()
                    preview.surfaceProvider = previewView.surfaceProvider
                    val newAnalyzer = LiveOcrAnalyzer(analysisExecutor, ::onAnalyzerFrame)
                    analyzer = newAnalyzer
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(analysisExecutor, newAnalyzer)
                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .build()
                    imageCapture = capture
                    provider.unbindAll()
                    provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                        capture,
                    )
                    cameraBound = true
                } catch (e: Exception) {
                    // Binding failed: close so JS falls back to the
                    // WebView preview. Never the system camera.
                    closeFromX()
                }
            },
            ContextCompat.getMainExecutor(this),
        )
    }

    private fun onAnalyzerFrame(data: OcrFrameData) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            LiveOcrSession.emitFrame(data)
            overlayView.setLiveState(
                data.stableName != null,
                data.stableNumber != null,
            )
            if (data.guidance != null) {
                guidanceView.text = data.guidance
                guidanceView.visibility = View.VISIBLE
            } else {
                guidanceView.visibility = View.GONE
            }
        }
    }

    /** Called by [LiveOcrSession.requestCapture] (any thread safe). */
    fun performCapture() {
        val capture = imageCapture
        if (capture == null || !cameraBound) {
            runOnUiThread {
                LiveOcrSession.deliverCapture(
                    Result.failure(IllegalStateException("camera-not-ready")),
                )
            }
            return
        }
        capture.takePicture(
            cameraExecutor,
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        val base64 = imageProxyToBase64Jpeg(image)
                        image.close()
                        runOnUiThread {
                            LiveOcrSession.deliverCapture(
                                Result.success(
                                    LiveOcrSession.CaptureResult(
                                        base64 = base64,
                                        name = LiveOcrSession.stableName,
                                        number = LiveOcrSession.stableNumber,
                                        script = LiveOcrSession.stableScript,
                                    ),
                                ),
                            )
                        }
                    } catch (e: Exception) {
                        try {
                            image.close()
                        } catch (ignored: Exception) {
                        }
                        runOnUiThread {
                            LiveOcrSession.deliverCapture(Result.failure(e))
                        }
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    runOnUiThread {
                        LiveOcrSession.deliverCapture(Result.failure(exception))
                    }
                }
            },
        )
    }

    // ---- Still conversion: YUV -> JPEG <= 2400px, q90, upright ----

    private fun imageProxyToBase64Jpeg(image: ImageProxy): String {
        val mediaImage = image.image
            ?: throw IllegalStateException("capture had no image")
        val rotation = image.imageInfo.rotationDegrees
        val w = image.width
        val height = image.height
        val nv21 = yuv420ToNv21(mediaImage, w, height)
        val yuvImage = YuvImage(nv21, ImageFormat.NV21, w, height, null)
        val jpegFull = ByteArrayOutputStream()
        if (!yuvImage.compressToJpeg(Rect(0, 0, w, height), 100, jpegFull)) {
            throw IllegalStateException("jpeg encode failed")
        }
        val bytes = jpegFull.toByteArray()
        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalStateException("jpeg decode failed")
        if (rotation != 0) {
            val matrix = Matrix()
            matrix.postRotate(rotation.toFloat())
            val rotated = Bitmap.createBitmap(
                bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true,
            )
            if (rotated !== bitmap) bitmap.recycle()
            bitmap = rotated
        }
        val maxEdge = max(bitmap.width, bitmap.height)
        if (maxEdge > 2400) {
            val scale = 2400f / maxEdge
            val scaled = Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * scale).toInt().coerceAtLeast(1),
                (bitmap.height * scale).toInt().coerceAtLeast(1),
                true,
            )
            if (scaled !== bitmap) bitmap.recycle()
            bitmap = scaled
        }
        val jpegOut = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 90, jpegOut)
        bitmap.recycle()
        return Base64.encodeToString(jpegOut.toByteArray(), Base64.NO_WRAP)
    }

    private fun yuv420ToNv21(mediaImage: Image, w: Int, h: Int): ByteArray {
        val yPlane = mediaImage.planes[0]
        val uPlane = mediaImage.planes[1]
        val vPlane = mediaImage.planes[2]
        val nv21 = ByteArray(w * h + w * h / 2)
        val yBuffer = yPlane.buffer
        for (row in 0 until h) {
            val rowBase = row * yPlane.rowStride
            for (col in 0 until w) {
                nv21[row * w + col] =
                    yBuffer.get(rowBase + col * yPlane.pixelStride)
            }
        }
        // NV21 interleaves V then U, at chroma (half) resolution.
        val chromaH = h / 2
        val chromaW = w / 2
        var idx = w * h
        val uBuffer = uPlane.buffer
        val vBuffer = vPlane.buffer
        for (row in 0 until chromaH) {
            for (col in 0 until chromaW) {
                val v = vBuffer.get(row * vPlane.rowStride + col * vPlane.pixelStride)
                val u = uBuffer.get(row * uPlane.rowStride + col * uPlane.pixelStride)
                if (idx + 1 < nv21.size) {
                    nv21[idx] = v
                    nv21[idx + 1] = u
                    idx += 2
                }
            }
        }
        return nv21
    }

    // ---- Programmatic UI (no XML resources to merge) ----

    private fun dp(value: Float): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            resources.displayMetrics,
        ).toInt()
    }

    private fun ovalDrawable(color: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
        }
    }

    private fun buildUi() {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)

        previewView = PreviewView(this)
        previewView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        root.addView(previewView)

        overlayView = LiveOcrOverlayView(this)
        overlayView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        root.addView(overlayView)

        guidanceView = TextView(this)
        guidanceView.setTextColor(Color.WHITE)
        guidanceView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        guidanceView.setPadding(dp(14f), dp(8f), dp(14f), dp(8f))
        guidanceView.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(24f).toFloat()
            setColor(Color.parseColor("#CC000000"))
        }
        guidanceView.visibility = View.GONE
        val guidanceParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        guidanceParams.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        guidanceParams.bottomMargin = dp(176f)
        guidanceView.layoutParams = guidanceParams
        root.addView(guidanceView)

        val snapButton = Button(this)
        snapButton.text = "SNAP"
        snapButton.setTextColor(Color.WHITE)
        snapButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        snapButton.typeface = android.graphics.Typeface.DEFAULT_BOLD
        snapButton.background = ovalDrawable(Color.parseColor("#00596B"))
        snapButton.minimumWidth = 0
        snapButton.minimumHeight = 0
        val snapParams = FrameLayout.LayoutParams(dp(76f), dp(76f))
        snapParams.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        snapParams.bottomMargin = dp(56f)
        snapButton.layoutParams = snapParams
        snapButton.setOnClickListener {
            // JS decides: it calls capture() (manual SNAP bypasses
            // every firing rule, as today).
            LiveOcrSession.emitSnapRequest()
        }
        root.addView(snapButton)

        val closeButton = Button(this)
        closeButton.text = "✕"
        closeButton.setTextColor(Color.WHITE)
        closeButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        closeButton.background = ovalDrawable(Color.parseColor("#80000000"))
        closeButton.minimumWidth = 0
        closeButton.minimumHeight = 0
        val closeParams = FrameLayout.LayoutParams(dp(48f), dp(48f))
        closeParams.gravity = Gravity.TOP or Gravity.END
        closeParams.topMargin = dp(16f)
        closeParams.marginEnd = dp(16f)
        closeButton.layoutParams = closeParams
        closeButton.setOnClickListener { closeFromX() }
        root.addView(closeButton)

        setContentView(root)
    }
}
