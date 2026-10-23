// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DeskKit",
    platforms: [.iOS(.v17), .macOS(.v14), .tvOS(.v17)],
    products: [
        .library(name: "DeskKit", targets: ["DeskKit"]),
    ],
    targets: [
        .target(name: "DeskKit"),
        .testTarget(name: "DeskKitTests", dependencies: ["DeskKit"]),
    ]
)
