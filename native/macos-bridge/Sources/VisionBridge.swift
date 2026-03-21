import Foundation
import Vision
import AppKit
import CoreML

class VisionBridge {

    // MARK: - YOLO Element Detection

    private var yoloModel: VNCoreMLModel?
    private let yoloClassNames = ["button", "field", "heading", "iframe", "image", "label", "link", "text"]

    /// Load the YOLO CoreML model for UI element detection.
    /// Called lazily on first detectElements call.
    private func ensureYoloModel() throws {
        if yoloModel != nil { return }

        // Look for model relative to the binary or via known paths
        let execPath = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let execDir = execPath.deletingLastPathComponent()
        let possiblePaths = [
            execDir.appendingPathComponent("../Resources/ui-elements.mlpackage"),
            execDir.appendingPathComponent("../../Resources/ui-elements.mlpackage"),
            execDir.appendingPathComponent("Resources/ui-elements.mlpackage"),
            URL(fileURLWithPath: "/tmp/vins-yolo/web-ui-8cls.mlpackage"), // Development fallback
        ]

        for modelURL in possiblePaths {
            if FileManager.default.fileExists(atPath: modelURL.path) {
                let config = MLModelConfiguration()
                config.computeUnits = .all // Use ANE when available
                let coreMLModel = try MLModel(contentsOf: modelURL, configuration: config)
                yoloModel = try VNCoreMLModel(for: coreMLModel)
                return
            }
        }

        throw BridgeError.general("YOLO model not found")
    }

    /// Detect UI elements in an image using the YOLO CoreML model.
    /// Returns bounding boxes with class labels and confidence scores.
    func detectElements(imagePath: String, confidence: Double = 0.25) throws -> [[String: Any]] {
        try ensureYoloModel()
        guard let model = yoloModel else {
            throw BridgeError.general("YOLO model not loaded")
        }

        let url = URL(fileURLWithPath: imagePath)
        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw BridgeError.general("Failed to load image at \(imagePath)")
        }

        let imageWidth = CGFloat(cgImage.width)
        let imageHeight = CGFloat(cgImage.height)

        let request = VNCoreMLRequest(model: model)
        request.imageCropAndScaleOption = .scaleFit

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        guard let observations = request.results as? [VNRecognizedObjectObservation] else {
            return []
        }

        var results: [[String: Any]] = []
        for obs in observations {
            guard obs.confidence >= Float(confidence) else { continue }

            let bbox = obs.boundingBox
            // Convert from Vision normalized coords (origin bottom-left) to screen coords
            let x = bbox.origin.x * imageWidth
            let y = (1 - bbox.origin.y - bbox.height) * imageHeight
            let width = bbox.width * imageWidth
            let height = bbox.height * imageHeight

            let className = obs.labels.first?.identifier ?? "unknown"

            results.append([
                "class": className,
                "confidence": Double(obs.confidence),
                "bounds": [
                    "x": Double(x),
                    "y": Double(y),
                    "width": Double(width),
                    "height": Double(height),
                ] as [String: Any],
            ] as [String: Any])
        }

        return results
    }

    /// Perform OCR on an image, optionally searching for specific text.
    /// Returns all recognized text with bounding boxes.
    func findText(imagePath: String, searchText: String?, mode: String = "accurate") throws -> [[String: Any]] {
        let results = try performOCR(imagePath: imagePath, mode: mode)

        guard let search = searchText?.lowercased() else {
            return results
        }

        return results.filter { result in
            guard let text = result["text"] as? String else { return false }
            return text.lowercased().contains(search)
        }
    }

    /// Full OCR of an image — returns all recognized text.
    /// mode: "fast" (perception loop, 10x faster) or "accurate" (tool actions, default)
    func ocr(imagePath: String, mode: String = "accurate") throws -> [String: Any] {
        let results = try performOCR(imagePath: imagePath, mode: mode)
        let fullText = results.compactMap { $0["text"] as? String }.joined(separator: "\n")
        return [
            "text": fullText,
            "regions": results,
        ]
    }

    /// OCR a specific region of a window — captures the window, crops to the ROI,
    /// and runs text recognition on just that region. Returns bounds in window coordinates.
    func ocrRegion(windowId: Int, region: [String: Double], mode: String = "accurate") throws -> [String: Any] {
        let roiX = region["x"] ?? 0
        let roiY = region["y"] ?? 0
        let roiW = region["width"] ?? 0
        let roiH = region["height"] ?? 0

        // Capture the full window
        guard let fullImage = CGWindowListCreateImage(
            .null, .optionIncludingWindow, CGWindowID(windowId), [.bestResolution, .boundsIgnoreFraming]
        ) else {
            throw BridgeError.general("CGWindowListCreateImage returned nil for window \(windowId)")
        }

        // Crop to the ROI (CGImage coordinates have origin top-left, same as our ROI)
        let cropRect = CGRect(x: roiX, y: roiY, width: roiW, height: roiH)
            .intersection(CGRect(x: 0, y: 0, width: fullImage.width, height: fullImage.height))

        guard !cropRect.isEmpty,
              let cropped = fullImage.cropping(to: cropRect) else {
            return ["text": "", "regions": [] as [Any]]
        }

        // Run OCR on cropped image
        let results = try performOCROnImage(cropped, mode: mode)

        // Translate bounds from cropped-image coordinates back to window coordinates
        let adjustedResults: [[String: Any]] = results.map { entry in
            var adjusted = entry
            if var bounds = entry["bounds"] as? [String: Double] {
                bounds["x"] = (bounds["x"] ?? 0) + roiX
                bounds["y"] = (bounds["y"] ?? 0) + roiY
                adjusted["bounds"] = bounds
            }
            return adjusted
        }

        let fullText = adjustedResults.compactMap { $0["text"] as? String }.joined(separator: "\n")
        return [
            "text": fullText,
            "regions": adjustedResults,
        ]
    }

    private func performOCR(imagePath: String, mode: String = "accurate") throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: imagePath)

        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw BridgeError.general("Failed to load image at \(imagePath)")
        }

        return try performOCROnImage(cgImage, mode: mode)
    }

    private func performOCROnImage(_ cgImage: CGImage, mode: String = "accurate") throws -> [[String: Any]] {
        let imageWidth = CGFloat(cgImage.width)
        let imageHeight = CGFloat(cgImage.height)

        let request = VNRecognizeTextRequest()

        if mode == "fast" {
            // FAST mode: 10x faster (~60ms vs ~631ms), used for perception loop
            // Trades ~20% text coverage for speed — acceptable for frame diffing
            request.recognitionLevel = .fast
            request.usesLanguageCorrection = false
            request.recognitionLanguages = ["en-US"]
        } else {
            // ACCURATE mode: full precision, used for tool actions (ocr, click_text)
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            if #available(macOS 13.0, *) {
                request.automaticallyDetectsLanguage = true
            }
            let supportedLangs = try? request.supportedRecognitionLanguages()
            if let supported = supportedLangs {
                request.recognitionLanguages = supported
            } else {
                request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant", "ja", "ko", "hi", "ar", "de", "fr", "es", "pt", "it", "ru"]
            }
        }

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        guard let observations = request.results else {
            return []
        }

        var results: [[String: Any]] = []

        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }

            let boundingBox = observation.boundingBox
            // Convert from Vision's normalized coordinates (origin bottom-left) to screen coordinates
            let x = boundingBox.origin.x * imageWidth
            let y = (1 - boundingBox.origin.y - boundingBox.height) * imageHeight
            let width = boundingBox.width * imageWidth
            let height = boundingBox.height * imageHeight

            results.append([
                "text": candidate.string,
                "confidence": Double(candidate.confidence),
                "bounds": [
                    "x": Double(x),
                    "y": Double(y),
                    "width": Double(width),
                    "height": Double(height),
                ] as [String: Any],
            ] as [String: Any])
        }

        return results
    }
}
