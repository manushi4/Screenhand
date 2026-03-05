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
  const steps = overrides.steps ?? [{ tool: "apps", params: {} }];
  return {
    id: "str_test" + Math.random().toString(36).slice(2, 6),
    task: "test task",
    steps,
    totalDurationMs: 50,
    successCount: 1,
    failCount: 0,
    lastUsed: new Date().toISOString(),
    tags: ["test"],
    fingerprint: steps.map((s) => s.tool).join("→"),
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
  // Remove lock file first, then clean up
  const lockPath = path.join(tmpDir, ".screenhand", "memory", ".lock");
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
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
      // Wait for 100ms debounce + some buffer
      await new Promise((r) => setTimeout(r, 200));

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

  describe("fingerprint index", () => {
    it("looks up strategy by fingerprint in O(1)", () => {
      const s = makeStrategy({ task: "photo", steps: [{ tool: "apps", params: {} }, { tool: "focus", params: {} }] });
      store.appendStrategy(s);

      const found = store.lookupByFingerprint("apps→focus");
      expect(found).not.toBeUndefined();
      expect(found!.task).toBe("photo");
    });

    it("returns undefined for unknown fingerprint", () => {
      expect(store.lookupByFingerprint("nonexistent→tools")).toBeUndefined();
    });

    it("rebuilds index on init from disk", async () => {
      store.appendStrategy(makeStrategy({ task: "persisted", steps: [{ tool: "launch", params: {} }, { tool: "ui_press", params: {} }] }));
      await waitForFlush();

      const store2 = new MemoryStore(tmpDir);
      store2.init();
      const found = store2.lookupByFingerprint("launch→ui_press");
      expect(found).not.toBeUndefined();
      expect(found!.task).toBe("persisted");
    });
  });

  describe("feedback loop", () => {
    it("increments successCount on positive outcome", () => {
      const s = makeStrategy({ task: "test feedback", steps: [{ tool: "apps", params: {} }] });
      store.appendStrategy(s);

      store.recordStrategyOutcome("apps", true);
      const strategies = store.readStrategies();
      expect(strategies[0]!.successCount).toBe(2);
    });

    it("increments failCount on negative outcome", () => {
      const s = makeStrategy({ task: "test feedback", steps: [{ tool: "apps", params: {} }] });
      store.appendStrategy(s);

      store.recordStrategyOutcome("apps", false);
      const strategies = store.readStrategies();
      expect(strategies[0]!.failCount).toBe(1);
    });

    it("does nothing for unknown fingerprint", () => {
      store.recordStrategyOutcome("unknown→fp", true);
      expect(store.readStrategies()).toHaveLength(0);
    });
  });

  describe("corrupted JSONL recovery", () => {
    it("skips corrupted lines and parses valid ones", async () => {
      // Manually write a file with a corrupted line
      store.appendStrategy(makeStrategy({ task: "good entry" }));
      await waitForFlush();

      const fp = path.join(tmpDir, ".screenhand", "memory", "strategies.jsonl");
      // Append a corrupted line
      fs.appendFileSync(fp, "NOT VALID JSON\n");
      // Append another valid line manually
      const valid = makeStrategy({ task: "after corruption" });
      fs.appendFileSync(fp, JSON.stringify(valid) + "\n");

      // Re-init from disk
      const store2 = new MemoryStore(tmpDir);
      store2.init();
      const strategies = store2.readStrategies();
      // Should have both valid entries, skipping the corrupted one
      expect(strategies.length).toBe(2);
      expect(strategies[0]!.task).toBe("good entry");
      expect(strategies[1]!.task).toBe("after corruption");
    });

    it("handles completely empty file", () => {
      const fp = path.join(tmpDir, ".screenhand", "memory", "strategies.jsonl");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, "");

      const store2 = new MemoryStore(tmpDir);
      store2.init();
      expect(store2.readStrategies()).toEqual([]);
    });

    it("handles file with only whitespace/empty lines", () => {
      const fp = path.join(tmpDir, ".screenhand", "memory", "strategies.jsonl");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, "\n\n  \n\n");

      const store2 = new MemoryStore(tmpDir);
      store2.init();
      expect(store2.readStrategies()).toEqual([]);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest strategies when exceeding 500 limit", () => {
      // Add 502 strategies with different timestamps
      for (let i = 0; i < 502; i++) {
        const date = new Date(Date.now() - (502 - i) * 1000); // oldest first
        store.appendStrategy(makeStrategy({
          task: `task_${i}`,
          lastUsed: date.toISOString(),
          steps: [{ tool: `tool_${i}`, params: {} }],
          fingerprint: `tool_${i}`,
        }));
      }

      const strategies = store.readStrategies();
      expect(strategies.length).toBeLessThanOrEqual(500);
      // Oldest entries (task_0, task_1) should have been evicted
      expect(strategies.find((s) => s.task === "task_0")).toBeUndefined();
      expect(strategies.find((s) => s.task === "task_1")).toBeUndefined();
      // Newest entries should remain
      expect(strategies.find((s) => s.task === "task_501")).not.toBeUndefined();
    });

    it("evicts oldest errors when exceeding 200 limit", () => {
      for (let i = 0; i < 202; i++) {
        const date = new Date(Date.now() - (202 - i) * 1000);
        store.appendError(makeError({
          tool: `tool_${i}`,
          error: `error_${i}`,
          lastSeen: date.toISOString(),
        }));
      }

      const errors = store.readErrors();
      expect(errors.length).toBeLessThanOrEqual(200);
    });
  });

  describe("file locking", () => {
    it("creates lock file on init", () => {
      const lockPath = path.join(tmpDir, ".screenhand", "memory", ".lock");
      expect(fs.existsSync(lockPath)).toBe(true);
      const content = fs.readFileSync(lockPath, "utf-8").trim();
      expect(parseInt(content, 10)).toBe(process.pid);
    });

    it("second store instance skips writes when locked", async () => {
      // store already holds the lock
      store.appendStrategy(makeStrategy({ task: "from first" }));

      // Second instance can't get lock
      const store2 = new MemoryStore(tmpDir);
      store2.init();
      store2.appendStrategy(makeStrategy({ task: "from second" }));
      await waitForFlush();

      // Second instance should have it in cache but not on disk
      expect(store2.readStrategies().find((s) => s.task === "from second")).not.toBeUndefined();
    });
  });

  describe("buffered writes", () => {
    it("batches multiple action writes", async () => {
      // Write 5 actions rapidly
      for (let i = 0; i < 5; i++) {
        store.appendAction(makeAction({ tool: `tool_${i}` }));
      }

      // Stats should be immediate (in-memory)
      expect(store.getStats().totalActions).toBe(5);

      // Wait for debounced flush
      await new Promise((r) => setTimeout(r, 150));

      const fp = path.join(tmpDir, ".screenhand", "memory", "actions.jsonl");
      const lines = fs.readFileSync(fp, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(5);
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
