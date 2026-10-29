// swift-tools-version: 5.9
import PackageDescription

// FairSwap live-frame on-device OCR plugin (iOS side only).
// Zero third-party dependencies: AVFoundation + Vision ship with iOS.
// NOTE on naming: the Capacitor CLI derives this package's SPM product
// name from the npm package id "@fairswap/live-ocr" (fixName -> "FairswapLiveOcr")
// and writes `.product(name: "FairswapLiveOcr", package: "FairswapLiveOcr")`
// into ios/App/CapApp-SPM/Package.swift. This package name and the library
// product name MUST stay "FairswapLiveOcr" or `npx cap sync ios` output
// will not link. The JS-facing plugin name is separate: jsName "LiveOcr".
let package = Package(
    name: "FairswapLiveOcr",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "FairswapLiveOcr",
            targets: ["LiveOcrPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "LiveOcrPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/LiveOcrPlugin")
    ]
)
