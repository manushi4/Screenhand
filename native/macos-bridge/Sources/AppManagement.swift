import AppKit
import Foundation

class AppManagement {

    private let ax: AccessibilityBridge

    init(ax: AccessibilityBridge) {
        self.ax = ax
    }

    func launchApp(bundleId: String) throws -> [String: Any] {
        let workspace = NSWorkspace.shared

        guard let url = workspace.urlForApplication(withBundleIdentifier: bundleId) else {
            throw BridgeError.notFound("Application with bundle ID '\(bundleId)' not found")
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true

        let semaphore = DispatchSemaphore(value: 0)
        var launchedApp: NSRunningApplication?
        var launchError: Error?

        workspace.openApplication(at: url, configuration: config) { app, error in
            launchedApp = app
            launchError = error
            semaphore.signal()
        }

        semaphore.wait()

        if let error = launchError {
            throw BridgeError.general("Failed to launch '\(bundleId)': \(error.localizedDescription)")
        }

        guard let app = launchedApp else {
            throw BridgeError.general("Launch returned nil for '\(bundleId)'")
        }

        // Wait for the app to finish launching (up to 10 seconds)
        let deadline = Date().addingTimeInterval(10)
        while !app.isFinishedLaunching && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        return [
            "bundleId": bundleId,
            "appName": app.localizedName ?? bundleId,
            "pid": Int(app.processIdentifier),
            "windowTitle": "",
        ]
    }

    func focusApp(bundleId: String) throws {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            throw BridgeError.notFound("No running application with bundle ID '\(bundleId)'")
        }

        // Attempt 1: activateIgnoringOtherApps (strongest NSRunningApplication API)
        app.activate(options: .activateIgnoringOtherApps)

        // Poll up to 400ms for focus to switch
        let pollEnd = Date().addingTimeInterval(0.4)
        while Date() < pollEnd {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId {
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        // Attempt 2: AppleScript activation via bundle ID — goes through Apple Events,
        // often succeeds when NSRunningApplication.activate fails (e.g. VS Code holding focus).
        // Uses "id bundleId" form to avoid issues with Unicode chars in app names (WhatsApp).
        let script = NSAppleScript(source: "tell application id \"\(bundleId)\" to activate")
        script?.executeAndReturnError(nil)

        // Poll up to 400ms more
        let asEnd = Date().addingTimeInterval(0.4)
        while Date() < asEnd {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId {
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        // Attempt 3: Raise the main window via AX API
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        if let axWindows = self.ax.getAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement],
           let mainWindow = axWindows.first {
            AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString)
            // One more activate after raising — the combo often works when neither alone does
            app.activate(options: .activateIgnoringOtherApps)
        }

        // Final poll — 300ms
        let finalEnd = Date().addingTimeInterval(0.3)
        while Date() < finalEnd {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId {
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        // Focus never changed — report honestly
        let actual = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        throw BridgeError.general("Focus failed: \(actual) is frontmost instead of \(bundleId)")
    }

    /// Focus a specific window by its CG windowId.
    /// Activates the owning app and raises the target window via AX.
    func focusWindow(windowId: Int) throws {
        // Find the window's owner PID from CG
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw BridgeError.notFound("Cannot enumerate windows")
        }
        guard let target = windowList.first(where: { ($0[kCGWindowNumber as String] as? Int) == windowId }),
              let ownerPid = target[kCGWindowOwnerPID as String] as? Int else {
            throw BridgeError.notFound("Window \(windowId) not found")
        }

        // Activate the owning app
        if let app = NSRunningApplication(processIdentifier: pid_t(ownerPid)) {
            app.activate(options: .activateIgnoringOtherApps)
        }

        // Raise the specific window via AX
        let appElement = AXUIElementCreateApplication(pid_t(ownerPid))
        guard let axWindows = self.ax.getAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] else {
            return // App activated, but can't raise specific window
        }

        // Match AX window to CG window by position
        var targetPos = CGPoint.zero
        if let bounds = target[kCGWindowBounds as String] as? [String: Any] {
            targetPos.x = CGFloat((bounds["X"] as? NSNumber)?.doubleValue ?? 0)
            targetPos.y = CGFloat((bounds["Y"] as? NSNumber)?.doubleValue ?? 0)
        }

        for axWin in axWindows {
            var axPos = CGPoint.zero
            if let posValue = self.ax.getAttribute(axWin, kAXPositionAttribute) {
                AXValueGetValue(posValue as! AXValue, .cgPoint, &axPos)
            }
            if abs(axPos.x - targetPos.x) < 2 && abs(axPos.y - targetPos.y) < 2 {
                AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
                return
            }
        }
    }

    func listRunningApps() -> [[String: Any]] {
        let workspace = NSWorkspace.shared
        return workspace.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app in
                [
                    "bundleId": app.bundleIdentifier ?? "unknown",
                    "name": app.localizedName ?? "Unknown",
                    "pid": Int(app.processIdentifier),
                    "isActive": app.isActive,
                ] as [String: Any]
            }
    }

    func listWindows() -> [[String: Any]] {
        // Use .optionAll to include minimized/off-screen windows (e.g. Safari minimized to dock).
        // layer == 0 filter below already excludes desktop elements and system overlays.
        guard let windowList = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }

        return windowList.compactMap { window -> [String: Any]? in
            guard let windowId = window[kCGWindowNumber as String] as? Int,
                  let ownerPid = window[kCGWindowOwnerPID as String] as? Int,
                  let boundsRaw = window[kCGWindowBounds as String],
                  let layer = window[kCGWindowLayer as String] as? Int,
                  layer == 0 else { // Only normal windows (layer 0)
                return nil
            }

            // Parse bounds — CGWindowListCopyWindowInfo returns a dict with CGFloat values
            var rect = CGRect.zero
            if let boundsDict = boundsRaw as? [String: Any] {
                let bx = (boundsDict["X"] as? NSNumber)?.doubleValue ?? 0
                let by = (boundsDict["Y"] as? NSNumber)?.doubleValue ?? 0
                let bw = (boundsDict["Width"] as? NSNumber)?.doubleValue ?? 0
                let bh = (boundsDict["Height"] as? NSNumber)?.doubleValue ?? 0
                rect = CGRect(x: bx, y: by, width: bw, height: bh)
            }

            let title = window[kCGWindowName as String] as? String ?? ""
            let ownerName = window[kCGWindowOwnerName as String] as? String ?? ""
            let isOnScreen = window[kCGWindowIsOnscreen as String] as? Bool ?? true

            // Skip zero-size windows (system placeholders, UI services)
            if rect.width < 10 && rect.height < 10 { return nil }

            // Look up bundle ID from PID
            let bundleId = NSRunningApplication(processIdentifier: pid_t(ownerPid))?.bundleIdentifier ?? ""

            return [
                "windowId": windowId,
                "title": title,
                "bundleId": bundleId,
                "pid": ownerPid,
                "appName": ownerName,
                "bounds": [
                    "x": Double(rect.origin.x),
                    "y": Double(rect.origin.y),
                    "width": Double(rect.size.width),
                    "height": Double(rect.size.height),
                ] as [String: Double],
                "isOnScreen": isOnScreen,
            ]
        }
    }

    /// List windows with AX-enriched metadata (focused, isMain) merged onto CG window data.
    /// This is the preferred method for window resolution — it tells callers which window
    /// is actually focused/main, avoiding wrong-window attachment.
    ///
    /// Matching uses a multi-signal join: position + title + size to avoid mis-annotation
    /// when windows share geometry or move during polling.
    func listWindowsWithAX() -> [[String: Any]] {
        var cgWindows = listWindows()

        // Group by PID so we only query AX for apps that have windows
        var pidSet = Set<Int>()
        for win in cgWindows {
            if let pid = win["pid"] as? Int { pidSet.insert(pid) }
        }

        // For each PID, get AX windows and extract focused/isMain
        struct AXWindowInfo {
            let posX: Double
            let posY: Double
            let width: Double
            let height: Double
            let title: String
            let focused: Bool
            let isMain: Bool
            let subrole: String
        }

        var axInfoByPid: [Int: [AXWindowInfo]] = [:]

        for pid in pidSet {
            let appElement = AXUIElementCreateApplication(pid_t(pid))
            guard let axWindows = self.ax.getAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] else {
                continue
            }

            var infos: [AXWindowInfo] = []
            for axWin in axWindows {
                var pos = CGPoint.zero
                var size = CGSize.zero
                if let posValue = self.ax.getAttribute(axWin, kAXPositionAttribute) {
                    AXValueGetValue(posValue as! AXValue, .cgPoint, &pos)
                }
                if let sizeValue = self.ax.getAttribute(axWin, kAXSizeAttribute) {
                    AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
                }
                let title = self.ax.getAttribute(axWin, kAXTitleAttribute) as? String ?? ""
                let focused = self.ax.getAttribute(axWin, kAXFocusedAttribute) as? Bool ?? false
                let isMain = self.ax.getAttribute(axWin, kAXMainAttribute) as? Bool ?? false
                let subrole = self.ax.getAttribute(axWin, kAXSubroleAttribute) as? String ?? ""
                infos.append(AXWindowInfo(
                    posX: Double(pos.x), posY: Double(pos.y),
                    width: Double(size.width), height: Double(size.height),
                    title: title,
                    focused: focused, isMain: isMain, subrole: subrole
                ))
            }
            axInfoByPid[pid] = infos
        }

        // Merge AX info into CG windows using multi-signal matching
        for i in 0..<cgWindows.count {
            guard let pid = cgWindows[i]["pid"] as? Int,
                  let bounds = cgWindows[i]["bounds"] as? [String: Double],
                  let bx = bounds["x"], let by = bounds["y"],
                  let bw = bounds["width"], let bh = bounds["height"],
                  let infos = axInfoByPid[pid] else {
                continue
            }

            let cgTitle = cgWindows[i]["title"] as? String ?? ""

            // Score each AX window — higher score = better match
            var bestScore = 0
            var bestInfo: AXWindowInfo? = nil

            for info in infos {
                var score = 0
                // Position match (within 2px) — required baseline
                let posMatch = abs(info.posX - bx) < 2 && abs(info.posY - by) < 2
                if !posMatch { continue }
                score += 10

                // Size match (within 5px)
                if abs(info.width - bw) < 5 && abs(info.height - bh) < 5 {
                    score += 5
                }

                // Title match — strongest signal for disambiguation
                if !cgTitle.isEmpty && !info.title.isEmpty && cgTitle == info.title {
                    score += 20
                }

                if score > bestScore {
                    bestScore = score
                    bestInfo = info
                }
            }

            if let info = bestInfo {
                cgWindows[i]["focused"] = info.focused
                cgWindows[i]["isMain"] = info.isMain
                cgWindows[i]["subrole"] = info.subrole
            }
        }

        return cgWindows
    }

    func frontmostApp() -> [String: Any] {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return ["error": "No frontmost application"]
        }
        return [
            "bundleId": app.bundleIdentifier ?? "unknown",
            "name": app.localizedName ?? "Unknown",
            "pid": Int(app.processIdentifier),
        ]
    }
}
