import CoreGraphics
import Foundation
import AppKit

class CoreGraphicsBridge {

    // MARK: - PID-targeted Event Posting

    /// Post a CGEvent to a specific process (PID-targeted) or to the global HID stream.
    /// When targetPid is provided, posts the event directly to that process
    /// instead of broadcasting to the frontmost app via the global HID stream.
    private func postEvent(_ event: CGEvent, targetPid: pid_t?) {
        if let pid = targetPid {
            event.postToPid(pid)
        } else {
            event.post(tap: .cghidEventTap)
        }
    }

    // MARK: - Mouse Events

    func mouseClick(x: Double, y: Double, button: String, clickCount: Int, modifiers: [String] = [], targetPid: pid_t? = nil) {
        let point = CGPoint(x: x, y: y)

        let (downType, upType) = mouseButtonTypes(button: button)
        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }

        // Multi-click (double/triple) must use global HID posting — postToPid drops clickState
        let useGlobal = clickCount > 1
        for i in 1...clickCount {
            if let downEvent = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton(button)) {
                downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                if !flags.isEmpty { downEvent.flags = flags }
                if useGlobal {
                    downEvent.post(tap: .cghidEventTap)
                } else {
                    postEvent(downEvent, targetPid: targetPid)
                }
            }
            usleep(10_000) // 10ms between down and up
            if let upEvent = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton(button)) {
                upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                if !flags.isEmpty { upEvent.flags = flags }
                if useGlobal {
                    upEvent.post(tap: .cghidEventTap)
                } else {
                    postEvent(upEvent, targetPid: targetPid)
                }
            }
            if i < clickCount { usleep(30_000) } // 30ms between clicks (enough for triple-click)
        }
    }

    func mouseMove(x: Double, y: Double, targetPid: pid_t? = nil) {
        let point = CGPoint(x: x, y: y)
        if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            postEvent(event, targetPid: targetPid)
        }
    }

    func mouseDrag(fromX: Double, fromY: Double, toX: Double, toY: Double, modifiers: [String] = [], targetPid: pid_t? = nil) {
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }

        // Mouse down at source
        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
            if !flags.isEmpty { downEvent.flags = flags }
            postEvent(downEvent, targetPid: targetPid)
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
                if !flags.isEmpty { dragEvent.flags = flags }
                postEvent(dragEvent, targetPid: targetPid)
            }
            usleep(20_000) // 20ms between steps
        }

        // Mouse up at destination
        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
            if !flags.isEmpty { upEvent.flags = flags }
            postEvent(upEvent, targetPid: targetPid)
        }
    }

    /// Press and hold at a position for a duration (milliseconds).
    /// Used for accent character picker, long-press menus, etc.
    func mousePressAndHold(x: Double, y: Double, durationMs: Int, targetPid: pid_t? = nil) {
        let point = CGPoint(x: x, y: y)

        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
            postEvent(downEvent, targetPid: targetPid)
        }
        usleep(UInt32(durationMs) * 1000)
        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
            postEvent(upEvent, targetPid: targetPid)
        }
    }

    /// Key press and hold for a duration (milliseconds).
    /// Used for accent character picker (hold 'e' to get é, è, ê, etc.).
    func keyPressAndHold(key: String, durationMs: Int, targetPid: pid_t? = nil) {
        guard let code = keyCodeForString(key.lowercased()) else { return }
        let source = CoreGraphicsBridge.typingSource

        if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) {
            postEvent(downEvent, targetPid: targetPid)
        }
        usleep(UInt32(durationMs) * 1000)
        if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
            postEvent(upEvent, targetPid: targetPid)
        }
    }

    /// Fast flick gesture — 3 steps, 5ms gaps. Triggers iOS swipe gestures.
    func mouseFlick(fromX: Double, fromY: Double, toX: Double, toY: Double, targetPid: pid_t? = nil) {
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
            postEvent(downEvent, targetPid: targetPid)
        }
        usleep(10_000) // 10ms

        // Just 3 fast steps
        for i in 1...3 {
            let t = Double(i) / 3.0
            let point = CGPoint(x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t)
            if let dragEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) {
                postEvent(dragEvent, targetPid: targetPid)
            }
            usleep(5_000) // 5ms
        }

        if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
            postEvent(upEvent, targetPid: targetPid)
        }
    }

    func scroll(x: Double, y: Double, deltaX: Int, deltaY: Int, targetPid: pid_t? = nil) {
        // Move mouse to position first
        mouseMove(x: x, y: y, targetPid: targetPid)
        usleep(50_000)

        if let scrollEvent = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) {
            postEvent(scrollEvent, targetPid: targetPid)
        }
    }

    // MARK: - Keyboard Events

    func keyCombo(keys: [String], targetPid: pid_t? = nil) {
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
            postEvent(downEvent, targetPid: targetPid)
        }
        usleep(50_000)
        if let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            upEvent.flags = modifiers
            postEvent(upEvent, targetPid: targetPid)
        }
    }

    /// Shared event source for typing — associates events with the current login session
    /// so Cocoa text views (NSTextView, etc.) accept them via the input method pipeline.
    private static let typingSource: CGEventSource? = CGEventSource(stateID: .combinedSessionState)

    func typeText(text: String, targetPid: pid_t? = nil) {
        let source = CoreGraphicsBridge.typingSource
        for char in text {
            // Handle control characters as real key presses
            if char == "\n" || char == "\r" {
                if let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true) { // Return
                    postEvent(down, targetPid: targetPid)
                }
                usleep(30_000)
                if let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) {
                    postEvent(up, targetPid: targetPid)
                }
                usleep(15_000)
                continue
            }
            if char == "\t" {
                if let down = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: true) { // Tab
                    postEvent(down, targetPid: targetPid)
                }
                usleep(30_000)
                if let up = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: false) {
                    postEvent(up, targetPid: targetPid)
                }
                usleep(15_000)
                continue
            }

            let str = String(char)
            let chars = Array(str.utf16)
            // Use virtualKey 9 (unused on most layouts) for non-ASCII to prevent the
            // input method from resolving virtualKey 0 ('a') and overriding the unicode string.
            let isAscii = char.isASCII
            let vk: CGKeyCode = isAscii ? 0 : 9

            if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: true) {
                downEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
                postEvent(downEvent, targetPid: targetPid)
            }
            // Non-ASCII needs slightly more time for the input method pipeline to process
            // but keep delays short to avoid bridge timeout on long strings (10s limit)
            usleep(isAscii ? 20_000 : 35_000)
            if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: false) {
                upEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
                postEvent(upEvent, targetPid: targetPid)
            }
            usleep(isAscii ? 10_000 : 20_000)
        }
    }

    // MARK: - Screenshots

    /// Track consecutive CG API failures per window to prefer CLI fallback
    private var cgWindowFailures = [Int: Int]()
    private static let CG_FAILURE_THRESHOLD = 2

    /// Run a capture operation on a background thread with a timeout.
    /// Uses autoreleasepool to prevent CGImage memory accumulation.
    /// CGWindowListCreateImage can block indefinitely when screen recording
    /// permission hasn't been granted, so we need a timeout guard.
    private func timedCapture<T>(timeoutSec: Double = 10, _ work: @escaping () throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        var result: T?
        var captureError: Error?

        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                do {
                    result = try work()
                } catch {
                    captureError = error
                }
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

    func captureWindow(windowId: Int, safeCLI: Bool = false) throws -> [String: Any] {
        // safeCLI=true: always use CLI (for browser windows that crash CG API)
        if safeCLI {
            return try screencaptureCliWindow(windowId: windowId)
        }

        // If CG API has been crashing for this window, go straight to CLI fallback
        let failures = cgWindowFailures[windowId] ?? 0
        if failures >= CoreGraphicsBridge.CG_FAILURE_THRESHOLD {
            return try screencaptureCliWindow(windowId: windowId)
        }

        do {
            let result: [String: Any] = try timedCapture(timeoutSec: 5) {
                guard let image = CGWindowListCreateImage(
                    .null, .optionIncludingWindow, CGWindowID(windowId), [.bestResolution, .boundsIgnoreFraming]
                ) else {
                    throw BridgeError.general("CGWindowListCreateImage returned nil for window \(windowId)")
                }
                let path = try self.saveImage(image)
                return ["path": path, "width": image.width, "height": image.height]
            }
            // CG API succeeded — reset failure counter
            cgWindowFailures[windowId] = 0
            return result
        } catch {
            // Track CG failure so we prefer CLI next time
            cgWindowFailures[windowId] = failures + 1
            // Fallback: use screencapture -l (runs in subprocess, crash-safe)
            return try screencaptureCliWindow(windowId: windowId)
        }
    }

    /// Fallback screenshot using macOS `screencapture` CLI (always has permission).
    /// Runs in a subprocess — crash-safe even for GPU-heavy windows.
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

        return readImageDimensions(fileURL: fileURL)
    }

    /// Fallback window capture using `screencapture -l <windowId>`.
    /// Runs in a subprocess — crash-safe even for GPU-heavy windows.
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

        return readImageDimensions(fileURL: fileURL)
    }

    /// Read image dimensions from a file.
    private func readImageDimensions(fileURL: URL) -> [String: Any] {
        guard let image = NSImage(contentsOf: fileURL),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return ["path": fileURL.path, "width": 0, "height": 0]
        }
        return ["path": fileURL.path, "width": cgImage.width, "height": cgImage.height]
    }

    /// Capture a window and return the image as an in-memory base64 PNG string.
    /// Avoids disk I/O — useful for high-frequency perception (vision diffs).
    /// Falls back to file-based capture if CG API fails.
    func captureWindowBuffer(windowId: Int, safeCLI: Bool = false) throws -> [String: Any] {
        // safeCLI=true: always use CLI (for browser windows that crash CG API)
        if safeCLI {
            return try captureWindowBufferViaFile(windowId: windowId)
        }

        // If CG API keeps failing, fall back to file-based capture + base64 encode
        let failures = cgWindowFailures[windowId] ?? 0
        if failures >= CoreGraphicsBridge.CG_FAILURE_THRESHOLD {
            return try captureWindowBufferViaFile(windowId: windowId)
        }

        do {
            let result: [String: Any] = try timedCapture(timeoutSec: 5) {
                guard let image = CGWindowListCreateImage(
                    .null, .optionIncludingWindow, CGWindowID(windowId), [.bestResolution, .boundsIgnoreFraming]
                ) else {
                    throw BridgeError.general("CGWindowListCreateImage returned nil for window \(windowId)")
                }

                // Encode CGImage → PNG Data in memory (no temp file)
                let mutableData = NSMutableData()
                guard let dest = CGImageDestinationCreateWithData(mutableData as CFMutableData, "public.png" as CFString, 1, nil) else {
                    throw BridgeError.general("Failed to create in-memory image destination")
                }
                CGImageDestinationAddImage(dest, image, nil)
                guard CGImageDestinationFinalize(dest) else {
                    throw BridgeError.general("Failed to encode PNG to memory buffer")
                }

                let base64 = (mutableData as Data).base64EncodedString()
                return ["base64": base64, "width": image.width, "height": image.height]
            }
            cgWindowFailures[windowId] = 0
            return result
        } catch {
            cgWindowFailures[windowId] = (cgWindowFailures[windowId] ?? 0) + 1
            return try captureWindowBufferViaFile(windowId: windowId)
        }
    }

    /// Fallback for captureWindowBuffer: capture to file via CLI, then read+encode.
    private func captureWindowBufferViaFile(windowId: Int) throws -> [String: Any] {
        let fileResult = try captureWindow(windowId: windowId)
        guard let path = fileResult["path"] as? String else {
            throw BridgeError.general("captureWindow fallback returned no path")
        }
        let url = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: url)
        let base64 = data.base64EncodedString()
        let width = fileResult["width"] as? Int ?? 0
        let height = fileResult["height"] as? Int ?? 0
        // Clean up temp file
        try? FileManager.default.removeItem(at: url)
        return ["base64": base64, "width": width, "height": height]
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
