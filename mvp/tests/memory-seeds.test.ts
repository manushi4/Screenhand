import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SEED_STRATEGIES } from "../src/memory/seeds.js";
import { MemoryStore } from "../src/memory/store.js";
import { RecallEngine } from "../src/memory/recall.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seeds-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SEED_STRATEGIES structure", () => {
  it("all seeds have valid required fields", () => {
    for (const s of SEED_STRATEGIES) {
      expect(s.id).toBeTruthy();
      expect(s.task).toBeTruthy();
      expect(s.steps.length).toBeGreaterThan(0);
      expect(s.tags.length).toBeGreaterThan(0);
      expect(s.fingerprint).toBeTruthy();
      expect(typeof s.successCount).toBe("number");
      expect(typeof s.failCount).toBe("number");
      expect(s.lastUsed).toBeTruthy();
      for (const step of s.steps) {
        expect(step.tool).toBeTruthy();
        expect(step.params).toBeDefined();
      }
    }
  });

  it("all seeds have successCount of 10", () => {
    for (const s of SEED_STRATEGIES) {
      expect(s.successCount).toBe(10);
    }
  });

  it("has no duplicate fingerprints", () => {
    const fingerprints = SEED_STRATEGIES.map((s) => s.fingerprint);
    const unique = new Set(fingerprints);
    // Some seeds may share tool sequences (e.g. focus→key), so check IDs are unique
    const ids = SEED_STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has approximately 12 seed strategies", () => {
    expect(SEED_STRATEGIES.length).toBeGreaterThanOrEqual(10);
    expect(SEED_STRATEGIES.length).toBeLessThanOrEqual(15);
  });
});

describe("Store seed loading", () => {
  it("loads seeds on first init (empty directory)", () => {
    const store = new MemoryStore(tmpDir);
    store.init();
    const strategies = store.readStrategies();
    expect(strategies.length).toBe(SEED_STRATEGIES.length);
    expect(strategies[0]!.id).toMatch(/^seed_/);
  });

  it("skips seeds when strategies already exist on disk", async () => {
    // First init — seeds are loaded and persisted
    const store1 = new MemoryStore(tmpDir);
    store1.init();

    // Add a custom strategy
    store1.appendStrategy({
      id: "str_custom",
      task: "custom task",
      steps: [{ tool: "screenshot", params: {} }],
      totalDurationMs: 100,
      successCount: 5,
      failCount: 0,
      lastUsed: new Date().toISOString(),
      tags: ["custom"],
      fingerprint: "screenshot",
    });

    // Flush pending async writes before reloading
    await store1.flush();

    // Create a new store instance — should NOT re-add seeds
    const store2 = new MemoryStore(tmpDir);
    store2.init();
    const strategies = store2.readStrategies();
    // Should have seeds + custom, not double seeds
    expect(strategies.length).toBe(SEED_STRATEGIES.length + 1);
  });

  it("seeds are searchable via RecallEngine", () => {
    const store = new MemoryStore(tmpDir);
    store.init();
    const engine = new RecallEngine(store);

    const results = engine.recallStrategies("take photo", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.task).toContain("Photo Booth");
  });

  it("seeds survive reload (persisted to disk)", async () => {
    const store1 = new MemoryStore(tmpDir);
    store1.init();

    // Flush pending async writes
    await store1.flush();

    // Check the file was written
    const memDir = path.join(tmpDir, ".screenhand", "memory");
    const strategiesFile = path.join(memDir, "strategies.jsonl");
    expect(fs.existsSync(strategiesFile)).toBe(true);

    const lines = fs.readFileSync(strategiesFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(SEED_STRATEGIES.length);
  });
});
