// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from "vitest";
import { MenuScanner } from "../src/ingestion/menu-scanner.js";
import type { BridgeClient } from "../src/native/bridge-client.js";

function makeMockBridge(tree: any): BridgeClient {
  return {
    call: vi.fn().mockImplementation((method: string) => {
      if (method === "ax.getMenuBar") return Promise.resolve(tree);
      return Promise.resolve(null);
    }),
  } as unknown as BridgeClient;
}

const MOCK_AX_TREE = {
  role: "AXMenuBar",
  children: [
    {
      role: "AXMenuBarItem",
      title: "File",
      children: [
        { role: "AXMenuItem", title: "New", AXMenuItemCmdChar: "N", AXMenuItemCmdModifiers: 0, children: [] },
        { role: "AXMenuItem", title: "Open", AXMenuItemCmdChar: "O", AXMenuItemCmdModifiers: 0, children: [] },
        { role: "AXSeparator", children: [] },
        {
          role: "AXMenuItem",
          title: "Export",
          children: [
            { role: "AXMenuItem", title: "Media", AXMenuItemCmdChar: "M", AXMenuItemCmdModifiers: 0, children: [] },
            { role: "AXMenuItem", title: "Frame", AXMenuItemCmdChar: "F", AXMenuItemCmdModifiers: 1, children: [] },
          ],
        },
      ],
    },
    {
      role: "AXMenuBarItem",
      title: "Edit",
      children: [
        { role: "AXMenuItem", title: "Undo", AXMenuItemCmdChar: "Z", AXMenuItemCmdModifiers: 0, children: [] },
        { role: "AXMenuItem", title: "Redo", AXMenuItemCmdChar: "Z", AXMenuItemCmdModifiers: 1, children: [] },
        { role: "AXMenuItem", title: "Copy", AXMenuItemCmdChar: "C", AXMenuItemCmdModifiers: 0, children: [] },
      ],
    },
  ],
};

describe("MenuScanner", () => {
  it("extracts menu hierarchy from AX tree", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");

    expect(result.bundleId).toBe("com.test.app");
    expect(result.appName).toBe("TestApp");
    expect(result.totalMenus).toBe(2); // File, Edit
    expect(result.totalItems).toBeGreaterThan(5);
  });

  it("identifies keyboard shortcuts", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");

    expect(Object.keys(result.shortcuts).length).toBeGreaterThan(0);
    // File.New should have Cmd+N
    expect(result.shortcuts["File.New"]).toBe("Cmd+N");
    // Edit.Undo should have Cmd+Z
    expect(result.shortcuts["Edit.Undo"]).toBe("Cmd+Z");
  });

  it("detects modifier keys (Shift)", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");

    // Edit.Redo has Shift modifier (1)
    expect(result.shortcuts["Edit.Redo"]).toBe("Shift+Cmd+Z");
    // Export > Frame has Shift modifier
    expect(result.shortcuts["File.Export.Frame"]).toBe("Shift+Cmd+F");
  });

  it("handles nested submenus", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");

    // Export > Media should be in shortcuts
    expect(result.shortcuts["File.Export.Media"]).toBe("Cmd+M");
  });

  it("converts to reference format", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");
    const ref = scanner.toReferenceFormat(result);

    expect(ref.shortcuts).toBeDefined();
    expect(ref.menuPaths.length).toBeGreaterThan(0);
    expect(ref.shortcuts["File"]).toBeDefined();
    expect(ref.shortcuts["Edit"]).toBeDefined();
  });

  it("skips separators", async () => {
    const bridge = makeMockBridge(MOCK_AX_TREE);
    const scanner = new MenuScanner(bridge);
    const result = await scanner.scan(1234, "com.test.app", "TestApp");

    // Should not include separator as a menu item
    const allTitles = result.menuTree.flatMap(function flatten(n: any): string[] {
      return [n.title, ...(n.children ?? []).flatMap(flatten)];
    });
    expect(allTitles).not.toContain("separator");
  });
});
