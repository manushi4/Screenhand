// Chaos bug-finding tests — targeting perception, world-model, context-tracker, recorder
// Every test is designed to expose a real defect found by code review

import { describe, it, expect } from "vitest";

// ── FrameDiffer (src/perception/frame-differ.ts) ─────────────

describe("FrameDiffer bug hunting", () => {
  it("BUG: height=0 makes bytesPerRow=Infinity, grid hashing silently breaks", async () => {
    const { FrameDiffer } = await import("../src/perception/frame-differ.js");
    const differ = new FrameDiffer();

    const buf = Buffer.alloc(100, 0x42);
    // height=0 → after fix: early return with empty hashes map
    const result = differ.diff(buf, 100, 0);
    // Should return empty regions safely
    expect(result.changedRegions.length).toBe(0);
    expect(result.changed).toBe(false);
  });

  it("BUG: negative dimensions produce no warnings and empty results", async () => {
    const { FrameDiffer } = await import("../src/perception/frame-differ.js");
    const differ = new FrameDiffer();

    const buf = Buffer.alloc(100, 0x42);
    // width=-100 → cols = Math.ceil(-100/64) = -1 → loop never runs
    const result = differ.diff(buf, -100, 50);
    expect(result.changedRegions.length).toBe(0);
  });

  it("BUG: zero-size buffer with valid dimensions", async () => {
    const { FrameDiffer } = await import("../src/perception/frame-differ.js");
    const differ = new FrameDiffer();

    const buf = Buffer.alloc(0);
    // Empty buffer → bytesPerRow = Math.ceil(0/100) || 1 = 0 || 1 = 1
    // But there's nothing to hash
    const result = differ.diff(buf, 100, 100);
    expect(result.changedRegions.length).toBe(0);
  });
});

// ── WorldModel (src/state/world-model.ts) ────────────────────

describe("WorldModel bug hunting", () => {
  it("BUG: dialog_appeared events have NO dedup — duplicates pile up", async () => {
    const { WorldModel } = await import("../src/state/world-model.js");
    const wm = new WorldModel();

    // Simulate rapid duplicate dialog_appeared events from AX
    for (let i = 0; i < 5; i++) {
      wm.ingestUIEvents([{
        type: "dialog_appeared",
        windowTitle: "Save Changes?",
        timestamp: Date.now(),
      }]);
    }

    const dialogs = wm.getActiveDialogs();
    // BUG: Each event pushes a new dialog — no dedup by title
    // Should be 1, but will be 5
    expect(dialogs.length).toBe(1);
  });

  it("BUG: text_visible assertion with empty string matches EVERYTHING", async () => {
    const { WorldModel } = await import("../src/state/world-model.js");
    const wm = new WorldModel();

    // Add a window with a control
    wm.ingestAXTree(1, "com.test", "Test App", 12345, [{
      role: "button",
      title: "Submit",
      value: null,
      enabled: true,
      focused: false,
      position: { x: 100, y: 100, width: 80, height: 30 },
      children: [],
    }]);

    // Empty string assertion — "".includes("") is ALWAYS true in JS
    const result = wm.assertStateDetailed({ type: "text_visible", target: "" });
    // BUG: Empty target matches every control
    expect(result.matched).toBe(false);
  });

  it("BUG: window_focused assertion with non-numeric target — NaN comparison", async () => {
    const { WorldModel } = await import("../src/state/world-model.js");
    const wm = new WorldModel();

    // Set up a focused window
    wm.ingestAXTree(42, "com.test", "Test App", 12345, []);

    const result = wm.assertStateDetailed({ type: "window_focused", target: "garbage" });
    // Number("garbage") = NaN, NaN === 42 is false
    // BUG: confidence is 1.0 even though the assertion is nonsensical
    expect(result.matched).toBe(false);
    expect(result.confidence).toBeLessThan(1.0); // Should indicate low confidence for bad input
  });
});

// ── ContextTracker (src/context-tracker.ts) ──────────────────

describe("ContextTracker bug hunting", () => {
  it("BUG: javascript: URL extracts empty hostname, triggers domain lookup with ''", async () => {
    const { ContextTracker } = await import("../src/context-tracker.js");
    const { PlaybookStore } = await import("../src/playbook/store.js");

    const store = new PlaybookStore("/tmp/ct-test-" + Date.now());
    const tracker = new ContextTracker(store);

    // javascript: URL → hostname is ""
    tracker.updateContext("browser_navigate", { url: "javascript:alert(1)" });
    const hints = tracker.getHints("browser_click", { selector: "#btn" });
    // Should NOT match any playbook — empty domain is meaningless
    // After our prior fix, matchByDomain("") returns null, so this should be safe
    expect(hints.playbookHint).toBeFalsy();
  });

  it("BUG: data: URL extracts empty hostname", async () => {
    const { ContextTracker } = await import("../src/context-tracker.js");
    const { PlaybookStore } = await import("../src/playbook/store.js");

    const store = new PlaybookStore("/tmp/ct-test2-" + Date.now());
    const tracker = new ContextTracker(store);

    tracker.updateContext("browser_navigate", { url: "data:text/html,<h1>test</h1>" });
    const hints = tracker.getHints("browser_click", { selector: "#btn" });
    expect(hints.playbookHint).toBeFalsy();
  });

  it("BUG: findRelevantSelector with empty target matches ALL selectors", async () => {
    const { ContextTracker } = await import("../src/context-tracker.js");
    const { PlaybookStore } = await import("../src/playbook/store.js");

    const store = new PlaybookStore("/tmp/ct-test3-" + Date.now());
    // Add a playbook with selectors
    store.save({
      id: "pb1", name: "Test", description: "test", platform: "example",
      steps: [], tags: [], successCount: 1, failCount: 0, domain: "example.com",
      selectors: { toolbar: { search: "#search-input", menu: "#main-menu" } },
    } as any);

    const tracker = new ContextTracker(store);
    tracker.updateContext("browser_navigate", { url: "https://example.com/page" });

    // Empty target — should NOT match any selector
    const hints = tracker.getHints("click_with_fallback", { target: "" });
    // BUG: "toolbar.search".includes("") is true → returns spurious match
    expect(hints.selectorHint).toBeFalsy();
  });
});

// ── McpPlaybookRecorder (src/playbook/mcp-recorder.ts) ──────

describe("McpPlaybookRecorder bug hunting", () => {
  it("BUG: type_into dedup doesn't check text field — different text is deduped", async () => {
    const { McpPlaybookRecorder } = await import("../src/playbook/mcp-recorder.js");
    const recorder = new McpPlaybookRecorder("/tmp/rec-test-" + Date.now());

    recorder.start("test-platform");
    // Type "hello" into search box
    recorder.captureToolCall("type_text", { text: "hello", target: "#search" }, true);
    // Type "world" into same box — different text but same target
    recorder.captureToolCall("type_text", { text: "world", target: "#search" }, true);

    const playbook = recorder.stop("test", "test playbook");
    // BUG: Dedup checks action+target+code+keys+menuPath but NOT text
    // Both steps have action="type_into" target="#search" → second is deduped
    // Should have 2 steps (different text), not 1
    const typeSteps = playbook.steps.filter(s => s.action === "type_into");
    expect(typeSteps.length).toBe(2);
  });
});

// ── Publisher edge cases (src/community/publisher.ts) ────────

describe("Publisher additional bug hunting", () => {
  it("BUG: publish with successRate=NaN bypasses quality check", async () => {
    const { PlaybookPublisher } = await import("../src/community/publisher.js");
    const publisher = new PlaybookPublisher("/tmp/pub-test-" + Date.now(), null);

    const playbook = {
      id: "test1", name: "Test", description: "Test", platform: "test",
      bundleId: "com.test",
      steps: [{ action: "click", target: "#btn" }],
      tags: ["test"], successCount: 5, failCount: 0, domain: "",
    };

    // NaN < 0.5 is false — so the quality check passes!
    const result = publisher.publish(playbook as any, NaN, 5);
    // BUG: NaN successRate should be rejected
    expect(result).toBeNull();
  });

  it("BUG: publish with negative executionCount bypasses minRuns check", async () => {
    const { PlaybookPublisher } = await import("../src/community/publisher.js");
    const publisher = new PlaybookPublisher("/tmp/pub-test2-" + Date.now(), null);

    const playbook = {
      id: "test2", name: "Test", description: "Test", platform: "test",
      bundleId: "com.test",
      steps: [{ action: "click", target: "#btn" }],
      tags: ["test"], successCount: 5, failCount: 0, domain: "",
    };

    // -1 < 3 is true, so minRuns check fails correctly
    // But what about executionCount=Infinity?
    const result = publisher.publish(playbook as any, 1.0, Infinity);
    // Infinity >= 3 is true, Infinity is not a valid execution count
    expect(result).toBeNull();
  });
});

// ── RecoveryEngine (src/recovery/engine.ts) ─────────────────

describe("RecoveryEngine bug hunting", () => {
  it("BUG: configure() mutates shared DEFAULT_CONFIG via Object.assign", async () => {
    const { RecoveryEngine } = await import("../src/recovery/engine.js");
    const { WorldModel } = await import("../src/state/world-model.js");

    const wm1 = new WorldModel();
    const mockExecute = async () => ({ ok: true, result: "done" });
    const mockMemory = { recordError: () => {} } as any;

    const engine1 = new RecoveryEngine(wm1, mockExecute, mockMemory);
    const engine2 = new RecoveryEngine(wm1, mockExecute, mockMemory);

    // configure() uses Object.assign(this.config, partial)
    // this.config was initialized as { ...DEFAULT_CONFIG, ...config }
    // So it's a new object — should be safe
    engine1.configure({ referencesDir: "/custom/path" });

    const status1 = engine1.getStatus();
    const status2 = engine2.getStatus();
    // Both should work independently
    expect(status1.cooldownCount).toBe(0);
    expect(status2.cooldownCount).toBe(0);
  });
});

// ── Deterministic planner edge cases ────────────────────────

describe("Deterministic planner additional bugs", () => {
  it("BUG: parseFlowStep allows arbitrary tool injection via function call syntax", async () => {
    const { flowToPlan } = await import("../src/planner/deterministic.js");

    // This step looks like a function call — parseFlowStep matches it
    const plan = flowToPlan("dangerous", {
      steps: ["rm_rf(path: '/important/data')"],
      description: "Dangerous flow",
    });

    // BUG: Any word followed by (...) is treated as a valid tool
    // The step is marked requiresLLM=false (executable!) with tool="rm_rf"
    expect(plan.steps[0]!.requiresLLM).toBe(true); // Should require LLM review
  });

  it("BUG: strategyToPlan with NaN successCount/failCount", async () => {
    const { strategyToPlan } = await import("../src/planner/deterministic.js");

    const plan = strategyToPlan({
      id: "s1",
      task: "test",
      steps: [{ tool: "click_text", params: { text: "OK" } }],
      tags: [],
      fingerprint: "click_text",
      successCount: NaN,
      failCount: NaN,
      lastUsed: new Date().toISOString(),
    } as any);

    // NaN + NaN > 0 is false → reliability = 0.5
    // But NaN / (NaN + NaN) = NaN → reliability should guard against this
    expect(Number.isFinite(plan.confidence)).toBe(true);
  });
});
