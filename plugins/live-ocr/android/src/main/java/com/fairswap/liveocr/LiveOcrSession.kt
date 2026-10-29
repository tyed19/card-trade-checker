package com.fairswap.liveocr

/**
 * Single-session state shared by [LiveOcrPlugin] (bridge side) and
 * [LiveOcrActivity] (camera-screen side). Everything here is touched
 * on the main thread only, except the @Volatile stable reads, which
 * the activity refreshes from each analyzed frame before forwarding it.
 *
 * Lifecycle contract (matches the web integration):
 * - Fresh shots arrive with stage == null and all locked flags false:
 *   nothing banked, nothing pulsing.
 * - Continuation shots arrive with a real stage ('number' | 'tilt' |
 *   'straight', from lib/progress.js) and locked flags from server
 *   progress; the stage segment pulses, locked segments start filled.
 * - capture() tears the session down WITHOUT emitting `closed`
 *   (the capture result itself ends the session for JS).
 * - The native X / back button emits `closed` and then finishes.
 * - stopCamera() tears down silently (JS already knows it stopped).
 * - Backgrounding pauses CameraX in the activity (analysis stops);
 *   the session itself survives a foreground return via rebind.
 */
object LiveOcrSession {

    interface Listener {
        fun onFrame(data: OcrFrameData)
        fun onSnapRequest()
        fun onClosed()
    }

    data class CaptureResult(
        val base64: String,
        val name: String?,
        val number: String?,
        val script: String?,
    )

    var listener: Listener? = null

    /** Null = fresh shot: nothing banked, nothing pulsing. */
    var stage: String? = null
    var lockedPicture: Boolean = false
    var lockedName: Boolean = false
    var lockedNumber: Boolean = false

    @Volatile var stableName: String? = null
    @Volatile var stableNumber: String? = null
    @Volatile var stableScript: String? = null

    var activity: LiveOcrActivity? = null
    var active: Boolean = false
        private set

    private var closedEmitted: Boolean = false
    private var captureCallback: ((Result<CaptureResult>) -> Unit)? = null
    var captureInFlight: Boolean = false
        private set

    fun begin(
        stage: String?,
        lockedPicture: Boolean,
        lockedName: Boolean,
        lockedNumber: Boolean,
        listener: Listener,
    ) {
        this.stage = stage
        this.lockedPicture = lockedPicture
        this.lockedName = lockedName
        this.lockedNumber = lockedNumber
        this.listener = listener
        stableName = null
        stableNumber = null
        stableScript = null
        closedEmitted = false
        captureCallback = null
        captureInFlight = false
        active = true
    }

    /** A session with no live activity is stale (e.g. process death): reusable. */
    fun resetIfStale() {
        if (active && activity == null && !captureInFlight) {
            reset()
        }
    }

    fun reset() {
        active = false
        listener = null
        stage = null
        lockedPicture = false
        lockedName = false
        lockedNumber = false
        stableName = null
        stableNumber = null
        stableScript = null
        closedEmitted = false
        captureCallback = null
        captureInFlight = false
        activity = null
    }

    /** Called on the main thread for every analyzed frame. */
    fun emitFrame(data: OcrFrameData) {
        if (!active) return
        stableName = data.stableName
        stableNumber = data.stableNumber
        stableScript = data.stableScript
        listener?.onFrame(data)
    }

    fun emitSnapRequest() {
        if (active) listener?.onSnapRequest()
    }

    /** X / back: exactly one `closed` event, then the activity finishes. */
    fun emitClosed() {
        if (!active || closedEmitted) return
        closedEmitted = true
        listener?.onClosed()
    }

    /**
     * JS capture(): asks the live activity to take the still. Returns
     * false when there is no session/activity or a capture is already
     * in flight (the caller rejects instead of queueing).
     */
    fun requestCapture(callback: (Result<CaptureResult>) -> Unit): Boolean {
        if (!active || captureInFlight) return false
        val act = activity ?: return false
        captureInFlight = true
        captureCallback = callback
        act.performCapture()
        return true
    }

    /** Called on the main thread by the activity with the still (or error). */
    fun deliverCapture(result: Result<CaptureResult>) {
        captureInFlight = false
        val cb = captureCallback
        captureCallback = null
        cb?.invoke(result)
    }

    /** Silent teardown (stopCamera / after capture): no `closed` event. */
    fun endSilently() {
        val act = activity
        activity = null
        val wasActive = active
        active = false
        listener = null
        captureCallback = null
        captureInFlight = false
        if (wasActive) act?.finishSilently()
    }

    fun detachActivity(act: LiveOcrActivity) {
        if (activity === act) activity = null
    }
}
