import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import type { ActionEntry, Strategy, ErrorPattern } from "../src/memory/types.js";

let tmpDir: string;
let store: MemoryStore;

function makeAction(overrides: Partial<ActionEntry> = {}): ActionEntry {
  return {
    id: "a_test" + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    sessionId: "s_test",
    tool: "apps",
    params: {},
    durationMs: 50,
    success: true,
    result: "ok",
    error: null,
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "str_test" + Math.random().toString(36).slice(2, 6),
    task: "test task",
    steps: [{ tool: "apps", params: {} }],
    totalDurationMs: 50,
    successCount: 1,
    lastUsed: new Date().toISOString(),
    tags: ["test"],
    ...overrides,
  };
}

function makeError(overrides: Partial<ErrorPattern> = {}): ErrorPattern {
  return {
    id: "err_test" + Math.random().toString(36).slice(2, 6),
    tool: "launch",
    params: { bundleId: "com.test.App" },
    error: "timed out",
    resolution: null,
    occurrences: 1,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

/** Wait for async file writes to flush */
function waitForFlush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenhand-test-"));
  store = new MemoryStore(tmpDir);
  store.init();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  describe("actions", () => {
    it("appends actions and updates in-memory stats", () => {
      store.appendAction(makeAction({ tool: "apps" }));
      store.appendAction(makeAction({ tool: "focus" }));

      const stats = store.getStats();
      expect(stats.totalActions).toBe(2);
      expect(stats.topTools).toContainEqual({ tool: "apps", count: 1 });
      expect(stats.topTools).toContainEqual({ tool: "focus", count: 1 });
    });

    it("tracks success rate in-memory", () => {
      store.appendAction(makeAction({ success: true }));
      store.appendAction(makeAction({ success: true }));
      store.appendAction(makeAction({ success: false }));

      expect(store.getStats().successRate).toBeCloseTo(2 / 3);
    });

    it("writes to disk asynchronously", async () => {
      store.appendAction(makeAction({ tool: "apps" }));
      await waitForFlush();

      const fp = path.join(tmpDir, ".screenhand", "memory", "actions.jsonl");
      expect(fs.existsSync(fp)).toBe(true);
      const content = fs.readFileSync(fp, "utf-8").trim();
      expect(content.split("\n")).toHaveLength(1);
    });

    it("returns empty stats when no actions", () => {
      expect(store.getStats().totalActions).toBe(0);
      expect(store.getStats().successRate).toBe(0);
    });
  });

  describe("strategies (cached)", () => {
    it("appends and reads from cache", () => {
      store.appendStrategy(makeStrategy({ task: "task A" }));
      store.appendStrategy(makeStrategy({ task: "task B" }));

      const strategies = store.readStrategies();
      expect(strategies).toHaveLength(2);
    });

    it("deduplicates by task name and increments successCount", () => {
      store.appendStrategy(makeStrategy({ task: "take a photo", successCount: 1 }));
      store.appendStrategy(makeStrategy({ task: "take a photo", successCount: 1 }));

      const strategies = store.readStrategies();
      expect(strategies).toHaveLength(1);
      expect(strategies[0]!.successCount).toBe(2);
    });

    it("persists to disk asynchronously", async () => {
      store.appendStrategy(makeStrategy({ task: "persist test" }));
      await waitForFlush();

      const fp = path.join(tmpDir, ".screenhand", "memory", "strategies.jsonl");
      const content = fs.readFileSync(fp, "utf-8").trim();
      expect(content).toContain("persist test");
    });

    it("survives re-init (loads from disk)", async () => {
      store.appendStrategy(makeStrategy({ task: "survive reload" }));
      await waitForFlush();

      // Create a new store pointing at the same dir
      const store2 = new MemoryStore(tmpDir);
      store2.init();
      expect(store2.readStrategies()).toHaveLength(1);
      expect(store2.readStrategies()[0]!.task).toBe("survive reload");
    });
  });

  describe("errors (cached)", () => {
    it("appends and reads from cache", () => {
      store.appendError(makeError());
      const errors = store.readErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.tool).toBe("launch");
    });

    it("deduplicates by tool+error and increments occurrences", () => {
      store.appendError(makeError({ tool: "launch", error: "timed out" }));
      store.appendError(makeError({ tool: "launch", error: "timed out" }));

      const errors = store.readErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.occurrences).toBe(2);
    });

    it("preserves existing resolution when new one is null", () => {
      store.appendError(makeError({ tool: "launch", error: "timeout", resolution: "use focus()" }));
      store.appendError(makeError({ tool: "launch", error: "timeout", resolution: null }));

      const errors = store.readErrors();
      expect(errors[0]!.resolution).toBe("use focus()");
    });
  });

  describe("stats", () => {
    it("returns correct stats from in-memory counters", () => {
      store.appendAction(makeAction({ tool: "apps", success: true }));
      store.appendAction(makeAction({ tool: "apps", success: true }));
      store.appendAction(makeAction({ tool: "focus", success: false }));
      store.appendStrategy(makeStrategy());
      store.appendError(makeError());

      const stats = store.getStats();
      expect(stats.totalActions).toBe(3);
      expect(stats.totalStrategies).toBe(1);
      expect(stats.totalErrors).toBe(1);
      expect(stats.successRate).toBeCloseTo(2 / 3);
      expect(stats.topTools[0]!.tool).toBe("apps");
      expect(stats.topTools[0]!.count).toBe(2);
    });
  });

  describe("clear", () => {
    it("clears specific category from cache and disk", () => {
      store.appendAction(makeAction());
      store.appendStrategy(makeStrategy());
      store.appendError(makeError());

      store.clear("actions");
      expect(store.getStats().totalActions).toBe(0);
      expect(store.readStrategies()).toHaveLength(1);
      expect(store.readErrors()).toHaveLength(1);
    });

    it("clears all", () => {
      store.appendAction(makeAction());
      store.appendStrategy(makeStrategy());
      store.appendError(makeError());

      store.clear("all");
      expect(store.getStats().totalActions).toBe(0);
      expect(store.readStrategies()).toEqual([]);
      expect(store.readErrors()).toEqual([]);
    });
  });
});
