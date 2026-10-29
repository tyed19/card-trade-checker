import AVFoundation
import Capacitor
import UIKit

// MARK: - Bridge contract (web agent builds against these exact names)
//
// Methods (jsName "LiveOcr"):
//   isAvailable() -> { supported: Bool, reason?: "unsupported-os"|"no-camera"|"model-missing" }
//   startCamera({ stage: String, locked: { picture?: Bool, name?: Bool, number?: Bool } })
//   capture()     -> { base64: String, deviceOcr: { name: String?, number: String?, script: "latin"|"japanese"? } }
//   stopCamera()  -> void
// Events (notifyListeners):
//   ocrFrame     -> { frameId, cardBox: {x,y,w,h}? , observations: [...], stable: {name, number}, sharpness }
//   snapRequest  -> {} (native SNAP tapped; JS then calls capture())
//   closed       -> {} (native X tapped)
//
// Coordinate space for cardBox / observation boundingBox: normalized 0–1
// portrait-up preview space, origin TOP-LEFT, x right, y down. Vision's
// native origin is bottom-left; the engine flips it (see LiveOcrEngine).
// This matches the on-screen outline (LiveOcrGuide.rect), NOT raw sensor
// buffer coordinates and NOT UIKit view points. JS must not re-derive
// regions from these coordinates: `region` is already assigned natively.
// Guidance text is rendered natively on the camera screen and is NOT part
// of the ocrFrame payload; JS can infer the blocked state from
// cardBox/stable/sharpness if it needs to.
//
// Sharpness is a Laplacian variance computed to match
// lib/shotquality.js `measureShot` exactly (grayscale 0.299/0.587/0.114,
// frame scaled to ~320px wide, 4-neighbor kernel -4*center + neighbors,
// variance over interior pixels, rounded, floored at 0), so the JS bar
// SHARP_MIN (400) means the same thing on both paths. It is present
// (as a number) in every ocrFrame event; only a measurement failure
// yields null, and the JS firing check treats non-numbers as not sharp.
//
// Deviations from the task/spec, documented (not silent):
//  1. Stability "2 consecutive sampled frames" is counted PER SCRIPT
//     during Latin/Japanese alternation (see LiveOcrEngine.updateStability).
//     Strict global consecutiveness could never stabilize a Japanese read:
//     every other sample runs the Latin recognizer and yields nothing, yet
//     a stable read is what ends alternation. Interleaved other-script
//     samples neither increment nor reset a run.
//  2. The .accurate confirm pass runs on the full-resolution VIDEO frame
//     (1920x1080 session preset) restricted to the strip via Vision's
//     regionOfInterest, rather than a separately cropped UIImage. Same
//     pixels as a crop of that frame; avoids a photo-output round trip
//     per sample. The captured still (capture()) is a separate,
//     full-resolution photo-output JPEG.
//  3. isAvailable() never returns "model-missing" on iOS: Vision models
//     ship in the OS. It returns "no-camera" for a missing back camera
//     or denied/restricted camera authorization, and "unsupported-os"
//     only if the runtime is somehow below the v15 deployment floor
//     (unreachable in practice — the app cannot install below it).
//  4. capture() tears down the session and dismisses the screen itself
//     (per spec: teardown also on capture). It does NOT emit "closed";
//     JS distinguishes a captured close from an X close by the capture()
//     resolution. stopCamera() after capture() is a harmless no-op.
//  5. startCamera() resolves once the screen is presented, not on close.
//     The screen's lifetime is reported via "snapRequest"/"closed" events
//     and the capture()/stopCamera() resolutions.

@objc(LiveOcrPlugin)
public class LiveOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveOcrPlugin"
    public let jsName = "LiveOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopCamera", returnType: CAPPluginReturnPromise),
    ]

    private var engine: LiveOcrEngine?
    private var cameraVC: LiveCameraViewController?
    private var backgroundObservers: [NSObjectProtocol] = []

    deinit {
        for observer in backgroundObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - isAvailable

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 15, *) {
            // Vision is part of the OS: no downloadable model to miss.
        } else {
            call.resolve(["supported": false, "reason": "unsupported-os"])
            return
        }
        guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil else {
            call.resolve(["supported": false, "reason": "no-camera"])
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            call.resolve(["supported": false, "reason": "no-camera"])
        default:
            // .notDetermined: startCamera() requests permission then.
            call.resolve(["supported": true])
        }
    }

    // MARK: - startCamera

    @objc func startCamera(_ call: CAPPluginCall) {
        let options = call.options as? [String: Any] ?? [:]
        let stage = options["stage"] as? String
        var lockedPicture = false
        var lockedName = false
        var lockedNumber = false
        if let locked = options["locked"] as? [String: Any] {
            lockedPicture = locked["picture"] as? Bool ?? false
            lockedName = locked["name"] as? Bool ?? false
            lockedNumber = locked["number"] as? Bool ?? false
        }

        // Restart cleanly if a previous screen is still up.
        teardown(emitClosed: false)

        let present: () -> Void = { [weak self] in
            guard let self = self else { return }
            let engine = LiveOcrEngine()
            engine.delegate = self
            self.engine = engine
            let vc = LiveCameraViewController(
                engine: engine,
                stage: stage,
                locked: (picture: lockedPicture, name: lockedName, number: lockedNumber))
            vc.onSnap = { [weak self] in
                self?.notifyListeners("snapRequest", data: [:])
            }
            vc.onClose = { [weak self] in
                self?.teardown(emitClosed: true)
            }
            self.cameraVC = vc
            self.watchBackgrounding()
            guard let presenter = self.bridge?.viewController else {
                self.teardown(emitClosed: false)
                call.reject("no-presenter", "LIVEOCR_NO_PRESENTER")
                return
            }
            presenter.present(vc, animated: true) {
                engine.start { [weak self] error in
                    if let error = error {
                        self?.teardown(emitClosed: false)
                        call.reject(error, "LIVEOCR_START_FAILED")
                    } else {
                        call.resolve([:])
                    }
                }
            }
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted { present() } else { call.reject("no-camera", "LIVEOCR_NO_CAMERA") }
                }
            }
        default:
            call.reject("no-camera", "LIVEOCR_NO_CAMERA")
        }
    }

    // MARK: - capture

    @objc func capture(_ call: CAPPluginCall) {
        guard let engine = engine, engine.isActive else {
            call.reject("camera-not-started", "LIVEOCR_NOT_STARTED")
            return
        }
        let stable = engine.currentStable
        engine.captureStill { [weak self] base64 in
            guard let self = self else { return }
            guard let base64 = base64 else {
                call.reject("capture-failed", "LIVEOCR_CAPTURE_FAILED")
                return
            }
            // Explicit NSNull for absent values: a nil Optional wrapped
            // in Any does not bridge to JSON null reliably.
            let deviceOcr: [String: Any] = [
                "name": stable.name ?? NSNull(),
                "number": stable.number ?? NSNull(),
                "script": stable.script?.rawValue ?? NSNull(),
            ]
            call.resolve(["base64": base64, "deviceOcr": deviceOcr])
            // Teardown on capture (spec). No "closed" event: the capture()
            // resolution itself tells JS the screen is done.
            self.teardown(emitClosed: false)
        }
    }

    // MARK: - stopCamera

    @objc func stopCamera(_ call: CAPPluginCall) {
        teardown(emitClosed: false)
        call.resolve([:])
    }

    // MARK: - Teardown

    /// Stops all analysis and dismisses the screen. Safe to call when
    /// nothing is running (no-op). Analysis never runs while closed:
    /// the engine's session is stopped here and its sample delegate
    /// drops frames once `isActive` is false.
    private func teardown(emitClosed: Bool) {
        if emitClosed {
            notifyListeners("closed", data: [:])
        }
        for observer in backgroundObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        backgroundObservers = []
        engine?.stop()
        engine = nil
        if let vc = cameraVC, vc.presentingViewController != nil {
            vc.dismiss(animated: true)
        }
        cameraVC = nil
    }

    /// Backgrounding stops analysis and closes the screen (spec).
    private func watchBackgrounding() {
        let center = NotificationCenter.default
        let resign = center.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.teardown(emitClosed: true)
            }
        let background = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.teardown(emitClosed: true)
            }
        backgroundObservers = [resign, background]
    }
}

// MARK: - Engine delegate -> JS events + native screen

extension LiveOcrPlugin: LiveOcrEngineDelegate {
    func liveOcrEngine(_ engine: LiveOcrEngine, didAnalyze frame: LiveOcrFrame) {
        // Native screen first (outline fill + guidance line).
        cameraVC?.update(with: frame)

        var observations: [[String: Any]] = []
        for obs in frame.observations {
            observations.append([
                "text": obs.text,
                "confidence": obs.confidence.map { Double($0) } ?? NSNull(),
                "boundingBox": [
                    "x": Double(obs.box.minX),
                    "y": Double(obs.box.minY),
                    "w": Double(obs.box.width),
                    "h": Double(obs.box.height),
                ],
                "region": obs.region.rawValue,
                "script": obs.script.rawValue,
            ])
        }
        var payload: [String: Any] = [
            "frameId": frame.frameId,
            "observations": observations,
            "stable": [
                "name": frame.stableName ?? NSNull(),
                "number": frame.stableNumber ?? NSNull(),
            ],
            "sharpness": frame.sharpness ?? NSNull(),
        ]
        if let box = frame.cardBox {
            payload["cardBox"] = [
                "x": Double(box.minX),
                "y": Double(box.minY),
                "w": Double(box.width),
                "h": Double(box.height),
            ]
        } else {
            payload["cardBox"] = NSNull()
        }
        notifyListeners("ocrFrame", data: payload)
    }
}
