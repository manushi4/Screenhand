import CoreGraphics
import Foundation
import AppKit

class CoreGraphicsBridge {

    // MARK: - Mouse Events

    func mouseClick(x: Double, y: Double, button: String, clickCount: Int) {
        let point = CGPoint(x: x, y: y)

        let (downType, upType) = mouseButtonTypes(button: button)

        for _ in 0..<clickCount {
            if let downEvent = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton(button)) {
                downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
                downEvent.post(tap: .cghidEventTap)
            }
            usleep(50_000) // 50ms between down and up
            if let upEvent = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton(button)) {
                upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
                upEvent.post(tap: .cghidEventTap)
            }
        }
    }

    func mouseMove(x: Double, y: Double) {
        let point = CGPoint(x: x, y: y)
        if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            event.post(tap: .cghidEventTap)
        }
    }

    func mouseDrag(fromX: Double, fromY: Double, toX: Double, toY: Double) {
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        // Mouse down at source
        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
            downEvent.post(tap: .cghidEventTap)
        }
        usleep(100_000) // 100ms

        // Interpolate drag points
        let steps = 10
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let x = fromX + (toX - fromX) * t
            let y = fromY + (toY - fromY) * t
            let point = CGPoint(x: x, y: y)
            if let dragEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) {
                dragEvent.post(tap: .cghidEventTap)
            }
            usleep(20_000) // 20ms between steps
        }

        // Mouse up at destination
        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
            upEvent.post(tap: .cghidEventTap)
        }
    }

    /// Fast flick gesture — 3 steps, 5ms gaps. Triggers iOS swipe gestures.
    func mouseFlick(fromX: Double, fromY: Double, toX: Double, toY: Double) {
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
            downEvent.post(tap: .cghidEventTap)
        }
        usleep(10_000) // 10ms

        // Just 3 fast steps
        for i in 1...3 {
            let t = Double(i) / 3.0
            let point = CGPoint(x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t)
            if let dragEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) {
                dragEvent.post(tap: .cghidEventTap)
            }
            usleep(5_000) // 5ms
        }

        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
            upEvent.post(tap: .cghidEventTap)
        }
    }

    func scroll(x: Double, y: Double, deltaX: Int, deltaY: Int) {
        // Move mouse to position first
        mouseMove(x: x, y: y)
        usleep(50_000)

        if let scrollEvent = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) {
            scrollEvent.post(tap: .cghidEventTap)
        }
    }

    // MARK: - Keyboard Events

    func keyCombo(keys: [String]) {
        var modifiers: CGEventFlags = []
        var keyCode: CGKeyCode?

        for key in keys {
            let lower = key.lowercased()
            switch lower {
            case "cmd", "command", "meta":
                modifiers.insert(.maskCommand)
            case "shift":
                modifiers.insert(.maskShift)
            case "alt", "option":
                modifiers.insert(.maskAlternate)
            case "ctrl", "control":
                modifiers.insert(.maskControl)
            case "fn":
                modifiers.insert(.maskSecondaryFn)
            default:
                keyCode = keyCodeForString(lower)
            }
        }

        guard let code = keyCode else { return }

        if let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
            downEvent.flags = modifiers
            downEvent.post(tap: .cghidEventTap)
        }
        usleep(50_000)
        if let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            upEvent.flags = modifiers
            upEvent.post(tap: .cghidEventTap)
        }
    }

    func typeText(text: String) {
        for char in text {
            let str = String(char)
            if let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
                let chars = Array(str.utf16)
                event.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
                event.post(tap: .cghidEventTap)
            }
            usleep(20_000) // 20ms between characters
            if let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                event.post(tap: .cghidEventTap)
            }
            usleep(10_000)
        }
    }

    // MARK: - Screenshots

    /// Run a capture operation on a background thread with a timeout.
    /// CGWindowListCreateImage can block indefinitely when screen recording
    /// permission hasn't been granted, so we need a timeout guard.
    private func timedCapture<T>(timeoutSec: Double = 10, _ work: @escaping () throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        var result: T?
        var captureError: Error?

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                result = try work()
            } catch {
                captureError = error
            }
            semaphore.signal()
        }

        let waitResult = semaphore.wait(timeout: .now() + timeoutSec)
        if waitResult == .timedOut {
            throw BridgeError.permissionDenied("Screen capture timed out — screen recording permission likely not granted. Grant access in System Settings → Privacy & Security → Screen Recording, then restart.")
        }
        if let err = captureError { throw err }
        return result!
    }

    func captureScreen(region: [String: Double]?) throws -> [String: Any] {
        // Try CGWindowListCreateImage first (fast, in-process)
        // Fall back to `screencapture` CLI (always has permission as a system binary)
        do {
            return try timedCapture(timeoutSec: 5) {
                let rect: CGRect
                if let region = region {
                    rect = CGRect(
                        x: region["x"] ?? 0,
                        y: region["y"] ?? 0,
                        width: region["width"] ?? 0,
                        height: region["height"] ?? 0
                    )
                } else {
                    rect = CGRect.infinite
                }
                guard let image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, .bestResolution) else {
                    throw BridgeError.general("CGWindowListCreateImage returned nil")
                }
                let path = try self.saveImage(image)
                return ["path": path, "width": image.width, "height": image.height]
            }
        } catch {
            // Fallback: use macOS screencapture CLI
            return try screencaptureCliFullscreen(region: region)
        }
    }

    func captureWindow(windowId: Int) throws -> [String: Any] {
        do {
            return try timedCapture(timeoutSec: 5) {
                guard let image = CGWindowListCreateImage(
                    .null, .optionIncludingWindow, CGWindowID(windowId), .bestResolution
                ) else {
                    throw BridgeError.general("CGWindowListCreateImage returned nil for window \(windowId)")
                }
                let path = try self.saveImage(image)
                return ["path": path, "width": image.width, "height": image.height]
            }
        } catch {
            // Fallback: use screencapture -l (capture specific window by ID)
            return try screencaptureCliWindow(windowId: windowId)
        }
    }

    /// Fallback screenshot using macOS `screencapture` CLI (always has permission).
    private func screencaptureCliFullscreen(region: [String: Double]?) throws -> [String: Any] {
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "bridge_screenshot_\(UUID().uuidString).png"
        let fileURL = tempDir.appendingPathComponent(fileName)

        var args = ["-x", fileURL.path] // -x = no sound
        if let r = region {
            let x = Int(r["x"] ?? 0)
            let y = Int(r["y"] ?? 0)
            let w = Int(r["width"] ?? 0)
            let h = Int(r["height"] ?? 0)
            args = ["-x", "-R", "\(x),\(y),\(w),\(h)", fileURL.path]
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = args
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw BridgeError.general("screencapture failed with exit code \(process.terminationStatus)")
        }

        // Read back image dimensions
        guard let image = NSImage(contentsOf: fileURL),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return ["path": fileURL.path, "width": 0, "height": 0]
        }
        return ["path": fileURL.path, "width": cgImage.width, "height": cgImage.height]
    }

    /// Fallback window capture using `screencapture -l <windowId>`.
    private func screencaptureCliWindow(windowId: Int) throws -> [String: Any] {
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "bridge_screenshot_\(UUID().uuidString).png"
        let fileURL = tempDir.appendingPathComponent(fileName)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(windowId), fileURL.path]
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw BridgeError.general("screencapture -l failed with exit code \(process.terminationStatus)")
        }

        guard let image = NSImage(contentsOf: fileURL),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return ["path": fileURL.path, "width": 0, "height": 0]
        }
        return ["path": fileURL.path, "width": cgImage.width, "height": cgImage.height]
    }

    private func saveImage(_ image: CGImage) throws -> String {
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "bridge_screenshot_\(UUID().uuidString).png"
        let fileURL = tempDir.appendingPathComponent(fileName)

        guard let dest = CGImageDestinationCreateWithURL(fileURL as CFURL, "public.png" as CFString, 1, nil) else {
            throw BridgeError.general("Failed to create image destination")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw BridgeError.general("Failed to write screenshot")
        }

        return fileURL.path
    }

    // MARK: - Key Code Mapping

    private func mouseButtonTypes(button: String) -> (CGEventType, CGEventType) {
        switch button.lowercased() {
        case "right":
            return (.rightMouseDown, .rightMouseUp)
        case "other", "middle":
            return (.otherMouseDown, .otherMouseUp)
        default:
            return (.leftMouseDown, .leftMouseUp)
        }
    }

    private func mouseButton(_ button: String) -> CGMouseButton {
        switch button.lowercased() {
        case "right": return .right
        case "other", "middle": return .center
        default: return .left
        }
    }

    private func keyCodeForString(_ key: String) -> CGKeyCode? {
        let keyMap: [String: CGKeyCode] = [
            "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5,
            "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45,
            "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32,
            "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
            "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
            "6": 22, "7": 26, "8": 28, "9": 25,
            "return": 36, "enter": 36, "tab": 48, "space": 49,
            "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "up": 126, "down": 125, "left": 123, "right": 124,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
            "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
            "f11": 103, "f12": 111,
            "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42,
            ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
        ]
        return keyMap[key]
    }
}
