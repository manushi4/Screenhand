/**
 * L1+L2 Scenario Tests — Batch 2
 *
 * Covers modules with ZERO test coverage that testers completely ignored:
 * - LocatorCache (L1): cache + learning engine fallback
 * - TimelineLogger (L1): action telemetry tracking
 * - AX Role Map (L1): web↔macOS role translation
 * - LocatorPolicy (L5→L1): Bayesian locator scoring
 * - SensorPolicy (L5→L2): per-app perception source ranking
 * - RecoveryPolicy (L5→L4): recovery strategy ranking
 * - PatternPolicy (L5→L1): tool+locator pattern learning
 * - PlaybookStore (L1): matching by domain/bundleId/URL/tags/task
 * - Config (L1): default budget values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// L1: LOCATOR CACHE — in-memory cache + learning engine fallback
// ═══════════════════════════════════════════════════════════════════════

describe("L1 LocatorCache", () => {
  async function createCache() {
    const { LocatorCache } = await import("../src/runtime/locator-cache.js");
    return new LocatorCache();
  }

  it("set/get stores and retrieves locator", async () => {
    const cache = await createCache();
    cache.set("github.com", "selector:#submit", "[data-testid='submit']");
    expect(cache.get("github.com", "selector:#submit")).toBe("[data-testid='submit']");
  });

  it("get returns undefined for cache miss", async () => {
    const cache = await createCache();
    expect(cache.get("github.com", "selector:#missing")).toBeUndefined();
  });

  it("set overwrites existing entry", async () => {
    const cache = await createCache();
    cache.set("site", "action", "locator1");
    cache.set("site", "action", "locator2");
    expect(cache.get("site", "action")).toBe("locator2");
  });

  it("different sites have separate caches", async () => {
    const cache = await createCache();
    cache.set("siteA", "action", "locatorA");
    cache.set("siteB", "action", "locatorB");
    expect(cache.get("siteA", "action")).toBe("locatorA");
    expect(cache.get("siteB", "action")).toBe("locatorB");
  });

  it("falls back to learning engine when cache misses", async () => {
    const cache = await createCache();
    const mockEngine = {
      recommendLocator: vi.fn().mockReturnValue({ locator: "[data-auto='btn']", score: 0.9 }),
    };
    cache.setLearningEngine(mockEngine as any);

    const result = cache.get("site", "action");
    expect(result).toBe("[data-auto='btn']");
    expect(mockEngine.recommendLocator).toHaveBeenCalledWith("site", "action");
  });

  it("promotes learning engine result to cache on hit", async () => {
    const cache = await createCache();
    const mockEngine = {
      recommendLocator: vi.fn().mockReturnValue({ locator: "[data-auto='btn']", score: 0.9 }),
    };
    cache.setLearningEngine(mockEngine as any);

    // First call hits engine
    cache.get("site", "action");
    // Second call should hit cache (engine not called again)
    mockEngine.recommendLocator.mockReturnValue(null);
    expect(cache.get("site", "action")).toBe("[data-auto='btn']");
  });

  it("returns undefined when learning engine also misses", async () => {
    const cache = await createCache();
    const mockEngine = { recommendLocator: vi.fn().mockReturnValue(null) };
    cache.setLearningEngine(mockEngine as any);
    expect(cache.get("site", "action")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L1: TIMELINE LOGGER — action telemetry
// ═══════════════════════════════════════════════════════════════════════

describe("L1 TimelineLogger", () => {
  async function createLogger() {
    const { TimelineLogger } = await import("../src/logging/timeline-logger.js");
    return new TimelineLogger();
  }

  it("start() returns telemetry with zero counters", async () => {
    const logger = await createLogger();
    const tel = logger.start("press", "session1");
    expect(tel.action).toBe("press");
    expect(tel.sessionId).toBe("session1");
    expect(tel.locateMs).toBe(0);
    expect(tel.actMs).toBe(0);
    expect(tel.verifyMs).toBe(0);
    expect(tel.retries).toBe(0);
    expect(tel.startedAt).toBeTruthy();
  });

  it("finish() adds finishedAt, totalMs, and status", async () => {
    const logger = await createLogger();
    const tel = logger.start("click", "s1");
    const finished = logger.finish(tel, "success");
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.totalMs).toBeGreaterThanOrEqual(0);
    expect(finished.status).toBe("success");
  });

  it("getRecent() returns finished actions", async () => {
    const logger = await createLogger();
    const t1 = logger.start("click", "s1");
    logger.finish(t1, "success");
    const t2 = logger.start("type", "s1");
    logger.finish(t2, "failed");

    const recent = logger.getRecent();
    expect(recent.length).toBe(2);
    expect(recent[0]!.action).toBe("click");
    expect(recent[1]!.action).toBe("type");
  });

  it("getRecent() respects limit parameter", async () => {
    const logger = await createLogger();
    for (let i = 0; i < 10; i++) {
      const t = logger.start(`action${i}`, "s1");
      logger.finish(t, "success");
    }
    expect(logger.getRecent(3).length).toBe(3);
    // Should return last 3
    expect(logger.getRecent(3)[0]!.action).toBe("action7");
  });

  it("getRecent() returns empty when no actions logged", async () => {
    const logger = await createLogger();
    expect(logger.getRecent()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L1: AX ROLE MAP — web↔macOS role translation
// ═══════════════════════════════════════════════════════════════════════

describe("L1 AX Role Map", () => {
  async function importRoleMap() {
    return await import("../src/runtime/ax-role-map.js");
  }

  it("WEB_TO_AX_ROLE maps button to AXButton", async () => {
    const { WEB_TO_AX_ROLE } = await importRoleMap();
    expect(WEB_TO_AX_ROLE["button"]).toBe("AXButton");
  });

  it("WEB_TO_AX_ROLE maps all common web roles", async () => {
    const { WEB_TO_AX_ROLE } = await importRoleMap();
    const expected: Record<string, string> = {
      button: "AXButton",
      link: "AXLink",
      textbox: "AXTextField",
      checkbox: "AXCheckBox",
      slider: "AXSlider",
      heading: "AXHeading",
      img: "AXImage",
      dialog: "AXSheet",
    };
    for (const [web, ax] of Object.entries(expected)) {
      expect(WEB_TO_AX_ROLE[web]).toBe(ax);
    }
  });

  it("AX_TO_WEB_ROLE is a valid reverse map", async () => {
    const { AX_TO_WEB_ROLE, WEB_TO_AX_ROLE } = await importRoleMap();
    // Every AX role in the reverse map should exist as a value in the forward map
    for (const [ax, web] of Object.entries(AX_TO_WEB_ROLE)) {
      expect(WEB_TO_AX_ROLE[web]).toBe(ax);
    }
  });

  it("toAXRole converts web role to AX role", async () => {
    const { toAXRole } = await importRoleMap();
    expect(toAXRole("button")).toBe("AXButton");
    expect(toAXRole("link")).toBe("AXLink");
    expect(toAXRole("textbox")).toBe("AXTextField");
  });

  it("toAXRole passes through AX roles unchanged", async () => {
    const { toAXRole } = await importRoleMap();
    expect(toAXRole("AXButton")).toBe("AXButton");
    expect(toAXRole("AXTextField")).toBe("AXTextField");
  });

  it("toAXRole returns original string for unknown roles", async () => {
    const { toAXRole } = await importRoleMap();
    expect(toAXRole("customrole")).toBe("customrole");
  });

  it("toAXRole is case-insensitive", async () => {
    const { toAXRole } = await importRoleMap();
    expect(toAXRole("Button")).toBe("AXButton");
    expect(toAXRole("LINK")).toBe("AXLink");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L5→L1: LOCATOR POLICY — Bayesian locator scoring
// ═══════════════════════════════════════════════════════════════════════

describe("L5 LocatorPolicy Bayesian scoring", () => {
  async function createPolicy() {
    const { LocatorPolicy } = await import("../src/learning/locator-policy.js");
    return new LocatorPolicy();
  }

  it("record creates new entry on first outcome", async () => {
    const policy = await createPolicy();
    policy.record({
      bundleId: "com.test", actionKey: "click:Submit",
      locator: "#submit", method: "ax", success: true,
    });
    const entries = policy.getEntries("com.test", "click:Submit");
    expect(entries.length).toBe(1);
    expect(entries[0]!.successCount).toBe(1);
    expect(entries[0]!.failCount).toBe(0);
  });

  it("record increments counters on subsequent outcomes", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", actionKey: "click:Save", locator: "#save", method: "ax", success: true });
    }
    policy.record({ bundleId: "com.test", actionKey: "click:Save", locator: "#save", method: "ax", success: false });

    const entries = policy.getEntries("com.test", "click:Save");
    expect(entries[0]!.successCount).toBe(5);
    expect(entries[0]!.failCount).toBe(1);
  });

  it("Bayesian score starts at 0.5 and converges to true rate", async () => {
    const policy = await createPolicy();
    // Record 10 successes, 0 failures
    for (let i = 0; i < 10; i++) {
      policy.record({ bundleId: "com.test", actionKey: "a", locator: "#x", method: "ax", success: true });
    }
    const entries = policy.getEntries("com.test", "a");
    // (10 + 2) / (10 + 4) ≈ 0.857 — approaching 1.0 but with prior pull
    expect(entries[0]!.score).toBeGreaterThan(0.8);
    expect(entries[0]!.score).toBeLessThan(1.0);
  });

  it("recommend returns null with insufficient samples", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", actionKey: "a", locator: "#x", method: "ax", success: true });
    expect(policy.recommend("com.test", "a")).toBeNull(); // default minSamples=5
  });

  it("recommend returns best locator after enough samples", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 8; i++) {
      policy.record({ bundleId: "com.test", actionKey: "a", locator: "#good", method: "ax", success: true });
    }
    for (let i = 0; i < 8; i++) {
      policy.record({ bundleId: "com.test", actionKey: "a", locator: "#bad", method: "ax", success: false });
    }
    const rec = policy.recommend("com.test", "a");
    expect(rec).not.toBeNull();
    expect(rec!.locator).toBe("#good");
  });

  it("tracks multiple locators per action independently", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", actionKey: "a", locator: "#x", method: "ax", success: true });
    policy.record({ bundleId: "com.test", actionKey: "a", locator: "#y", method: "cdp", success: false });
    const entries = policy.getEntries("com.test", "a");
    expect(entries.length).toBe(2);
  });

  it("clear removes all entries", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", actionKey: "a", locator: "#x", method: "ax", success: true });
    policy.clear();
    expect(policy.getAllEntries().length).toBe(0);
  });

  it("loadEntries restores persisted state", async () => {
    const { LocatorPolicy } = await import("../src/learning/locator-policy.js");
    const policy = await createPolicy();
    const key = LocatorPolicy.makeKey("com.test", "a");
    policy.loadEntries([{
      key, locator: "#restored", method: "ax",
      successCount: 10, failCount: 2, score: 0.8, lastUsed: new Date().toISOString(),
    }]);
    const entries = policy.getEntries("com.test", "a");
    expect(entries.length).toBe(1);
    expect(entries[0]!.locator).toBe("#restored");
    expect(entries[0]!.successCount).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L5→L2: SENSOR POLICY — per-app perception source ranking
// ═══════════════════════════════════════════════════════════════════════

describe("L5 SensorPolicy source ranking", () => {
  async function createPolicy() {
    const { SensorPolicy } = await import("../src/learning/sensor-policy.js");
    return new SensorPolicy();
  }

  it("record creates entry and tracks latency", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 50 });
    const all = policy.getAllEntries();
    expect(all.length).toBe(1);
    expect(all[0]!.avgLatencyMs).toBe(50);
  });

  it("record computes running average latency", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 100 });
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 200 });
    const all = policy.getAllEntries();
    expect(all[0]!.avgLatencyMs).toBeCloseTo(150, 0);
  });

  it("rank returns sources sorted by score", async () => {
    const policy = await createPolicy();
    // AX: 8 successes, 2 failures
    for (let i = 0; i < 8; i++) policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 30 });
    for (let i = 0; i < 2; i++) policy.record({ bundleId: "com.test", sourceType: "ax", success: false, latencyMs: 30 });
    // OCR: 3 successes, 7 failures
    for (let i = 0; i < 3; i++) policy.record({ bundleId: "com.test", sourceType: "ocr", success: true, latencyMs: 200 });
    for (let i = 0; i < 7; i++) policy.record({ bundleId: "com.test", sourceType: "ocr", success: false, latencyMs: 200 });

    const ranked = policy.rank("com.test");
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.sourceType).toBe("ax"); // higher score
  });

  it("rank breaks ties by latency (lower is better)", async () => {
    const policy = await createPolicy();
    // Same success rate, different latency
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 100 });
      policy.record({ bundleId: "com.test", sourceType: "cdp", success: true, latencyMs: 20 });
    }
    const ranked = policy.rank("com.test");
    // Scores should be nearly equal, so CDP (lower latency) should rank first
    expect(ranked[0]!.sourceType).toBe("cdp");
  });

  it("recommend returns null with insufficient data", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 30 });
    expect(policy.recommend("com.test")).toBeNull(); // needs 5 samples
  });

  it("recommend returns best source after enough data", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 6; i++) {
      policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 30 });
    }
    expect(policy.recommend("com.test")).toBe("ax");
  });

  it("different bundleIds have independent rankings", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 6; i++) {
      policy.record({ bundleId: "com.app1", sourceType: "ax", success: true, latencyMs: 30 });
      policy.record({ bundleId: "com.app2", sourceType: "ocr", success: true, latencyMs: 200 });
    }
    expect(policy.recommend("com.app1")).toBe("ax");
    expect(policy.recommend("com.app2")).toBe("ocr");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L5→L4: RECOVERY POLICY — recovery strategy ranking
// ═══════════════════════════════════════════════════════════════════════

describe("L5 RecoveryPolicy strategy ranking", () => {
  async function createPolicy() {
    const { RecoveryPolicy } = await import("../src/learning/recovery-policy.js");
    return new RecoveryPolicy();
  }

  it("record creates entry and tracks duration", async () => {
    const policy = await createPolicy();
    policy.record({
      blockerType: "unexpected_dialog", bundleId: "com.test",
      strategyId: "dismiss_cancel", success: true, durationMs: 200,
    });
    const all = policy.getAllEntries();
    expect(all.length).toBe(1);
    expect(all[0]!.avgDurationMs).toBe(200);
  });

  it("rank returns strategies sorted by success rate", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 8; i++) {
      policy.record({ blockerType: "unexpected_dialog", bundleId: "com.test", strategyId: "escape", success: true, durationMs: 50 });
    }
    for (let i = 0; i < 3; i++) {
      policy.record({ blockerType: "unexpected_dialog", bundleId: "com.test", strategyId: "cancel", success: true, durationMs: 100 });
    }
    for (let i = 0; i < 5; i++) {
      policy.record({ blockerType: "unexpected_dialog", bundleId: "com.test", strategyId: "cancel", success: false, durationMs: 100 });
    }

    const ranked = policy.rank("unexpected_dialog", "com.test");
    expect(ranked[0]!.strategyId).toBe("escape");
  });

  it("recommend returns null with insufficient samples", async () => {
    const policy = await createPolicy();
    policy.record({ blockerType: "focus_lost", bundleId: "com.test", strategyId: "refocus", success: true, durationMs: 50 });
    expect(policy.recommend("focus_lost", "com.test")).toBeNull();
  });

  it("recommend returns best strategy after enough data", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 5; i++) {
      policy.record({ blockerType: "focus_lost", bundleId: "com.test", strategyId: "refocus", success: true, durationMs: 50 });
    }
    expect(policy.recommend("focus_lost", "com.test")).toBe("refocus");
  });

  it("loadEntries restores state", async () => {
    const policy = await createPolicy();
    policy.loadEntries([{
      key: "unexpected_dialog::com.test", strategyId: "escape",
      successCount: 20, failCount: 1, score: 0.9, avgDurationMs: 45,
      lastUsed: new Date().toISOString(),
    }]);
    const all = policy.getAllEntries();
    expect(all.length).toBe(1);
    expect(all[0]!.successCount).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L5→L1: PATTERN POLICY — tool+locator pattern learning
// ═══════════════════════════════════════════════════════════════════════

describe("L5 PatternPolicy pattern learning", () => {
  async function createPolicy() {
    const { PatternPolicy } = await import("../src/learning/pattern-policy.js");
    return new PatternPolicy();
  }

  it("record creates and updates entries", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", tool: "click", locator: "#btn", method: "ax", success: true });
    policy.record({ bundleId: "com.test", tool: "click", locator: "#btn", method: "ax", success: true });
    policy.record({ bundleId: "com.test", tool: "click", locator: "#btn", method: "ax", success: false });

    const all = policy.getAllEntries();
    expect(all.length).toBe(1);
    expect(all[0]!.successCount).toBe(2);
    expect(all[0]!.failCount).toBe(1);
  });

  it("query returns entries for bundleId sorted by score", async () => {
    const policy = await createPolicy();
    // Good locator
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", tool: "click", locator: "#good", method: "ax", success: true });
    }
    // Bad locator
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", tool: "click", locator: "#bad", method: "ax", success: false });
    }
    const results = policy.query("com.test");
    expect(results.length).toBe(2);
    expect(results[0]!.locator).toBe("#good"); // higher score first
  });

  it("query filters by tool when specified", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", tool: "click", locator: "#a", method: "ax", success: true });
    policy.record({ bundleId: "com.test", tool: "type", locator: "#b", method: "ax", success: true });
    expect(policy.query("com.test", "click").length).toBe(1);
    expect(policy.query("com.test", "type").length).toBe(1);
  });

  it("recommend returns null below minSamples", async () => {
    const policy = await createPolicy();
    policy.record({ bundleId: "com.test", tool: "click", locator: "#a", method: "ax", success: true });
    expect(policy.recommend("com.test", "click")).toBeNull();
  });

  it("recommend returns best pattern above threshold", async () => {
    const policy = await createPolicy();
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", tool: "click", locator: "#btn", method: "ax", success: true });
    }
    const rec = policy.recommend("com.test", "click");
    expect(rec).not.toBeNull();
    expect(rec!.locator).toBe("#btn");
  });

  it("recommend returns null when score is 0.5 or below", async () => {
    const policy = await createPolicy();
    // Equal success and failure = score stays near 0.5
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId: "com.test", tool: "click", locator: "#flaky", method: "ax", success: true });
      policy.record({ bundleId: "com.test", tool: "click", locator: "#flaky", method: "ax", success: false });
    }
    // Score ≈ (5+2)/(10+4) ≈ 0.5 — should not recommend
    expect(policy.recommend("com.test", "click")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L1: PLAYBOOK STORE — matching algorithms
// ═══════════════════════════════════════════════════════════════════════

describe("L1 PlaybookStore matching", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbstore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createStore(playbooks: any[] = []) {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    for (const pb of playbooks) {
      fs.writeFileSync(path.join(tmpDir, `${pb.id}.json`), JSON.stringify(pb));
    }
    const store = new PlaybookStore(tmpDir);
    store.load();
    return store;
  }

  function makePlaybook(overrides: any = {}) {
    return {
      id: "test-pb",
      name: "Test Playbook",
      description: "A test",
      platform: "TestApp",
      tags: ["test"],
      version: "1.0.0",
      steps: [],
      successCount: 0,
      failCount: 0,
      ...overrides,
    };
  }

  it("load() reads playbooks from directory", async () => {
    const store = await createStore([makePlaybook({ id: "pb1" }), makePlaybook({ id: "pb2" })]);
    expect(store.getAll().length).toBe(2);
  });

  it("load() skips unparseable files", async () => {
    fs.writeFileSync(path.join(tmpDir, "bad.json"), "not json");
    const store = await createStore([makePlaybook({ id: "good" })]);
    expect(store.getAll().length).toBe(1);
  });

  it("get() retrieves by ID", async () => {
    const store = await createStore([makePlaybook({ id: "my-pb" })]);
    expect(store.get("my-pb")).toBeDefined();
    expect(store.get("missing")).toBeUndefined();
  });

  it("matchByDomain matches platform name", async () => {
    const store = await createStore([makePlaybook({ id: "github", platform: "GitHub" })]);
    const match = store.matchByDomain("github.com");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("github");
  });

  it("matchByDomain matches URL patterns", async () => {
    const store = await createStore([makePlaybook({
      id: "figma", platform: "Figma", urlPatterns: ["figma\\.com"],
    })]);
    expect(store.matchByDomain("figma.com")).not.toBeNull();
  });

  it("matchByDomain returns null for no match", async () => {
    const store = await createStore([makePlaybook({ id: "github", platform: "GitHub" })]);
    expect(store.matchByDomain("randomsite.xyz")).toBeNull();
  });

  it("matchByBundleId matches exact bundleId", async () => {
    const store = await createStore([makePlaybook({
      id: "safari", platform: "Safari", bundleId: "com.apple.Safari",
    })]);
    expect(store.matchByBundleId("com.apple.Safari")).not.toBeNull();
  });

  it("matchByBundleId matches by short app name from bundleId", async () => {
    const store = await createStore([makePlaybook({
      id: "davinci", platform: "DaVinciResolve",
    })]);
    const match = store.matchByBundleId("com.blackmagic-design.DaVinciResolve");
    expect(match).not.toBeNull();
  });

  it("matchByUrl matches URL against patterns", async () => {
    const store = await createStore([makePlaybook({
      id: "gh", platform: "GitHub", urlPatterns: ["github\\.com/.*"],
    })]);
    const matches = store.matchByUrl("https://github.com/test/repo");
    expect(matches.length).toBe(1);
  });

  it("matchByTags matches playbooks with matching tags", async () => {
    const store = await createStore([
      makePlaybook({ id: "a", tags: ["automation", "web"] }),
      makePlaybook({ id: "b", tags: ["native", "macos"] }),
    ]);
    const matches = store.matchByTags(["web"]);
    expect(matches.length).toBe(1);
    expect(matches[0]!.id).toBe("a");
  });

  it("matchByPlatform filters by platform name", async () => {
    const store = await createStore([
      makePlaybook({ id: "a", platform: "GitHub" }),
      makePlaybook({ id: "b", platform: "Figma" }),
    ]);
    expect(store.matchByPlatform("GitHub").length).toBe(1);
  });

  it("matchByTask does keyword matching", async () => {
    const store = await createStore([
      makePlaybook({ id: "login", name: "Login Flow", description: "Automate login to the dashboard", tags: ["auth"] }),
      makePlaybook({ id: "export", name: "Export Data", description: "Export CSV from reports", tags: ["data"] }),
    ]);
    const match = store.matchByTask("login to the dashboard");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("login");
  });

  it("matchByTask returns null for no keyword match", async () => {
    const store = await createStore([makePlaybook({ id: "a", name: "Test", description: "Nothing" })]);
    expect(store.matchByTask("zzz qqq xxx")).toBeNull();
  });

  it("save() writes to disk and updates in-memory", async () => {
    const store = await createStore([]);
    const pb = makePlaybook({ id: "new-pb" });
    store.save(pb);

    expect(store.get("new-pb")).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, "new-pb.json"))).toBe(true);
  });

  it("recordOutcome updates success/fail counts and saves", async () => {
    const store = await createStore([makePlaybook({ id: "pb1", successCount: 0, failCount: 0 })]);
    store.recordOutcome("pb1", true);
    store.recordOutcome("pb1", true);
    store.recordOutcome("pb1", false);

    const pb = store.get("pb1")!;
    expect(pb.successCount).toBe(2);
    expect(pb.failCount).toBe(1);
    expect(pb.lastRun).toBeTruthy();
  });

  it("normalize converts legacy format with flows", async () => {
    const legacy = {
      platform: "Instagram",
      playbook: "instagram_v2",
      description: "Instagram automation",
      version: "2.0.0",
      flows: { login: { steps: ["open app", "enter credentials"] } },
      urls: { main: "https://instagram.com" },
      selectors: { feed: { post: "[data-testid='post']" } },
      errors: [{ error: "Rate limited", solution: "Wait 30s", severity: "high" }],
    };
    fs.writeFileSync(path.join(tmpDir, "instagram_v2.json"), JSON.stringify(legacy));
    const { PlaybookStore } = await import("../src/playbook/store.js");
    const store = new PlaybookStore(tmpDir);
    store.load();

    const pb = store.get("instagram_v2");
    expect(pb).toBeDefined();
    expect(pb!.platform).toBe("Instagram");
    expect(pb!.flows).toBeDefined();
    expect(pb!.selectors).toBeDefined();
    expect(pb!.errors!.length).toBe(1);
  });

  it("load() on nonexistent directory does not throw", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    const store = new PlaybookStore("/nonexistent/path");
    expect(() => store.load()).not.toThrow();
    expect(store.getAll()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// L1: CONFIG — default budget values
// ═══════════════════════════════════════════════════════════════════════

describe("L1 Config defaults", () => {
  it("DEFAULT_ACTION_BUDGET has expected values", async () => {
    const config = await import("../src/config.js");
    expect(config.DEFAULT_ACTION_BUDGET.locateMs).toBe(800);
    expect(config.DEFAULT_ACTION_BUDGET.actMs).toBe(200);
    expect(config.DEFAULT_ACTION_BUDGET.verifyMs).toBe(2000);
    expect(config.DEFAULT_ACTION_BUDGET.maxRetries).toBe(1);
  });

  it("DEFAULT_NAVIGATE_TIMEOUT_MS is 10 seconds", async () => {
    const config = await import("../src/config.js");
    expect(config.DEFAULT_NAVIGATE_TIMEOUT_MS).toBe(10000);
  });

  it("DEFAULT_PROFILE is automation", async () => {
    const config = await import("../src/config.js");
    expect(config.DEFAULT_PROFILE).toBe("automation");
  });
});
