import AppKit
import Foundation

class AppManagement {

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
        app.activate()
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
        guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
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
