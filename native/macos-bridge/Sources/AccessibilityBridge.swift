import ApplicationServices
import AppKit
import Foundation

class AccessibilityBridge {

    func isAccessibilityTrusted() -> Bool {
        return AXIsProcessTrusted()
    }

    // MARK: - Element Tree

    /// Max total nodes to emit in a single tree build to prevent runaway traversal on heavy DOMs (Canva, Figma)
    private static let treeBuildNodeBudget = 3000
    /// Max siblings to include per parent during tree build
    private static let treeBuildSiblingCap = 80

    func getElementTree(pid: pid_t, maxDepth: Int, windowId: Int? = nil) throws -> [String: Any] {
        let appElement = AXUIElementCreateApplication(pid)
        var nodesEmitted = 0

        // If windowId specified, scope to that window instead of full app tree
        if let wid = windowId, wid > 0 {
            if let windowsRef = getAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] {
                // Match by CGWindowID via position/size comparison with CG window list
                let cgWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                let appCGWindows = cgWindows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }

                for win in windowsRef {
                    // Get AX window position and size
                    var axPos = CGPoint.zero
                    var axSize = CGSize.zero
                    if let posValue = getAttribute(win, kAXPositionAttribute) {
                        AXValueGetValue(posValue as! AXValue, .cgPoint, &axPos)
                    }
                    if let sizeValue = getAttribute(win, kAXSizeAttribute) {
                        AXValueGetValue(sizeValue as! AXValue, .cgSize, &axSize)
                    }

                    // Match against CG window with target windowId
                    for cgWin in appCGWindows {
                        guard let cgId = cgWin[kCGWindowNumber as String] as? Int, cgId == wid else { continue }
                        if let bounds = cgWin[kCGWindowBounds as String] as? [String: Any],
                           let cgX = bounds["X"] as? Double,
                           let cgY = bounds["Y"] as? Double {
                            // Match by position (within tolerance for rounding)
                            if abs(Double(axPos.x) - cgX) < 2 && abs(Double(axPos.y) - cgY) < 2 {
                                var tree = try buildTree(element: win, depth: 0, maxDepth: maxDepth, nodesEmitted: &nodesEmitted, isAppRoot: false)
                                tree["_nodeCount"] = nodesEmitted
                                return tree
                            }
                        }
                    }
                }
            }
            // Fallback: if window not found by ID, use app root
        }

        var tree = try buildTree(element: appElement, depth: 0, maxDepth: maxDepth, nodesEmitted: &nodesEmitted, isAppRoot: true)
        tree["_nodeCount"] = nodesEmitted
        return tree
    }

    private func buildTree(element: AXUIElement, depth: Int, maxDepth: Int, nodesEmitted: inout Int, isAppRoot: Bool = false) throws -> [String: Any] {
        // Global node budget — stop adding nodes once exceeded
        nodesEmitted += 1
        if nodesEmitted > AccessibilityBridge.treeBuildNodeBudget {
            return ["role": "BudgetExceeded", "_truncated": true]
        }

        var node: [String: Any] = [:]

        node["role"] = getAttribute(element, kAXRoleAttribute) as? String ?? "Unknown"
        if let title = getAttribute(element, kAXTitleAttribute) as? String, !title.isEmpty {
            node["title"] = title
        }
        if let value = getAttribute(element, kAXValueAttribute) {
            node["value"] = "\(value)"
        }
        if let desc = getAttribute(element, kAXDescriptionAttribute) as? String, !desc.isEmpty {
            node["description"] = desc
        }
        if let identifier = getAttribute(element, kAXIdentifierAttribute) as? String, !identifier.isEmpty {
            node["identifier"] = identifier
        }
        if let enabled = getAttribute(element, kAXEnabledAttribute) as? Bool {
            node["enabled"] = enabled
        }
        if let focused = getAttribute(element, kAXFocusedAttribute) as? Bool {
            node["focused"] = focused
        }

        // Position and size
        if let posValue = getAttribute(element, kAXPositionAttribute) {
            var point = CGPoint.zero
            if AXValueGetValue(posValue as! AXValue, .cgPoint, &point) {
                node["position"] = ["x": Double(point.x), "y": Double(point.y)]
            }
        }
        if let sizeValue = getAttribute(element, kAXSizeAttribute) {
            var size = CGSize.zero
            if AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) {
                node["size"] = ["width": Double(size.width), "height": Double(size.height)]
            }
        }

        // Children (if not at max depth and within global budget)
        if depth < maxDepth && nodesEmitted < AccessibilityBridge.treeBuildNodeBudget {
            if let children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                var childNodes: [[String: Any]] = []
                for (index, child) in children.enumerated() {
                    if index >= AccessibilityBridge.treeBuildSiblingCap { break }
                    if nodesEmitted >= AccessibilityBridge.treeBuildNodeBudget { break }
                    // Skip self-referential AXApplication children at the app root level.
                    // Some apps (Notes, Safari) list AXApplication elements as children
                    // of themselves, causing infinite recursion. Only check at depth 0
                    // (the app root) to avoid affecting legitimate nested elements.
                    if isAppRoot {
                        let childRole = getAttribute(child, kAXRoleAttribute) as? String ?? ""
                        if childRole == "AXApplication" { continue }
                    }
                    if let childNode = try? buildTree(element: child, depth: depth + 1, maxDepth: maxDepth, nodesEmitted: &nodesEmitted) {
                        childNodes.append(childNode)
                    }
                }
                if !childNodes.isEmpty {
                    node["children"] = childNodes
                }
            }
        }

        return node
    }

    // MARK: - Menu Bar Tree

    func getMenuBarTree(pid: pid_t, maxDepth: Int) throws -> [String: Any] {
        let appElement = AXUIElementCreateApplication(pid)
        guard let menuBar = getAttribute(appElement, kAXMenuBarAttribute) as AnyObject? else {
            throw BridgeError.notFound("Menu bar not found for pid \(pid)")
        }
        let menuBarElement = menuBar as! AXUIElement
        return try buildMenuTree(element: menuBarElement, depth: 0, maxDepth: maxDepth, expandMenus: true)
    }

    private func buildMenuTree(element: AXUIElement, depth: Int, maxDepth: Int, expandMenus: Bool = false) throws -> [String: Any] {
        var node: [String: Any] = [:]

        let role = getAttribute(element, kAXRoleAttribute) as? String ?? "Unknown"
        node["role"] = role
        if let title = getAttribute(element, kAXTitleAttribute) as? String, !title.isEmpty {
            node["title"] = title
        }
        if let desc = getAttribute(element, kAXDescriptionAttribute) as? String, !desc.isEmpty {
            node["description"] = desc
        }
        if let enabled = getAttribute(element, kAXEnabledAttribute) as? Bool {
            node["enabled"] = enabled
        }

        // Menu-specific attributes
        if let cmdChar = getAttribute(element, "AXMenuItemCmdChar") as? String, !cmdChar.isEmpty {
            node["AXMenuItemCmdChar"] = cmdChar
        }
        if let cmdMods = getAttribute(element, "AXMenuItemCmdModifiers") {
            node["AXMenuItemCmdModifiers"] = cmdMods
        }
        if let markChar = getAttribute(element, "AXMenuItemMarkChar") as? String, !markChar.isEmpty {
            node["AXMenuItemMarkChar"] = markChar
        }

        // Children (if not at max depth)
        if depth < maxDepth {
            var children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement]

            // macOS AXMenuBarItem has a child AXMenu, but the AXMenu's children
            // (actual AXMenuItems) are empty until the menu is opened via AXPress.
            // Always press AXMenuBarItem to populate its submenu items.
            let shouldExpand = expandMenus && role == "AXMenuBarItem"
            if shouldExpand {
                AXUIElementPerformAction(element, kAXPressAction as CFString)
                // Poll for the AXMenu child's children to appear (max 200ms)
                let deadline = Date().addingTimeInterval(0.2)
                while Date() < deadline {
                    // Re-read children — the AXMenu inside should now have items
                    children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement]
                    if let menu = children?.first {
                        let menuChildren = getAttribute(menu, kAXChildrenAttribute) as? [AXUIElement]
                        if menuChildren != nil && !menuChildren!.isEmpty { break }
                    }
                    Thread.sleep(forTimeInterval: 0.02)
                }
            }

            if let children = children {
                var childNodes: [[String: Any]] = []
                for (index, child) in children.enumerated() {
                    if index > 100 { break } // Safety limit
                    if let childNode = try? buildMenuTree(element: child, depth: depth + 1, maxDepth: maxDepth, expandMenus: expandMenus) {
                        childNodes.append(childNode)
                    }
                }
                if !childNodes.isEmpty {
                    node["children"] = childNodes
                }
            }

            // Close the menu we opened
            if shouldExpand {
                AXUIElementPerformAction(element, kAXCancelAction as CFString)
                Thread.sleep(forTimeInterval: 0.03)
            }
        }

        return node
    }

    // MARK: - Find Element

    func findElement(pid: pid_t, role: String?, title: String?, value: String?,
                     identifier: String?, exact: Bool, maxDepth: Int = 30) throws -> [String: Any] {
        let appElement = AXUIElementCreateApplication(pid)
        var visited = 0
        guard let result = searchElement(
            element: appElement, path: [], depth: 0, maxDepth: maxDepth,
            nodesVisited: &visited,
            role: role, title: title,
            value: value, identifier: identifier, exact: exact,
            isAppRoot: true
        ) else {
            throw BridgeError.notFound("Element not found matching criteria")
        }
        return result
    }

    /// Max total nodes to visit in a single search to prevent runaway traversal on heavy DOMs
    private static let searchNodeBudget = 2000
    /// Max siblings to check per parent during search
    private static let searchSiblingCap = 100

    private func searchElement(element: AXUIElement, path: [Int], depth: Int, maxDepth: Int,
                               nodesVisited: inout Int,
                               role: String?,
                               title: String?, value: String?, identifier: String?,
                               exact: Bool, isAppRoot: Bool = false) -> [String: Any]? {
        // Bail if we've exceeded the node budget or depth limit
        nodesVisited += 1
        if nodesVisited > AccessibilityBridge.searchNodeBudget { return nil }
        if depth > maxDepth { return nil }

        // Check if this element matches
        let elementRole = getAttribute(element, kAXRoleAttribute) as? String ?? ""
        let elementSubrole = getAttribute(element, kAXSubroleAttribute) as? String ?? ""
        let elementTitle = getAttribute(element, kAXTitleAttribute) as? String ?? ""
        let elementValue = getAttribute(element, kAXValueAttribute).flatMap { "\($0)" } ?? ""
        let elementId = getAttribute(element, kAXIdentifierAttribute) as? String ?? ""
        let elementDesc = getAttribute(element, kAXDescriptionAttribute) as? String ?? ""

        var matches = true
        if let role = role {
            // Match role OR subrole — allows searching by "AXCloseButton" subrole
            let roleMatch = matchString(elementRole, role, exact: exact)
            let subroleMatch = !elementSubrole.isEmpty && matchString(elementSubrole, role, exact: exact)
            matches = matches && (roleMatch || subroleMatch)
        }
        if let title = title {
            // Match title, description, OR subrole — many elements have no title but do
            // have AXDescription or a meaningful subrole (e.g. AXCloseButton, AXMinimizeButton).
            let titleMatch = matchString(elementTitle, title, exact: exact)
            let descMatch = !elementDesc.isEmpty && matchString(elementDesc, title, exact: exact)
            let subroleMatch = !elementSubrole.isEmpty && matchString(elementSubrole, title, exact: exact)
            matches = matches && (titleMatch || descMatch || subroleMatch)
        }
        if let value = value {
            matches = matches && matchString(elementValue, value, exact: exact)
        }
        if let identifier = identifier {
            matches = matches && matchString(elementId, identifier, exact: exact)
        }

        if matches && (role != nil || title != nil || value != nil || identifier != nil) {
            var result: [String: Any] = [
                "role": elementRole,
                "title": elementTitle,
                "elementPath": path,
                "handleId": "ax_\(path.map { String($0) }.joined(separator: "_"))",
            ]
            if !elementValue.isEmpty { result["value"] = elementValue }
            if !elementId.isEmpty { result["identifier"] = elementId }
            if !elementDesc.isEmpty { result["description"] = elementDesc }
            if !elementSubrole.isEmpty { result["subrole"] = elementSubrole }

            // Get position for coordinates
            if let posValue = getAttribute(element, kAXPositionAttribute) {
                var point = CGPoint.zero
                if AXValueGetValue(posValue as! AXValue, .cgPoint, &point) {
                    if let sizeValue = getAttribute(element, kAXSizeAttribute) {
                        var size = CGSize.zero
                        if AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) {
                            result["bounds"] = [
                                "x": Double(point.x), "y": Double(point.y),
                                "width": Double(size.width), "height": Double(size.height)
                            ]
                        }
                    }
                }
            }

            return result
        }

        // Search children (with breadth + depth + budget limits)
        if depth < maxDepth {
            if let children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                for (index, child) in children.enumerated() {
                    if index >= AccessibilityBridge.searchSiblingCap { break }
                    if nodesVisited > AccessibilityBridge.searchNodeBudget { break }
                    // Skip self-referential AXApplication children at app root
                    if isAppRoot {
                        let childRole = getAttribute(child, kAXRoleAttribute) as? String ?? ""
                        if childRole == "AXApplication" { continue }
                    }
                    var childPath = path
                    childPath.append(index)
                    if let found = searchElement(
                        element: child, path: childPath, depth: depth + 1, maxDepth: maxDepth,
                        nodesVisited: &nodesVisited,
                        role: role, title: title,
                        value: value, identifier: identifier, exact: exact
                    ) {
                        return found
                    }
                }
            }
        }

        return nil
    }

    // MARK: - Actions

    func performAction(pid: pid_t, elementPath: [Int], action: String, expectedTitle: String? = nil) throws {
        let element = try resolveElement(pid: pid, path: elementPath, expectedTitle: expectedTitle)
        let result = AXUIElementPerformAction(element, action as CFString)
        if result != .success {
            throw BridgeError.general("AX action '\(action)' failed with code \(result.rawValue)")
        }
    }

    func setElementValue(pid: pid_t, elementPath: [Int], value: String) throws {
        let element = try resolveElement(pid: pid, path: elementPath)
        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
        if result != .success {
            // Try focused approach: set focus then type
            let focusResult = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
            if focusResult != .success {
                throw BridgeError.general("Cannot focus element for value set, code \(focusResult.rawValue)")
            }
            // Use CG to type the value — PID-targeted to the correct process
            CoreGraphicsBridge().typeText(text: value, targetPid: pid)
        }
        // Verify the value was actually set — some apps (Notes, etc.) silently ignore AXSetValue
        usleep(50_000) // 50ms settle time
        let readBack = getAttribute(element, kAXValueAttribute).flatMap { "\($0)" } ?? ""
        if !readBack.contains(value.prefix(20)) && readBack != value {
            throw BridgeError.general("Value set reported success but verification failed — element still shows \"\(String(readBack.prefix(60)))\" instead of \"\(String(value.prefix(60)))\". This element may not support programmatic value changes.")
        }
    }

    func getElementValue(pid: pid_t, elementPath: [Int]) throws -> [String: Any] {
        let element = try resolveElement(pid: pid, path: elementPath)
        let value = getAttribute(element, kAXValueAttribute)
        return ["value": value.flatMap { "\($0)" } ?? ""]
    }

    // MARK: - Menu Click

    func menuClick(pid: pid_t, menuPath: [String]) throws {
        guard !menuPath.isEmpty else {
            throw BridgeError.missingParam("menuPath must not be empty")
        }

        let appElement = AXUIElementCreateApplication(pid)
        guard let menuBar = getAttribute(appElement, kAXMenuBarAttribute) as AnyObject? else {
            throw BridgeError.notFound("Menu bar not found")
        }
        let menuBarElement = menuBar as! AXUIElement

        var currentElement: AXUIElement = menuBarElement

        for menuItem in menuPath {
            guard let children = getAttribute(currentElement, kAXChildrenAttribute) as? [AXUIElement] else {
                throw BridgeError.notFound("No children found in menu for '\(menuItem)'")
            }

            var found = false
            // Strip invisible Unicode direction marks (LTR U+200E, RTL U+200F, etc.)
            // that apps like WhatsApp prepend to menu titles.
            let cleanItem = menuItem.filter { !$0.unicodeScalars.allSatisfy { s in
                (0x200B...0x200F).contains(s.value) || (0x2028...0x202F).contains(s.value) ||
                (0xFEFF...0xFEFF).contains(s.value)
            }}
            for child in children {
                let rawTitle = getAttribute(child, kAXTitleAttribute) as? String ?? ""
                let title = rawTitle.filter { !$0.unicodeScalars.allSatisfy { s in
                    (0x200B...0x200F).contains(s.value) || (0x2028...0x202F).contains(s.value) ||
                    (0xFEFF...0xFEFF).contains(s.value)
                }}
                if title == cleanItem || rawTitle == menuItem {
                    // Press this menu item to open it (for submenus) or activate it
                    AXUIElementPerformAction(child, kAXPressAction as CFString)

                    // Poll for children to appear (max 500ms, 50ms intervals)
                    // instead of a fixed 100ms sleep
                    let pollDeadline = Date().addingTimeInterval(0.5)
                    var submenuResolved = false
                    while Date() < pollDeadline {
                        if let submenu = getAttribute(child, kAXChildrenAttribute) as? [AXUIElement],
                           let firstChild = submenu.first {
                            currentElement = firstChild
                            submenuResolved = true
                            break
                        }
                        Thread.sleep(forTimeInterval: 0.05)
                    }

                    // If no submenu appeared after polling, still check once more
                    if !submenuResolved {
                        if let submenu = getAttribute(child, kAXChildrenAttribute) as? [AXUIElement],
                           let firstChild = submenu.first {
                            currentElement = firstChild
                        }
                    }

                    found = true
                    break
                }
            }

            if !found {
                throw BridgeError.notFound("Menu item '\(menuItem)' not found")
            }
        }
    }

    // MARK: - Helpers

    private func resolveElement(pid: pid_t, path: [Int], expectedTitle: String? = nil) throws -> AXUIElement {
        var current = AXUIElementCreateApplication(pid) as AXUIElement
        for index in path {
            guard let children = getAttribute(current, kAXChildrenAttribute) as? [AXUIElement] else {
                throw BridgeError.notFound("No children at path index \(index)")
            }
            guard index < children.count else {
                throw BridgeError.notFound("Index \(index) out of bounds (count: \(children.count))")
            }
            current = children[index]
        }
        // Verify the resolved element still matches the expected identity
        if let expected = expectedTitle {
            let actualTitle = getAttribute(current, kAXTitleAttribute) as? String ?? ""
            let actualDesc = getAttribute(current, kAXDescriptionAttribute) as? String ?? ""
            if actualTitle != expected && actualDesc != expected {
                throw BridgeError.general("Element at path has changed: expected '\(expected)' but found '\(actualTitle.isEmpty ? actualDesc : actualTitle)'")
            }
        }
        return current
    }

    func getAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return result == .success ? value : nil
    }

    private func matchString(_ haystack: String, _ needle: String, exact: Bool) -> Bool {
        if exact {
            return haystack == needle
        }
        return haystack.localizedCaseInsensitiveContains(needle)
    }
}
