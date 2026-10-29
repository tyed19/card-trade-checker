import AVFoundation
import UIKit

/// The native camera screen, in the reset's single-outline language:
/// one card outline, a SNAP button, an X, and ONE guidance line that only
/// appears when blocked. Never falls back to the system camera from here.
/// Outline segments fill from live stable reads (plus pre-filled `locked`
/// pieces); a segment turns gold only on server confirmation, which this
/// screen never claims — gold is the web layer's job after capture.
final class LiveCameraViewController: UIViewController {

    var onSnap: (() -> Void)?
    var onClose: (() -> Void)?

    private let engine: LiveOcrEngine
    private var lockedName = false
    private var lockedNumber = false
    private var lockedPicture = false
    private var stage: String?

    private var previewContainer = UIView()
    private var outlineView = UIView()
    private var topSegment = UIView()
    private var bottomSegment = UIView()
    private var leftSegment = UIView()
    private var rightSegment = UIView()
    private var guidanceLabel = UILabel()
    private var snapButton = UIButton(type: .system)
    private var closeButton = UIButton(type: .system)
    private var pulseTimer: Timer?

    init(engine: LiveOcrEngine, stage: String?, locked: (picture: Bool, name: Bool, number: Bool)) {
        self.engine = engine
        self.stage = stage
        self.lockedPicture = locked.picture
        self.lockedName = locked.name
        self.lockedNumber = locked.number
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        previewContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewContainer)
        NSLayoutConstraint.activate([
            previewContainer.topAnchor.constraint(equalTo: view.topAnchor),
            previewContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            previewContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            previewContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        let previewLayer = engine.makePreviewLayer()
        previewLayer.frame = view.bounds
        previewContainer.layer.addSublayer(previewLayer)
        self.previewLayer = previewLayer

        buildControls()
        buildOutline()
        updateSegments(name: false, number: false)
        startPulse()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        layoutOutline()
    }

    private var previewLayer: AVCaptureVideoPreviewLayer?

    // MARK: Outline

    private func buildOutline() {
        outlineView.translatesAutoresizingMaskIntoConstraints = false
        outlineView.layer.borderWidth = 2
        outlineView.layer.borderColor = UIColor.white.cgColor
        outlineView.layer.cornerRadius = 14
        outlineView.backgroundColor = .clear
        view.addSubview(outlineView)

        for segment in [topSegment, bottomSegment, leftSegment, rightSegment] {
            segment.translatesAutoresizingMaskIntoConstraints = false
            segment.backgroundColor = UIColor.white.withAlphaComponent(0.25)
            segment.layer.cornerRadius = 3
            outlineView.addSubview(segment)
        }

        guidanceLabel.translatesAutoresizingMaskIntoConstraints = false
        guidanceLabel.textColor = .white
        guidanceLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
        guidanceLabel.textAlignment = .center
        guidanceLabel.numberOfLines = 2
        guidanceLabel.isHidden = true
        view.addSubview(guidanceLabel)
        NSLayoutConstraint.activate([
            guidanceLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            guidanceLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            guidanceLabel.bottomAnchor.constraint(equalTo: snapButton.topAnchor, constant: -24),
        ])
    }

    private func layoutOutline() {
        // Same geometry as LiveOcrGuide.rect, in view coordinates.
        let guide = LiveOcrGuide.rect
        let frame = CGRect(
            x: guide.minX * view.bounds.width,
            y: guide.minY * view.bounds.height,
            width: guide.width * view.bounds.width,
            height: guide.height * view.bounds.height)
        outlineView.frame = frame
        let thickness: CGFloat = 6
        topSegment.frame = CGRect(x: 0, y: -thickness / 2, width: frame.width, height: thickness)
        bottomSegment.frame = CGRect(x: 0, y: frame.height - thickness / 2, width: frame.width, height: thickness)
        leftSegment.frame = CGRect(x: -thickness / 2, y: 0, width: thickness, height: frame.height)
        rightSegment.frame = CGRect(x: frame.width - thickness / 2, y: 0, width: thickness, height: frame.height)
    }

    private func buildControls() {
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("✕", for: .normal)
        closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 22, weight: .bold)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        snapButton.translatesAutoresizingMaskIntoConstraints = false
        snapButton.setTitle("SNAP", for: .normal)
        snapButton.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .bold)
        snapButton.setTitleColor(.black, for: .normal)
        snapButton.backgroundColor = .white
        snapButton.layer.cornerRadius = 32
        snapButton.addTarget(self, action: #selector(snapTapped), for: .touchUpInside)
        view.addSubview(snapButton)

        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            closeButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            closeButton.widthAnchor.constraint(equalToConstant: 44),
            closeButton.heightAnchor.constraint(equalToConstant: 44),
            snapButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            snapButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            snapButton.widthAnchor.constraint(equalToConstant: 120),
            snapButton.heightAnchor.constraint(equalToConstant: 64),
        ])
    }

    @objc private func snapTapped() { onSnap?() }
    @objc private func closeTapped() { onClose?() }

    // MARK: Live state

    /// Called by the plugin on every analyzed frame (main thread).
    func update(with frame: LiveOcrFrame) {
        updateSegments(name: frame.stableName != nil, number: frame.stableNumber != nil)
        if let guidance = frame.guidance, !guidance.isEmpty {
            guidanceLabel.text = guidance
            guidanceLabel.isHidden = false
        } else {
            guidanceLabel.isHidden = true
        }
    }

    private func updateSegments(name: Bool, number: Bool) {
        // Live-read fill (teal). Server-confirmed gold is never drawn here:
        // this screen only ever shows live reads + locked pre-fill.
        let filled = UIColor(red: 0.0, green: 0.84, blue: 0.63, alpha: 1.0) // mint #00D6A1
        let empty = UIColor.white.withAlphaComponent(0.25)
        topSegment.backgroundColor = (lockedName || name) ? filled : empty
        bottomSegment.backgroundColor = (lockedNumber || number) ? filled : empty
        leftSegment.backgroundColor = lockedPicture ? filled : empty
        rightSegment.backgroundColor = lockedPicture ? filled : empty
    }

    /// Pulses the segment for the missing `stage` piece. Stage strings come
    /// from the web progress state (lib/progress.js PROGRESS_STAGES):
    ///   - null (fresh shot) -> nothing pulses: nothing is banked and
    ///     nothing is missing yet. (A JS null arrives as nil here.)
    ///   - "number"   -> bottom segment (the number corner is decisive).
    ///   - "straight" -> top segment (number + picture read, name missing:
    ///     reframe straight so the title reads).
    ///   - "tilt"     -> nothing pulses: tilt is a framing/angle stage,
    ///     not a missing piece, so no single segment honestly owns it;
    ///     the guidance line covers the blocked state instead.
    /// Anything else (including legacy "name"/"picture" strings) maps
    /// defensively: "name" -> top, "picture"/"art" -> art sides.
    private func startPulse() {
        pulseTimer?.invalidate()
        let target: UIView
        let lower = (stage ?? "").lowercased()
        if lower.contains("number") {
            target = bottomSegment
        } else if lower.contains("straight") || lower.contains("name") {
            target = topSegment
        } else if lower.contains("picture") || lower.contains("art") {
            target = leftSegment
        } else {
            return
        }
        pulseTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak target] _ in
            guard let target = target else { return }
            UIView.animate(withDuration: 0.4) {
                target.alpha = target.alpha < 1 ? 1 : 0.35
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        pulseTimer?.invalidate()
        pulseTimer = nil
    }

    deinit {
        pulseTimer?.invalidate()
    }
}
