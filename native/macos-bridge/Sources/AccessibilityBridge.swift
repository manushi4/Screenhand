import ApplicationServices
import AppKit
import Foundation

class AccessibilityBridge {

    func isAccessibilityTrusted() -> Bool {
        return AXIsProcessTrusted()
    }

    // MARK: - Element Tree

    func getElementTree(pid: pid_t, maxDepth: Int) throws -> [String: Any] {
        let appElement = AXUIElementCreateApplication(pid)
        return try buildTree(element: appElement, depth: 0, maxDepth: maxDepth)
    }

    private func buildTree(element: AXUIElement, depth: Int, maxDepth: Int) throws -> [String: Any] {
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

        // Children (if not at max depth)
        if depth < maxDepth {
            if let children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                var childNodes: [[String: Any]] = []
                for (index, child) in children.enumerated() {
                    if index > 100 { break } // Safety limit
                    if let childNode = try? buildTree(element: child, depth: depth + 1, maxDepth: maxDepth) {
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

    // MARK: - Find Element

    func findElement(pid: pid_t, role: String?, title: String?, value: String?,
                     identifier: String?, exact: Bool) throws -> [String: Any] {
        let appElement = AXUIElementCreateApplication(pid)
        guard let result = searchElement(
            element: appElement, path: [], role: role, title: title,
            value: value, identifier: identifier, exact: exact
        ) else {
            throw BridgeError.notFound("Element not found matching criteria")
        }
        return result
    }

    private func searchElement(element: AXUIElement, path: [Int], role: String?,
                               title: String?, value: String?, identifier: String?,
                               exact: Bool) -> [String: Any]? {
        // Check if this element matches
        let elementRole = getAttribute(element, kAXRoleAttribute) as? String ?? ""
        let elementTitle = getAttribute(element, kAXTitleAttribute) as? String ?? ""
        let elementValue = getAttribute(element, kAXValueAttribute).flatMap { "\($0)" } ?? ""
        let elementId = getAttribute(element, kAXIdentifierAttribute) as? String ?? ""

        var matches = true
        if let role = role {
            matches = matches && matchString(elementRole, role, exact: exact)
        }
        if let title = title {
            matches = matches && matchString(elementTitle, title, exact: exact)
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

        // Search children
        if let children = getAttribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            for (index, child) in children.enumerated() {
                var childPath = path
                childPath.append(index)
                if let found = searchElement(
                    element: child, path: childPath, role: role, title: title,
                    value: value, identifier: identifier, exact: exact
                ) {
                    return found
                }
            }
        }

        return nil
    }

    // MARK: - Actions

    func performAction(pid: pid_t, elementPath: [Int], action: String) throws {
        let element = try resolveElement(pid: pid, path: elementPath)
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
            // Use CG to type the value
            CoreGraphicsBridge().typeText(text: value)
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
            for child in children {
                let title = getAttribute(child, kAXTitleAttribute) as? String ?? ""
                if title == menuItem {
                    // Press this menu item to open it (for submenus) or activate it
                    AXUIElementPerformAction(child, kAXPressAction as CFString)
                    // Small delay for menu to open
                    Thread.sleep(forTimeInterval: 0.1)

                    // If there are more items in the path, navigate into the submenu
                    if let submenu = getAttribute(child, kAXChildrenAttribute) as? [AXUIElement],
                       let firstChild = submenu.first {
                        currentElement = firstChild
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

    private func resolveElement(pid: pid_t, path: [Int]) throws -> AXUIElement {
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
        return current
    }

    private func getAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
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
