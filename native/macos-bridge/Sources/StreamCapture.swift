import Foundation
import ScreenCaptureKit
import CoreMedia
import AppKit

/// Continuous screen capture using SCStream.
/// Keeps the latest frame as a temp PNG file on disk.
/// Replaces one-shot CGWindowListCreateImage (~200ms) with pre-captured frames (~0ms read).
class StreamCapture: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private var _running = false
    private let queue = DispatchQueue(label: "streamcapture.state")

    /// Path to the latest captured frame (PNG file)
    private var _latestFramePath: String?
    private var _latestWidth: Int = 0
    private var _latestHeight: Int = 0
    private var _latestFrameTime: Date?
    private var _frameCount: UInt64 = 0
    private var saveEveryN: Int = 1

    /// Start continuous capture for a specific window.
    func start(windowId: Int, fps: Int = 30) async throws {
        var alreadyRunning = false
        queue.sync { alreadyRunning = self._running }
        if alreadyRunning { return }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == CGWindowID(windowId) }) else {
            throw BridgeError.general("Window \(windowId) not found for stream capture")
        }

        self.saveEveryN = max(1, fps / 30)

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = window.frame.width > 0 ? Int(window.frame.width) * 2 : 2880
        config.height = window.frame.height > 0 ? Int(window.frame.height) * 2 : 1800
        config.showsCursor = false
        config.capturesAudio = false
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.queueDepth = 3

        let newStream = SCStream(filter: filter, configuration: config, delegate: nil)
        try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        try await newStream.startCapture()

        queue.sync {
            self.stream = newStream
            self._running = true
            self._frameCount = 0
        }
    }

    /// Stop the stream and clean up.
    func stop() async {
        var s: SCStream?
        var pathToClean: String?

        queue.sync {
            s = self.stream
            self._running = false
            self.stream = nil
            pathToClean = self._latestFramePath
            self._latestFramePath = nil
        }

        if let s = s {
            try? await s.stopCapture()
        }

        if let path = pathToClean {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    var isRunning: Bool {
        queue.sync { _running }
    }

    /// Get info about the latest frame.
    func getLatestInfo() -> [String: Any]? {
        queue.sync {
            guard let path = _latestFramePath, let time = _latestFrameTime else { return nil }
            return [
                "path": path,
                "width": _latestWidth,
                "height": _latestHeight,
                "ageMs": Int(Date().timeIntervalSince(time) * 1000),
                "frameCount": _frameCount,
            ]
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }

        var shouldSave = false
        queue.sync {
            guard self._running else { shouldSave = false; return }
            _frameCount += 1
            shouldSave = _frameCount % UInt64(saveEveryN) == 0
        }
        guard shouldSave else { return }

        guard let imageBuffer = sampleBuffer.imageBuffer else { return }
        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        let context = CIContext()
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)

        guard let cgImage = context.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) else { return }

        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent("stream_frame_latest.png")
        let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
        guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else { return }

        do {
            let tmpURL = tempDir.appendingPathComponent("stream_frame_tmp_\(ProcessInfo.processInfo.processIdentifier).png")
            try pngData.write(to: tmpURL)
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmpURL)

            queue.sync {
                self._latestFramePath = fileURL.path
                self._latestWidth = width
                self._latestHeight = height
                self._latestFrameTime = Date()
            }
        } catch {
            // Skip frame on write failure
        }
    }
}
