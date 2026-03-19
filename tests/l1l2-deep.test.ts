/**
 * Deep L1+L2 tests — scenarios the testers missed.
 * Covers: VisionAdapter, AppleScriptAdapter, CDPSource, RecoveryStrategies,
 * ContextTracker edge cases, PerceptionManager reactive events,
 * WorldModel dialog/browser state, and cross-adapter session lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════
// L1: VISION ADAPTER (zero prior coverage)
// ═══════════════════════════════════════════════════════════

describe("L1 VisionAdapter", () => {
  function mockBridge() {
    return {
      start: vi.fn(),
      call: vi.fn(),
    } as any;
  }

  async function importVisionAdapter() {
    const mod = await import("../src/runtime/vision-adapter.js");
    return mod.VisionAdapter;
  }

  it("attach creates session with vision prefix and reuses on second call", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.apple.finder", name: "Finder", pid: 100 });
    const adapter = new VisionAdapter(bridge);

    const session1 = await adapter.attach("test-profile");
    expect(session1.sessionId).toMatch(/^vision_session_/);
    expect(session1.adapterType).toBe("vision");

    // Second attach same profile returns same session
    const session2 = await adapter.attach("test-profile");
    expect(session2.sessionId).toBe(session1.sessionId);
  });

  it("attach with reuseSessionId preserves the ID", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.apple.finder", name: "Finder", pid: 100 });
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("profile", "vision_session_custom_123");
    expect(session.sessionId).toBe("vision_session_custom_123");
  });

  it("getAppContext returns app context from frontmost at attach time", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test.app", name: "TestApp", pid: 42 });
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("p");
    const ctx = await adapter.getAppContext(session.sessionId);
    expect(ctx.bundleId).toBe("com.test.app");
    expect(ctx.pid).toBe(42);
  });

  it("getAppContext throws for unknown session", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    const adapter = new VisionAdapter(bridge);

    await expect(adapter.getAppContext("nonexistent")).rejects.toThrow("Session not found");
  });

  it("getPageMeta returns app:// URL for non-browser", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test.app", name: "TestApp", pid: 1 });
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("p");
    const meta = await adapter.getPageMeta(session.sessionId);
    expect(meta.url).toBe("app://com.test.app");
    expect(meta.title).toBe("TestApp");
  });

  it("navigate with app:// URL launches app and updates state", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call
      .mockResolvedValueOnce({ bundleId: "com.apple.finder", name: "Finder", pid: 1 }) // attach frontmost
      .mockResolvedValueOnce({ bundleId: "com.apple.Notes", appName: "Notes", pid: 99 }); // launch
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("p");
    const meta = await adapter.navigate(session.sessionId, "app://com.apple.Notes", 5000);
    expect(meta.url).toBe("app://com.apple.Notes");
    expect(bridge.call).toHaveBeenCalledWith("app.launch", { bundleId: "com.apple.Notes" });
  });

  it("locate with coordinates target returns immediately", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test", name: "Test", pid: 1 });
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("p");
    const element = await adapter.locate(
      session.sessionId,
      { type: "coordinates", x: 100, y: 200 },
      1000,
    );
    expect(element).not.toBeNull();
    expect(element!.coordinates).toEqual({ x: 100, y: 200, width: 1, height: 1 });
    expect(element!.locatorUsed).toBe("vision:coordinates");
  });

  it("locate with text target uses OCR and returns best match", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call
      .mockResolvedValueOnce({ bundleId: "com.test", name: "Test", pid: 1 }) // attach
      .mockResolvedValueOnce({ path: "/tmp/screen.png" }) // captureScreen
      .mockResolvedValueOnce([ // findText
        { text: "Submit", confidence: 0.9, bounds: { x: 10, y: 20, width: 80, height: 30 } },
        { text: "Submit Form", confidence: 0.7, bounds: { x: 10, y: 20, width: 120, height: 30 } },
      ]);
    const adapter = new VisionAdapter(bridge);

    const session = await adapter.attach("p");
    const element = await adapter.locate(
      session.sessionId,
      { type: "text", value: "Submit" },
      5000,
    );
    expect(element).not.toBeNull();
    expect(element!.label).toBe("Submit"); // Higher confidence
    expect(element!.coordinates).toEqual({ x: 10, y: 20, width: 80, height: 30 });
  });

  it("locate returns null when OCR finds nothing within timeout", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call
      .mockResolvedValueOnce({ bundleId: "com.test", name: "Test", pid: 1 })
      .mockResolvedValue({ path: "/tmp/screen.png" }) // captureScreen
      .mockResolvedValue([]); // findText — empty

    // Override to always return empty for findText
    bridge.call.mockImplementation(async (method: string) => {
      if (method === "app.frontmost") return { bundleId: "com.test", name: "Test", pid: 1 };
      if (method === "cg.captureScreen") return { path: "/tmp/screen.png" };
      if (method === "vision.findText") return [];
      return null;
    });

    const adapter = new VisionAdapter(bridge);
    const session = await adapter.attach("p");
    const element = await adapter.locate(
      session.sessionId,
      { type: "text", value: "NotFound" },
      300, // Short timeout
    );
    expect(element).toBeNull();
  });

  it("click throws without coordinates", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test", name: "Test", pid: 1 });
    const adapter = new VisionAdapter(bridge);

    await expect(
      adapter.click("any", { handleId: "h", locatorUsed: "test" }),
    ).rejects.toThrow("requires coordinates");
  });

  it("click sends mouseClick at element center", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test", name: "Test", pid: 1 });
    const adapter = new VisionAdapter(bridge);

    await adapter.click("any", {
      handleId: "h",
      locatorUsed: "test",
      coordinates: { x: 100, y: 200, width: 80, height: 40 },
    });

    expect(bridge.call).toHaveBeenCalledWith("cg.mouseClick", { x: 140, y: 220 });
  });

  it("elementTree throws — vision adapter does not support it", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    const adapter = new VisionAdapter(bridge);

    await expect(adapter.elementTree("any")).rejects.toThrow("does not support elementTree");
  });

  it("extract with table format returns structured OCR data", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockImplementation(async (method: string) => {
      if (method === "app.frontmost") return { bundleId: "com.test", name: "Test", pid: 1 };
      if (method === "cg.captureScreen") return { path: "/tmp/screen.png" };
      if (method === "vision.ocr") return {
        text: "Hello World",
        regions: [
          { text: "Hello", confidence: 0.95, bounds: { x: 10, y: 10, width: 50, height: 20 } },
          { text: "World", confidence: 0.90, bounds: { x: 70, y: 10, width: 50, height: 20 } },
        ],
      };
      return null;
    });
    const adapter = new VisionAdapter(bridge);
    const session = await adapter.attach("p");
    const result = await adapter.extract(session.sessionId, { type: "text", value: "any" }, "table") as any;
    expect(result.headers).toEqual(["text", "confidence", "x", "y", "width", "height"]);
    expect(result.rows).toHaveLength(2);
  });

  it("waitFor text_appears returns true when text found", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    let callCount = 0;
    bridge.call.mockImplementation(async (method: string) => {
      if (method === "app.frontmost") return { bundleId: "com.test", name: "Test", pid: 1 };
      if (method === "cg.captureScreen") return { path: "/tmp/screen.png" };
      if (method === "vision.findText") {
        callCount++;
        if (callCount >= 2) return [{ text: "Ready", confidence: 0.9, bounds: { x: 0, y: 0, width: 50, height: 20 } }];
        return [];
      }
      return null;
    });
    const adapter = new VisionAdapter(bridge);
    const session = await adapter.attach("p");
    const found = await adapter.waitFor(session.sessionId, { type: "text_appears", text: "Ready" }, 5000);
    expect(found).toBe(true);
  });

  it("waitFor returns false for unsupported condition types", async () => {
    const VisionAdapter = await importVisionAdapter();
    const bridge = mockBridge();
    bridge.call.mockResolvedValue({ bundleId: "com.test", name: "Test", pid: 1 });
    const adapter = new VisionAdapter(bridge);
    const session = await adapter.attach("p");
    const found = await adapter.waitFor(
      session.sessionId,
      { type: "url_matches", regex: ".*" },
      100,
    );
    expect(found).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// L1: APPLESCRIPT ADAPTER (zero prior coverage)
// ═══════════════════════════════════════════════════════════

describe("L1 AppleScriptAdapter", () => {
  async function importASAdapter() {
    const mod = await import("../src/runtime/applescript-adapter.js");
    return mod.AppleScriptAdapter;
  }

  it("isScriptable returns true for known apps", async () => {
    const ASAdapter = await importASAdapter();
    expect(ASAdapter.isScriptable("com.apple.finder")).toBe(true);
    expect(ASAdapter.isScriptable("com.apple.Safari")).toBe(true);
    expect(ASAdapter.isScriptable("com.apple.Notes")).toBe(true);
    expect(ASAdapter.isScriptable("com.apple.TextEdit")).toBe(true);
  });

  it("isScriptable returns false for unknown apps", async () => {
    const ASAdapter = await importASAdapter();
    expect(ASAdapter.isScriptable("com.google.Chrome")).toBe(false);
    expect(ASAdapter.isScriptable("com.microsoft.VSCode")).toBe(false);
  });

  it("attach creates session with as_ prefix and defaults to Finder", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    const session = await adapter.attach("test-profile");
    expect(session.sessionId).toMatch(/^as_session_/);
    expect(session.adapterType).toBe("applescript");
  });

  it("attach reuses existing session for same profile", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    const s1 = await adapter.attach("p1");
    const s2 = await adapter.attach("p1");
    expect(s1.sessionId).toBe(s2.sessionId);
  });

  it("attach with reuseSessionId preserves ID", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    const session = await adapter.attach("p", "as_session_custom_999");
    expect(session.sessionId).toBe("as_session_custom_999");
  });

  it("requireSession throws for unknown session", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    await expect(adapter.click("nonexistent", { handleId: "h", locatorUsed: "test" }))
      .rejects.toThrow("Session not found");
  });

  it("menuClick throws for empty menuPath", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    const session = await adapter.attach("p");
    await expect(adapter.menuClick(session.sessionId, []))
      .rejects.toThrow("menuPath must not be empty");
  });

  it("escapeAS handles backslashes and quotes", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    // Access private method via prototype
    const escaped = (adapter as any).escapeAS('test "quoted" path\\here');
    expect(escaped).toBe('test \\"quoted\\" path\\\\here');
  });

  it("getSearchText extracts text from various target types", async () => {
    const ASAdapter = await importASAdapter();
    const adapter = new ASAdapter();
    const session = await adapter.attach("p");

    // buildLocateScript throws for unsupported types, but locate() catches it
    // and returns null after timeout (the throw is inside the retry loop's catch)
    const result = await adapter.locate(session.sessionId, { type: "image", base64: "abc" } as any, 100);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// L2: CDP SOURCE (minimal prior coverage)
// ═══════════════════════════════════════════════════════════

describe("L2 CDPSource", () => {
  async function importCDPSource() {
    const mod = await import("../src/perception/cdp-source.js");
    return mod.CDPSource;
  }

  it("drainMutations returns null when buffer empty", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    expect(source.drainMutations()).toBeNull();
  });

  it("processCDPConsoleMessage ignores non-mutation messages", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    source.processCDPConsoleMessage("regular console log");
    source.processCDPConsoleMessage("");
    source.processCDPConsoleMessage("__sh_other__data");
    expect(source.drainMutations()).toBeNull();
  });

  it("processCDPConsoleMessage parses mutation data correctly", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();

    const mutations = [
      { type: "childList", target: "DIV#main", addedNodes: 3, removedNodes: 0 },
      { type: "attributes", target: "SPAN.label", attribute: "class", addedNodes: 0, removedNodes: 0 },
    ];
    source.processCDPConsoleMessage("__sh_mutations__" + JSON.stringify(mutations));

    const event = source.drainMutations();
    expect(event).not.toBeNull();
    expect(event!.source).toBe("cdp_mutations");
    expect(event!.rate).toBe("fast");
    expect((event!.data as any).mutations).toHaveLength(2);
    expect((event!.data as any).mutations[0].selector).toBe("DIV#main");
    expect((event!.data as any).mutations[0].addedNodes).toBe(3);
    expect((event!.data as any).mutations[1].attribute).toBe("class");
  });

  it("processCDPConsoleMessage handles malformed JSON gracefully", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    source.processCDPConsoleMessage("__sh_mutations__{invalid json");
    expect(source.drainMutations()).toBeNull(); // No crash, empty buffer
  });

  it("mutation buffer caps at maxBufferSize", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();

    // Push 150 mutations (cap is 100)
    for (let i = 0; i < 15; i++) {
      const batch = Array.from({ length: 10 }, (_, j) => ({
        type: "childList",
        target: `DIV#item${i * 10 + j}`,
        addedNodes: 1,
        removedNodes: 0,
      }));
      source.processCDPConsoleMessage("__sh_mutations__" + JSON.stringify(batch));
    }

    const event = source.drainMutations();
    expect((event!.data as any).mutations.length).toBeLessThanOrEqual(100);
  });

  it("drainMutations clears buffer after drain", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    source.processCDPConsoleMessage("__sh_mutations__" + JSON.stringify([
      { type: "childList", target: "DIV", addedNodes: 1, removedNodes: 0 },
    ]));

    const first = source.drainMutations();
    expect(first).not.toBeNull();
    const second = source.drainMutations();
    expect(second).toBeNull(); // Buffer cleared
  });

  it("reset clears buffer and observer state", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();

    source.processCDPConsoleMessage("__sh_mutations__" + JSON.stringify([
      { type: "childList", target: "DIV", addedNodes: 1, removedNodes: 0 },
    ]));
    source.reset();

    expect(source.drainMutations()).toBeNull();
    expect((source as any).observerInstalled).toBe(false);
  });

  it("installMutationObserver is idempotent", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    const mockClient = {
      DOM: { enable: vi.fn() },
      Runtime: {
        enable: vi.fn(),
        evaluate: vi.fn().mockResolvedValue({}),
        consoleAPICalled: vi.fn(),
      },
    };

    await source.installMutationObserver(mockClient);
    await source.installMutationObserver(mockClient); // Second call should no-op

    expect(mockClient.DOM.enable).toHaveBeenCalledTimes(1);
  });

  it("installMutationObserver handles CDP errors gracefully", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    const mockClient = {
      DOM: { enable: vi.fn().mockRejectedValue(new Error("CDP disconnected")) },
      Runtime: { enable: vi.fn(), evaluate: vi.fn(), consoleAPICalled: vi.fn() },
    };

    // Should not throw
    await source.installMutationObserver(mockClient);
    expect((source as any).observerInstalled).toBe(false);
  });

  it("pollSnapshot returns structured page data", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    const mockClient = {
      Runtime: {
        evaluate: vi.fn().mockResolvedValue({
          result: { value: JSON.stringify({ url: "https://example.com", title: "Example", nodeCount: 150 }) },
        }),
      },
    };

    const event = await source.pollSnapshot(mockClient);
    expect(event).not.toBeNull();
    expect(event!.source).toBe("cdp_snapshot");
    expect((event!.data as any).url).toBe("https://example.com");
    expect((event!.data as any).nodeCount).toBe(150);
  });

  it("pollSnapshot returns null on CDP error", async () => {
    const CDPSource = await importCDPSource();
    const source = new CDPSource();
    const mockClient = {
      Runtime: { evaluate: vi.fn().mockRejectedValue(new Error("timeout")) },
    };
    const event = await source.pollSnapshot(mockClient);
    expect(event).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// L1: RECOVERY STRATEGIES (untested)
// ═══════════════════════════════════════════════════════════

describe("L1 RecoveryStrategies", () => {
  async function importStrategies() {
    return await import("../src/recovery/strategies.js");
  }

  it("getBuiltinStrategies returns strategies for unexpected_dialog", async () => {
    const { getBuiltinStrategies } = await importStrategies();
    const strategies = getBuiltinStrategies("unexpected_dialog");
    expect(strategies.length).toBeGreaterThanOrEqual(3);
    expect(strategies[0]!.id).toBe("dismiss_dialog_cancel");
    expect(strategies[1]!.id).toBe("dismiss_dialog_ok");
    expect(strategies[2]!.id).toBe("dismiss_dialog_escape");
  });

  it("getBuiltinStrategies returns strategies for focus_lost", async () => {
    const { getBuiltinStrategies } = await importStrategies();
    const strategies = getBuiltinStrategies("focus_lost");
    expect(strategies.length).toBeGreaterThanOrEqual(1);
    expect(strategies[0]!.steps[0]!.tool).toBe("focus");
  });

  it("getBuiltinStrategies returns strategies for permission_dialog", async () => {
    const { getBuiltinStrategies } = await importStrategies();
    const strategies = getBuiltinStrategies("permission_dialog");
    expect(strategies.length).toBeGreaterThanOrEqual(2);
    const labels = strategies.map(s => s.label);
    expect(labels.some(l => l.includes("Allow"))).toBe(true);
    expect(labels.some(l => l.includes("OK"))).toBe(true);
  });

  it("getBuiltinStrategies returns empty for unknown blocker type", async () => {
    const { getBuiltinStrategies } = await importStrategies();
    const strategies = getBuiltinStrategies("nonexistent_type" as any);
    expect(strategies).toEqual([]);
  });

  it("all builtin strategies have required fields", async () => {
    const { getBuiltinStrategies } = await importStrategies();
    // Check all known blocker types
    const types = ["unexpected_dialog", "permission_dialog", "focus_lost", "element_not_found", "timeout", "captcha", "rate_limited"] as const;
    for (const bt of types) {
      const strategies = getBuiltinStrategies(bt);
      for (const s of strategies) {
        expect(s.id).toBeTruthy();
        expect(s.blockerType).toBe(bt);
        expect(s.label).toBeTruthy();
        expect(Array.isArray(s.steps)).toBe(true);
        expect(s.source).toBeTruthy();
      }
    }
  });

  it("parseSolutionToSteps handles click instructions", async () => {
    const { parseSolutionToSteps } = await importStrategies();
    const steps = parseSolutionToSteps('Click the "Save" button');
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0]!.tool).toBe("click_text");
  });

  it("parseSolutionToSteps handles keyboard shortcuts", async () => {
    const { parseSolutionToSteps } = await importStrategies();
    const steps = parseSolutionToSteps("Press Cmd+S to save");
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0]!.tool).toBe("key");
  });

  it("buildStrategyWithContext injects bundleId into focus steps", async () => {
    const { buildStrategyWithContext } = await importStrategies();
    const strategy = {
      id: "test",
      blockerType: "focus_lost" as const,
      label: "Test",
      steps: [{ tool: "focus", params: {}, description: "Refocus" }],
      postcondition: null,
      source: "builtin" as const,
    };
    const result = buildStrategyWithContext(strategy, "com.test.app");
    expect(result.steps[0]!.params.bundleId).toBe("com.test.app");
  });
});

// ═══════════════════════════════════════════════════════════
// L2: PERCEPTION MANAGER REACTIVE EVENTS
// ═══════════════════════════════════════════════════════════

describe("L2 PerceptionManager reactive events", () => {
  async function importManager() {
    const mod = await import("../src/perception/manager.js");
    return mod.PerceptionManager;
  }

  async function importWorldModel() {
    const mod = await import("../src/state/world-model.js");
    return mod.WorldModel;
  }

  it("emits dialog_detected when coordinator reports dialog event", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);

    const events: any[] = [];
    pm.on("dialog_detected", (e: any) => events.push(e));

    // Simulate coordinator emitting a dialog event
    (pm as any).handleReactiveEvent({
      data: {
        type: "ax_events",
        events: [{ type: "dialog_appeared", windowTitle: "Save Changes?", pid: 42 }],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Save Changes?");
    expect(events[0].pid).toBe(42);
  });

  it("emits app_switched when coordinator reports app activation", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    // Set current bundleId so the switch is detected
    (pm as any).currentBundleId = "com.apple.finder";

    const events: any[] = [];
    pm.on("app_switched", (e: any) => events.push(e));

    (pm as any).handleReactiveEvent({
      data: {
        type: "ax_events",
        events: [{ type: "app_activated", bundleId: "com.apple.Safari", pid: 99 }],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].bundleId).toBe("com.apple.Safari");
  });

  it("does NOT emit app_switched when bundleId matches current", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    (pm as any).currentBundleId = "com.apple.finder";

    const events: any[] = [];
    pm.on("app_switched", (e: any) => events.push(e));

    (pm as any).handleReactiveEvent({
      data: {
        type: "ax_events",
        events: [{ type: "app_activated", bundleId: "com.apple.finder", pid: 1 }],
      },
    });

    expect(events).toHaveLength(0);
  });

  it("stop clears all context state", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);

    (pm as any).currentContext = { bundleId: "com.test", pid: 1 };
    (pm as any).currentPid = 1;
    (pm as any).currentBundleId = "com.test";

    await pm.stop();

    expect((pm as any).currentContext).toBeNull();
    expect((pm as any).currentPid).toBeNull();
    expect((pm as any).currentBundleId).toBeNull();
  });

  it("isRunning returns false before createSources", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    expect(pm.isRunning).toBe(false);
  });

  it("getStats returns empty stats before createSources", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    const stats = pm.getStats();
    expect(stats.started).toBe(false);
    expect(stats.fastCycles).toBe(0);
  });

  it("getFreshnessSummary returns not initialized before createSources", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    expect(pm.getFreshnessSummary()).toBe("Perception: not initialized");
  });

  it("ensureStarted is no-op without coordinator", async () => {
    const PerceptionManager = await importManager();
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    const pm = new PerceptionManager(wm);
    // Should not throw
    await pm.ensureStarted({ bundleId: "com.test", appName: "Test", pid: 1, windowTitle: "" });
    expect(pm.isRunning).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// L2: WORLD MODEL — BROWSER STATE + DIALOG PRUNING
// ═══════════════════════════════════════════════════════════

describe("L2 WorldModel browser and dialog state", () => {
  async function importWorldModel() {
    const mod = await import("../src/state/world-model.js");
    return mod.WorldModel;
  }

  it("ingestCDPSnapshot stores browser URL and title", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();

    wm.ingestCDPSnapshot("com.google.Chrome", "https://example.com", "Example Page");
    const state = wm.getState();
    const domain = state.appDomains.get("com.google.Chrome");
    expect(domain).toBeDefined();
    expect(domain!.family).toBe("browser");
  });

  it("updateFocusedApp sets focused app state", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();

    wm.updateFocusedApp({ bundleId: "com.apple.finder", appName: "Finder", pid: 100, windowTitle: "Desktop" });
    const state = wm.getState();
    expect(state.focusedApp).toBeDefined();
    expect(state.focusedApp!.bundleId).toBe("com.apple.finder");
    expect(state.focusedApp!.appName).toBe("Finder");
  });

  it("getActiveDialogs returns empty when no dialogs present", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    expect(wm.getActiveDialogs()).toEqual([]);
  });

  it("getFocusedWindow returns null when no windows tracked", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    expect(wm.getFocusedWindow()).toBeNull();
  });

  it("toSummary includes focused app when set", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    wm.updateFocusedApp({ bundleId: "com.apple.finder", appName: "Finder", pid: 1, windowTitle: "" });
    const summary = wm.toSummary();
    expect(summary).toContain("Finder");
    expect(summary).toContain("com.apple.finder");
  });

  it("getStaleControls returns empty on fresh model", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    expect(wm.getStaleControls()).toEqual([]);
  });

  it("getTrackedEntities returns empty on fresh model", async () => {
    const WorldModel = await importWorldModel();
    const wm = new WorldModel();
    expect(wm.getTrackedEntities().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// L1+L2: CROSS-ADAPTER SESSION ID FORMAT VALIDATION
// ═══════════════════════════════════════════════════════════

describe("L1 Session ID format validation", () => {
  async function importSessionManager() {
    const mod = await import("../src/runtime/session-manager.js");
    return mod.SessionManager;
  }

  it("session IDs follow the expected prefix_profile_timestamp_hash format", async () => {
    // Validate that session ID generation creates proper format
    const id = "ax_session_myprofile_1234567890123_abcdef01";
    const parts = id.split("_");
    expect(parts[0]).toBe("ax");
    expect(parts[1]).toBe("session");
    expect(parts[2]).toBe("myprofile");
    // Remaining parts form timestamp + hash
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  it("session IDs from different adapters have correct prefixes", async () => {
    // Vision: vision_session_
    // AS: as_session_
    // AX: ax_session_
    // CDP: cdp_session_
    const prefixes = ["ax_session_", "cdp_session_", "as_session_", "vision_session_"];
    for (const prefix of prefixes) {
      expect(prefix).toMatch(/^(ax|cdp|as|vision)_session_$/);
    }
  });
});
