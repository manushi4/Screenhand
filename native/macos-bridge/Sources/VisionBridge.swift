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

    private func performOCR(imagePath: String) throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: imagePath)

        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw BridgeError.general("Failed to load image at \(imagePath)")
        }

        let imageWidth = CGFloat(cgImage.width)
        let imageHeight = CGFloat(cgImage.height)

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

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
