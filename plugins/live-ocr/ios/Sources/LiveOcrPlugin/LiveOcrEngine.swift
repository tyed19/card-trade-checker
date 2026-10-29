import AVFoundation
import CoreImage
import CoreVideo
import UIKit
import Vision

// MARK: - Shared geometry

/// Normalized rect of the on-screen card outline, in portrait-up preview
/// space (origin top-left, x right, y down, 0–1). The view controller draws
/// its outline from these same constants, so the guide regions the engine
/// uses when no card box is found match the outline the user sees.
/// Card aspect 63:88 ≈ 0.716; outline height 72% of the preview height.
enum LiveOcrGuide {
    static let aspect: CGFloat = 63.0 / 88.0
    static let heightFraction: CGFloat = 0.72
    static var rect: CGRect {
        let h = heightFraction
        let w = h * aspect
        return CGRect(x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h)
    }
    /// Title strip: top 18% of a card rect. Number strip: bottom 35%.
    static func titleStrip(of card: CGRect) -> CGRect {
        CGRect(x: card.minX, y: card.minY, width: card.width, height: card.height * 0.18)
    }
    static func numberStrip(of card: CGRect) -> CGRect {
        CGRect(x: card.minX, y: card.maxY - card.height * 0.35, width: card.width, height: card.height * 0.35)
    }
}

// MARK: - Types

enum LiveOcrScript: String {
    case latin
    case japanese

    var recognitionLanguages: [String] {
        switch self {
        case .latin: return ["en-US"]
        case .japanese: return ["ja-JP"]
        }
    }
}

enum LiveOcrRegion: String {
    case title
    case number
    case attack
    case other
}

struct LiveOcrObservation {
    var text: String
    var confidence: Float?
    var box: CGRect // portrait-up preview space, origin top-left, 0–1
    var region: LiveOcrRegion
    var script: LiveOcrScript
}

struct LiveOcrFrame {
    var frameId: Int
    var cardBox: CGRect? // portrait-up preview space, origin top-left, 0–1
    var observations: [LiveOcrObservation]
    var stableName: String?
    var stableNumber: String?
    var stableScript: LiveOcrScript?
    var sharpness: Double?
    var guidance: String? // nil = silent (reads progressing / complete)
}

/// Delegate receives analysis results on the main thread.
protocol LiveOcrEngineDelegate: AnyObject {
    func liveOcrEngine(_ engine: LiveOcrEngine, didAnalyze frame: LiveOcrFrame)
}

// MARK: - Engine

/// Owns the AVCaptureSession, the per-sample Vision pipeline, stability
/// tracking (spec D5), language alternation, and sharpness measurement.
/// No network use anywhere in this file. Analysis runs only while
/// `isActive` is true (screen open, app foregrounded).
final class LiveOcrEngine: NSObject {

    // Tunables from the spec (starting values, not claims).
    private static let sampleInterval: TimeInterval = 0.2 // ~200ms
    private static let downscaleMaxEdge: CGFloat = 1280
    private static let confidenceFloor: Float = 0.7
    private static let latinSamplesBeforeAlternating = 3
    private static let staleAfterSamples = 5
    private static let samplesBeforeNumberGuidance = 5

    weak var delegate: LiveOcrEngineDelegate?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "liveocr.session")
    private let analysisQueue = DispatchQueue(label: "liveocr.analysis")
    private var videoOutput: AVCaptureVideoDataOutput?
    private var photoOutput: AVCapturePhotoOutput?
    private var previewLayer: AVCaptureVideoPreviewLayer?

    private var lastSampleTime: Date = .distantPast
    private var analysisInFlight = false
    private(set) var isActive = false

    private var sampleIndex = 0
    private var frameIdCounter = 0

    // Language state machine.
    private var stuckScript: LiveOcrScript?
    private var alternating = false
    private var alternateToggle: LiveOcrScript = .latin
    private var consecutiveNoStableLatin = 0
    private var lastSampleIndexByScript: [LiveOcrScript: Int] = [:]

    // Stability tracking (spec D5). Candidates keyed by script+region+normalized key.
    private struct Candidate {
        var displayText: String
        var consecutive: Int
        var lastScriptSampleIndex: Int
    }
    private var candidates: [String: Candidate] = [:]
    private struct StableRead {
        var displayText: String
        var script: LiveOcrScript
        var lastSeenSample: Int
        var firstStableSample: Int
    }
    private var stableByRegion: [LiveOcrRegion: StableRead] = [:]

    private var ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var pendingPhotoCompletion: ((Data?) -> Void)?
    private var latestStableName: String? { stableByRegion[.title]?.displayText }
    private var latestStableNumber: String? { stableByRegion[.number]?.displayText }

    var currentStable: (name: String?, number: String?, script: LiveOcrScript?) {
        (latestStableName, latestStableNumber, currentScriptForReport)
    }

    private var currentScriptForReport: LiveOcrScript? {
        if let stuck = stuckScript { return stuck }
        return stableByRegion[.title]?.script ?? stableByRegion[.number]?.script
    }

    // MARK: Session lifecycle

    /// Starts the session. Calls completion on the main thread with an error
    /// string, or nil on success. Does not present any UI.
    func start(completion: @escaping (String?) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            guard !self.isActive else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                DispatchQueue.main.async { completion("no-camera") }
                return
            }
            do {
                try device.lockForConfiguration()
                if device.isFocusModeSupported(.continuousAutoFocus) {
                    device.focusMode = .continuousAutoFocus
                }
                if device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposureMode = .continuousAutoExposure
                }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    device.whiteBalanceMode = .continuousAutoWhiteBalance
                }
                device.unlockForConfiguration()
            } catch {
                // Non-fatal: proceed with device defaults.
            }
            self.session.beginConfiguration()
            if self.session.canSetSessionPreset(.hd1920x1080) {
                self.session.sessionPreset = .hd1920x1080
            } else if self.session.canSetSessionPreset(.hd1280x720) {
                self.session.sessionPreset = .hd1280x720
            }
            do {
                let input = try AVCaptureDeviceInput(device: device)
                if self.session.canAddInput(input) { self.session.addInput(input) }
            } catch {
                self.session.commitConfiguration()
                DispatchQueue.main.async { completion("no-camera") }
                return
            }
            let videoOutput = AVCaptureVideoDataOutput()
            // NOTE: the dictionary KEY is kCVPixelBufferPixelFormatTypeKey
            // but the VALUE constant is kCVPixelFormatType_32BGRA (no
            // "Buffer" in the value name) — the Buffer-spelled variant
            // does not exist and fails CI with "cannot find in scope".
            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: self.analysisQueue)
            if self.session.canAddOutput(videoOutput) { self.session.addOutput(videoOutput) }
            self.videoOutput = videoOutput
            let photoOutput = AVCapturePhotoOutput()
            if self.session.canAddOutput(photoOutput) { self.session.addOutput(photoOutput) }
            self.photoOutput = photoOutput
            self.session.commitConfiguration()
            self.session.startRunning()
            self.isActive = true
            DispatchQueue.main.async { completion(nil) }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self = self, self.isActive else { return }
            self.isActive = false
            self.session.stopRunning()
            self.analysisInFlight = false
            self.pendingPhotoCompletion = nil
        }
    }

    func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.connection?.videoOrientation = .portrait
        previewLayer = layer
        return layer
    }

    // MARK: Still capture

    /// Captures a full-resolution still, normalized upright, longest edge
    /// ≤ 2400px, JPEG q90, base64-encoded. Completion on the main thread.
    /// Does NOT tear down the session; the caller owns teardown.
    func captureStill(completion: @escaping (String?) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self = self, self.isActive, let photoOutput = self.photoOutput else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            self.pendingPhotoCompletion = { [weak self] data in
                guard let self = self else { return }
                let base64 = self.jpegBase64(from: data)
                DispatchQueue.main.async { completion(base64) }
            }
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            settings.flashMode = .off
            if let connection = photoOutput.connection(with: .video) {
                connection.videoOrientation = Self.photoOrientation()
            }
            photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    private static func photoOrientation() -> AVCaptureVideoOrientation {
        switch UIDevice.current.orientation {
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        case .portraitUpsideDown: return .portraitUpsideDown
        default: return .portrait
        }
    }

    private func jpegBase64(from data: Data?) -> String? {
        guard let data = data, let image = UIImage(data: data) else { return nil }
        let maxEdge: CGFloat = 2400
        let longest = max(image.size.width, image.size.height)
        let targetSize: CGSize
        if longest > maxEdge {
            let scale = maxEdge / longest
            targetSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        } else {
            targetSize = image.size
        }
        // Drawing normalizes orientation to .up, so the JPEG is upright
        // regardless of how the sensor was held.
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let upright = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        return upright.jpegData(compressionQuality: 0.9)?.base64EncodedString()
    }

    // MARK: Sampling

    private func shouldSample(now: Date) -> Bool {
        guard isActive, !analysisInFlight else { return false }
        guard now.timeIntervalSince(lastSampleTime) >= Self.sampleInterval else { return false }
        lastSampleTime = now
        analysisInFlight = true
        return true
    }

    private func scriptForNextSample() -> LiveOcrScript {
        if let stuck = stuckScript { return stuck }
        if alternating {
            let script = alternateToggle
            alternateToggle = (script == .latin) ? .japanese : .latin
            return script
        }
        return .latin
    }

    private func analyze(pixelBuffer: CVPixelBuffer) {
        sampleIndex += 1
        let thisSample = sampleIndex
        let script = scriptForNextSample()
        // Previous sample taken in THIS script (nil on the script's first
        // sample). Captured before advancing, so consecutive counting below
        // is per-script: interleaved other-script samples neither count
        // toward nor break a candidate's run. See updateStability.
        let prevScriptSample = lastSampleIndexByScript[script]
        lastSampleIndexByScript[script] = thisSample

        let fullWidth = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let fullHeight = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        let scale = min(1, Self.downscaleMaxEdge / max(fullWidth, fullHeight))

        // Downscaled frame (longest edge ≤ 1280) for box + fast text.
        let downscaled = downscale(pixelBuffer: pixelBuffer, scale: scale)
        let sharpness = measureSharpness(downscaled: downscaled)

        var cardBox: CGRect?
        var observations: [LiveOcrObservation] = []

        do {
            let rectRequest = VNDetectRectanglesRequest()
            rectRequest.minimumAspectRatio = 0.5
            rectRequest.maximumAspectRatio = 1.0
            rectRequest.minimumSize = 0.15
            rectRequest.maximumObservations = 1
            rectRequest.quadratureTolerance = 20

            let textRequest = VNRecognizeTextRequest()
            textRequest.recognitionLevel = .fast
            textRequest.recognitionLanguages = script.recognitionLanguages
            textRequest.usesLanguageCorrection = false
            textRequest.minimumTextHeight = 0.01

            let handler = VNImageRequestHandler(cvPixelBuffer: downscaled, orientation: .right, options: [:])
            try handler.perform([rectRequest, textRequest])

            if let rect = rectRequest.results?.first {
                cardBox = topLeft(rect.boundingBox)
            }
            for obs in (textRequest.results ?? []) {
                guard let candidate = obs.topCandidates(1).first else { continue }
                let box = topLeft(obs.boundingBox)
                let region = Self.region(for: box, cardBox: cardBox)
                observations.append(LiveOcrObservation(
                    text: candidate.string,
                    confidence: candidate.confidence,
                    box: box,
                    region: region,
                    script: script))
            }

            // Confirm pass: if a title/number candidate exists but is not yet
            // stable, re-read that strip with .accurate on the FULL-resolution
            // frame, restricted to the strip via regionOfInterest.
            let needsConfirm = Set(observations.filter { obs in
                (obs.region == .title || obs.region == .number)
                    && obs.confidence.map { $0 >= Self.confidenceFloor } == true
                    && stableByRegion[obs.region] == nil
            }.map { $0.region })
            for region in needsConfirm {
                let strip = (region == .title)
                    ? LiveOcrGuide.titleStrip(of: cardBox ?? LiveOcrGuide.rect)
                    : LiveOcrGuide.numberStrip(of: cardBox ?? LiveOcrGuide.rect)
                let confirmRequest = VNRecognizeTextRequest()
                confirmRequest.recognitionLevel = .accurate
                confirmRequest.recognitionLanguages = script.recognitionLanguages
                confirmRequest.usesLanguageCorrection = false
                confirmRequest.minimumTextHeight = 0.01
                confirmRequest.regionOfInterest = visionROI(fromTopLeft: strip)
                let fullHandler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right, options: [:])
                try fullHandler.perform([confirmRequest])
                for obs in (confirmRequest.results ?? []) {
                    guard let candidate = obs.topCandidates(1).first else { continue }
                    // Confirm observations belong to the strip they were read from.
                    observations.append(LiveOcrObservation(
                        text: candidate.string,
                        confidence: candidate.confidence,
                        box: strip,
                        region: region,
                        script: script))
                }
            }
        } catch {
            // A failed Vision pass yields an empty observation set for this
            // sample; stability/staleness bookkeeping below still runs so a
            // transient failure cannot freeze a stale read forever.
        }

        updateStability(with: observations, sample: thisSample, script: script, prevScriptSample: prevScriptSample)
        expireStaleReads(sample: thisSample)
        updateLanguageState(script: script)

        frameIdCounter += 1
        let frame = LiveOcrFrame(
            frameId: frameIdCounter,
            cardBox: cardBox,
            observations: observations,
            stableName: latestStableName,
            stableNumber: latestStableNumber,
            stableScript: currentScriptForReport,
            sharpness: sharpness,
            guidance: guidance(cardBox: cardBox))
        analysisInFlight = false
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.delegate?.liveOcrEngine(self, didAnalyze: frame)
        }
    }

    // MARK: Stability (spec D5)

    private func normalizedKey(for text: String, region: LiveOcrRegion) -> String {
        let collapsed = text.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if region == .number {
            // Numbers: punctuation-stripped for the equality comparison.
            return collapsed.filter { $0.isNumber || $0.isLetter }
        }
        return collapsed
    }

    private func updateStability(with observations: [LiveOcrObservation], sample: Int, script: LiveOcrScript, prevScriptSample: Int?) {
        // Only title/number observations at/above the confidence floor count.
        // (Observations below the floor are still emitted to JS raw.)
        // Consecutive = consecutive samples OF THE SAME SCRIPT. During
        // Latin/Japanese alternation this is required, not a relaxation:
        // strict global consecutiveness could never stabilize a Japanese
        // read, because every other sample runs the Latin recognizer and
        // yields nothing — yet a stable read is exactly what ends
        // alternation (updateLanguageState sticks the script). An
        // interleaved other-script sample neither increments nor resets
        // the run; only a same-script sample without the string resets it
        // (via the candidate's staleness filter + the reset branch below).
        for obs in observations where (obs.region == .title || obs.region == .number) {
            guard let confidence = obs.confidence, confidence >= Self.confidenceFloor else { continue }
            let key = "\(script.rawValue)|\(obs.region.rawValue)|\(normalizedKey(for: obs.text, region: obs.region))"
            let trimmed = obs.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if var existing = candidates[key], existing.lastScriptSampleIndex == prevScriptSample {
                existing.consecutive += 1
                existing.displayText = trimmed
                existing.lastScriptSampleIndex = sample
                candidates[key] = existing
            } else if candidates[key] != nil {
                candidates[key] = Candidate(displayText: trimmed, consecutive: 1, lastScriptSampleIndex: sample)
            } else {
                candidates[key] = Candidate(displayText: trimmed, consecutive: 1, lastScriptSampleIndex: sample)
            }
            if let candidate = candidates[key], candidate.consecutive >= 2 {
                let previous = stableByRegion[obs.region]
                stableByRegion[obs.region] = StableRead(
                    displayText: candidate.displayText,
                    script: script,
                    lastSeenSample: sample,
                    firstStableSample: previous?.firstStableSample ?? sample)
            } else if var stable = stableByRegion[obs.region], stable.script == script {
                // Already stable and re-observed: refresh text + freshness.
                if stable.displayText != obs.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    && normalizedKey(for: stable.displayText, region: obs.region) == normalizedKey(for: obs.text, region: obs.region) {
                    stable.displayText = obs.text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                stable.lastSeenSample = sample
                stableByRegion[obs.region] = stable
            }
        }
    }

    private func expireStaleReads(sample: Int) {
        for (region, stable) in stableByRegion where sample - stable.lastSeenSample > Self.staleAfterSamples {
            stableByRegion.removeValue(forKey: region)
        }
        // Candidates that missed their follow-up sample stop counting.
        candidates = candidates.filter { _, candidate in
            sample - candidate.lastScriptSampleIndex <= Self.staleAfterSamples
        }
    }

    private func updateLanguageState(script: LiveOcrScript) {
        if stableByRegion[.title] != nil || stableByRegion[.number] != nil {
            if let titleScript = stableByRegion[.title]?.script {
                stuckScript = titleScript
            } else if let numberScript = stableByRegion[.number]?.script {
                stuckScript = numberScript
            }
            alternating = false
            return
        }
        if !alternating && script == .latin {
            consecutiveNoStableLatin += 1
            if consecutiveNoStableLatin >= Self.latinSamplesBeforeAlternating {
                alternating = true
                alternateToggle = .japanese
            }
        }
    }

    private func guidance(cardBox: CGRect?) -> String? {
        let hasName = latestStableName != nil
        let hasNumber = latestStableNumber != nil
        if hasName && hasNumber { return nil }
        if hasName && !hasNumber {
            let sinceTitle = stableByRegion[.title].map { sampleIndex - $0.firstStableSample } ?? 0
            if sinceTitle >= Self.samplesBeforeNumberGuidance {
                return "number not readable yet — tilt a little"
            }
            return nil
        }
        if cardBox == nil { return "move closer" }
        return nil
    }

    // MARK: Coordinate helpers

    /// Vision boxes are origin bottom-left; the bridge contract is origin
    /// top-left. Both are normalized 0–1 in portrait-up preview space
    /// (VNImageRequestHandler orientation .right, back camera, portrait).
    private func topLeft(_ visionBox: CGRect) -> CGRect {
        CGRect(x: visionBox.minX, y: 1 - visionBox.maxY, width: visionBox.width, height: visionBox.height)
    }

    /// Convert a top-left-origin rect to Vision's regionOfInterest space
    /// (origin bottom-left, same normalized portrait-up axes).
    private func visionROI(fromTopLeft rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
    }

    private static func region(for box: CGRect, cardBox: CGRect?) -> LiveOcrRegion {
        let center = CGPoint(x: box.midX, y: box.midY)
        if let card = cardBox {
            if center.y < card.minY + card.height * 0.18 { return .title }
            if center.y > card.maxY - card.height * 0.35 { return .number }
            return .attack
        }
        let guide = LiveOcrGuide.rect
        if center.y < guide.minY + guide.height * 0.18 { return .title }
        if center.y > guide.maxY - guide.height * 0.35 { return .number }
        return .other
    }

    // MARK: Frame helpers

    private func downscale(pixelBuffer: CVPixelBuffer, scale: CGFloat) -> CVPixelBuffer {
        guard scale < 1 else { return pixelBuffer }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let scaled = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let width = Int(CGFloat(CVPixelBufferGetWidth(pixelBuffer)) * scale)
        let height = Int(CGFloat(CVPixelBufferGetHeight(pixelBuffer)) * scale)
        var output: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_32BGRA, nil, &output)
        guard status == kCVReturnSuccess, let buffer = output else { return pixelBuffer }
        ciContext.render(scaled, to: buffer)
        return buffer
    }

    /// Laplacian variance on the downscaled grayscale frame, computed to
    /// match lib/shotquality.js `measureShot` EXACTLY, so the JS bar
    /// SHARP_MIN (400) means the same thing on both paths:
    ///   - grayscale weights 0.299 / 0.587 / 0.114 (CIColorMatrix),
    ///   - frame scaled to ~320px wide (the web bar is calibrated at
    ///     that scale; Laplacian variance is resolution-dependent, so
    ///     measuring at the ≤1280 analysis size would inflate values
    ///     several-fold and let blurry frames pass the bar),
    ///   - 4-neighbor Laplacian: lap = -4*center + left + right + up + down,
    ///   - variance over interior pixels only (1px border excluded),
    ///   - rounded, floored at 0, exactly like the web implementation.
    /// A previous version used an 8-neighbor kernel at ≤1280px; that
    /// produced systematically larger values than the web gate for the
    /// same scene and was replaced for this reason (see report).
    private func measureSharpness(downscaled: CVPixelBuffer) -> Double? {
        let fullWidth = CVPixelBufferGetWidth(downscaled)
        let fullHeight = CVPixelBufferGetHeight(downscaled)
        let targetWidth = min(320, fullWidth)
        let scale = CGFloat(targetWidth) / CGFloat(fullWidth)
        let targetHeight = max(1, Int((CGFloat(fullHeight) * scale).rounded()))
        let luminance = CIVector(x: 0.299, y: 0.587, z: 0.114, w: 0)
        let grayImage = CIImage(cvPixelBuffer: downscaled)
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": luminance,
                "inputGVector": luminance,
                "inputBVector": luminance,
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            ])
        let count = targetWidth * targetHeight
        let grayPtr = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
        defer { grayPtr.deallocate() }
        ciContext.render(
            grayImage, toBitmap: grayPtr, rowBytes: targetWidth,
            bounds: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight),
            format: .R8, colorSpace: CGColorSpaceCreateDeviceGray())
        var sum: Double = 0
        var sumSq: Double = 0
        var n = 0
        for y in 1..<(targetHeight - 1) {
            for x in 1..<(targetWidth - 1) {
                let i = y * targetWidth + x
                let lap = -4 * Double(grayPtr[i])
                    + Double(grayPtr[i - 1]) + Double(grayPtr[i + 1])
                    + Double(grayPtr[i - targetWidth]) + Double(grayPtr[i + targetWidth])
                sum += lap
                sumSq += lap * lap
                n += 1
            }
        }
        guard n > 0 else { return nil }
        let mean = sum / Double(n)
        let variance = sumSq / Double(n) - mean * mean
        guard variance.isFinite else { return nil }
        return max(0, variance.rounded())
    }
}

// MARK: - Delegates

extension LiveOcrEngine: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard shouldSample(now: Date()) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            analysisInFlight = false
            return
        }
        analysisQueue.async { [weak self] in
            self?.analyze(pixelBuffer: pixelBuffer)
        }
    }
}

extension LiveOcrEngine: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let completion = pendingPhotoCompletion
        pendingPhotoCompletion = nil
        completion?(error == nil ? photo.fileDataRepresentation() : nil)
    }
}
