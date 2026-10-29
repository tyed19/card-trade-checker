package com.fairswap.liveocr

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject

/**
 * Capacitor bridge for FairSwap live-frame on-device OCR.
 *
 * Contract (the web agent builds against exactly these names/shapes):
 * - isAvailable() -> { supported, reason? }
 * - startCamera({ stage: string | null, locked: { picture?, name?, number? } | null })
 * - events: ocrFrame, snapRequest, closed
 * - capture() -> { base64, deviceOcr: { name, number, script } }
 * - stopCamera() -> {}
 *
 * Notes honored from the web + iOS integrations:
 * - Fresh shots send stage null (and locked null): treated as "fresh
 *   shot, nothing banked, nothing pulsing" — NOT as a stage string.
 * - ocrFrame.stable is exactly { name, number }; stable.number is the
 *   RAW observed string ('025/162'), because the web parseDeviceNumber
 *   extracts num + total from the slash form. Stability comparison
 *   still uses the normalized form (see LiveOcrAnalyzer).
 * - ocrFrame.sharpness is measureShot-exact Laplacian variance
 *   (see LiveOcrAnalyzer); null only on measurement failure.
 * - capture() tears the session down WITHOUT emitting `closed`.
 * - The system camera is never launched from this path.
 * - No network use in the OCR path; no permission beyond CAMERA
 *   (requested by the activity at runtime).
 */
@CapacitorPlugin(name = "LiveOcr")
class LiveOcrPlugin : Plugin() {

    private val sessionListener = object : LiveOcrSession.Listener {
        override fun onFrame(data: OcrFrameData) {
            notifyListeners("ocrFrame", ocrFrameToJS(data))
        }

        override fun onSnapRequest() {
            notifyListeners("snapRequest", JSObject())
        }

        override fun onClosed() {
            notifyListeners("closed", JSObject())
        }
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 24) {
            val result = JSObject()
            result.put("supported", false)
            result.put("reason", "unsupported-os")
            call.resolve(result)
            return
        }
        val pm = context.packageManager
        if (pm == null || !pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            val result = JSObject()
            result.put("supported", false)
            result.put("reason", "no-camera")
            call.resolve(result)
            return
        }
        // Bundled models are linked at build time, so a missing model
        // is effectively unreachable unless the AAR is stripped. The
        // honest probe available is client construction: if even that
        // throws, report model-missing rather than claiming support.
        // (Client construction does not itself load the model; a
        // runtime recognition failure still surfaces as empty frames,
        // never as a crash or a verdict.)
        try {
            val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
            val japanese = TextRecognition.getClient(
                JapaneseTextRecognizerOptions.Builder().build(),
            )
            try {
                latin.close()
            } catch (ignored: Exception) {
            }
            try {
                japanese.close()
            } catch (ignored: Exception) {
            }
        } catch (e: Exception) {
            val result = JSObject()
            result.put("supported", false)
            result.put("reason", "model-missing")
            call.resolve(result)
            return
        }
        val result = JSObject()
        result.put("supported", true)
        call.resolve(result)
    }

    @PluginMethod
    fun startCamera(call: PluginCall) {
        LiveOcrSession.resetIfStale()
        if (LiveOcrSession.active) {
            call.reject("already-running")
            return
        }
        // stage is null on fresh shots (NOT a string): nothing banked,
        // nothing pulsing. locked may also be null: all flags false.
        val stage: String? = call.getString("stage")
        val locked = call.getObject("locked")
        val lockedPicture = locked?.optBoolean("picture", false) ?: false
        val lockedName = locked?.optBoolean("name", false) ?: false
        val lockedNumber = locked?.optBoolean("number", false) ?: false

        LiveOcrSession.begin(
            stage = stage,
            lockedPicture = lockedPicture,
            lockedName = lockedName,
            lockedNumber = lockedNumber,
            listener = sessionListener,
        )

        val hostActivity = activity
        if (hostActivity == null) {
            LiveOcrSession.reset()
            call.reject("no-activity")
            return
        }
        hostActivity.runOnUiThread {
            try {
                val intent = Intent(hostActivity, LiveOcrActivity::class.java)
                hostActivity.startActivity(intent)
                val result = JSObject()
                result.put("presented", true)
                call.resolve(result)
            } catch (e: Exception) {
                LiveOcrSession.reset()
                call.reject("present-failed", e)
            }
        }
    }

    @PluginMethod
    fun capture(call: PluginCall) {
        if (!LiveOcrSession.active) {
            call.reject("not-running")
            return
        }
        val started = LiveOcrSession.requestCapture { result ->
            // Delivered on the main thread by the activity.
            result.onSuccess { captured ->
                val deviceOcr = JSObject()
                if (captured.name != null) {
                    deviceOcr.put("name", captured.name)
                } else {
                    deviceOcr.put("name", JSONObject.NULL)
                }
                if (captured.number != null) {
                    deviceOcr.put("number", captured.number)
                } else {
                    deviceOcr.put("number", JSONObject.NULL)
                }
                if (captured.script != null) {
                    deviceOcr.put("script", captured.script)
                } else {
                    deviceOcr.put("script", JSONObject.NULL)
                }
                val out = JSObject()
                out.put("base64", captured.base64)
                out.put("deviceOcr", deviceOcr)
                call.resolve(out)
                // Capture ends the session WITHOUT a `closed` event.
                LiveOcrSession.endSilently()
            }.onFailure { e ->
                // Session stays alive so JS can retry or stopCamera.
                call.reject("capture-failed", e)
            }
        }
        if (!started) {
            if (LiveOcrSession.captureInFlight) {
                call.reject("capture-in-flight")
            } else {
                call.reject("not-running")
            }
        }
    }

    @PluginMethod
    fun stopCamera(call: PluginCall) {
        // Silent teardown: no `closed` event (JS already knows).
        LiveOcrSession.endSilently()
        call.resolve()
    }

    protected override fun handleOnDestroy() {
        LiveOcrSession.endSilently()
        super.handleOnDestroy()
    }

    private fun boxToJS(box: NormalizedBox): JSObject {
        val out = JSObject()
        out.put("x", box.x)
        out.put("y", box.y)
        out.put("w", box.w)
        out.put("h", box.h)
        return out
    }

    private fun ocrFrameToJS(data: OcrFrameData): JSObject {
        val frame = JSObject()
        frame.put("frameId", data.frameId)
        if (data.cardBox != null) {
            frame.put("cardBox", boxToJS(data.cardBox))
        } else {
            frame.put("cardBox", JSONObject.NULL)
        }
        val observations = JSArray()
        for (obs in data.observations) {
            val item = JSObject()
            item.put("text", obs.text)
            // ML Kit exposes no per-element confidence; frame
            // stability is the confidence proxy (spec D5).
            item.put("confidence", JSONObject.NULL)
            item.put("boundingBox", boxToJS(obs.box))
            item.put("region", obs.region)
            item.put("script", obs.script)
            observations.put(item)
        }
        frame.put("observations", observations)
        val stable = JSObject()
        if (data.stableName != null) {
            stable.put("name", data.stableName)
        } else {
            stable.put("name", JSONObject.NULL)
        }
        if (data.stableNumber != null) {
            stable.put("number", data.stableNumber)
        } else {
            stable.put("number", JSONObject.NULL)
        }
        frame.put("stable", stable)
        if (data.sharpness != null) {
            frame.put("sharpness", data.sharpness)
        } else {
            frame.put("sharpness", JSONObject.NULL)
        }
        return frame
    }
}
