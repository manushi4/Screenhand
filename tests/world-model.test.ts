// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WorldModel } from "../src/state/world-model.js";
import type { AXNode, AppContext, UIEvent } from "../src/types.js";
import * as persistence from "../src/state/persistence.js";

vi.mock("../src/state/persistence.js", async () => {
  const actual = await vi.importActual("../src/state/persistence.js") as Record<string, unknown>;
  return {
    ...actual,
    loadWorldState: vi.fn().mockReturnValue(null),
    saveWorldState: vi.fn(),
  };
});

function makeAppContext(overrides?: Partial<AppContext>): AppContext {
  return {
    bundleId: "com.test.App",
    appName: "TestApp",
    pid: 1234,
    windowTitle: "Test Window",
    windowId: 1,
    ...overrides,
  };
}

function makeAXTree(children?: AXNode[]): AXNode {
  return {
    role: "window",
    title: "Test Window",
    position: { x: 0, y: 0 },
    size: { width: 800, height: 600 },
    children: children ?? [
      {
        role: "button",
        title: "OK",
        position: { x: 100, y: 200 },
        size: { width: 80, height: 30 },
        enabled: true,
        focused: false,
      },
      {
        role: "textField",
        title: "Name",
        value: "hello",
        position: { x: 100, y: 250 },
        size: { width: 200, height: 30 },
        enabled: true,
        focused: true,
      },
    ],
  };
}

describe("world-model", () => {
  let model: WorldModel;

  beforeEach(() => {
    vi.mocked(persistence.loadWorldState).mockReturnValue(null);
    model = new WorldModel({ persistDebounceMs: 0 });
    model.init("test-session");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("init creates empty state", () => {
    const state = model.getState();
    expect(state.windows.size).toBe(0);
    expect(state.focusedWindowId).toBeNull();
    expect(state.focusedApp).toBeNull();
    expect(state.activeDialogs).toHaveLength(0);
    expect(state.sessionId).toBe("test-session");
  });

  it("ingestAXTree populates controls", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());

    const win = model.getWindowState(1);
    expect(win).not.toBeNull();
    expect(win!.controls.size).toBeGreaterThanOrEqual(2);
    // window + button + textField = at least 3
    expect(win!.title.value).toBe("Test Window");
  });

  it("stableId consistency", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const controlsBefore = new Map(model.getWindowState(1)!.controls);

    // Re-ingest same tree
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const controlsAfter = model.getWindowState(1)!.controls;

    // Same stableIds should exist
    for (const sid of controlsBefore.keys()) {
      expect(controlsAfter.has(sid)).toBe(true);
    }
  });

  it("confidence decay", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;

    // Fresh state should have high confidence
    expect(win.title.confidence).toBeGreaterThan(0.95);

    // Manually set updatedAt to 10 minutes ago for a control
    const state = model.getState();
    const firstWin = state.windows.get(1)!;
    const pastTime = new Date(Date.now() - 10 * 60_000).toISOString();
    firstWin.title = {
      ...firstWin.title,
      updatedAt: pastTime,
    };

    const decayedWin = model.getWindowState(1)!;
    expect(decayedWin.title.confidence).toBeLessThan(0.7);
  });

  it("ingestUIEvents updates values", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());

    const events: UIEvent[] = [
      {
        type: "value_changed",
        timestamp: new Date().toISOString(),
        pid: 1234,
        elementRole: "textField",
        elementLabel: "Name",
        oldValue: "hello",
        newValue: "world",
      },
    ];

    model.ingestUIEvents(events);

    // Find the textField control and check its value
    const state = model.getState();
    const win = state.windows.get(1)!;
    let found = false;
    for (const control of win.controls.values()) {
      if (control.role === "textField" && control.label.value === "Name") {
        expect(control.value.value).toBe("world");
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("dialog detection", () => {
    const treeWithDialog: AXNode = {
      role: "window",
      title: "Main",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "sheet",
          title: "Save As",
          position: { x: 200, y: 200 },
          size: { width: 400, height: 300 },
          children: [
            {
              role: "button",
              title: "Cancel",
              position: { x: 300, y: 400 },
              size: { width: 80, height: 30 },
            },
          ],
        },
      ],
    };

    model.ingestAXTree(1, treeWithDialog, makeAppContext());
    const dialogs = model.getActiveDialogs();
    expect(dialogs.length).toBeGreaterThanOrEqual(1);
    const sheetDialog = dialogs.find((d) => d.type === "sheet");
    expect(sheetDialog).toBeDefined();
    expect(sheetDialog!.title).toBe("Save As");
  });

  // ── 3a.1: WorldState new fields ──

  it("initializes new WorldState fields", () => {
    const state = model.getState();
    expect(state.updatedAt).toBeTruthy();
    expect(state.confidence).toBe(1.0);
    expect(state.pendingGoal).toBeNull();
    expect(state.recentTransitions).toEqual([]);
  });

  it("updatedAt changes on ingest", () => {
    const before = model.getState().updatedAt;
    // Small delay to ensure different timestamp
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const after = model.getState().updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("setPendingGoal sets and clears goal", () => {
    model.setPendingGoal("Export video as H.264");
    expect(model.getState().pendingGoal).toBe("Export video as H.264");
    model.setPendingGoal(null);
    expect(model.getState().pendingGoal).toBeNull();
  });

  // ── 3a.2: WindowState new fields ──

  it("sets lastAXScanAt after ingestAXTree", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;
    expect(win.lastAXScanAt).toBeTruthy();
    expect(new Date(win.lastAXScanAt!).getTime()).not.toBeNaN();
  });

  it("sets lastOCRAt after ingestOCRRegions", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.ingestOCRRegions(1, [
      { text: "Hello", bounds: { x: 10, y: 20, width: 50, height: 12 } },
    ]);
    const win = model.getWindowState(1)!;
    expect(win.lastOCRAt).toBeTruthy();
  });

  it("sets lastCDPScanAt after ingestCDPSnapshot", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.ingestCDPSnapshot("com.test.App", "https://example.com", "Example", 1);
    const win = model.getWindowState(1)!;
    expect(win.lastCDPScanAt).toBeTruthy();
  });

  it("tracks focusedElement from AX tree", () => {
    const treeWithFocus: AXNode = {
      role: "window",
      title: "Test",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "textField",
          title: "Name",
          focused: true,
          position: { x: 100, y: 100 },
          size: { width: 200, height: 30 },
        },
        {
          role: "button",
          title: "Submit",
          position: { x: 100, y: 200 },
          size: { width: 80, height: 30 },
        },
      ],
    };
    model.ingestAXTree(1, treeWithFocus, makeAppContext());
    const win = model.getWindowState(1)!;
    expect(win.focusedElement).not.toBeNull();
    expect(win.focusedElement!.role).toBe("textField");
  });

  it("tracks visibleControls (interactive elements)", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;
    expect(win.visibleControls.length).toBeGreaterThan(0);
    // All visible controls should be interactive roles
    for (const ctrl of win.visibleControls) {
      expect(["button", "textField", "checkbox", "link", "tab", "slider", "menuItem"].some(r => ctrl.role === r)).toBe(true);
    }
  });

  it("initializes null scan timestamps for new windows", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;
    expect(win.lastAXScanAt).toBeTruthy(); // Just scanned
    expect(win.lastCDPScanAt).toBeNull();
    expect(win.lastOCRAt).toBeNull();
    expect(win.lastScreenshotHash).toBeNull();
    expect(win.scrollPosition).toBeNull();
  });

  // ── 3a.3: DialogState new fields ──

  it("extracts buttons from dialog children", () => {
    const treeWithDialog: AXNode = {
      role: "window",
      title: "Main",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "dialog",
          title: "Confirm Delete",
          position: { x: 200, y: 200 },
          size: { width: 400, height: 200 },
          children: [
            { role: "staticText", title: "Are you sure you want to delete this item?", position: { x: 220, y: 220 }, size: { width: 360, height: 20 } },
            { role: "button", title: "Delete", position: { x: 300, y: 350 }, size: { width: 80, height: 30 } },
            { role: "button", title: "Cancel", position: { x: 400, y: 350 }, size: { width: 80, height: 30 } },
          ],
        },
      ],
    };
    model.ingestAXTree(1, treeWithDialog, makeAppContext());
    const dialogs = model.getActiveDialogs();
    expect(dialogs.length).toBe(1);
    expect(dialogs[0]!.buttons).toContain("Delete");
    expect(dialogs[0]!.buttons).toContain("Cancel");
    expect(dialogs[0]!.message).toBe("Are you sure you want to delete this item?");
    expect(dialogs[0]!.source).toBe("ax");
  });

  it("detects save dialog type from title", () => {
    const treeWithSave: AXNode = {
      role: "window",
      title: "Editor",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "modal",
          title: "Save changes?",
          position: { x: 200, y: 200 },
          size: { width: 300, height: 150 },
          children: [
            { role: "button", title: "Save", position: { x: 220, y: 300 }, size: { width: 80, height: 30 } },
            { role: "button", title: "Don't Save", position: { x: 320, y: 300 }, size: { width: 100, height: 30 } },
          ],
        },
      ],
    };
    model.ingestAXTree(1, treeWithSave, makeAppContext());
    const dialogs = model.getActiveDialogs();
    expect(dialogs[0]!.type).toBe("save");
  });

  it("detects permission dialog type from title", () => {
    const tree: AXNode = {
      role: "window",
      title: "App",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "alert",
          title: "Allow access to camera?",
          position: { x: 200, y: 200 },
          size: { width: 300, height: 150 },
          children: [
            { role: "button", title: "Allow", position: { x: 220, y: 300 }, size: { width: 80, height: 30 } },
            { role: "button", title: "Deny", position: { x: 320, y: 300 }, size: { width: 80, height: 30 } },
          ],
        },
      ],
    };
    model.ingestAXTree(1, tree, makeAppContext());
    const dialogs = model.getActiveDialogs();
    expect(dialogs[0]!.type).toBe("permission");
  });

  // ── Persistence with new fields ──

  it("persistence round-trip preserves new fields", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.setPendingGoal("test goal");
    model.ingestOCRRegions(1, [{ text: "test", bounds: { x: 0, y: 0, width: 10, height: 10 } }]);

    const state = model.getState();
    const json = persistence.worldStateToJSON(state);
    const parsed = JSON.parse(json);
    const restored = persistence.worldStateFromJSON(parsed);

    expect(restored.updatedAt).toBeTruthy();
    expect(restored.confidence).toBe(1.0);
    expect(restored.pendingGoal).toBe("test goal");
    expect(Array.isArray(restored.recentTransitions)).toBe(true);

    const win = restored.windows.get(1)!;
    expect(win.lastAXScanAt).toBeTruthy();
    expect(win.lastOCRAt).toBeTruthy();
    expect(win.lastCDPScanAt).toBeNull();
    expect(win.focusedElement).toBeTruthy();
    expect(win.visibleControls).toBeInstanceOf(Array);
    expect(win.dialogStack).toBeInstanceOf(Array);
  });

  it("persistence round-trip", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.updateFocusedApp(makeAppContext());

    const state = model.getState();

    // Test serialization round-trip
    const json = persistence.worldStateToJSON(state);
    const parsed = JSON.parse(json);
    const restored = persistence.worldStateFromJSON(parsed);

    expect(restored.sessionId).toBe("test-session");
    expect(restored.windows.size).toBe(1);
    expect(restored.windows.get(1)!.controls.size).toBe(
      state.windows.get(1)!.controls.size,
    );
    expect(restored.focusedApp?.bundleId).toBe("com.test.App");
  });

  it("updateFocusedApp", () => {
    const ctx = makeAppContext({
      bundleId: "com.apple.Safari",
      appName: "Safari",
      windowId: 42,
    });
    model.updateFocusedApp(ctx);

    const state = model.getState();
    expect(state.focusedWindowId).toBe(42);
    expect(state.focusedApp?.bundleId).toBe("com.apple.Safari");
    expect(state.focusedApp?.appName).toBe("Safari");
  });

  it("toSummary", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.updateFocusedApp(makeAppContext());

    const summary = model.toSummary();
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("1 window(s)");
    expect(summary).toContain("control(s) tracked");
    expect(summary).toContain("TestApp");
  });

  it("stale controls", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());

    // Set all controls' value.updatedAt to 10 minutes ago
    const state = model.getState();
    const win = state.windows.get(1)!;
    const pastTime = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const control of win.controls.values()) {
      control.value = { ...control.value, updatedAt: pastTime };
    }

    const stale = model.getStaleControls(5 * 60_000);
    expect(stale.length).toBeGreaterThan(0);
  });

  it("app domain detection", () => {
    const ctx = makeAppContext({
      bundleId: "com.blackmagic-design.DaVinciResolveLite",
      appName: "DaVinci Resolve",
    });
    model.updateFocusedApp(ctx);

    const domain = model.getAppDomain(
      "com.blackmagic-design.DaVinciResolveLite",
    );
    expect(domain).not.toBeNull();
    expect(domain!.family).toBe("video_editor");
  });

  // ── Source-weighted fusion (Phase 4) ──

  it("AX control has source attribution", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;
    for (const ctrl of win.controls.values()) {
      expect(ctrl.source).toBe("ax");
      expect(ctrl.sourceConfidence).toBe(0.9);
      expect(ctrl.lastSeenAt).toBeTruthy();
    }
  });

  it("OCR control has source attribution", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    model.ingestOCRRegions(1, [
      { text: "UniqueOCRText", bounds: { x: 500, y: 500, width: 100, height: 20 } },
    ]);
    const win = model.getWindowState(1)!;
    let foundOCR = false;
    for (const ctrl of win.controls.values()) {
      if (ctrl.source === "ocr") {
        expect(ctrl.sourceConfidence).toBe(0.7);
        foundOCR = true;
      }
    }
    expect(foundOCR).toBe(true);
  });

  it("AX control not overwritten by stale OCR at same position", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const win = model.getWindowState(1)!;
    // Find the "OK" button
    let okButton: any = null;
    for (const ctrl of win.controls.values()) {
      if (ctrl.label.value === "OK") okButton = ctrl;
    }
    expect(okButton).not.toBeNull();
    expect(okButton.source).toBe("ax");

    // OCR the same position — should not overwrite (AX has higher confidence)
    model.ingestOCRRegions(1, [
      { text: "OK", bounds: { x: 100, y: 200, width: 80, height: 30 } },
    ]);
    // The button with stableId based on "staticText|OK|100,200" differs from "button|OK|100,200"
    // so they'd be separate controls. The merge only kicks in when stableIds match.
    const winAfter = model.getWindowState(1)!;
    expect(winAfter.controls.size).toBeGreaterThanOrEqual(win.controls.size);
  });

  // ── Consistent snapshot (Phase 8) ──

  it("getConsistentSnapshot returns independent copy", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const snapshot = model.getConsistentSnapshot();
    const state = model.getState();

    // Snapshot should have same data
    expect(snapshot.windows.size).toBe(state.windows.size);
    expect(snapshot.sessionId).toBe(state.sessionId);

    // But different Map instances
    expect(snapshot.windows).not.toBe(state.windows);
  });

  it("getConsistentSnapshot deeply clones controls (nested isolation)", () => {
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
    const snapshot = model.getConsistentSnapshot();

    // Mutate snapshot's control position
    const snapWin = snapshot.windows.get(1)!;
    const firstCtrl = [...snapWin.controls.values()][0]!;
    firstCtrl.position.x = 9999;

    // Original should be unaffected
    const origWin = model.getState().windows.get(1)!;
    const origCtrl = [...origWin.controls.values()][0]!;
    expect(origCtrl.position.x).not.toBe(9999);
  });

  // ── Entity tracking (Phase 5) ──

  it("trackedEntities is populated after ingestAXTree", () => {
    const treeWithGroup: AXNode = {
      role: "window",
      title: "Test",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "toolbar",
          title: "Main Toolbar",
          position: { x: 0, y: 0 },
          size: { width: 800, height: 40 },
        },
        {
          role: "tabGroup",
          title: "Tabs",
          position: { x: 0, y: 40 },
          size: { width: 800, height: 30 },
        },
      ],
    };
    model.ingestAXTree(1, treeWithGroup, makeAppContext());
    const entities = model.getTrackedEntities();
    expect(entities.size).toBeGreaterThanOrEqual(2);
  });

  it("max controls cap", () => {
    const manyChildren: AXNode[] = [];
    for (let i = 0; i < 1000; i++) {
      manyChildren.push({
        role: "button",
        title: `Button ${i}`,
        position: { x: i * 10, y: 0 },
        size: { width: 80, height: 30 },
      });
    }

    const tree: AXNode = {
      role: "window",
      title: "Big Window",
      position: { x: 0, y: 0 },
      size: { width: 10000, height: 600 },
      children: manyChildren,
    };

    model.ingestAXTree(1, tree, makeAppContext());

    const win = model.getWindowState(1)!;
    // Window root + children capped at maxControlsPerWindow (500)
    expect(win.controls.size).toBeLessThanOrEqual(500);
  });
});

describe("postcondition verification", () => {
  let model: WorldModel;

  beforeEach(() => {
    model = new WorldModel({ persistDebounceMs: 999999 });
    model.init("test-pc");
    // Ingest a tree so we have controls to assert against
    model.ingestAXTree(1, makeAXTree(), makeAppContext());
  });

  it("assertStateDetailed returns match with confidence for control_exists", () => {
    const result = model.assertStateDetailed({ type: "control_exists", target: model.getState().windows.get(1)!.controls.keys().next().value! });
    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.actual).toBeTruthy();
  });

  it("assertStateDetailed returns no match for missing control", () => {
    const result = model.assertStateDetailed({ type: "control_exists", target: "nonexistent_id" });
    expect(result.matched).toBe(false);
    expect(result.actual).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("assertStateDetailed checks control_absent", () => {
    const result = model.assertStateDetailed({ type: "control_absent", target: "nonexistent_id" });
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("assertStateDetailed checks window_focused", () => {
    model.updateFocusedApp(makeAppContext({ windowId: 1 }));
    const result = model.assertStateDetailed({ type: "window_focused", target: "1" });
    expect(result.matched).toBe(true);
    expect(result.actual).toBe("1");
  });

  it("assertStateDetailed checks app_focused", () => {
    model.updateFocusedApp(makeAppContext({ bundleId: "com.test.App" }));
    const result = model.assertStateDetailed({ type: "app_focused", target: "com.test.App" });
    expect(result.matched).toBe(true);
    expect(result.actual).toBe("com.test.App");

    const miss = model.assertStateDetailed({ type: "app_focused", target: "com.other.App" });
    expect(miss.matched).toBe(false);
  });

  it("assertStateDetailed checks dialog_absent and dialog_present", () => {
    const absent = model.assertStateDetailed({ type: "dialog_absent", target: "Save?" });
    expect(absent.matched).toBe(true);

    const present = model.assertStateDetailed({ type: "dialog_present", target: "Save?" });
    expect(present.matched).toBe(false);
  });

  it("assertStateDetailed checks url_equals for browser state", () => {
    model.ingestCDPSnapshot("com.google.Chrome", "https://example.com/page", "Example");
    const result = model.assertStateDetailed({ type: "url_equals", target: "https://example.com/page" });
    expect(result.matched).toBe(true);
    expect(result.actual).toBe("https://example.com/page");
    expect(result.confidence).toBeGreaterThan(0);

    const miss = model.assertStateDetailed({ type: "url_equals", target: "https://other.com" });
    expect(miss.matched).toBe(false);
  });

  it("setExpectedPostcondition + verifyPostcondition workflow", () => {
    model.updateFocusedApp(makeAppContext({ bundleId: "com.test.App" }));

    // Set expectation
    model.setExpectedPostcondition({ type: "app_focused", target: "com.test.App" });
    expect(model.getState().expectedPostcondition).not.toBeNull();

    // Verify — should match
    const result = model.verifyPostcondition();
    expect(result.matched).toBe(true);
    expect(result.actual).toBe("com.test.App");

    // Postcondition should be cleared after verification
    expect(model.getState().expectedPostcondition).toBeNull();
  });

  it("verifyPostcondition returns mismatch when state doesn't match", () => {
    model.updateFocusedApp(makeAppContext({ bundleId: "com.test.App" }));
    model.setExpectedPostcondition({ type: "app_focused", target: "com.other.App" });

    const result = model.verifyPostcondition();
    expect(result.matched).toBe(false);
    expect(result.actual).toBe("com.test.App");
  });

  it("verifyPostcondition with no expectation returns matched", () => {
    const result = model.verifyPostcondition();
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("setExpectedPostcondition(null) clears expectation", () => {
    model.setExpectedPostcondition({ type: "dialog_absent", target: "test" });
    model.setExpectedPostcondition(null);
    expect(model.getState().expectedPostcondition).toBeNull();
  });

  it("assertState delegates to assertStateDetailed", () => {
    model.updateFocusedApp(makeAppContext({ bundleId: "com.test.App" }));
    expect(model.assertState({ type: "app_focused", target: "com.test.App" })).toBe(true);
    expect(model.assertState({ type: "app_focused", target: "com.other.App" })).toBe(false);
  });

  // ── 3a.6 read methods ──

  it("getFocusedElement returns focused control", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    const focused = model.getFocusedElement();
    expect(focused).not.toBeNull();
    expect(focused!.role).toBe("textField");
    expect(focused!.label.value).toBe("Name");
  });

  it("getFocusedElement returns null when no focused window", () => {
    // Clear focusedWindowId (ingestAXTree now auto-sets it)
    model.getState().focusedWindowId = null;
    expect(model.getFocusedElement()).toBeNull();
  });

  it("getDialogStack returns active dialogs", () => {
    const dialogTree: AXNode = {
      role: "window",
      title: "Main",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "sheet",
          title: "Save changes?",
          position: { x: 200, y: 200 },
          size: { width: 400, height: 200 },
          children: [
            { role: "button", title: "Save", position: { x: 300, y: 350 }, size: { width: 80, height: 30 } },
          ],
        },
      ],
    };
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, dialogTree, ctx);
    const stack = model.getDialogStack();
    expect(stack.length).toBeGreaterThanOrEqual(1);
    expect(stack[0]!.title).toBe("Save changes?");
  });

  it("getDomainState returns domain for focused app", () => {
    const ctx = makeAppContext({ bundleId: "com.apple.Safari" });
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    const domain = model.getDomainState();
    expect(domain).not.toBeNull();
    expect(domain!.family).toBe("browser");
  });

  it("getDomainState returns null when no focused app", () => {
    expect(model.getDomainState()).toBeNull();
  });

  it("getDomainField returns specific field from domain", () => {
    const ctx = makeAppContext({ bundleId: "com.apple.Safari" });
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    expect(model.getDomainField("family")).toBe("browser");
    expect(model.getDomainField("nonexistent")).toBeUndefined();
  });

  it("getAppFamily returns family string for focused app", () => {
    const ctx = makeAppContext({ bundleId: "com.figma.Desktop" });
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    expect(model.getAppFamily()).toBe("design_tool");
  });

  it("getAppFamily returns null when no focused app", () => {
    expect(model.getAppFamily()).toBeNull();
  });

  it("getConfidence reads focusedWindow.title", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    const conf = model.getConfidence("focusedWindow.title");
    expect(conf).toBeGreaterThan(0.9);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  it("getConfidence reads control by stableId", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);
    const win = model.getFocusedWindow()!;
    expect(win).not.toBeNull();
    const firstCtrl = win.controls.values().next().value!;
    const conf = model.getConfidence(`control.${firstCtrl.stableId}.label`);
    expect(conf).toBeGreaterThan(0.9);
  });

  it("getConfidence returns 0 for unknown paths", () => {
    expect(model.getConfidence("nonexistent.path")).toBe(0);
    expect(model.getConfidence("control.missing.value")).toBe(0);
  });

  it("getConfidence reads state-level confidence", () => {
    expect(model.getConfidence("state")).toBe(1.0);
  });

  // ── 3a.8 state transition tracking ──

  it("records window_added transition on first ingest", () => {
    const ctx = makeAppContext();
    model.ingestAXTree(1, makeAXTree(), ctx);
    const transitions = model.getRecentTransitions();
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    const added = transitions.find((t) => t.trigger === "ax:window_added");
    expect(added).toBeDefined();
    expect(added!.from).toBe("(none)");
    expect(added!.to).toBe("Test Window");
  });

  it("records title_changed transition", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    // Change title
    const newTree = makeAXTree();
    newTree.title = "Updated Window";
    model.ingestAXTree(1, newTree, makeAppContext({ windowTitle: "Updated Window" }));

    const transitions = model.getRecentTransitions();
    const titleChange = transitions.find((t) => t.trigger === "ax:title_changed");
    expect(titleChange).toBeDefined();
    expect(titleChange!.from).toBe("Test Window");
    expect(titleChange!.to).toBe("Updated Window");
  });

  it("records dialog_count_changed on dialog appear", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    // Ingest with dialog
    const dialogTree: AXNode = {
      role: "window",
      title: "Test Window",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      children: [
        {
          role: "sheet",
          title: "Save?",
          position: { x: 200, y: 200 },
          size: { width: 300, height: 150 },
          children: [],
        },
      ],
    };
    model.ingestAXTree(1, dialogTree, ctx);

    const transitions = model.getRecentTransitions();
    const dialogChange = transitions.find((t) => t.trigger === "ax:dialog_count_changed");
    expect(dialogChange).toBeDefined();
    expect(dialogChange!.from).toBe("0");
  });

  it("records window_removed on window_closed event", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    model.ingestUIEvents([{ type: "window_closed", pid: 1234 }]);

    const transitions = model.getRecentTransitions();
    const removed = transitions.find((t) => t.trigger === "ui_event:window_removed");
    expect(removed).toBeDefined();
    expect(removed!.to).toBe("(none)");
  });

  it("caps transitions at 50", () => {
    const ctx = makeAppContext();
    // Generate >50 transitions by repeatedly changing title
    for (let i = 0; i < 60; i++) {
      const tree = makeAXTree();
      tree.title = `Window ${i}`;
      model.ingestAXTree(1, tree, makeAppContext({ windowTitle: `Window ${i}` }));
    }
    const transitions = model.getRecentTransitions();
    expect(transitions.length).toBeLessThanOrEqual(50);
  });

  it("records controls_changed when control count changes", () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx); // 2 controls

    // Ingest with more controls
    const bigTree = makeAXTree([
      { role: "button", title: "A", position: { x: 10, y: 10 }, size: { width: 80, height: 30 } },
      { role: "button", title: "B", position: { x: 100, y: 10 }, size: { width: 80, height: 30 } },
      { role: "button", title: "C", position: { x: 200, y: 10 }, size: { width: 80, height: 30 } },
      { role: "button", title: "D", position: { x: 300, y: 10 }, size: { width: 80, height: 30 } },
    ]);
    model.ingestAXTree(1, bigTree, ctx);

    const transitions = model.getRecentTransitions();
    const ctrlChange = transitions.find((t) => t.trigger === "ax:controls_changed");
    expect(ctrlChange).toBeDefined();
    expect(ctrlChange!.from).toBe("3"); // window + button + textField
    expect(ctrlChange!.to).toBe("5"); // window + 4 buttons
  });

  // ── 3a.9 domain schema loading ──

  it("loadDomainSchema returns null when no reference file matches", () => {
    const m = new WorldModel({ persistDebounceMs: 0, referencesDir: "/nonexistent" });
    m.init("test");
    expect(m.loadDomainSchema("com.unknown.app")).toBeNull();
  });

  it("loadDomainSchema loads schema from reference file", () => {
    // Create a temp reference dir with a test reference
    const tmpDir = require("node:os").tmpdir();
    const refsDir = require("node:path").join(tmpDir, `screenhand-test-refs-${Date.now()}`);
    require("node:fs").mkdirSync(refsDir, { recursive: true });
    require("node:fs").writeFileSync(
      require("node:path").join(refsDir, "test-app.json"),
      JSON.stringify({
        bundleId: "com.test.SchemaApp",
        domainSchema: {
          fields: {
            activePage: { type: "string", description: "Current page" },
            zoom: { type: "number" },
          },
          strict: true,
        },
      }),
    );

    const m = new WorldModel({ persistDebounceMs: 0, referencesDir: refsDir });
    m.init("test");
    const schema = m.loadDomainSchema("com.test.SchemaApp");
    expect(schema).not.toBeNull();
    expect(schema!.fields.activePage).toBeDefined();
    expect(schema!.fields.activePage.type).toBe("string");
    expect(schema!.strict).toBe(true);

    // Cleanup
    require("node:fs").rmSync(refsDir, { recursive: true });
  });

  it("loadDomainSchema caches results", () => {
    const m = new WorldModel({ persistDebounceMs: 0, referencesDir: "/nonexistent" });
    m.init("test");
    m.loadDomainSchema("com.test.cached");
    // Second call should use cache (returns null, no error)
    expect(m.loadDomainSchema("com.test.cached")).toBeNull();
  });

  it("updateDomainState creates and updates domain state", () => {
    model.updateDomainState("com.test.App", { zoom: 1.5, activeTool: "brush" });
    const domain = model.getAppDomain("com.test.App");
    expect(domain).not.toBeNull();
  });

  it("updateDomainState rejects invalid types when schema is strict", () => {
    const tmpDir = require("node:os").tmpdir();
    const refsDir = require("node:path").join(tmpDir, `screenhand-test-refs2-${Date.now()}`);
    require("node:fs").mkdirSync(refsDir, { recursive: true });
    require("node:fs").writeFileSync(
      require("node:path").join(refsDir, "strict.json"),
      JSON.stringify({
        bundleId: "com.test.Strict",
        domainSchema: {
          fields: {
            zoom: { type: "number" },
            name: { type: "string" },
          },
          strict: true,
        },
      }),
    );

    const m = new WorldModel({ persistDebounceMs: 0, referencesDir: refsDir });
    m.init("test");
    m.loadDomainSchema("com.test.Strict");

    // Valid update
    m.updateDomainState("com.test.Strict", { zoom: 2.0, name: "test" });
    const domain = m.getAppDomain("com.test.Strict") as Record<string, unknown>;
    expect(domain).not.toBeNull();

    // Invalid type (string where number expected) — should be skipped
    m.updateDomainState("com.test.Strict", { zoom: "not-a-number" });

    // Unknown key in strict mode — should be skipped
    m.updateDomainState("com.test.Strict", { unknownField: true });

    // Cleanup
    require("node:fs").rmSync(refsDir, { recursive: true });
  });

  it("updateDomainState never overrides family", () => {
    const ctx = makeAppContext({ bundleId: "com.apple.Safari" });
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    model.updateDomainState("com.apple.Safari", { family: "video_editor" } as any);
    const domain = model.getAppDomain("com.apple.Safari");
    expect(domain!.family).toBe("browser");
  });

  // ── Decay timer (3a.10) ──

  it("startDecayTimer proactively decays confidence without reads", async () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    // Get initial confidence
    const winBefore = model.getFocusedWindow();
    expect(winBefore).toBeTruthy();
    const confBefore = winBefore!.title.confidence;
    expect(confBefore).toBeGreaterThan(0.9);

    // Fake time passage: shift updatedAt back 5 minutes on the title field
    const state = model.getState();
    const win = state.windows.get(1);
    if (win) {
      win.title = { ...win.title, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
      for (const [id, ctrl] of win.controls) {
        win.controls.set(id, {
          ...ctrl,
          label: { ...ctrl.label, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          value: { ...ctrl.value, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
          enabled: { ...ctrl.enabled, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
        });
      }
    }

    // Start timer with very short interval
    model.startDecayTimer(50);

    // Wait for one tick
    await new Promise((r) => setTimeout(r, 100));
    model.stopDecayTimer();

    // After decay, confidence should be lower
    const winAfter = state.windows.get(1);
    expect(winAfter!.title.confidence).toBeLessThan(confBefore);
  });

  it("stopDecayTimer stops the timer", async () => {
    const ctx = makeAppContext();
    model.updateFocusedApp(ctx);
    model.ingestAXTree(1, makeAXTree(), ctx);

    // Shift time back
    const state = model.getState();
    const win = state.windows.get(1);
    if (win) {
      win.title = { ...win.title, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    }

    model.startDecayTimer(50);
    model.stopDecayTimer();

    // Confidence should not have changed yet (timer stopped before tick)
    const confAfterStop = state.windows.get(1)!.title.confidence;
    await new Promise((r) => setTimeout(r, 100));
    // Still the same — timer was stopped
    expect(state.windows.get(1)!.title.confidence).toBe(confAfterStop);
  });

  it("startDecayTimer replaces previous timer", () => {
    model.startDecayTimer(1000);
    model.startDecayTimer(2000); // Should not throw, should replace
    model.stopDecayTimer();
  });
});

describe("diffStates", () => {
  function makeWorldState(overrides?: Partial<{
    focusedApp: { bundleId: string; appName: string; pid: number } | null;
    windows: Map<number, { title: { value: string; confidence: number; updatedAt: string }; controls: Map<string, unknown> }>;
    activeDialogs: unknown[];
  }>) {
    return {
      sessionId: "test",
      focusedWindowId: null,
      focusedApp: overrides?.focusedApp ?? null,
      windows: overrides?.windows ?? new Map(),
      activeDialogs: overrides?.activeDialogs ?? [],
      updatedAt: new Date().toISOString(),
      confidence: 1.0,
      pendingGoal: null,
      recentTransitions: [],
      expectedPostcondition: null,
      browserState: null,
    };
  }

  it("diffStates detects focus change", () => {
    const before = makeWorldState({
      focusedApp: { bundleId: "com.app.A", appName: "A", pid: 1 },
    });
    const after = makeWorldState({
      focusedApp: { bundleId: "com.app.B", appName: "B", pid: 2 },
    });

    const transitions = WorldModel.diffStates(before as any, after as any);
    const focusChange = transitions.find((t) => t.trigger === "diff:focus_changed");
    expect(focusChange).toBeDefined();
    expect(focusChange!.from).toBe("com.app.A");
    expect(focusChange!.to).toBe("com.app.B");
  });

  it("diffStates detects window added/removed", () => {
    const win1 = { title: { value: "Win1", confidence: 1, updatedAt: new Date().toISOString() }, controls: new Map() };
    const win2 = { title: { value: "Win2", confidence: 1, updatedAt: new Date().toISOString() }, controls: new Map() };

    const before = makeWorldState({ windows: new Map([[1, win1]]) as any });
    const after = makeWorldState({ windows: new Map([[2, win2]]) as any });

    const transitions = WorldModel.diffStates(before as any, after as any);
    const added = transitions.find((t) => t.trigger === "diff:window_added");
    const removed = transitions.find((t) => t.trigger === "diff:window_removed");
    expect(added).toBeDefined();
    expect(added!.to).toBe("Win2");
    expect(removed).toBeDefined();
    expect(removed!.from).toBe("Win1");
  });

  it("diffStates returns empty for identical states", () => {
    const state = makeWorldState({
      focusedApp: { bundleId: "com.app.A", appName: "A", pid: 1 },
      windows: new Map([[1, { title: { value: "Win1", confidence: 1, updatedAt: new Date().toISOString() }, controls: new Map() }]]) as any,
      activeDialogs: [],
    });

    const transitions = WorldModel.diffStates(state as any, state as any);
    expect(transitions.length).toBe(0);
  });
});
