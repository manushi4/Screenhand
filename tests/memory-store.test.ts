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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenhand-test-"));
  store = new MemoryStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  describe("actions", () => {
    it("appends and reads actions", () => {
      const a1 = makeAction({ tool: "apps" });
      const a2 = makeAction({ tool: "focus" });
      store.appendAction(a1);
      store.appendAction(a2);

      const actions = store.readActions();
      expect(actions).toHaveLength(2);
      expect(actions[0]!.tool).toBe("apps");
      expect(actions[1]!.tool).toBe("focus");
    });

    it("returns empty array when no file exists", () => {
      expect(store.readActions()).toEqual([]);
    });

    it("rotates actions file at 10MB", () => {
      // Write a large payload to exceed 10MB (10 * 1024 * 1024 = 10,485,760)
      const bigResult = "x".repeat(1_100_000);
      for (let i = 0; i < 11; i++) {
        store.appendAction(makeAction({ result: bigResult }));
      }

      const memDir = path.join(tmpDir, ".screenhand", "memory");
      expect(fs.existsSync(path.join(memDir, "actions.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(memDir, "actions.1.jsonl"))).toBe(true);

      // Current file should have fewer entries than total written
      const current = store.readActions();
      expect(current.length).toBeLessThan(11);
    });
  });

  describe("strategies", () => {
    it("appends and reads strategies", () => {
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
  });

  describe("errors", () => {
    it("appends and reads error patterns", () => {
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
    it("returns correct stats", () => {
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

    it("returns zero stats when empty", () => {
      const stats = store.getStats();
      expect(stats.totalActions).toBe(0);
      expect(stats.successRate).toBe(0);
    });
  });

  describe("clear", () => {
    it("clears specific category", () => {
      store.appendAction(makeAction());
      store.appendStrategy(makeStrategy());
      store.appendError(makeError());

      store.clear("actions");
      expect(store.readActions()).toEqual([]);
      expect(store.readStrategies()).toHaveLength(1);
      expect(store.readErrors()).toHaveLength(1);
    });

    it("clears all", () => {
      store.appendAction(makeAction());
      store.appendStrategy(makeStrategy());
      store.appendError(makeError());

      store.clear("all");
      expect(store.readActions()).toEqual([]);
      expect(store.readStrategies()).toEqual([]);
      expect(store.readErrors()).toEqual([]);
    });
  });
});
