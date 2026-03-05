import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { RecallEngine } from "../src/memory/recall.js";
import { SessionTracker } from "../src/memory/session.js";

let tmpDir: string;
let store: MemoryStore;
let recall: RecallEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenhand-recall-"));
  store = new MemoryStore(tmpDir);
  store.init();
  recall = new RecallEngine(store);
});

afterEach(() => {
  // Remove lock file first, then clean up
  const lockPath = path.join(tmpDir, ".screenhand", "memory", ".lock");
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function addStrategy(task: string, tools: string[], tags: string[] = [], overrides: Partial<{ successCount: number; failCount: number }> = {}): void {
  store.appendStrategy({
    id: "str_" + Math.random().toString(36).slice(2, 8),
    task,
    steps: tools.map((t) => ({ tool: t, params: {} })),
    totalDurationMs: 100,
    successCount: overrides.successCount ?? 1,
    failCount: overrides.failCount ?? 0,
    lastUsed: new Date().toISOString(),
    tags: tags.length > 0 ? tags : task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3),
    fingerprint: tools.join("→"),
  });
}

function addError(tool: string, error: string, resolution: string | null = null): void {
  store.appendError({
    id: "err_" + Math.random().toString(36).slice(2, 8),
    tool,
    params: {},
    error,
    resolution,
    occurrences: 1,
    lastSeen: new Date().toISOString(),
  });
}

describe("RecallEngine", () => {
  describe("recallStrategies", () => {
    it("returns empty when no strategies exist", () => {
      expect(recall.recallStrategies("take a photo")).toEqual([]);
    });

    it("finds strategies by keyword match", () => {
      addStrategy("take a photo with Photo Booth", ["apps", "focus", "ui_press"], ["photo", "booth", "camera"]);
      addStrategy("open Chrome and navigate", ["launch", "browser_navigate"], ["chrome", "browser"]);

      const results = recall.recallStrategies("photo");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.task).toContain("photo");
    });

    it("ranks by relevance — more keyword matches = higher score", () => {
      addStrategy("take a photo with Photo Booth", ["apps", "focus", "ui_press"], ["photo", "booth", "camera"]);
      addStrategy("open Photos app", ["launch"], ["photos", "app"]);

      const results = recall.recallStrategies("take photo booth");
      expect(results[0]!.task).toContain("Photo Booth");
    });

    it("respects limit parameter", () => {
      addStrategy("task one", ["apps"]);
      addStrategy("task two", ["apps"]);
      addStrategy("task three", ["apps"]);

      const results = recall.recallStrategies("task", 2);
      expect(results).toHaveLength(2);
    });
  });

  describe("recallByFingerprint", () => {
    it("returns null when no match", () => {
      expect(recall.recallByFingerprint(["apps", "focus"])).toBeNull();
    });

    it("returns exact match by tool sequence", () => {
      addStrategy("photo workflow", ["apps", "focus", "ui_press"]);
      const result = recall.recallByFingerprint(["apps", "focus", "ui_press"]);
      expect(result).not.toBeNull();
      expect(result!.task).toBe("photo workflow");
    });

    it("skips strategies that fail more than succeed", () => {
      addStrategy("unreliable", ["apps", "focus"], [], { successCount: 2, failCount: 5 });
      expect(recall.recallByFingerprint(["apps", "focus"])).toBeNull();
    });

    it("returns strategy when failures are within tolerance", () => {
      addStrategy("mostly works", ["apps", "focus"], [], { successCount: 5, failCount: 3 });
      const result = recall.recallByFingerprint(["apps", "focus"]);
      expect(result).not.toBeNull();
    });
  });

  describe("reliability penalty in recallStrategies", () => {
    it("penalizes strategies with high fail rates", () => {
      addStrategy("reliable photo", ["apps", "focus", "ui_press"], ["photo"], { successCount: 10, failCount: 1 });
      addStrategy("unreliable photo", ["launch", "ui_press"], ["photo"], { successCount: 2, failCount: 8 });

      const results = recall.recallStrategies("photo");
      expect(results.length).toBe(2);
      // Reliable strategy should rank higher
      expect(results[0]!.task).toBe("reliable photo");
    });
  });

  describe("quickErrorCheck", () => {
    it("returns null when no errors", () => {
      expect(recall.quickErrorCheck("launch")).toBeNull();
    });

    it("returns null when no resolution exists", () => {
      addError("launch", "timed out", null);
      expect(recall.quickErrorCheck("launch")).toBeNull();
    });

    it("returns error with resolution", () => {
      addError("launch", "timed out", "use focus() instead");
      const result = recall.quickErrorCheck("launch");
      expect(result).not.toBeNull();
      expect(result!.resolution).toBe("use focus() instead");
    });

    it("returns highest-occurrence error", () => {
      addError("launch", "error A", "fix A");
      // Add same error again to bump occurrences
      store.appendError({
        id: "err_bump", tool: "launch", params: {},
        error: "error A", resolution: "fix A",
        occurrences: 1, lastSeen: new Date().toISOString(),
      });
      addError("launch", "error B", "fix B");

      const result = recall.quickErrorCheck("launch");
      expect(result!.error).toBe("error A");
      expect(result!.occurrences).toBe(2);
    });
  });

  describe("quickStrategyHint", () => {
    it("returns null when no strategies", () => {
      expect(recall.quickStrategyHint(["apps"])).toBeNull();
    });

    it("suggests next step when mid-strategy", () => {
      addStrategy("photo workflow", ["apps", "focus", "ui_press"]);

      const hint = recall.quickStrategyHint(["apps", "focus"]);
      expect(hint).not.toBeNull();
      expect(hint!.nextStep.tool).toBe("ui_press");
      expect(hint!.fingerprint).toBe("apps→focus→ui_press");
    });

    it("skips unreliable strategies", () => {
      addStrategy("bad workflow", ["apps", "focus", "ui_press"], [], { successCount: 1, failCount: 5 });
      expect(recall.quickStrategyHint(["apps", "focus"])).toBeNull();
    });

    it("returns null when sequence doesn't match", () => {
      addStrategy("photo workflow", ["apps", "focus", "ui_press"]);
      expect(recall.quickStrategyHint(["launch", "focus"])).toBeNull();
    });

    it("returns null when strategy is already complete", () => {
      addStrategy("photo workflow", ["apps", "focus"]);
      expect(recall.quickStrategyHint(["apps", "focus"])).toBeNull();
    });
  });

  describe("recallErrors", () => {
    it("returns all errors when no tool filter", () => {
      addError("launch", "timed out", "use focus() instead");
      addError("ui_press", "element not found");

      const results = recall.recallErrors();
      expect(results).toHaveLength(2);
    });

    it("filters by tool name", () => {
      addError("launch", "timed out");
      addError("ui_press", "element not found");

      const results = recall.recallErrors("launch");
      expect(results).toHaveLength(1);
      expect(results[0]!.tool).toBe("launch");
    });
  });
});

describe("SessionTracker", () => {
  it("starts a session and returns an ID", () => {
    const tracker = new SessionTracker(store);
    const id = tracker.startSession("test task");
    expect(id).toMatch(/^s_/);
  });

  it("saves a strategy on successful endSession", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("take a photo");

    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "focus", params: { bundleId: "com.apple.PhotoBooth" },
      durationMs: 30, success: true, result: "Focused", error: null,
    });
    tracker.recordAction({
      id: "a_2", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "ui_press", params: { pid: 1234, title: "Take Photo" },
      durationMs: 50, success: true, result: "Pressed", error: null,
    });

    const strategy = tracker.endSession(true);
    expect(strategy).not.toBeNull();
    expect(strategy!.task).toBe("take a photo");
    expect(strategy!.steps).toHaveLength(2);

    expect(store.readStrategies()).toHaveLength(1);
  });

  it("returns null on failed endSession", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("test");
    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    expect(tracker.endSession(false)).toBeNull();
    expect(store.readStrategies()).toHaveLength(0);
  });

  it("allows passing task description at endSession", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession();
    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    const result = tracker.endSession(true, "list running apps");
    expect(result).not.toBeNull();
    expect(result!.task).toBe("list running apps");
  });

  it("provides recent tool names for strategy matching", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("test");

    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });
    tracker.recordAction({
      id: "a_2", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "focus", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    expect(tracker.getRecentToolNames()).toEqual(["apps", "focus"]);
  });

  it("auto-saves strategy when starting a new session after 3+ successes", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("first task");

    // Record 3 successful actions
    for (let i = 0; i < 3; i++) {
      tracker.recordAction({
        id: `a_${i}`, timestamp: new Date().toISOString(), sessionId: "s_test",
        tool: ["apps", "focus", "ui_press"][i]!, params: {},
        durationMs: 10, success: true, result: "ok", error: null,
      });
    }

    // Starting a new session triggers auto-save of the previous one
    tracker.startSession("second task");

    const strategies = store.readStrategies();
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.task).toBe("first task");
    expect(strategies[0]!.steps).toHaveLength(3);
  });

  it("does NOT auto-save when fewer than 3 successful actions", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("short task");

    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });
    tracker.recordAction({
      id: "a_2", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "focus", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    tracker.startSession("next task");
    expect(store.readStrategies()).toHaveLength(0);
  });

  it("auto-infers task description from tool sequence when no explicit description", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession(); // no description

    for (let i = 0; i < 3; i++) {
      tracker.recordAction({
        id: `a_${i}`, timestamp: new Date().toISOString(), sessionId: "s_test",
        tool: ["apps", "focus", "ui_press"][i]!,
        params: i === 1 ? { bundleId: "com.apple.Safari" } : {},
        durationMs: 10, success: true, result: "ok", error: null,
      });
    }

    tracker.startSession("new session");

    const strategies = store.readStrategies();
    expect(strategies).toHaveLength(1);
    // Should contain tool names and key params
    expect(strategies[0]!.task).toContain("apps");
    expect(strategies[0]!.task).toContain("focus");
    expect(strategies[0]!.task).toContain("Safari");
  });
});
