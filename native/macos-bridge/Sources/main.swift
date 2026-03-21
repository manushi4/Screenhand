import Foundation

/// JSON-RPC over stdio bridge for macOS native APIs.
/// Reads JSON requests from stdin (one per line), dispatches to the appropriate bridge,
/// and writes JSON responses to stdout (one per line).

// MARK: - Signal Handlers
// Catch fatal signals (SIGSEGV, SIGBUS, SIGABRT) that CGWindowListCreateImage
// can trigger on GPU-heavy windows. Write an error to stderr so the Node.js
// bridge client can detect the crash, then exit cleanly.
func installSignalHandlers() {
    // Fatal signals — crash reporting
    let fatalSignals: [Int32] = [SIGSEGV, SIGBUS, SIGABRT]
    for sig in fatalSignals {
        signal(sig) { signum in
            let msg = "Bridge fatal signal \(signum) — restarting\n"
            msg.withCString { ptr in
                _ = Darwin.write(STDERR_FILENO, ptr, Int(strlen(ptr)))
            }
            _exit(128 + signum)
        }
    }

    // Graceful shutdown signals — notify Node.js BridgeClient before exit
    let gracefulSignals: [Int32] = [SIGTERM, SIGINT]
    for sig in gracefulSignals {
        signal(sig) { signum in
            let reason = signum == SIGTERM ? "SIGTERM" : "SIGINT"
            let notification = "{\"jsonrpc\":\"2.0\",\"method\":\"bridge.shutdown\",\"params\":{\"reason\":\"\(reason)\"}}\n"
            notification.withCString { ptr in
                _ = Darwin.write(STDOUT_FILENO, ptr, Int(strlen(ptr)))
            }
            // Flush stdout
            fflush(stdout)
            _exit(0)
        }
    }
}
installSignalHandlers()

struct JsonRpcRequest: Codable {
    let id: Int
    let method: String
    let params: [String: AnyCodable]?
}

struct JsonRpcResponse: Codable {
    let id: Int
    let result: AnyCodable?
    let error: JsonRpcError?
}

struct JsonRpcError: Codable {
    let code: Int
    let message: String
}

/// Type-erased Codable wrapper for JSON values.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}

// MARK: - Helpers

func param<T>(_ params: [String: AnyCodable]?, _ key: String) -> T? {
    guard let raw = params?[key]?.value else { return nil }
    if let v = raw as? T { return v }
    // Numeric coercion: JSON integers may arrive as Int when Double is expected
    if T.self == Double.self {
        if let i = raw as? Int { return Double(i) as? T }
    }
    if T.self == Int.self {
        if let d = raw as? Double { return Int(d) as? T }
    }
    return nil
}

func requiredParam<T>(_ params: [String: AnyCodable]?, _ key: String) throws -> T {
    guard let value: T = param(params, key) else {
        throw BridgeError.missingParam(key)
    }
    return value
}

enum BridgeError: LocalizedError {
    case missingParam(String)
    case notFound(String)
    case permissionDenied(String)
    case general(String)

    var errorDescription: String? {
        switch self {
        case .missingParam(let name): return "Missing required parameter: \(name)"
        case .notFound(let what): return "Not found: \(what)"
        case .permissionDenied(let msg): return "Permission denied: \(msg)"
        case .general(let msg): return msg
        }
    }
}

// MARK: - Bridge Modules

let accessibilityBridge = AccessibilityBridge()
let observerBridge = ObserverBridge()
let coreGraphicsBridge = CoreGraphicsBridge()
let visionBridge = VisionBridge()
let appManagement = AppManagement(ax: accessibilityBridge)
let streamCapture = StreamCapture()

// MARK: - Method Dispatch

func dispatch(method: String, params: [String: AnyCodable]?) throws -> Any {
    switch method {
    // Lifecycle
    case "ping":
        return ["pong": true, "pid": ProcessInfo.processInfo.processIdentifier, "accessible": accessibilityBridge.isAccessibilityTrusted()] as [String: Any]

    case "check_permissions":
        return ["trusted": accessibilityBridge.isAccessibilityTrusted()] as [String: Bool]

    // App Management
    case "app.launch":
        let bundleId: String = try requiredParam(params, "bundleId")
        return try appManagement.launchApp(bundleId: bundleId)

    case "app.focus":
        let bundleId: String = try requiredParam(params, "bundleId")
        try appManagement.focusApp(bundleId: bundleId)
        return ["ok": true]

    case "app.list":
        return appManagement.listRunningApps()

    case "app.windows":
        return appManagement.listWindows()

    case "app.frontmost":
        return appManagement.frontmostApp()

    // Window management (AX-enriched)
    case "window.list":
        return appManagement.listWindowsWithAX()

    case "window.focus":
        let windowId: Int = try requiredParam(params, "windowId")
        try appManagement.focusWindow(windowId: windowId)
        return ["ok": true]

    // Accessibility
    case "ax.findElement":
        let pid: Int = try requiredParam(params, "pid")
        let role: String? = param(params, "role")
        let title: String? = param(params, "title")
        let value: String? = param(params, "value")
        let identifier: String? = param(params, "identifier")
        let exact: Bool = param(params, "exact") ?? true
        let maxDepth: Int = param(params, "maxDepth") ?? 30
        return try accessibilityBridge.findElement(
            pid: pid_t(pid), role: role, title: title, value: value,
            identifier: identifier, exact: exact, maxDepth: maxDepth
        )

    case "ax.getElementTree":
        let pid: Int = try requiredParam(params, "pid")
        let maxDepth: Int = param(params, "maxDepth") ?? 5
        let windowId: Int? = param(params, "windowId")
        return try accessibilityBridge.getElementTree(pid: pid_t(pid), maxDepth: maxDepth, windowId: windowId)

    case "ax.getMenuBar":
        let pid: Int = try requiredParam(params, "pid")
        let maxDepth: Int = param(params, "maxDepth") ?? 10
        return try accessibilityBridge.getMenuBarTree(pid: pid_t(pid), maxDepth: maxDepth)

    case "ax.performAction":
        let pid: Int = try requiredParam(params, "pid")
        let elementPath: [Int] = try requiredParam(params, "elementPath")
        let action: String = param(params, "action") ?? "AXPress"
        let expectedTitle: String? = param(params, "expectedTitle")
        try accessibilityBridge.performAction(pid: pid_t(pid), elementPath: elementPath, action: action, expectedTitle: expectedTitle)
        return ["ok": true]

    case "ax.setElementValue":
        let pid: Int = try requiredParam(params, "pid")
        let elementPath: [Int] = try requiredParam(params, "elementPath")
        let value: String = try requiredParam(params, "value")
        try accessibilityBridge.setElementValue(pid: pid_t(pid), elementPath: elementPath, value: value)
        return ["ok": true]

    case "ax.getElementValue":
        let pid: Int = try requiredParam(params, "pid")
        let elementPath: [Int] = try requiredParam(params, "elementPath")
        return try accessibilityBridge.getElementValue(pid: pid_t(pid), elementPath: elementPath)

    case "ax.menuClick":
        let pid: Int = try requiredParam(params, "pid")
        let menuPath: [String] = try requiredParam(params, "menuPath")
        try accessibilityBridge.menuClick(pid: pid_t(pid), menuPath: menuPath)
        return ["ok": true]

    // Observer
    case "observer.start":
        let pid: Int = try requiredParam(params, "pid")
        let notifications: [String]? = param(params, "notifications")
        try observerBridge.startObserving(pid: pid_t(pid), notifications: notifications)
        return ["ok": true]

    case "observer.stop":
        let pid: Int = try requiredParam(params, "pid")
        observerBridge.stopObserving(pid: pid_t(pid))
        return ["ok": true]

    // CoreGraphics
    case "cg.mouseClick":
        let x: Double = try requiredParam(params, "x")
        let y: Double = try requiredParam(params, "y")
        let button: String = param(params, "button") ?? "left"
        let clickCount: Int = param(params, "clickCount") ?? 1
        let modifiers: [String] = param(params, "modifiers") ?? []
        let mcTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.mouseClick(x: x, y: y, button: button, clickCount: clickCount, modifiers: modifiers, targetPid: mcTargetPid)
        return ["ok": true]

    case "cg.mouseMove":
        let x: Double = try requiredParam(params, "x")
        let y: Double = try requiredParam(params, "y")
        let mmTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.mouseMove(x: x, y: y, targetPid: mmTargetPid)
        return ["ok": true]

    case "cg.mouseDrag":
        let fromX: Double = try requiredParam(params, "fromX")
        let fromY: Double = try requiredParam(params, "fromY")
        let toX: Double = try requiredParam(params, "toX")
        let toY: Double = try requiredParam(params, "toY")
        let dragModifiers: [String] = param(params, "modifiers") ?? []
        let mdTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.mouseDrag(fromX: fromX, fromY: fromY, toX: toX, toY: toY, modifiers: dragModifiers, targetPid: mdTargetPid)
        return ["ok": true]

    case "cg.mousePressAndHold":
        let phX: Double = try requiredParam(params, "x")
        let phY: Double = try requiredParam(params, "y")
        let phDuration: Int = param(params, "durationMs") ?? 500
        let phTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.mousePressAndHold(x: phX, y: phY, durationMs: phDuration, targetPid: phTargetPid)
        return ["ok": true]

    case "cg.keyPressAndHold":
        let kphKey: String = try requiredParam(params, "key")
        let kphDuration: Int = param(params, "durationMs") ?? 500
        let kphTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.keyPressAndHold(key: kphKey, durationMs: kphDuration, targetPid: kphTargetPid)
        return ["ok": true]

    case "cg.mouseFlick":
        let fxF: Double = try requiredParam(params, "fromX")
        let fyF: Double = try requiredParam(params, "fromY")
        let txF: Double = try requiredParam(params, "toX")
        let tyF: Double = try requiredParam(params, "toY")
        let mfTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.mouseFlick(fromX: fxF, fromY: fyF, toX: txF, toY: tyF, targetPid: mfTargetPid)
        return ["ok": true]

    case "cg.keyCombo":
        let keys: [String] = try requiredParam(params, "keys")
        let kcTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.keyCombo(keys: keys, targetPid: kcTargetPid)
        return ["ok": true]

    case "cg.typeText":
        let text: String = try requiredParam(params, "text")
        let ttTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.typeText(text: text, targetPid: ttTargetPid)
        return ["ok": true]

    case "cg.captureScreen":
        let region: [String: Double]? = param(params, "region")
        return try coreGraphicsBridge.captureScreen(region: region)

    case "cg.captureWindow":
        let windowId: Int = try requiredParam(params, "windowId")
        let safeCLI: Bool = param(params, "safeCLI") ?? false
        return try coreGraphicsBridge.captureWindow(windowId: windowId, safeCLI: safeCLI)

    case "cg.captureWindowBuffer":
        let windowId: Int = try requiredParam(params, "windowId")
        let safeCLI: Bool = param(params, "safeCLI") ?? false
        return try coreGraphicsBridge.captureWindowBuffer(windowId: windowId, safeCLI: safeCLI)

    case "cg.scroll":
        let x: Double = try requiredParam(params, "x")
        let y: Double = try requiredParam(params, "y")
        let deltaX: Int = param(params, "deltaX") ?? 0
        let deltaY: Int = param(params, "deltaY") ?? 0
        let scTargetPid: pid_t? = (param(params, "targetPid") as Int?).map { pid_t($0) }
        coreGraphicsBridge.scroll(x: x, y: y, deltaX: deltaX, deltaY: deltaY, targetPid: scTargetPid)
        return ["ok": true]

    // Vision
    case "vision.findText":
        let imagePath: String = try requiredParam(params, "imagePath")
        let searchText: String? = param(params, "searchText")
        let ftMode: String = param(params, "mode") ?? "accurate"
        return try visionBridge.findText(imagePath: imagePath, searchText: searchText, mode: ftMode)

    case "vision.ocr":
        let imagePath: String = try requiredParam(params, "imagePath")
        let ocrMode: String = param(params, "mode") ?? "accurate"
        return try visionBridge.ocr(imagePath: imagePath, mode: ocrMode)

    case "vision.ocrRegion":
        let windowId: Int = try requiredParam(params, "windowId")
        let region: [String: Double] = try requiredParam(params, "region")
        let ocrRegionMode: String = param(params, "mode") ?? "accurate"
        return try visionBridge.ocrRegion(windowId: windowId, region: region, mode: ocrRegionMode)

    case "vision.detectElements":
        let imagePath: String = try requiredParam(params, "imagePath")
        let confidence: Double = param(params, "confidence") ?? 0.25
        let elements = try visionBridge.detectElements(imagePath: imagePath, confidence: confidence)
        return ["elements": elements, "count": elements.count]

    // Stream capture — continuous SCStream for fast perception
    case "vision.startStream":
        let windowId: Int = try requiredParam(params, "windowId")
        let fps: Int = param(params, "fps") ?? 30
        let sem = DispatchSemaphore(value: 0)
        var streamError: Error?
        Task {
            do {
                try await streamCapture.start(windowId: windowId, fps: fps)
            } catch {
                streamError = error
            }
            sem.signal()
        }
        sem.wait()
        if let err = streamError { throw err }
        return ["ok": true, "fps": fps]

    case "vision.stopStream":
        let sem = DispatchSemaphore(value: 0)
        Task {
            await streamCapture.stop()
            sem.signal()
        }
        sem.wait()
        return ["ok": true]

    case "vision.streamStatus":
        let running = streamCapture.isRunning
        if running, let info = streamCapture.getLatestInfo() {
            return ["running": true, "path": info["path"]!, "width": info["width"]!, "height": info["height"]!, "ageMs": info["ageMs"]!, "frameCount": info["frameCount"]!]
        }
        return ["running": running]

    case "vision.latestFrame":
        guard streamCapture.isRunning else {
            throw BridgeError.general("Stream not running")
        }
        guard let info = streamCapture.getLatestInfo() else {
            throw BridgeError.general("No frame captured yet")
        }
        return info

    default:
        throw BridgeError.general("Unknown method: \(method)")
    }
}

// MARK: - Main Loop

let encoder = JSONEncoder()
encoder.outputFormatting = []

let decoder = JSONDecoder()

/// Write a JSON line to stdout (thread-safe).
let outputLock = NSLock()
func writeLine(_ data: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func writeResponse(_ response: JsonRpcResponse) {
    if let data = try? encoder.encode(response) {
        writeLine(data)
    }
}

func writeEvent(_ event: [String: Any]) {
    let wrapped: [String: Any] = ["id": 0, "event": event]
    if let data = try? JSONSerialization.data(withJSONObject: wrapped) {
        writeLine(data)
    }
}

// Set up observer event forwarding
observerBridge.onEvent = { event in
    writeEvent(event)
}

// Process stdin line by line
while let line = readLine() {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8) else { continue }

    do {
        let request = try decoder.decode(JsonRpcRequest.self, from: data)
        do {
            let result = try dispatch(method: request.method, params: request.params)
            let response = JsonRpcResponse(
                id: request.id,
                result: AnyCodable(result),
                error: nil
            )
            writeResponse(response)
        } catch {
            let response = JsonRpcResponse(
                id: request.id,
                result: nil,
                error: JsonRpcError(code: -1, message: error.localizedDescription)
            )
            writeResponse(response)
        }
    } catch {
        // Malformed JSON — try to extract id from raw string
        var extractedId = 0
        if let idRange = line.range(of: "\"id\"\\s*:\\s*(\\d+)", options: .regularExpression) {
            let match = line[idRange]
            if let digitRange = match.range(of: "\\d+$", options: .regularExpression) {
                extractedId = Int(match[digitRange]) ?? 0
            }
        }
        if extractedId == 0 {
            // No id could be extracted — log to stderr so Node.js BridgeClient can detect it
            let stderrMsg = "Bridge parse error (no id): \(error.localizedDescription)\n"
            stderrMsg.withCString { ptr in
                _ = Darwin.write(STDERR_FILENO, ptr, Int(strlen(ptr)))
            }
        }
        let response = JsonRpcResponse(
            id: extractedId,
            result: nil,
            error: JsonRpcError(code: -32700, message: "Parse error: \(error.localizedDescription)")
        )
        writeResponse(response)
    }
}
