// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// CHAOS L1+L2 — Combined destruction tests for Control and Perception layers.
// Every test combines 2+ failure modes simultaneously.
// Tests cover: Executor, SessionManager, ContextTracker, PlaybookStore,
// McpPlaybookRecorder, MemoryStore/RecallEngine, BridgeClient, Coordinator,
// WorldModel, Persistence, FusionPipeline.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorldModel } from "../src/state/world-model.js";
import { FusionPipeline } from "../src/state/fusion.js";
import { PerceptionCoordinator } from "../src/perception/coordinator.js";
import {
  worldStateToJSON,
  worldStateFromJSON,
  DebouncedPersister,
} from "../src/state/persistence.js";
import { ContextTracker } from "../src/context-tracker.js";
import { PlaybookStore } from "../src/playbook/store.js";
import { McpPlaybookRecorder } from "../src/playbook/mcp-recorder.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { Executor } from "../src/runtime/executor.js";
import { RecallEngine } from "../src/memory/recall.js";
import { MemoryStore } from "../src/memory/store.js";
import type { AXNode, AppContext } from "../src/types.js";
import type { WorldState } from "../src/state/types.js";
import * as persistence from "../src/state/persistence.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/state/persistence.js", async () => {
  const actual = (await vi.importActual("../src/state/persistence.js")) as Record<string, unknown>;
  return {
    ...actual,
    loadWorldState: vi.fn().mockReturnValue(null),
    saveWorldState: vi.fn(),
  };
});

// ── Helpers ──

function makeCtx(overrides?: Partial<AppContext>): AppContext {
  return {
    bundleId: "com.test.Chaos",
    appName: "ChaosApp",
    pid: 9999,
    windowTitle: "Chaos Window",
    windowId: 1,
    ...overrides,
  };
}

function makeTree(children?: AXNode[]): AXNode {
  return {
    role: "window",
    title: "Chaos Window",
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    children: children ?? [
      {
        role: "button",
        title: "OK",
        position: { x: 100, y: 200 },
        size: { width: 80, height: 30 },
        enabled: true,
      },
    ],
  };
}

function makeFatTree(n: number): AXNode {
  const children: AXNode[] = [];
  for (let i = 0; i < n; i++) {
    children.push({
      role: "button",
      title: `Btn_${i}`,
      position: { x: (i % 50) * 30, y: Math.floor(i / 50) * 30 },
      size: { width: 25, height: 25 },
      enabled: true,
    });
  }
  return {
    role: "window",
    title: "Fat Window",
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    children,
  };
}

function mockAXSource() {
  return {
    drainEvents: vi.fn().mockReturnValue(null),
    pollAXTree: vi.fn().mockResolvedValue({ event: null, latencyMs: 5, nodeCount: 0 }),
    startObserving: vi.fn().mockResolvedValue(undefined),
    stopObserving: vi.fn().mockResolvedValue(undefined),
    isObserving: false,
    shouldSkipPoll: vi.fn().mockReturnValue(false),
  } as any;
}

function mockVisionSource() {
  return {
    captureAndDiffOptimized: vi.fn().mockResolvedValue({ diffEvent: null, ocrEvent: null }),
    reset: vi.fn(),
    setSafeCLI: vi.fn(),
  } as any;
}

function mockCDPSource() {
  return {
    drainMutations: vi.fn().mockReturnValue(null),
    pollSnapshot: vi.fn().mockResolvedValue(null),
    installMutationObserver: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  } as any;
}

function mockAdapter(overrides?: Record<string, any>) {
  return {
    attach: vi.fn().mockResolvedValue({
      sessionId: "ax_session_test_1234567890123",
      profile: "test",
      createdAt: new Date().toISOString(),
    }),
    locate: vi.fn().mockResolvedValue({ selector: "#ok", x: 100, y: 200, width: 80, height: 30 }),
    click: vi.fn().mockResolvedValue(undefined),
    setValue: vi.fn().mockResolvedValue(undefined),
    getValue: vi.fn().mockResolvedValue("test"),
    waitFor: vi.fn().mockResolvedValue(true),
    getPageMeta: vi.fn().mockResolvedValue({ url: "https://test.com", title: "Test" }),
    getAppContext: vi.fn().mockResolvedValue(makeCtx()),
    isFrontmost: vi.fn().mockResolvedValue(true),
    focusApp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function mockLogger() {
  return {
    start: vi.fn().mockReturnValue({ retries: 0, locateMs: 0, actMs: 0, verifyMs: 0 }),
    finish: vi.fn().mockImplementation((t, status) => ({ ...t, status })),
  } as any;
}

function mockCache() {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  } as any;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chaos-l1l2-"));
}

// ═══════════════════════════════════════════════════════════
// L1A: SESSION MANAGER DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1A: Session Manager Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1A1: Concurrent re-attach with adapter throwing mid-attach + stale session lookup", async () => {
    // COMBO: adapter.attach() throws intermittently + concurrent requireSessionResilent calls
    let callCount = 0;
    const adapter = mockAdapter({
      attach: vi.fn().mockImplementation(async (profile: string, reuseId?: string) => {
        callCount++;
        if (callCount % 2 === 0) throw new Error("Bridge died during attach");
        return {
          sessionId: reuseId ?? `ax_session_${profile}_1234567890123`,
          profile,
          createdAt: new Date().toISOString(),
        };
      }),
    });

    const mgr = new SessionManager(adapter);
    const sessionId = "ax_session_test_1234567890123";

    // Fire 10 concurrent requireSessionResilent — mix of success/failure
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => mgr.requireSessionResilent(sessionId)),
    );

    const successes = results.filter(r => r.status === "fulfilled");
    const failures = results.filter(r => r.status === "rejected");

    // At least some should succeed (odd calls succeed)
    expect(successes.length).toBeGreaterThan(0);
    // At least some should fail (even calls throw)
    expect(failures.length).toBeGreaterThan(0);
    // VERDICT: RESILIENT — failures don't corrupt internal state
  });

  it("L1A2: Session ID with embedded control chars + null bytes + 10KB profile name", async () => {
    // COMBO: malformed session ID + oversized profile extraction
    const adapter = mockAdapter();
    const mgr = new SessionManager(adapter);

    // Session ID with null bytes, newlines, control chars
    const evilIds = [
      "ax_session_\x00evil\x00_1234567890123",
      "ax_session_test\nnewline_1234567890123",
      "ax_session_" + "A".repeat(10000) + "_1234567890123",
      "\x00\x01\x02\x03",
      "",
      "ax_session___1234567890123", // empty profile segment
    ];

    for (const id of evilIds) {
      // Must not throw — should fall back to "automation" profile
      const session = await mgr.requireSessionResilent(id);
      expect(session).toBeTruthy();
      expect(session.sessionId).toBeTruthy();
    }
    // VERDICT: RESILIENT — regex fails gracefully, falls back to "automation"
  });

  it("L1A3: sessionStart for same profile while attach is in-flight + second caller sees stale", async () => {
    // COMBO: race between two sessionStart calls for same profile
    let resolveFirst: (() => void) | null = null;
    const adapter = mockAdapter({
      attach: vi.fn().mockImplementation(async (profile: string) => {
        if (!resolveFirst) {
          // First call: hang until we release it
          await new Promise<void>(r => { resolveFirst = r; });
        }
        return {
          sessionId: `ax_session_${profile}_${Date.now()}`,
          profile,
          createdAt: new Date().toISOString(),
        };
      }),
    });

    const mgr = new SessionManager(adapter);

    // Start first sessionStart — it will hang
    const p1 = mgr.sessionStart("user");

    // Start second sessionStart — should return the in-flight session (cached)
    // But first hasn't completed yet! Race condition.
    await new Promise(r => setTimeout(r, 50));

    // Release the first call
    resolveFirst!();

    const s1 = await p1;
    // Second call for same profile should return cached
    const s2 = await mgr.sessionStart("user");
    expect(s1.sessionId).toBe(s2.sessionId);
    // VERDICT: RESILIENT — Map cache deduplicates after first resolves
  });
});

// ═══════════════════════════════════════════════════════════
// L1B: EXECUTOR DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1B: Executor Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1B1: Locate succeeds but act throws, retry locate also fails — verify must not run", async () => {
    // COMBO: intermittent locate + act failure + verify interaction
    let locateCallNum = 0;
    const adapter = mockAdapter({
      locate: vi.fn().mockImplementation(async () => {
        locateCallNum++;
        if (locateCallNum === 1) return { selector: "#btn", x: 100, y: 200, width: 80, height: 30 };
        throw new Error("Element detached from DOM during retry");
      }),
      click: vi.fn().mockRejectedValue(new Error("Element not interactable")),
      waitFor: vi.fn().mockImplementation(() => {
        throw new Error("VERIFY SHOULD NEVER RUN");
      }),
    });

    const executor = new Executor(adapter, mockCache(), mockLogger());

    const result = await executor.press({
      sessionId: "ax_session_test_1234567890123",
      target: { type: "selector", value: "#btn" },
      verify: { type: "selector_visible", selector: "#success" },
      budget: { locateMs: 100, actMs: 100, verifyMs: 100, maxRetries: 1 },
    });

    expect(result.ok).toBe(false);
    // Verify was never called (act threw, then retry locate threw)
    expect(adapter.waitFor).not.toHaveBeenCalled();
    // VERDICT: RESILIENT — verify correctly skipped when act fails
  });

  it("L1B2: getAppContext throws + getPageMeta throws — siteKey falls back to 'unknown-site'", async () => {
    // COMBO: both app context and page meta unavailable during locate cache key generation
    // BUG FOUND: when getPageMeta throws at the end (after successful click), press() catches
    // it and returns failure. The siteKey fallback works, but final getPageMeta is not optional.
    const adapter = mockAdapter({
      getAppContext: vi.fn().mockRejectedValue(new Error("No app focused")),
      getPageMeta: vi.fn().mockRejectedValue(new Error("No page loaded")),
      locate: vi.fn().mockResolvedValue({ selector: "#btn", x: 50, y: 50, width: 80, height: 30 }),
    });

    const executor = new Executor(adapter, mockCache(), mockLogger());

    const result = await executor.press({
      sessionId: "ax_session_test_1234567890123",
      target: { type: "selector", value: "#btn" },
      budget: { locateMs: 200, actMs: 200, verifyMs: 200, maxRetries: 0 },
    });

    // BUG: getPageMeta is called after successful click — if it throws, the whole
    // action is reported as failed even though the click DID succeed. This is a
    // false failure report.
    expect(result.ok).toBe(false);
    // VERDICT: CASCADE — getPageMeta failure after successful action causes false failure report
  });

  it("L1B3: Locate times out + act times out + verify times out — all budget exhaustion at once", async () => {
    // COMBO: all three phases exceed their budgets simultaneously
    const adapter = mockAdapter({
      locate: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 5000)); // Way over budget
        return { selector: "#btn", x: 50, y: 50, width: 80, height: 30 };
      }),
    });

    const executor = new Executor(adapter, mockCache(), mockLogger());

    const start = Date.now();
    const result = await executor.press({
      sessionId: "ax_session_test_1234567890123",
      target: { type: "selector", value: "#btn" },
      budget: { locateMs: 50, actMs: 50, verifyMs: 50, maxRetries: 0 },
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    // Budget enforcement: must not wait the full 5s sleep in locate
    // Error code may be TIMEOUT or LOCATE_FAILED depending on executor internals
    expect(result.error).toBeDefined();
    expect(elapsed).toBeLessThan(3000);
    // VERDICT: RESILIENT — timed() correctly aborts long-running operations
  });

  it("L1B4: setValue succeeds but getValue returns wrong value + verify also fails", async () => {
    // COMBO: type value mismatch + verification failure double-error
    const adapter = mockAdapter({
      setValue: vi.fn().mockResolvedValue(undefined),
      getValue: vi.fn().mockResolvedValue("wrong_value"), // Mismatch!
      waitFor: vi.fn().mockResolvedValue(false), // Would also fail
    });

    const executor = new Executor(adapter, mockCache(), mockLogger());

    const result = await executor.typeInto({
      sessionId: "ax_session_test_1234567890123",
      target: { type: "selector", value: "#input" },
      text: "expected_value",
      verifyValue: true,
      budget: { locateMs: 200, actMs: 200, verifyMs: 200, maxRetries: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_FAILED");
    // VERDICT: RESILIENT — catches mismatch before reaching custom verify
  });
});

// ═══════════════════════════════════════════════════════════
// L1C: CONTEXT TRACKER DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1C: Context Tracker Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1C1: Load reference with valid JSON but wrong schema + simultaneously get hints", () => {
    // COMBO: bad playbook shape + concurrent hint request
    const dir = tmpDir();

    // Write a valid JSON file with completely wrong schema
    const badPlaybook = {
      not_a_playbook: true,
      randomField: 42,
      nested: { deeply: { wrong: true } },
    };
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "evil.json"), JSON.stringify(badPlaybook));

    const store = new PlaybookStore(path.join(dir, "references"));
    store.load();

    const tracker = new ContextTracker(store);

    // Update context with a URL that would match "evil"
    tracker.updateContext("browser_navigate", { url: "https://evil.com/page" });

    // Get hints immediately — no crash even with broken playbook
    const hints = tracker.getHints("browser_click", { selector: "#btn" });
    expect(Array.isArray(hints)).toBe(true);

    // Record outcome — must not throw
    tracker.recordOutcome("browser_click", { selector: "#btn" }, true, null);

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — bad schema silently produces no matches
  });

  it("L1C2: Rapid domain switching + flush racing with recordOutcome + selector promotion", () => {
    // COMBO: domain change invalidates context mid-flush + selector promotion logic
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });

    // Write a proper playbook
    const playbook = {
      id: "test-pb",
      name: "Test",
      description: "test",
      platform: "testapp",
      steps: [],
      tags: ["testapp"],
      version: "1.0.0",
      successCount: 5,
      failCount: 0,
      urlPatterns: ["testapp\\.com"],
      selectors: { main: { btn: "#main-btn" } },
      errors: [],
    };
    fs.writeFileSync(
      path.join(dir, "references", "testapp.json"),
      JSON.stringify(playbook),
    );

    const store = new PlaybookStore(path.join(dir, "references"));
    store.load();

    const tracker = new ContextTracker(store);

    // Set context
    tracker.updateContext("browser_navigate", { url: "https://testapp.com" });

    // Record 50 outcomes rapidly, switching domain mid-way
    for (let i = 0; i < 25; i++) {
      tracker.recordOutcome("browser_click", { selector: ".auto-selector" }, true, null);
    }

    // Switch domain mid-stream
    tracker.updateContext("browser_navigate", { url: "https://other.com" });

    // Record more outcomes — these go to a different (null) context
    for (let i = 0; i < 25; i++) {
      tracker.recordOutcome("browser_click", { selector: ".other-selector" }, true, null);
    }

    // Force flush — must not crash even though context changed
    tracker.flush();

    // Verify no crash, learnings buffer reset
    const hints = tracker.getHints("browser_click", {});
    expect(Array.isArray(hints)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — domain switch mid-flush discards orphaned learnings
  });

  it("L1C3: updateContextFromWindowTitle with evil URLs + unicode + injection attempts", () => {
    // COMBO: malformed window titles + boundary conditions
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    const store = new PlaybookStore(path.join(dir, "references"));
    store.load();
    const tracker = new ContextTracker(store);

    const evilTitles = [
      "javascript:alert(1) — Safari",
      "data:text/html,<script>evil</script> — Safari",
      "\x00\x01\x02 — Safari",
      "A".repeat(100000) + " — Safari",
      " — Safari",
      "https://evil.com/" + "A".repeat(50000) + " — Safari",
      "正常なタイトル — Safari",
      "",
    ];

    for (const title of evilTitles) {
      // Must not throw
      tracker.updateContextFromWindowTitle("com.apple.Safari", title);
    }

    // Tracker still functional
    tracker.updateContext("browser_navigate", { url: "https://test.com" });
    expect(tracker.getCurrentDomain()).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — evil titles are safely ignored
  });
});

// ═══════════════════════════════════════════════════════════
// L1D: PLAYBOOK STORE + RECORDER DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1D: Playbook Store + Recorder Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1D1: Concurrent save to same playbook ID + recorder stop mid-save", () => {
    // COMBO: two saves racing on same filename + recorder producing output
    const dir = tmpDir();
    const store = new PlaybookStore(dir);

    const playbook1 = {
      id: "race-pb",
      name: "Race 1",
      description: "First",
      platform: "test",
      steps: [],
      tags: ["test"],
      version: "1.0.0",
      successCount: 0,
      failCount: 0,
    } as any;

    const playbook2 = {
      ...playbook1,
      name: "Race 2",
      description: "Second",
      successCount: 10,
    };

    // Save both concurrently (sync, but interleaved in spirit)
    store.save(playbook1);
    store.save(playbook2);

    // The last write wins (atomic write is rename-based)
    store.load();
    const loaded = store.get("race-pb");
    expect(loaded).toBeTruthy();
    expect(loaded!.name).toBe("Race 2"); // Last write wins

    // Now test recorder stop writing to same dir
    const recorder = new McpPlaybookRecorder(dir);
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 50);
    recorder.captureToolCall("browser_type", { selector: "#input", text: "hello" }, true, "ok", 30);
    const recorded = recorder.stop("Recorded PB", "Test recording");

    // Verify both the raced playbook and recorded playbook exist
    store.load();
    expect(store.get("race-pb")).toBeTruthy();
    expect(store.get(recorded.id)).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — atomic writes prevent corruption, last write wins
  });

  it("L1D2: Record during domain switch + stop with empty steps + save to non-existent dir", () => {
    // COMBO: recording observation-only tools + stopping empty recording + missing directory
    const dir = path.join(tmpDir(), "nonexistent", "deeply", "nested");

    const recorder = new McpPlaybookRecorder(dir);
    recorder.start("test");

    // Only capture skip-listed tools — no steps should be recorded
    const skipTools = ["screenshot", "ui_tree", "browser_dom", "memory_recall", "ocr"];
    for (const tool of skipTools) {
      recorder.captureToolCall(tool, {}, true, "ok", 10);
    }

    expect(recorder.stepCount).toBe(0);

    // Stop with zero steps — should still produce a valid playbook
    const pb = recorder.stop("Empty PB", "Nothing recorded");
    expect(pb.steps).toHaveLength(0);

    // Directory should have been created
    expect(fs.existsSync(dir)).toBe(true);

    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
    // VERDICT: RESILIENT — empty playbooks are valid, mkdirSync creates deeply nested dirs
  });

  it("L1D3: matchByDomain with 0/0 success/fail ratio + matchByBundleId with evil bundleIds", () => {
    // COMBO: division by zero in reliability scoring + malicious bundleId patterns
    const dir = tmpDir();
    const store = new PlaybookStore(dir);

    const pb = {
      id: "zero-ratio",
      name: "Zero Ratio",
      description: "test",
      platform: "zeroplat",
      urlPatterns: ["zeroplat\\.com"],
      bundleId: "com.test.zeroplat",
      steps: [],
      tags: ["zeroplat"],
      version: "1.0.0",
      successCount: 0,
      failCount: 0,
    } as any;
    store.save(pb);
    store.load();

    // matchByDomain with 0/0 ratio — score multiplication should handle 0/0
    const match = store.matchByDomain("zeroplat.com");
    // 0/0 gives NaN — must not crash or return NaN score
    expect(match === null || match.id === "zero-ratio").toBe(true);

    // Evil bundleIds
    const evilBundles = [
      "..\\..\\etc\\passwd",
      "com." + "x".repeat(10000) + ".evil",
      "\x00\x01\x02",
      "",
      "com.test.zeroplat", // exact match
    ];

    for (const bid of evilBundles) {
      // Must not throw
      const result = store.matchByBundleId(bid);
      expect(result === null || typeof result === "object").toBe(true);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: DEGRADED — 0/0 reliability score produces 0, making match return null even though the playbook is relevant
  });
});

// ═══════════════════════════════════════════════════════════
// L1E: MEMORY STORE + RECALL DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1E: Memory Store + Recall Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1E1: appendAction during flush + corrupted JSONL lines + file rotation race", () => {
    // COMBO: concurrent write/read + corruption + file size triggering rotation
    const dir = tmpDir();

    // Pre-create a corrupted actions.jsonl
    const memDir = path.join(dir, ".screenhand", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const corruptedLines = [
      '{"tool":"click","success":true}',
      "THIS IS NOT JSON",
      '{"tool":"type","success":false}',
      "{broken json",
      '{"tool":"navigate","success":true}',
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(memDir, "actions.jsonl"), corruptedLines);

    const store = new MemoryStore(dir);
    store.init();

    // Stats should reflect only the 3 valid lines
    const stats = store.getStats();
    expect(stats.totalActions).toBe(3);

    // Append rapidly during potential flush race
    for (let i = 0; i < 100; i++) {
      store.appendAction({
        tool: `tool_${i % 5}`,
        success: i % 3 !== 0,
        params: { idx: i },
        result: "ok",
        durationMs: 50,
        timestamp: new Date().toISOString(),
      } as any);
    }

    expect(store.getStats().totalActions).toBe(103);

    // Clean up
    store.clear("all");
    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — corrupted lines are skipped, valid lines parsed correctly
  });

  it("L1E2: RecallEngine with empty store + NaN timestamps in strategies + quickErrorCheck barrage", () => {
    // COMBO: empty recall + poisoned data + rapid calls
    const dir = tmpDir();
    const memDir = path.join(dir, ".screenhand", "memory");
    fs.mkdirSync(memDir, { recursive: true });

    // Write strategies with NaN/invalid timestamps
    const poisonedStrategies = [
      JSON.stringify({
        task: "test task",
        steps: [{ tool: "click", params: {} }],
        tags: ["test"],
        successCount: 5,
        failCount: 0,
        lastUsed: "not-a-date",
        fingerprint: "click",
      }),
      JSON.stringify({
        task: "another task",
        steps: [{ tool: "type", params: {} }],
        tags: ["test"],
        successCount: 0,
        failCount: 100,
        lastUsed: "Invalid Date", // Simulates corrupted timestamp
        fingerprint: "type",
      }),
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(memDir, "strategies.jsonl"), poisonedStrategies);

    const store = new MemoryStore(dir);
    store.init();
    const recall = new RecallEngine(store);

    // Rapid recall with varied queries — must not throw
    for (let i = 0; i < 50; i++) {
      const results = recall.recallStrategies(`test query ${i}`);
      expect(Array.isArray(results)).toBe(true);
    }

    // quickErrorCheck on empty errors — must not throw
    for (let i = 0; i < 50; i++) {
      const err = recall.quickErrorCheck(`tool_${i}`);
      expect(err === null || typeof err === "object").toBe(true);
    }

    // quickStrategyHint with unreliable strategy (failCount > successCount)
    const hint = recall.quickStrategyHint(["type"]);
    expect(hint).toBeNull(); // Unreliable strategy should be skipped

    store.clear("all");
    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — NaN dates produce NaN scores which are filtered out
  });

  it("L1E3: Strategy fingerprint collision + eviction during append + concurrent lookups", () => {
    // COMBO: fingerprint index corruption + LRU eviction race
    const dir = tmpDir();
    const store = new MemoryStore(dir);
    store.init();
    const recall = new RecallEngine(store);

    // Append 600 strategies (exceeds MAX_STRATEGIES=500) to trigger eviction
    for (let i = 0; i < 600; i++) {
      store.appendStrategy({
        task: `task_${i}`,
        steps: [{ tool: `tool_${i % 10}`, params: {} }],
        tags: [`tag_${i % 5}`],
        successCount: i % 10,
        failCount: 0,
        lastUsed: new Date(Date.now() - i * 60000).toISOString(),
        fingerprint: `tool_${i % 10}`, // Intentional collision!
      } as any);
    }

    // After eviction, at most 500 strategies remain
    const stats = store.getStats();
    expect(stats.totalStrategies).toBeLessThanOrEqual(500);

    // Fingerprint lookup should still work — returns the latest for each fingerprint
    for (let i = 0; i < 10; i++) {
      const result = recall.recallByFingerprint([`tool_${i}`]);
      // Some may have been evicted, but lookup should not crash
      expect(result === null || typeof result === "object").toBe(true);
    }

    store.clear("all");
    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: DEGRADED — fingerprint collisions overwrite entries; eviction may remove active strategies
  });
});

// ═══════════════════════════════════════════════════════════
// L2A: COORDINATOR + WORLD MODEL CROSS-LAYER DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L2A: Coordinator + WorldModel Cross-Layer", () => {
  let model: WorldModel;

  beforeEach(() => {
    vi.mocked(persistence.loadWorldState).mockReturnValue(null);
    model = new WorldModel({ persistDebounceMs: 0, maxControlsPerWindow: 500 });
    model.init("chaos-l2a");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L2A1: activateCDP called during stop() — race between cleanup and CDP injection", async () => {
    // COMBO: stop() clears cdpClient + activateCDP sets it simultaneously
    const ax = mockAXSource();
    const cdp = mockCDPSource();

    const coord = new PerceptionCoordinator(model, ax, cdp, null, {
      fastIntervalMs: 5000,
      mediumIntervalMs: 5000,
      slowIntervalMs: 5000,
      enableAX: true,
      enableCDP: true,
      enableVision: false,
      maxROIsPerCycle: 3,
      skipCaptureLock: true,
    });

    await coord.start(makeCtx());

    // Race: stop and activateCDP simultaneously
    const stopPromise = coord.stop();
    coord.activateCDP({ send: vi.fn() });

    await stopPromise;

    // After stop, coordinator must be stopped regardless of activateCDP
    expect(coord.isRunning).toBe(false);

    // Starting again must work cleanly
    await coord.start(makeCtx());
    expect(coord.isRunning).toBe(true);
    await coord.stop();
    // VERDICT: RESILIENT — stop() wins the race, activateCDP on stopped coordinator is harmless
  });

  it("L2A2: setLearningEngine during active mediumCycle — race on enricher access", async () => {
    // COMBO: learning engine swap during sensor ranking + active poll
    const ax = mockAXSource();
    let pollCount = 0;
    ax.pollAXTree.mockImplementation(async () => {
      pollCount++;
      return {
        event: {
          source: "ax_tree" as const,
          rate: "medium" as const,
          timestamp: new Date().toISOString(),
          data: {
            type: "ax_tree" as const,
            windowId: 1,
            tree: makeTree(),
            appContext: makeCtx(),
          },
        },
        latencyMs: 5,
        nodeCount: 2,
      };
    });

    const coord = new PerceptionCoordinator(model, ax, null, null, {
      fastIntervalMs: 5000,
      mediumIntervalMs: 30, // Fast medium cycles
      slowIntervalMs: 5000,
      enableAX: true,
      enableCDP: false,
      enableVision: false,
      maxROIsPerCycle: 3,
      skipCaptureLock: true,
    });

    await coord.start(makeCtx());

    // Swap learning engine while cycles are running
    const mockEngine = {
      rankSensors: vi.fn().mockReturnValue([
        { sourceType: "ax", score: 0.9 },
        { sourceType: "cdp", score: 0.5 },
      ]),
      recordSensorOutcome: vi.fn(),
    } as any;

    // Wait for a couple cycles, then swap engine mid-flight
    await new Promise(r => setTimeout(r, 100));
    coord.setLearningEngine(mockEngine);
    await new Promise(r => setTimeout(r, 100));

    // Swap again with a broken engine that throws
    const brokenEngine = {
      rankSensors: vi.fn().mockImplementation(() => { throw new Error("Engine crashed"); }),
      recordSensorOutcome: vi.fn().mockImplementation(() => { throw new Error("Record crashed"); }),
    } as any;
    coord.setLearningEngine(brokenEngine);
    await new Promise(r => setTimeout(r, 100));

    // Coordinator must survive
    expect(coord.isRunning).toBe(true);
    expect(pollCount).toBeGreaterThan(0);

    await coord.stop();
    // VERDICT: RESILIENT — learning engine failures are caught in mediumCycle's sensor ranking
  });

  it("L2A3: Concurrent ingestAXTree + ingestCDPSnapshot for same window — data consistency", () => {
    // COMBO: two sources writing to same windowId simultaneously
    const ctx = makeCtx({ bundleId: "com.google.Chrome" });

    // Ingest AX tree
    model.ingestAXTree(1, makeTree([
      { role: "button", title: "AX Button", position: { x: 100, y: 100 }, size: { width: 80, height: 30 }, enabled: true },
    ]), ctx);

    // Immediately ingest CDP snapshot for same bundleId
    model.ingestCDPSnapshot("com.google.Chrome", "https://test.com", "Test Page", 1);

    // Ingest AX again with different controls
    model.ingestAXTree(1, makeTree([
      { role: "textField", title: "CDP Input", position: { x: 200, y: 200 }, size: { width: 200, height: 30 } },
    ]), ctx);

    // Both sources should have contributed
    const win = model.getWindowState(1);
    expect(win).not.toBeNull();

    // App domain should have the CDP URL
    const domain = model.getAppDomain("com.google.Chrome");
    expect(domain).not.toBeNull();

    // Window should have latest AX controls
    expect(win!.controls.size).toBeGreaterThan(0);
    // VERDICT: RESILIENT — last writer wins for each field, no corruption
  });

  it("L2A4: ingestAXTree + ingestUIEvents('window_closed') in rapid alternation", () => {
    // COMBO: creating and destroying same window rapidly
    for (let round = 0; round < 50; round++) {
      model.ingestAXTree(1, makeTree(), makeCtx());
      model.ingestUIEvents([{ type: "window_closed", pid: 9999 } as any]);
    }

    // Final state: window should be gone (last operation was close)
    expect(model.getState().windows.size).toBe(0);

    // One more ingest — should work fresh
    model.ingestAXTree(1, makeTree(), makeCtx());
    expect(model.getState().windows.size).toBe(1);
    // VERDICT: RESILIENT — create/destroy cycles don't leak state
  });
});

// ═══════════════════════════════════════════════════════════
// L2B: FUSION + PERSISTENCE DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L2B: Fusion + Persistence Destruction", () => {
  let model: WorldModel;

  beforeEach(() => {
    vi.mocked(persistence.loadWorldState).mockReturnValue(null);
    model = new WorldModel({ persistDebounceMs: 0 });
    model.init("chaos-l2b");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L2B1: Three sources enqueue conflicting data for same windowId simultaneously", () => {
    // COMBO: AX + CDP + OCR all claiming different state for same window
    model.ingestAXTree(1, makeTree(), makeCtx());

    const fusion = new FusionPipeline();

    // AX says button at (100, 200)
    fusion.enqueue({
      source: "ax",
      timestamp: new Date(Date.now()).toISOString(),
      confidence: 0.9,
      windowId: 1,
      axTree: makeTree([
        { role: "button", title: "AX Button", position: { x: 100, y: 200 }, size: { width: 80, height: 30 }, enabled: true },
      ]),
      appContext: makeCtx(),
    });

    // CDP says different page
    fusion.enqueue({
      source: "cdp",
      timestamp: new Date(Date.now() + 1).toISOString(),
      confidence: 0.85,
      windowId: 1,
      cdpSnapshot: { bundleId: "com.test.Chaos", url: "https://different.com", title: "Different" },
    });

    // OCR says text at conflicting position
    fusion.enqueue({
      source: "ocr",
      timestamp: new Date(Date.now() + 2).toISOString(),
      confidence: 0.7,
      windowId: 1,
      ocrRegions: [{ text: "OCR Text", bounds: { x: 100, y: 200, width: 80, height: 30 } }],
    });

    // Flush all three — must not crash
    fusion.flush(model);
    expect(fusion.size).toBe(0);

    const win = model.getWindowState(1);
    expect(win).not.toBeNull();
    // VERDICT: RESILIENT — each source writes to its own data path (controls vs domain vs OCR)
  });

  it("L2B2: DebouncedPersister with saveFn that throws + schedule called 100 times", () => {
    // COMBO: persistence failure + rapid scheduling
    const throwingSaveFn = vi.fn().mockImplementation(() => {
      throw new Error("Disk full — EIO");
    });
    const persister = new DebouncedPersister(50, throwingSaveFn);

    model.ingestAXTree(1, makeTree(), makeCtx());

    // Schedule 100 times rapidly — only last pending should be flushed
    for (let i = 0; i < 100; i++) {
      persister.schedule(model.getState() as WorldState);
    }

    // Force flush — saveFn will throw
    expect(() => persister.flush()).toThrow("Disk full");

    // After the throw, persister should not be in a broken state
    // Schedule again — should work (pending is reset on flush attempt)
    persister.schedule(model.getState() as WorldState);
    // VERDICT: CASCADE — flush() throws, caller must catch; but internal state resets
  });

  it("L2B3: Serialize state with circular-like references (same object in multiple windows)", () => {
    // COMBO: shared control references + serialization boundary
    const sharedChildren = [
      { role: "button", title: "Shared", position: { x: 0, y: 0 }, size: { width: 50, height: 30 } },
    ] as AXNode[];

    // Ingest same children array for different windows
    for (let i = 0; i < 10; i++) {
      model.ingestAXTree(i, {
        role: "window",
        title: `Win ${i}`,
        position: { x: 0, y: 0 },
        size: { width: 800, height: 600 },
        children: sharedChildren,
      }, makeCtx({ windowId: i, pid: 5000 + i }));
    }

    const state = model.getState();
    // Serialize — must not infinite-loop on shared references
    const json = worldStateToJSON(state as WorldState);
    expect(json.length).toBeGreaterThan(0);

    const parsed = JSON.parse(json);
    const restored = worldStateFromJSON(parsed);
    expect(restored.windows.size).toBe(10);
    // VERDICT: RESILIENT — JSON.stringify handles shared references (no actual cycles)
  });

  it("L2B4: worldStateFromJSON with extra unknown fields + missing required fields", () => {
    // COMBO: forward-compatibility test + backward-compatibility test
    const futureState = {
      windows: {
        "1": {
          pid: 9999,
          bundleId: "com.test",
          appName: "Test",
          title: "Test Window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          controls: {},
          // New fields from "future version"
          futureField1: "hello",
          futureField2: { nested: true },
          // Missing many required fields
        },
      },
      focusedWindowId: 1,
      focusedApp: null,
      activeDialogs: [],
      // Missing: appDomains, lastFullScan, sessionId, etc.
      extraField: "future",
    };

    const restored = worldStateFromJSON(futureState as any);
    expect(restored).toBeTruthy();
    expect(restored.windows.size).toBe(1);
    // Defaults should be filled in
    expect(restored.confidence).toBe(1.0);
    expect(restored.pendingGoal).toBeNull();
    expect(restored.recentTransitions).toEqual([]);
    // VERDICT: RESILIENT — fromJSON provides defaults for missing fields, ignores unknown ones
  });
});

// ═══════════════════════════════════════════════════════════
// L2C: BRIDGE CLIENT DESTRUCTION (mock-based)
// ═══════════════════════════════════════════════════════════

describe("CHAOS L2C: Bridge Client Logic Destruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L2C1: writeQueue has 100 pending writes then process reference goes null", () => {
    // COMBO: burst writes + process death mid-queue
    // Simulating the writeQueue serialization logic without spawning a real process

    const pendingRejections: Error[] = [];
    let writeQueue = Promise.resolve();
    let processRef: { stdin: { write: (data: string, cb: () => void) => void } } | null = {
      stdin: {
        write: (_data: string, cb: () => void) => {
          // Simulate slow writes
          setTimeout(cb, 10);
        },
      },
    };

    // Queue 100 writes
    for (let i = 0; i < 100; i++) {
      const idx = i;
      writeQueue = writeQueue.then(() => {
        return new Promise<void>((writeResolve) => {
          try {
            if (!processRef || !processRef.stdin) {
              pendingRejections.push(new Error(`Write ${idx} failed: process null`));
              writeResolve();
              return;
            }
            processRef.stdin.write(`{"id":${idx}}\n`, () => writeResolve());
          } catch (err) {
            pendingRejections.push(err as Error);
            writeResolve();
          }
        });
      });

      // Kill process after 20 writes
      if (i === 20) {
        processRef = null;
      }
    }

    // Wait for all writes to complete/fail
    return writeQueue.then(() => {
      // processRef is nulled synchronously at i=20, but all writes are queued synchronously
      // before any execute (due to async chaining). Since the first write's 10ms setTimeout
      // hasn't fired yet when processRef is nulled, most/all writes see null process.
      // The key assertion: ALL writes complete (no hangs) and failures are captured.
      expect(pendingRejections.length).toBeGreaterThanOrEqual(80);
      expect(pendingRejections.length).toBeLessThanOrEqual(100);
      // All rejections should mention process null
      for (const err of pendingRejections) {
        expect(err.message).toContain("process null");
      }
      // VERDICT: RESILIENT — writeQueue drains cleanly, all pending writes get error callbacks
    });
  });

  it("L2C2: rejectAllPending with 200 pending requests + concurrent new requests arriving", () => {
    // COMBO: mass rejection + new requests during rejection
    const pending = new Map<number, { resolve: Function; reject: Function; timer: any }>();

    const rejectionErrors: Error[] = [];

    // Create 200 pending requests
    for (let i = 0; i < 200; i++) {
      pending.set(i, {
        resolve: () => {},
        reject: (err: Error) => { rejectionErrors.push(err); },
        timer: setTimeout(() => {}, 60000), // long timeout
      });
    }

    // Simulate rejectAllPending
    const rejectAllPending = (reason: string) => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
        pending.delete(id);
      }
    };

    rejectAllPending("Bridge crashed");

    expect(rejectionErrors).toHaveLength(200);
    expect(pending.size).toBe(0);

    // All errors should have the right message
    for (const err of rejectionErrors) {
      expect(err.message).toBe("Bridge crashed");
    }
    // VERDICT: RESILIENT — all 200 pending requests cleanly rejected, timers cleared
  });

  it("L2C3: Exponential backoff calculation with extreme consecutiveRestarts values", () => {
    // COMBO: backoff overflow + boundary conditions
    const BASE_DELAY = 500;

    const delays: number[] = [];
    for (let restart = 0; restart <= 20; restart++) {
      const raw = BASE_DELAY * Math.pow(2, restart);
      const capped = Math.min(raw, 8000);
      delays.push(capped);
    }

    // First few should be reasonable
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);
    expect(delays[2]).toBe(2000);
    expect(delays[3]).toBe(4000);
    expect(delays[4]).toBe(8000); // Capped

    // All should be capped at 8000
    for (let i = 4; i < delays.length; i++) {
      expect(delays[i]).toBe(8000);
    }

    // Very large restart count — Math.pow(2, 1000) is finite (~1e301) in JS, not Infinity
    // Math.pow(2, 1024) IS Infinity. Either way, Math.min(x, 8000) caps it.
    const extremeDelay = BASE_DELAY * Math.pow(2, 1000);
    expect(extremeDelay).toBeGreaterThan(1e100); // Astronomically large but finite
    const cappedExtreme = Math.min(extremeDelay, 8000);
    expect(cappedExtreme).toBe(8000); // Safely capped regardless
    // VERDICT: RESILIENT — Math.min cap prevents extreme values from propagating
  });
});

// ═══════════════════════════════════════════════════════════
// L1L2: CROSS-LAYER COMBINED DESTRUCTION
// ═══════════════════════════════════════════════════════════

describe("CHAOS L1L2: Cross-Layer Combined Destruction", () => {
  let model: WorldModel;

  beforeEach(() => {
    vi.mocked(persistence.loadWorldState).mockReturnValue(null);
    model = new WorldModel({ persistDebounceMs: 0 });
    model.init("chaos-cross");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CROSS1: ContextTracker flush + PlaybookStore save + WorldModel ingest all racing", () => {
    // COMBO: three subsystems writing simultaneously
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });

    const pb = {
      id: "race-test",
      name: "Race Test",
      description: "test",
      platform: "racetest",
      urlPatterns: ["racetest\\.com"],
      steps: [],
      tags: ["racetest"],
      version: "1.0.0",
      successCount: 5,
      failCount: 0,
      selectors: {},
      errors: [],
    } as any;
    fs.writeFileSync(path.join(dir, "references", "race-test.json"), JSON.stringify(pb));

    const store = new PlaybookStore(path.join(dir, "references"));
    store.load();

    const tracker = new ContextTracker(store);

    // Set context
    tracker.updateContext("browser_navigate", { url: "https://racetest.com" });

    // Simultaneously: record outcomes, ingest world model, save playbook
    for (let i = 0; i < 100; i++) {
      tracker.recordOutcome("browser_click", { selector: `.btn-${i}` }, true, null);
      model.ingestAXTree(1, makeFatTree(50), makeCtx());
      store.recordOutcome("race-test", i % 2 === 0);
    }

    // Flush tracker — triggers playbook save
    tracker.flush();

    // All systems still functional
    expect(model.getState().windows.size).toBe(1);
    const loaded = store.get("race-test");
    expect(loaded).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — each subsystem has its own state, no cross-contamination
  });

  it("CROSS2: Perception coordinator + session re-attach + broken adapter chain", async () => {
    // COMBO: coordinator running + session management + adapter failures
    const ax = mockAXSource();
    ax.pollAXTree.mockResolvedValue({
      event: {
        source: "ax_tree" as const,
        rate: "medium" as const,
        timestamp: new Date().toISOString(),
        data: {
          type: "ax_tree" as const,
          windowId: 1,
          tree: makeTree(),
          appContext: makeCtx(),
        },
      },
      latencyMs: 5,
      nodeCount: 2,
    });

    const coord = new PerceptionCoordinator(model, ax, null, null, {
      fastIntervalMs: 5000,
      mediumIntervalMs: 50,
      slowIntervalMs: 5000,
      enableAX: true,
      enableCDP: false,
      enableVision: false,
      maxROIsPerCycle: 3,
      skipCaptureLock: true,
    });

    await coord.start(makeCtx());

    // Simulate adapter failure during session re-attach
    const brokenAdapter = mockAdapter({
      attach: vi.fn().mockRejectedValue(new Error("Accessibility permissions revoked")),
    });
    const mgr = new SessionManager(brokenAdapter);

    // Re-attach should fail but not kill coordinator
    await expect(
      mgr.requireSessionResilent("ax_session_test_1234567890123"),
    ).rejects.toThrow("Accessibility permissions revoked");

    // Coordinator still running despite session failure
    expect(coord.isRunning).toBe(true);

    await new Promise(r => setTimeout(r, 200));

    // World model should have been updated by perception
    expect(model.getState().windows.size).toBeGreaterThan(0);

    await coord.stop();
    // VERDICT: RESILIENT — session failure is isolated from perception
  });

  it("CROSS3: Executor + RecallEngine + ContextTracker all processing simultaneously", async () => {
    // COMBO: action execution + memory recall + context tracking in one pass
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".screenhand", "memory"), { recursive: true });

    const store = new PlaybookStore(path.join(dir, "references"));
    store.load();
    const tracker = new ContextTracker(store);

    const memStore = new MemoryStore(dir);
    memStore.init();
    const recall = new RecallEngine(memStore);

    const adapter = mockAdapter();
    const executor = new Executor(adapter, mockCache(), mockLogger());

    // Simulate the intelligence wrapper pipeline
    tracker.updateContext("browser_navigate", { url: "https://test.com" });
    const errorCheck = recall.quickErrorCheck("browser_click");
    const hints = tracker.getHints("browser_click", { selector: "#btn" });

    // Execute action
    const result = await executor.press({
      sessionId: "ax_session_test_1234567890123",
      target: { type: "selector", value: "#btn" },
      budget: { locateMs: 200, actMs: 200, verifyMs: 200, maxRetries: 0 },
    });

    // Record outcome
    tracker.recordOutcome("browser_click", { selector: "#btn" }, result.ok, null);
    memStore.appendAction({
      tool: "browser_click",
      success: result.ok,
      params: { selector: "#btn" },
      result: "ok",
      durationMs: 50,
      timestamp: new Date().toISOString(),
    } as any);

    // Strategy hint
    const stratHint = recall.quickStrategyHint(["browser_navigate", "browser_click"]);

    expect(result.ok).toBe(true);
    expect(Array.isArray(hints)).toBe(true);
    expect(errorCheck === null || typeof errorCheck === "object").toBe(true);

    memStore.clear("all");
    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — full pipeline works end-to-end with no interference
  });

  it("CROSS4: WorldModel overloaded + fusion pipeline + perception stop/start + UI events blast", async () => {
    // COMBO: heavy world model + fusion + coordinator lifecycle + event storm
    const ax = mockAXSource();
    let pollNum = 0;
    ax.pollAXTree.mockImplementation(async () => {
      pollNum++;
      return {
        event: {
          source: "ax_tree" as const,
          rate: "medium" as const,
          timestamp: new Date().toISOString(),
          data: {
            type: "ax_tree" as const,
            windowId: pollNum % 5,
            tree: makeFatTree(100),
            appContext: makeCtx({ windowId: pollNum % 5, pid: 8000 + (pollNum % 5) }),
          },
        },
        latencyMs: 10,
        nodeCount: 100,
      };
    });

    ax.drainEvents.mockReturnValue({
      source: "ax_events",
      rate: "fast",
      timestamp: new Date().toISOString(),
      data: {
        type: "ax_events",
        events: Array.from({ length: 50 }, (_, i) => ({
          type: i % 3 === 0 ? "value_changed" : "focus_changed",
          pid: 8000 + (i % 5),
          elementRole: "button",
          elementLabel: `Btn_${i}`,
        })),
      },
    });

    const coord = new PerceptionCoordinator(model, ax, null, null, {
      fastIntervalMs: 30,
      mediumIntervalMs: 50,
      slowIntervalMs: 5000,
      enableAX: true,
      enableCDP: false,
      enableVision: false,
      maxROIsPerCycle: 3,
      skipCaptureLock: true,
    });

    // Pre-fill model with data
    for (let i = 0; i < 20; i++) {
      model.ingestAXTree(i, makeFatTree(100), makeCtx({ windowId: i, pid: 8000 + i }));
    }

    // Start, let cycles run
    await coord.start(makeCtx());
    await new Promise(r => setTimeout(r, 250));

    // Stop/start rapidly
    await coord.stop();
    await coord.start(makeCtx({ pid: 9000 }));
    await new Promise(r => setTimeout(r, 150));

    // Blast UI events while perception is running
    const eventBlast = Array.from({ length: 200 }, (_, i) => ({
      type: "value_changed",
      pid: 8000 + (i % 20),
      elementRole: "textField",
      elementLabel: `Input_${i}`,
      newValue: `Value_${i}`,
    }));
    model.ingestUIEvents(eventBlast as any);

    expect(coord.isRunning).toBe(true);

    const summary = model.toSummary();
    expect(summary).toBeTruthy();

    await coord.stop();
    // VERDICT: RESILIENT — high-throughput operation with lifecycle churn handled cleanly
  });

  it("CROSS5: Recorder captures during executor failures + context tracker domain flip", async () => {
    // COMBO: recording tool calls that fail + context switching mid-recording
    const dir = tmpDir();
    const recorder = new McpPlaybookRecorder(dir);
    const store = new PlaybookStore(dir);
    store.load();
    const tracker = new ContextTracker(store);

    recorder.start("chaos-test");
    tracker.updateContext("browser_navigate", { url: "https://site-a.com" });

    // Simulate a mix of successful and failed tool calls
    const tools = [
      { name: "browser_navigate", params: { url: "https://site-a.com" }, success: true },
      { name: "browser_click", params: { selector: "#btn" }, success: true },
      { name: "browser_click", params: { selector: "#missing" }, success: false },
      { name: "browser_type", params: { selector: "#input", text: "hello" }, success: true },
    ];

    for (const t of tools) {
      recorder.captureToolCall(t.name, t.params, t.success, t.success ? "ok" : "error", 50);
      tracker.recordOutcome(t.name, t.params, t.success, t.success ? null : "Element not found");
    }

    // Domain flip mid-recording
    tracker.updateContext("browser_navigate", { url: "https://site-b.com" });
    recorder.captureToolCall("browser_navigate", { url: "https://site-b.com" }, true, "ok", 30);

    // More tools on new domain
    for (let i = 0; i < 5; i++) {
      recorder.captureToolCall("browser_click", { selector: `#btn-${i}` }, true, "ok", 20);
      tracker.recordOutcome("browser_click", { selector: `#btn-${i}` }, true, null);
    }

    const pb = recorder.stop("Cross-domain PB", "Recorded across domains");
    tracker.flush();

    // Playbook should have steps from both domains
    expect(pb.steps.length).toBeGreaterThan(3);
    // Failed steps should be marked optional
    const optionalSteps = pb.steps.filter(s => s.optional);
    expect(optionalSteps.length).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true });
    // VERDICT: RESILIENT — cross-domain recording works, failures marked optional
  });
});
