import Foundation
import Vision
import AppKit

class VisionBridge {

    /// Perform OCR on an image, optionally searching for specific text.
    /// Returns all recognized text with bounding boxes.
    func findText(imagePath: String, searchText: String?) throws -> [[String: Any]] {
        let results = try performOCR(imagePath: imagePath)

        guard let search = searchText?.lowercased() else {
            return results
        }

        return results.filter { result in
            guard let text = result["text"] as? String else { return false }
            return text.lowercased().contains(search)
        }
    }

    /// Full OCR of an image — returns all recognized text.
    func ocr(imagePath: String) throws -> [String: Any] {
        let results = try performOCR(imagePath: imagePath)
        let fullText = results.compactMap { $0["text"] as? String }.joined(separator: "\n")
        return [
            "text": fullText,
            "regions": results,
        ]
    }

    /// OCR a specific region of a window — captures the window, crops to the ROI,
    /// and runs text recognition on just that region. Returns bounds in window coordinates.
    func ocrRegion(windowId: Int, region: [String: Double]) throws -> [String: Any] {
        let roiX = region["x"] ?? 0
        let roiY = region["y"] ?? 0
        let roiW = region["width"] ?? 0
        let roiH = region["height"] ?? 0

        // Capture the full window
        guard let fullImage = CGWindowListCreateImage(
            .null, .optionIncludingWindow, CGWindowID(windowId), .bestResolution
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
        let results = try performOCROnImage(cropped)

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

    private func performOCR(imagePath: String) throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: imagePath)

        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw BridgeError.general("Failed to load image at \(imagePath)")
        }

        return try performOCROnImage(cgImage)
    }

    private func performOCROnImage(_ cgImage: CGImage) throws -> [[String: Any]] {
        let imageWidth = CGFloat(cgImage.width)
        let imageHeight = CGFloat(cgImage.height)

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        // Enable automatic language detection for non-Latin scripts (CJK, Hindi, Arabic, etc.)
        // revision 3+ (macOS 13+) supports automatic multi-language detection
        if #available(macOS 13.0, *) {
            request.automaticallyDetectsLanguage = true
        }
        // Explicitly request common languages including non-Latin scripts
        let supportedLangs = try? request.supportedRecognitionLanguages()
        if let supported = supportedLangs {
            // Use all supported languages to maximize non-Latin coverage
            request.recognitionLanguages = supported
        } else {
            request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant", "ja", "ko", "hi", "ar", "de", "fr", "es", "pt", "it", "ru"]
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
