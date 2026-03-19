// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { BridgeClient } from "../native/bridge-client.js";
import type { MenuScanResult, MenuNode, MenuItem } from "./types.js";

/**
 * MenuScanner — scans an app's menu bar via AX tree, extracting
 * all menu paths, keyboard shortcuts, and enabled/disabled states.
 *
 * Uses the native bridge to walk the AXMenuBar subtree.
 */
export class MenuScanner {
  constructor(private readonly bridge: BridgeClient) {}

  /**
   * Scan the menu bar of a running app.
   */
  async scan(pid: number, bundleId: string, appName: string): Promise<MenuScanResult> {
    const tree = await this.bridge.call("ax.getMenuBar", {
      pid,
      maxDepth: 10,
    });

    const menuTree = this.parseAXTree(tree);
    const items = this.flattenTree(menuTree, []);
    const shortcuts: Record<string, string> = {};

    for (const item of items) {
      if (item.shortcut) {
        shortcuts[item.path.join(".")] = item.shortcut;
      }
    }

    return {
      bundleId,
      appName,
      totalMenus: menuTree.length,
      totalItems: items.length,
      shortcuts,
      menuTree,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Convert scan result to reference JSON format (shortcuts + flows sections).
   */
  toReferenceFormat(result: MenuScanResult): {
    shortcuts: Record<string, Record<string, string>>;
    menuPaths: string[];
  } {
    const shortcuts: Record<string, Record<string, string>> = {};
    const menuPaths: string[] = [];

    for (const topMenu of result.menuTree) {
      const category = topMenu.title;
      const items = this.flattenTree([topMenu], []);

      for (const item of items) {
        menuPaths.push(item.path.join(" > "));
        if (item.shortcut) {
          if (!shortcuts[category]) shortcuts[category] = {};
          shortcuts[category]![item.title] = item.shortcut;
        }
      }
    }

    return { shortcuts, menuPaths };
  }

  /**
   * Parse raw AX tree response into MenuNode tree.
   */
  private parseAXTree(tree: any): MenuNode[] {
    if (!tree || !Array.isArray(tree.children)) return [];

    const nodes: MenuNode[] = [];
    for (const child of tree.children) {
      const node = this.parseNode(child);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  private parseNode(axNode: any): MenuNode | null {
    if (!axNode) return null;

    const role = axNode.role ?? axNode.AXRole ?? "";
    const title =
      axNode.title ??
      axNode.AXTitle ??
      axNode.description ??
      axNode.AXDescription ??
      "";

    // Skip separators
    if (role === "AXSeparator" || title === "separator") return null;

    const shortcut = this.extractShortcut(axNode);
    const enabled = axNode.enabled !== false && axNode.AXEnabled !== false;
    const children: MenuNode[] = [];

    if (Array.isArray(axNode.children)) {
      for (const child of axNode.children) {
        const childNode = this.parseNode(child);
        if (childNode) children.push(childNode);
      }
    }

    // AXMenu containers have no title but hold the actual menu items as children.
    // Pass through their children instead of dropping the entire subtree.
    if (!title && children.length > 0) {
      return { title: role, shortcut: null, enabled: true, children };
    }

    // Skip leaf nodes with no title (not containers, not useful)
    if (!title) return null;

    return {
      title: String(title),
      shortcut,
      enabled,
      children,
    };
  }

  /**
   * Extract keyboard shortcut from AX node attributes.
   */
  private extractShortcut(axNode: any): string | null {
    // macOS AX provides shortcuts via AXMenuItemCmdChar, AXMenuItemCmdModifiers
    const cmdChar = axNode.AXMenuItemCmdChar ?? axNode.cmdChar ?? null;
    const cmdModifiers =
      axNode.AXMenuItemCmdModifiers ?? axNode.cmdModifiers ?? 0;

    if (!cmdChar) return null;

    const parts: string[] = [];
    // Modifier masks: Control=4, Option=2, Shift=1, Cmd=0 (always present)
    if (cmdModifiers & 4) parts.push("Ctrl");
    if (cmdModifiers & 2) parts.push("Option");
    if (cmdModifiers & 1) parts.push("Shift");
    parts.push("Cmd");
    parts.push(String(cmdChar));

    return parts.join("+");
  }

  /**
   * Flatten tree to list of items with full paths.
   */
  private flattenTree(nodes: MenuNode[], parentPath: string[]): MenuItem[] {
    const items: MenuItem[] = [];

    for (const node of nodes) {
      const path = [...parentPath, node.title];
      items.push({
        path,
        title: node.title,
        shortcut: node.shortcut,
        enabled: node.enabled,
        hasSubmenu: node.children.length > 0,
      });

      if (node.children.length > 0) {
        items.push(...this.flattenTree(node.children, path));
      }
    }

    return items;
  }
}
