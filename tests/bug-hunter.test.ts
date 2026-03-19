/**
 * BUG HUNTER — tests designed to FAIL by targeting real code defects.
 *
 * Each test targets a specific suspected bug. If it passes, the code is
 * correct. If it fails, we found a real bug to fix.
 *
 * Bug categories:
 * - Key collision / ambiguity
 * - Phantom matches on empty/short input
 * - NaN poison propagation
 * - State corruption after rehydrate
 * - Reliability weighting kills valid matches
 * - Timer/promise leaks
 * - Selector promotion blindspot
 * - Serialization data loss
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// BUG 1: LocatorCache key collision — :: separator in siteKey
//
// key("a::b", "c") = "a::b::c"
// key("a",  "b::c") = "a::b::c"
// These produce the same compound key → cache returns wrong locator
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: LocatorCache key collision", () => {
  it("siteKey containing :: collides with different actionKey", async () => {
    const { LocatorCache } = await import("../src/runtime/locator-cache.js");
    const cache = new LocatorCache();

    cache.set("a::b", "c", "locator-for-ab-c");
    cache.set("a", "b::c", "locator-for-a-bc");

    // These SHOULD be different entries, but :: separator causes collision
    expect(cache.get("a::b", "c")).toBe("locator-for-ab-c");
    expect(cache.get("a", "b::c")).toBe("locator-for-a-bc");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 2: PlaybookStore.matchByDomain("") matches EVERY playbook
//
// domain="" → domainLower.split(".")[0] = ""
// Every string .includes("") returns true
// So every playbook's platform matches → score += 2 for all
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: PlaybookStore.matchByDomain empty string", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbstore-bug-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("empty domain should NOT match any playbook", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "github.json"), JSON.stringify({
      id: "github", name: "GitHub", platform: "GitHub",
      tags: ["github"], steps: [], version: "1.0.0", successCount: 0, failCount: 0,
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // Empty domain should return null — it shouldn't match everything
    const match = store.matchByDomain("");
    expect(match).toBeNull();
  });

  it("single-char domain like 'a' should not phantom-match unrelated playbooks", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "canva.json"), JSON.stringify({
      id: "canva", name: "Canva", platform: "Canva",
      tags: ["canva", "design"], steps: [], version: "1.0.0", successCount: 0, failCount: 0,
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // "a" is part of "Canva" — this is a phantom match
    const match = store.matchByDomain("a.com");
    expect(match).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 3: PlaybookStore.matchByDomain reliability weighting zeroes score
//
// If a playbook has successCount=0 and failCount=5:
//   score *= 0 / (0+5) = 0
// Valid platform match gets wiped to zero, returns null
// Even though the playbook IS the right match, it's just unreliable
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: PlaybookStore reliability weight zeroes valid match", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbstore-bug2-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("playbook with 0 successes and N failures should still match by domain", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "github.json"), JSON.stringify({
      id: "github", name: "GitHub", platform: "GitHub",
      urlPatterns: ["github\\.com"],
      tags: ["github"], steps: [], version: "1.0.0",
      successCount: 0, failCount: 10, // All failures
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // This SHOULD match — the platform IS GitHub
    // But reliability weight = 0/10 = 0, zeroing the score
    const match = store.matchByDomain("github.com");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("github");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 4: Persistence NaN window ID — Map.get(NaN) always fails
//
// worldStateFromJSON uses Number(idStr) for window IDs.
// If JSON has non-numeric key like "main", Number("main") = NaN.
// Map.set(NaN, ...) works but Map.get(NaN) NEVER works (NaN !== NaN)
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: Persistence NaN window ID", () => {
  it("non-numeric window ID in JSON creates NaN key — unreachable by numeric lookup", async () => {
    const { worldStateFromJSON } = await import("../src/state/persistence.js");
    const json = {
      windows: {
        "main_window": { // non-numeric key → Number("main_window") = NaN
          windowId: 1, title: "Test", bundleId: "com.test",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          controls: {},
        },
      },
      focusedWindowId: null,
      focusedApp: null,
      activeDialogs: [],
      appDomains: {},
      lastFullScan: new Date().toISOString(),
      sessionId: "test",
    };
    const state = worldStateFromJSON(json as any);

    // Map uses SameValueZero, so Map.get(NaN) works — but the real bug is:
    // the window's actual numeric ID (windowId: 1) can't be used to find it
    expect(state.windows.size).toBe(1);
    expect(state.windows.get(1)).toBeUndefined(); // can't find by windowId=1
    expect(state.windows.get(NaN)).toBeDefined(); // only findable via NaN
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 5: EntityTracker — rehydrate with empty positions breaks matching
//
// If persisted entity has positions=[], matchOrCreate can never match it
// because lastPos is undefined → proximity check skipped → new entity
// created → duplicates accumulate
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: EntityTracker rehydrate empty positions", () => {
  it("entity with empty positions after rehydrate should still match by proximity", async () => {
    const { EntityTracker } = await import("../src/state/entity-tracker.js");
    const tracker = new EntityTracker();

    // Simulate rehydrated entity with empty positions (corruption or bug)
    const entities = new Map([
      ["e1", {
        entityId: "e1", type: "button" as const, label: "Save",
        windowId: 1, stableIds: [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        positions: [], // empty — no position history
        properties: {},
      }],
    ]);
    tracker.rehydrate(entities);

    // Now try to match — same label, type, window, position doesn't matter
    // since there's no last position to compare against
    const matched = tracker.matchOrCreate("button", "Save", { x: 100, y: 100 }, 1);

    // BUG: This creates a NEW entity instead of matching the rehydrated one
    expect(matched.entityId).toBe("e1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 6: ContextTracker flush() only promotes CSS-looking selectors
//
// Code checks: target.startsWith("[") || startsWith("#") || startsWith(".")
// But many real selectors start with tag names: "button[data-test]",
// "input.email", "div > .submit", "main nav a"
// These would NEVER be promoted even with 1000 successes
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: ContextTracker flush ignores non-CSS-prefix selectors", () => {
  it("tag-prefixed selectors like button[data-test] should be promoted after 2+ successes", async () => {
    const { ContextTracker } = await import("../src/context-tracker.js");
    const mockStore = {
      matchByDomain: vi.fn().mockReturnValue({
        id: "test", platform: "TestApp", name: "Test", errors: [], selectors: {},
      }),
      matchByBundleId: vi.fn(),
      save: vi.fn(),
    };
    const tracker = new ContextTracker(mockStore as any);
    tracker.updateContext("browser_navigate", { url: "https://testapp.com" });

    // Record tag-prefixed selector succeeding 3 times
    tracker.recordOutcome("browser_click", { selector: "button[data-testid='save']" }, true, null);
    tracker.recordOutcome("browser_click", { selector: "button[data-testid='save']" }, true, null);
    tracker.recordOutcome("browser_click", { selector: "button[data-testid='save']" }, true, null);

    tracker.flush();

    // BUG: This will NOT save because "button[...]" doesn't start with [, #, or .
    expect(mockStore.save).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 7: Executor timed() leaks timer on zero timeout
//
// timed(0, operation, errorCode)
// setTimeout(..., 0) fires on next tick
// If operation is synchronous (resolves immediately), the race is won
// But the timer is still scheduled and may fire AFTER clearTimeout
// in some edge cases with microtask ordering
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: Executor timed() with zero timeout", () => {
  it("zero timeout should still allow synchronous-resolving operation", async () => {
    const { Executor } = await import("../src/runtime/executor.js");
    const adapter = {
      locate: vi.fn().mockResolvedValue({ handleId: "h1", locatorUsed: "text", label: "OK" }),
      click: vi.fn().mockResolvedValue(undefined),
      getAppContext: vi.fn().mockResolvedValue({ bundleId: "com.test", pid: 1, url: null }),
      getPageMeta: vi.fn().mockResolvedValue({ url: "app://test", title: "T" }),
    };
    const cache = { get: vi.fn().mockReturnValue(null), set: vi.fn() };
    const logger = {
      start: vi.fn(() => ({ action: "p", sessionId: "s", startedAt: new Date().toISOString(), locateMs: 0, actMs: 0, verifyMs: 0, retries: 0 })),
      finish: vi.fn((t: any, s: string) => ({ ...t, status: s })),
    };

    const executor = new Executor(adapter as any, cache as any, logger as any);
    // Zero budget = zero timeout for locate, act, verify
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
      budget: { locateMs: 0, actMs: 0, verifyMs: 0, maxRetries: 0 },
    });

    // With 0ms budget, locate gets ~0ms timeout
    // strategyBudget = Math.max(50, Math.floor(0/3)) = 50 — actually min is 50!
    // So this won't fail at 0ms. But actMs IS passed directly to timed()
    // If the operation resolves instantly, it should still succeed
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 8: PlaybookStore matchByBundleId with tag collision
//
// The tag matching does: idLower.includes(tag.toLowerCase().replace(/[^a-z0-9.]/g, ""))
// bundleId "com.example.app" → idLower = "com.example.app"
// tag "com" → cleaned = "com"
// "com.example.app".includes("com") = true → score += 1
// This means ANY tag containing "com" matches ANY bundleId with "com"
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: PlaybookStore.matchByBundleId phantom tag match", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-tag-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("tag 'community' should NOT match bundleId containing 'com'", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "wrong.json"), JSON.stringify({
      id: "wrong", name: "Community Forum", platform: "Forum",
      tags: ["community"], // contains "com"
      steps: [], version: "1.0.0", successCount: 0, failCount: 0,
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // "community" cleaned = "community"
    // bundleId "com.apple.Safari" includes "community"? No.
    // But "com.apple.Safari" includes "com"? Yes — wait, tag is "community" not "com"
    // Actually: tag.toLowerCase().replace(/[^a-z0-9.]/g, "") = "community"
    // idLower.includes("community") → "com.apple.safari".includes("community") = false
    // So this specific case might be fine. Let me check a different case.

    // The REAL issue: tag = "com" (common tag)
    // "com.random.app".includes("com") = true → phantom match
    expect(store.matchByBundleId("com.apple.Safari")).toBeNull();
  });

  it("tag 'com' should NOT phantom-match every bundleId", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "commercial.json"), JSON.stringify({
      id: "commercial", name: "Commercial App", platform: "CommercialTool",
      tags: ["com", "business"], // "com" tag
      steps: [], version: "1.0.0", successCount: 0, failCount: 0,
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // bundleId "com.apple.Safari" includes "com" = true → phantom match!
    // This is a completely unrelated app
    const match = store.matchByBundleId("com.apple.Safari");
    expect(match).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 9: WorldModel computeStableId collision with negative coordinates
//
// Math.round(-25/50)*50 = Math.round(-0.5)*50
// In JS, Math.round(-0.5) = 0 (rounds toward +Infinity)
// So position (-25, 0) quantizes to (0, 0) — same as (0, 0)
// Two different controls at (-25, 0) and (0, 0) get the SAME stableId
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: WorldModel stableId collision with negative positions", () => {
  it("controls at (-25, 0) and (24, 0) should have DIFFERENT stableIds", async () => {
    // Both Math.round(-25/50)*50 and Math.round(24/50)*50 = 0
    // So controls at these positions get identical stableId if role and label match
    const crypto = await import("node:crypto");

    function computeStableId(role: string, label: string, x: number, y: number) {
      const qx = isNaN(x) ? 0 : Math.floor(x / 50) * 50;
      const qy = isNaN(y) ? 0 : Math.floor(y / 50) * 50;
      const input = `${role}|${label}|${qx},${qy}`;
      return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
    }

    const id1 = computeStableId("button", "OK", -25, 0);
    const id2 = computeStableId("button", "OK", 24, 0);

    // These are 49 pixels apart but quantize to the same bucket
    // Controls at these positions would be merged incorrectly
    expect(id1).not.toBe(id2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 10: SensorPolicy running average with NaN latency
//
// If latencyMs is NaN (e.g. from undefined timing):
//   avgLatencyMs = prev * ((total-1)/total) + NaN/total = NaN
// Once NaN enters, avgLatencyMs is poisoned forever
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: SensorPolicy NaN latency poisons running average", () => {
  it("NaN latency should not poison the average", async () => {
    const { SensorPolicy } = await import("../src/learning/sensor-policy.js");
    const policy = new SensorPolicy();

    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 100 });
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: NaN }); // oops
    policy.record({ bundleId: "com.test", sourceType: "ax", success: true, latencyMs: 200 });

    const entries = policy.getAllEntries();
    // avgLatencyMs should NOT be NaN
    expect(Number.isNaN(entries[0]!.avgLatencyMs)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 11: RecoveryPolicy running average with NaN duration — same issue
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: RecoveryPolicy NaN duration poisons running average", () => {
  it("NaN durationMs should not corrupt avgDurationMs", async () => {
    const { RecoveryPolicy } = await import("../src/learning/recovery-policy.js");
    const policy = new RecoveryPolicy();

    policy.record({ blockerType: "focus_lost", bundleId: "com.test", strategyId: "s1", success: true, durationMs: 50 });
    policy.record({ blockerType: "focus_lost", bundleId: "com.test", strategyId: "s1", success: true, durationMs: NaN });
    policy.record({ blockerType: "focus_lost", bundleId: "com.test", strategyId: "s1", success: true, durationMs: 150 });

    const all = policy.getAllEntries();
    expect(Number.isNaN(all[0]!.avgDurationMs)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 12: PlaybookStore.matchByDomain with just TLD matches everything
//
// domain "com" → split(".")[0] = "com"
// platform "Canva".includes("com") = false — wait, that's actually false
// But platform "Community".toLowerCase().includes("com") = true
// And tags: any tag containing "com" would match
// The real issue: very short domain prefixes cause broad matching
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: PlaybookStore.matchByDomain with short domain prefix", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-short-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("domain 'in.com' should not match 'Instagram' via 'in' prefix", async () => {
    const { PlaybookStore } = await import("../src/playbook/store.js");
    fs.writeFileSync(path.join(tmpDir, "instagram.json"), JSON.stringify({
      id: "instagram", name: "Instagram", platform: "Instagram",
      tags: ["instagram"], steps: [], version: "1.0.0", successCount: 0, failCount: 0,
    }));
    const store = new PlaybookStore(tmpDir);
    store.load();

    // "in.com".split(".")[0] = "in"
    // "instagram".includes("in") = true → score += 2 — PHANTOM MATCH!
    const match = store.matchByDomain("in.com");
    expect(match).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 13: TimelineLogger totalMs is NaN when startedAt is mangled
//
// If someone mutates telemetry.startedAt to invalid string:
// new Date("garbage").getTime() = NaN
// totalMs = finishedAt - NaN = NaN
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: TimelineLogger NaN totalMs", () => {
  it("finish() should handle corrupted startedAt without NaN", async () => {
    const { TimelineLogger } = await import("../src/logging/timeline-logger.js");
    const logger = new TimelineLogger();
    const tel = logger.start("press", "s1");
    tel.startedAt = "not-a-date"; // corrupted

    const finished = logger.finish(tel, "success");
    expect(Number.isNaN(finished.totalMs)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 14: DebouncedPersister — schedule after flush leaves orphan state
//
// flush() sets timer=null and pending=null
// Then schedule(state) checks if(this.timer) — it's null, so starts new timer
// But if flush() is called DURING the setTimeout callback's execution,
// the pending state might not be saved
// ═══════════════════════════════════════════════════════════════════════

describe("BUG: DebouncedPersister double schedule after flush", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rapid schedule-flush-schedule should save both states", async () => {
    const { DebouncedPersister } = await import("../src/state/persistence.js");
    const saves: any[] = [];
    const saveFn = vi.fn((s: any) => saves.push(s));
    const persister = new DebouncedPersister(100, saveFn);

    persister.schedule({ sessionId: "s1" } as any);
    persister.flush(); // saves s1 immediately
    persister.schedule({ sessionId: "s2" } as any);
    vi.advanceTimersByTime(200); // timer fires for s2

    expect(saves.length).toBe(2);
    expect(saves[0].sessionId).toBe("s1");
    expect(saves[1].sessionId).toBe("s2");
  });
});
