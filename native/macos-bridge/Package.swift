// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "macos-bridge",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "macos-bridge",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("Vision"),
            ]
        )
    ]
)
