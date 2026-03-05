import ApplicationServices
import Foundation

class ObserverBridge {
    private var observers: [pid_t: AXObserver] = [:]
    var onEvent: (([String: Any]) -> Void)?

    private let defaultNotifications: [String] = [
        kAXValueChangedNotification,
        kAXFocusedUIElementChangedNotification,
        kAXWindowCreatedNotification,
        kAXUIElementDestroyedNotification,
        kAXTitleChangedNotification,
        kAXMenuOpenedNotification,
        kAXSelectedTextChangedNotification,
        kAXLayoutChangedNotification,
    ]

    func startObserving(pid: pid_t, notifications: [String]?) throws {
        // Stop existing observer for this PID if any
        stopObserving(pid: pid)

        var observer: AXObserver?
        let result = AXObserverCreate(pid, observerCallback, &observer)
        guard result == .success, let obs = observer else {
            throw BridgeError.general("Failed to create AX observer for PID \(pid), code \(result.rawValue)")
        }

        let appElement = AXUIElementCreateApplication(pid)
        let notifs = notifications ?? defaultNotifications

        for notif in notifs {
            // Pass self pointer as refcon for callback
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            AXObserverAddNotification(obs, appElement, notif as CFString, refcon)
        }

        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(obs),
            .defaultMode
        )

        observers[pid] = obs
    }

    func stopObserving(pid: pid_t) {
        guard let observer = observers[pid] else { return }
        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )
        observers.removeValue(forKey: pid)
    }

    func handleNotification(observer: AXObserver, element: AXUIElement, notification: String) {
        var event: [String: Any] = [
            "type": mapNotificationType(notification),
            "notification": notification,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
        ]

        // Get PID
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        event["pid"] = Int(pid)

        // Get element role
        var roleValue: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue) == .success {
            event["elementRole"] = roleValue as? String
        }

        // Get element title
        var titleValue: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleValue) == .success {
            event["elementLabel"] = titleValue as? String
        }

        // Get element value for value_changed
        if notification == kAXValueChangedNotification {
            var valObj: AnyObject?
            if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valObj) == .success {
                event["newValue"] = "\(valObj!)"
            }
        }

        onEvent?(event)
    }

    private func mapNotificationType(_ notification: String) -> String {
        switch notification {
        case kAXValueChangedNotification: return "value_changed"
        case kAXFocusedUIElementChangedNotification: return "focus_changed"
        case kAXWindowCreatedNotification: return "window_created"
        case kAXUIElementDestroyedNotification: return "window_closed"
        case kAXTitleChangedNotification: return "title_changed"
        case kAXMenuOpenedNotification: return "menu_opened"
        case kAXLayoutChangedNotification: return "layout_changed"
        default: return notification
        }
    }
}

/// C callback for AXObserver notifications.
private func observerCallback(
    observer: AXObserver,
    element: AXUIElement,
    notification: CFString,
    refcon: UnsafeMutableRawPointer?
) {
    guard let refcon = refcon else { return }
    let bridge = Unmanaged<ObserverBridge>.fromOpaque(refcon).takeUnretainedValue()
    bridge.handleNotification(
        observer: observer,
        element: element,
        notification: notification as String
    )
}
