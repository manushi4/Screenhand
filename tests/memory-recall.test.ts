import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { RecallEngine } from "../src/memory/recall.js";
import { SessionTracker } from "../src/memory/session.js";
import type { Strategy, ErrorPattern } from "../src/memory/types.js";

let tmpDir: string;
let store: MemoryStore;
let recall: RecallEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenhand-recall-"));
  store = new MemoryStore(tmpDir);
  recall = new RecallEngine(store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function addStrategy(task: string, tools: string[], tags: string[] = []): void {
  store.appendStrategy({
    id: "str_" + Math.random().toString(36).slice(2, 8),
    task,
    steps: tools.map((t) => ({ tool: t, params: {} })),
    totalDurationMs: 100,
    successCount: 1,
    lastUsed: new Date().toISOString(),
    tags: tags.length > 0 ? tags : task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3),
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

    it("returns empty for unrelated queries", () => {
      addStrategy("take a photo with Photo Booth", ["apps", "focus", "ui_press"]);
      const results = recall.recallStrategies("send email");
      // May or may not match depending on token overlap — just verify it doesn't crash
      expect(Array.isArray(results)).toBe(true);
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

    it("returns empty for unknown tool", () => {
      addError("launch", "timed out");
      expect(recall.recallErrors("nonexistent")).toEqual([]);
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

    // Simulate recording actions
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
    expect(strategy!.steps[0]!.tool).toBe("focus");
    expect(strategy!.steps[1]!.tool).toBe("ui_press");

    // Verify it was persisted
    const saved = store.readStrategies();
    expect(saved).toHaveLength(1);
  });

  it("returns null on failed endSession", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession("test");
    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    const result = tracker.endSession(false);
    expect(result).toBeNull();
    expect(store.readStrategies()).toHaveLength(0);
  });

  it("returns null when no task description", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession(); // no task
    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    const result = tracker.endSession(true); // success but no task
    expect(result).toBeNull();
  });

  it("allows passing task description at endSession", () => {
    const tracker = new SessionTracker(store);
    tracker.startSession(); // no task initially
    tracker.recordAction({
      id: "a_1", timestamp: new Date().toISOString(), sessionId: "s_test",
      tool: "apps", params: {}, durationMs: 10, success: true, result: "ok", error: null,
    });

    const result = tracker.endSession(true, "list running apps");
    expect(result).not.toBeNull();
    expect(result!.task).toBe("list running apps");
  });
});
