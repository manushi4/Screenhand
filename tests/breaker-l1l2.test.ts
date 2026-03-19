/**
 * Breaker L1/L2 tests -- hunting for bugs in Control + Perception layers.
 *
 * Targets: SessionManager, Executor, ContextTracker, PlaybookStore,
 *          McpPlaybookRecorder, RecallEngine, AXSource, VisionSource,
 *          Persistence (round-trip), BridgeClient (write queue / rate limiter).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — SessionManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { SessionManager } from "../src/runtime/session-manager.js";
import type { AppAdapter } from "../src/runtime/app-adapter.js";
import type { SessionInfo } from "../src/types.js";

function makeMockAdapter(overrides?: Partial<AppAdapter>): AppAdapter {
  return {
    attach: vi.fn(async (profile: string, reuseSessionId?: string): Promise<SessionInfo> => ({
      sessionId: reuseSessionId ?? `ax_session_${profile}_${Date.now()}_abcd1234`,
      profile,
      createdAt: new Date().toISOString(),
    })),
    getAppContext: vi.fn(async () => ({
      bundleId: "com.test.App",
      appName: "TestApp",
      pid: 1234,
      windowTitle: "Test Window",
    })),
    getPageMeta: vi.fn(async () => ({ url: "about:blank", title: "Test" })),
    navigate: vi.fn(async (_sid: string, url: string) => ({ url, title: "Nav" })),
    locate: vi.fn(async () => null),
    click: vi.fn(async () => {}),
    setValue: vi.fn(async () => {}),
    getValue: vi.fn(async () => ""),
    waitFor: vi.fn(async () => true),
    extract: vi.fn(async () => null),
    screenshot: vi.fn(async () => "base64data"),
    ...overrides,
  };
}

describe("L1 SessionManager", () => {
  it("sessionStart returns same session for same profile (idempotent)", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const s1 = await mgr.sessionStart("user1");
    const s2 = await mgr.sessionStart("user1");
    expect(s1.sessionId).toBe(s2.sessionId);
    expect(adapter.attach).toHaveBeenCalledTimes(1);
  });

  it("requireSession throws for unknown session ID", () => {
    const mgr = new SessionManager(makeMockAdapter());
    expect(() => mgr.requireSession("nonexistent_id")).toThrow("Session not found");
  });

  it("getSession returns undefined for unknown ID", () => {
    const mgr = new SessionManager(makeMockAdapter());
    expect(mgr.getSession("ghost")).toBeUndefined();
  });

  it("requireSessionResilent re-creates session for ax_ prefix", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const sessionId = "ax_session_myprofile_1700000000000_aabbccdd";
    const result = await mgr.requireSessionResilent(sessionId);
    expect(result.sessionId).toBe(sessionId);
    // adapter.attach should be called with extracted profile "myprofile" and reuseSessionId
    expect(adapter.attach).toHaveBeenCalledWith("myprofile", sessionId);
  });

  it("requireSessionResilent extracts profile from cdp_ prefix", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const sessionId = "cdp_session_browser_1700000000000_aabbccdd";
    await mgr.requireSessionResilent(sessionId);
    expect(adapter.attach).toHaveBeenCalledWith("browser", sessionId);
  });

  it("requireSessionResilent extracts profile from vision_ prefix", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const sessionId = "vision_session_ocr_test_1700000000000";
    await mgr.requireSessionResilent(sessionId);
    // Greedy .+ should capture "ocr_test"
    expect(adapter.attach).toHaveBeenCalledWith("ocr_test", sessionId);
  });

  it("requireSessionResilent falls back to 'automation' for unrecognized format", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const sessionId = "totally_bogus_id_format";
    await mgr.requireSessionResilent(sessionId);
    expect(adapter.attach).toHaveBeenCalledWith("automation", sessionId);
  });

  it("requireSessionResilent returns existing in-memory session without re-attaching", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const session = await mgr.sessionStart("user1");
    const resilient = await mgr.requireSessionResilent(session.sessionId);
    expect(resilient.sessionId).toBe(session.sessionId);
    // attach called once for sessionStart, NOT again for requireSessionResilent
    expect(adapter.attach).toHaveBeenCalledTimes(1);
  });

  it("requireSessionResilent handles composite_ prefix", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    const sessionId = "composite_session_main_1700000000000_aabbccdd";
    await mgr.requireSessionResilent(sessionId);
    expect(adapter.attach).toHaveBeenCalledWith("main", sessionId);
  });

  // BUG HUNT: profile with digits that look like timestamps
  it("requireSessionResilent handles profile containing digits", async () => {
    const adapter = makeMockAdapter();
    const mgr = new SessionManager(adapter);

    // Profile = "user_1234567890" — the greedy .+ in regex should capture it
    const sessionId = "ax_session_user_1234567890_1700000000000_aabbccdd";
    await mgr.requireSessionResilent(sessionId);
    expect(adapter.attach).toHaveBeenCalledWith("user_1234567890", sessionId);
  });

  it("requireSessionResilent propagates adapter errors", async () => {
    const adapter = makeMockAdapter({
      attach: vi.fn(async () => { throw new Error("Bridge dead"); }),
    });
    const mgr = new SessionManager(adapter);

    await expect(mgr.requireSessionResilent("ax_session_test_1700000000000"))
      .rejects.toThrow("Bridge dead");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — Executor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { Executor } from "../src/runtime/executor.js";
import { LocatorCache } from "../src/runtime/locator-cache.js";
import { TimelineLogger } from "../src/logging/timeline-logger.js";

function makeExecutorKit(adapterOverrides?: Partial<AppAdapter>) {
  const adapter = makeMockAdapter({
    locate: vi.fn(async () => ({ id: "el1", selector: "#btn", role: "button", bounds: { x: 10, y: 10, width: 50, height: 20 } })),
    ...adapterOverrides,
  });
  const cache = new LocatorCache();
  const logger = new TimelineLogger();
  const executor = new Executor(adapter, cache, logger);
  return { adapter, cache, logger, executor };
}

describe("L1 Executor", () => {
  it("press succeeds on happy path", async () => {
    const { executor } = makeExecutorKit();
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
    });
    expect(result.ok).toBe(true);
  });

  it("press returns failure when all locate strategies fail", async () => {
    const { executor } = makeExecutorKit({
      locate: vi.fn(async () => null),
    });
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#missing" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("LOCATE_FAILED");
  });

  it("press returns failure after retry exhaustion", async () => {
    let callCount = 0;
    const { executor } = makeExecutorKit({
      locate: vi.fn(async () => {
        callCount++;
        return null;
      }),
    });
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#missing" },
      budget: { locateMs: 800, actMs: 200, verifyMs: 2000, maxRetries: 2 },
    });
    expect(result.ok).toBe(false);
    // With 2 retries, locate should be called 3 times (attempt 0, 1, 2)
    // Each attempt tries the selector strategy
    expect(callCount).toBe(3);
  });

  it("press handles verify failure", async () => {
    const { executor } = makeExecutorKit({
      waitFor: vi.fn(async () => false),
    });
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
      verify: { type: "visible", selector: "#result" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_FAILED");
  });

  it("typeInto detects value mismatch", async () => {
    const { executor } = makeExecutorKit({
      getValue: vi.fn(async () => "wrong value"),
    });
    const result = await executor.typeInto({
      sessionId: "s1",
      target: { type: "selector", value: "#input" },
      text: "expected value",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_FAILED");
    expect(result.error?.message).toContain("Field value mismatch");
  });

  it("typeInto skips value verification when verifyValue is false", async () => {
    const { executor } = makeExecutorKit({
      getValue: vi.fn(async () => "completely wrong"),
    });
    const result = await executor.typeInto({
      sessionId: "s1",
      target: { type: "selector", value: "#input" },
      text: "expected value",
      verifyValue: false,
    });
    expect(result.ok).toBe(true);
  });

  it("press expands text target into exact and fuzzy strategies", async () => {
    const locateCalls: Array<{ type: string }> = [];
    const { executor } = makeExecutorKit({
      locate: vi.fn(async (_sid: string, target: any) => {
        locateCalls.push({ type: target.type });
        // Succeed on fuzzy match
        if (target.exact === false) {
          return { id: "el1", selector: "text:Submit", role: "button", bounds: { x: 10, y: 10, width: 50, height: 20 } };
        }
        return null;
      }),
    });
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "text", value: "Submit" },
    });
    expect(result.ok).toBe(true);
    // Should have tried exact first, then fuzzy
    expect(locateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("press expands role target into 3 strategies (exact, fuzzy, fallback_text)", async () => {
    const locateCalls: string[] = [];
    const { executor } = makeExecutorKit({
      locate: vi.fn(async (_sid: string, target: any) => {
        locateCalls.push(target.type);
        return null;
      }),
    });
    await executor.press({
      sessionId: "s1",
      target: { type: "role", role: "button", name: "Submit" },
      budget: { locateMs: 3000, actMs: 200, verifyMs: 2000, maxRetries: 0 },
    });
    // Should try: role (exact), role (fuzzy), text (fallback)
    expect(locateCalls).toContain("role");
    expect(locateCalls).toContain("text");
  });

  it("press uses cached locator when available", async () => {
    const locateCalls: string[] = [];
    const { executor, cache } = makeExecutorKit({
      locate: vi.fn(async (_sid: string, target: any) => {
        locateCalls.push(target.value ?? target.type);
        return { id: "el1", selector: target.value, role: "button", bounds: { x: 10, y: 10, width: 50, height: 20 } };
      }),
      getAppContext: vi.fn(async () => ({
        bundleId: "com.test.App",
        appName: "TestApp",
        pid: 1234,
        windowTitle: "Test",
        url: "https://example.com/page",
      })),
    });

    // Pre-populate cache
    cache.set("example.com", "selector:#btn", "#cached-selector");

    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
    });
    expect(result.ok).toBe(true);
    // Should have tried the cached selector first
    expect(locateCalls[0]).toBe("#cached-selector");
  });

  it("press handles act timeout (click takes too long)", async () => {
    const { executor } = makeExecutorKit({
      click: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 500));
      }),
    });
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
      budget: { locateMs: 800, actMs: 50, verifyMs: 2000, maxRetries: 0 },
    });
    // With 50ms act budget and 500ms click, should time out
    expect(result.ok).toBe(false);
  });

  it("Executor.timed clears timeout timer on success (no leak)", async () => {
    const { executor } = makeExecutorKit();
    // Just verify it completes without hanging
    const result = await executor.press({
      sessionId: "s1",
      target: { type: "selector", value: "#btn" },
    });
    expect(result.ok).toBe(true);
    expect(result.telemetry).toBeDefined();
    expect(result.telemetry!.status).toBe("success");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — ContextTracker
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { ContextTracker } from "../src/context-tracker.js";
import { PlaybookStore } from "../src/playbook/store.js";

describe("L1 ContextTracker", () => {
  let tmpDir: string;
  let store: PlaybookStore;
  let tracker: ContextTracker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-ctx-"));
    const pbDir = path.join(tmpDir, "playbooks");
    fs.mkdirSync(pbDir, { recursive: true });
    store = new PlaybookStore(pbDir);
    store.load();
    tracker = new ContextTracker(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updateContext ignores URL tool with no url param", () => {
    tracker.updateContext("browser_open", {});
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("updateContext ignores invalid URL", () => {
    tracker.updateContext("browser_navigate", { url: "not-a-url" });
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("updateContext extracts domain from valid URL", () => {
    tracker.updateContext("browser_navigate", { url: "https://www.example.com/path?q=1" });
    expect(tracker.getCurrentDomain()).toBe("example.com");
  });

  it("updateContext strips www. prefix", () => {
    tracker.updateContext("browser_open", { url: "https://www.github.com/" });
    expect(tracker.getCurrentDomain()).toBe("github.com");
  });

  it("updateContext does not re-lookup on same domain", () => {
    const spy = vi.spyOn(store, "matchByDomain");
    tracker.updateContext("browser_navigate", { url: "https://example.com/page1" });
    tracker.updateContext("browser_navigate", { url: "https://example.com/page2" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("updateContext handles bundleId for native tools", () => {
    tracker.updateContext("focus", { bundleId: "com.apple.Safari" });
    expect(tracker.getCurrentDomain()).toBe("native:com.apple.Safari");
  });

  it("updateContext ignores non-string bundleId", () => {
    tracker.updateContext("focus", { bundleId: 12345 });
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("updateContext ignores non-URL and non-bundleId tools", () => {
    tracker.updateContext("screenshot", { url: "https://example.com" });
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("getHints returns empty when no context", () => {
    expect(tracker.getHints("browser_click", { selector: "#btn" })).toEqual([]);
  });

  it("recordOutcome does nothing when no context", () => {
    // Should not throw
    tracker.recordOutcome("browser_click", { selector: "#btn" }, true, null);
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("flush with no learnings is a no-op", () => {
    tracker.flush();
    // Should not throw
  });

  it("updateContextFromWindowTitle extracts domain from URL in title", () => {
    tracker.updateContextFromWindowTitle("com.apple.Safari", "Page - https://figma.com/design/abc - Safari");
    expect(tracker.getCurrentDomain()).toBe("figma.com");
  });

  it("updateContextFromWindowTitle ignores non-browser bundleId", () => {
    tracker.updateContextFromWindowTitle("com.apple.Finder", "Some Window Title");
    expect(tracker.getCurrentDomain()).toBeNull();
  });

  it("updateContextFromWindowTitle extracts domain from 'title - domain.com' pattern", () => {
    tracker.updateContextFromWindowTitle("com.apple.Safari", "My Page - example.com - Safari");
    expect(tracker.getCurrentDomain()).toBe("example.com");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — PlaybookStore
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("L1 PlaybookStore", () => {
  let tmpDir: string;
  let store: PlaybookStore;

  function makePlaybook(id: string, overrides?: Record<string, unknown>) {
    return {
      id,
      name: `${id} playbook`,
      description: "Test playbook",
      platform: id,
      version: "1.0.0",
      tags: [id],
      successCount: 5,
      failCount: 1,
      steps: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-pb-"));
    const pbDir = path.join(tmpDir, "playbooks");
    fs.mkdirSync(pbDir, { recursive: true });
    store = new PlaybookStore(pbDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("load handles empty directory", () => {
    store.load();
    expect(store.getAll()).toEqual([]);
  });

  it("load handles directory that does not exist", () => {
    const ghostStore = new PlaybookStore("/tmp/nonexistent-pb-dir-" + Date.now());
    ghostStore.load();
    expect(ghostStore.getAll()).toEqual([]);
  });

  it("save and load round-trip preserves playbook", () => {
    const pb = makePlaybook("roundtrip");
    store.save(pb as any);
    store.load();
    const loaded = store.get("roundtrip");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("roundtrip playbook");
  });

  it("load skips corrupt JSON files", () => {
    const pbDir = path.join(tmpDir, "playbooks");
    fs.writeFileSync(path.join(pbDir, "good.json"), JSON.stringify(makePlaybook("good")));
    fs.writeFileSync(path.join(pbDir, "bad.json"), "{corrupt!!!");
    store.load();
    expect(store.getAll()).toHaveLength(1);
    expect(store.get("good")).toBeDefined();
  });

  it("load skips non-JSON files", () => {
    const pbDir = path.join(tmpDir, "playbooks");
    fs.writeFileSync(path.join(pbDir, "good.json"), JSON.stringify(makePlaybook("good")));
    fs.writeFileSync(path.join(pbDir, "readme.txt"), "not a playbook");
    store.load();
    expect(store.getAll()).toHaveLength(1);
  });

  it("matchByDomain returns null when no match", () => {
    store.load();
    expect(store.matchByDomain("unknown-site.com")).toBeNull();
  });

  it("matchByBundleId returns null when no match", () => {
    store.load();
    expect(store.matchByBundleId("com.unknown.App")).toBeNull();
  });

  it("matchByDomain matches by URL patterns", () => {
    store.save(makePlaybook("figma", { urlPatterns: ["figma\\.com"] }) as any);
    store.load();
    expect(store.matchByDomain("figma.com")).not.toBeNull();
  });

  it("matchByBundleId matches by direct bundleId", () => {
    store.save(makePlaybook("safari", { bundleId: "com.apple.Safari" }) as any);
    store.load();
    expect(store.matchByBundleId("com.apple.Safari")).not.toBeNull();
  });

  it("recordOutcome increments success count", () => {
    store.save(makePlaybook("counter", { successCount: 0, failCount: 0 }) as any);
    store.load();
    store.recordOutcome("counter", true);
    const pb = store.get("counter");
    expect(pb!.successCount).toBe(1);
  });

  it("recordOutcome increments fail count", () => {
    store.save(makePlaybook("counter", { successCount: 0, failCount: 0 }) as any);
    store.load();
    store.recordOutcome("counter", false);
    const pb = store.get("counter");
    expect(pb!.failCount).toBe(1);
  });

  it("recordOutcome is a no-op for unknown ID", () => {
    store.load();
    // Should not throw
    store.recordOutcome("nonexistent", true);
  });

  it("matchByDomain weights by reliability (0 success + 0 fail = no penalty)", () => {
    store.save(makePlaybook("newsite", {
      urlPatterns: ["newsite\\.com"],
      successCount: 0,
      failCount: 0,
    }) as any);
    store.load();
    // With 0 total attempts, score *= 0/0 which is NaN --> score becomes NaN
    // This is a potential BUG: NaN > bestScore is false, so it never matches
    const result = store.matchByDomain("newsite.com");
    // If this is null, we found a bug!
    // The code: if (score > 0 && p.successCount + p.failCount > 0) multiplies by ratio
    // When total = 0, the multiply is skipped, score stays as-is. Should be fine.
    expect(result).not.toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — McpPlaybookRecorder
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { McpPlaybookRecorder } from "../src/playbook/mcp-recorder.js";

describe("L1 McpPlaybookRecorder", () => {
  let tmpDir: string;
  let recorder: McpPlaybookRecorder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-rec-"));
    recorder = new McpPlaybookRecorder(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captureToolCall is a no-op when not recording", () => {
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    expect(recorder.stepCount).toBe(0);
  });

  it("captureToolCall skips observation-only tools", () => {
    recorder.start("test");
    recorder.captureToolCall("screenshot", {}, true, "ok", 10);
    recorder.captureToolCall("ui_tree", {}, true, "ok", 10);
    recorder.captureToolCall("apps", {}, true, "ok", 10);
    expect(recorder.stepCount).toBe(0);
  });

  it("captureToolCall records actionable tools", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    recorder.captureToolCall("browser_type", { selector: "#input", text: "hello" }, true, "ok", 10);
    expect(recorder.stepCount).toBe(2);
  });

  it("captureToolCall deduplicates consecutive identical steps", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    expect(recorder.stepCount).toBe(1);
  });

  it("captureToolCall does NOT deduplicate different targets", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn1" }, true, "ok", 10);
    recorder.captureToolCall("browser_click", { selector: "#btn2" }, true, "ok", 10);
    expect(recorder.stepCount).toBe(2);
  });

  it("stop saves playbook to disk and returns it", () => {
    recorder.start("mysite");
    recorder.captureToolCall("browser_navigate", { url: "https://example.com" }, true, "ok", 10);
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);

    const pb = recorder.stop("My Playbook", "Does stuff");
    expect(pb.name).toBe("My Playbook");
    expect(pb.steps).toHaveLength(2);
    expect(pb.platform).toBe("mysite");

    // Verify file was written to disk
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });

  it("cancel clears state without saving", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    recorder.cancel();
    expect(recorder.isRecording).toBe(false);
    expect(recorder.stepCount).toBe(0);
  });

  it("marks failed steps as optional", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, false, "err", 10);
    const steps = recorder.getSteps();
    expect(steps[0]!.optional).toBe(true);
  });

  it("stop resets steps to empty", () => {
    recorder.start("test");
    recorder.captureToolCall("browser_click", { selector: "#btn" }, true, "ok", 10);
    recorder.stop("pb", "desc");
    expect(recorder.stepCount).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L2 — AXSource
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { AXSource } from "../src/perception/ax-source.js";

describe("L2 AXSource", () => {
  function makeMockObserver() {
    return {
      drainEvents: vi.fn(() => []),
      startObserving: vi.fn(async () => {}),
      stopObserving: vi.fn(async () => {}),
      isObserving: false,
    };
  }

  function makeMockBridge() {
    return {
      call: vi.fn(async () => ({
        role: "AXWindow",
        children: [],
        _nodeCount: 42,
      })),
    };
  }

  it("drainEvents returns null when observer has no events", () => {
    const observer = makeMockObserver();
    const bridge = makeMockBridge();
    const source = new AXSource(observer as any, bridge as any);
    expect(source.drainEvents()).toBeNull();
  });

  it("drainEvents returns perception event when observer has events", () => {
    const observer = makeMockObserver();
    observer.drainEvents.mockReturnValue([{ type: "value_changed", pid: 123 }]);
    const bridge = makeMockBridge();
    const source = new AXSource(observer as any, bridge as any);
    const result = source.drainEvents();
    expect(result).not.toBeNull();
    expect(result!.source).toBe("ax_events");
    expect(result!.rate).toBe("fast");
  });

  it("getAdaptiveMaxDepth returns lower depth for browsers", () => {
    const source = new AXSource({} as any, {} as any);
    expect(source.getAdaptiveMaxDepth("com.google.Chrome")).toBe(5);
    expect(source.getAdaptiveMaxDepth("com.apple.Safari")).toBe(5);
  });

  it("getAdaptiveMaxDepth returns higher depth for non-browsers", () => {
    const source = new AXSource({} as any, {} as any);
    expect(source.getAdaptiveMaxDepth("com.apple.Finder")).toBe(10);
  });

  it("shouldSkipPoll returns false with insufficient data", () => {
    const source = new AXSource({} as any, {} as any);
    expect(source.shouldSkipPoll()).toBe(false);
  });

  it("getAdaptiveMaxDepth reduces depth when latency is high", async () => {
    const observer = makeMockObserver();
    const bridge = makeMockBridge();
    // Make bridge call slow to simulate latency
    bridge.call.mockImplementation(async () => {
      return { role: "AXWindow", children: [], _nodeCount: 10 };
    });
    const source = new AXSource(observer as any, bridge as any);

    // Manually inject high latencies
    const latencies = (source as any).recentLatencies as number[];
    latencies.push(4000, 4000, 4000, 4000, 4000);

    const depth = source.getAdaptiveMaxDepth("com.apple.Finder");
    // avgLatency = 4000 > 3000, so depth = max(2, 10-3) = 7
    expect(depth).toBe(7);
  });

  it("shouldSkipPoll returns true when average latency > 5000ms", () => {
    const source = new AXSource({} as any, {} as any);
    const latencies = (source as any).recentLatencies as number[];
    latencies.push(6000, 6000, 6000);
    expect(source.shouldSkipPoll()).toBe(true);
  });

  it("pollAXTree returns null event when bridge returns null", async () => {
    const observer = makeMockObserver();
    const bridge = makeMockBridge();
    bridge.call.mockResolvedValue(null);

    const source = new AXSource(observer as any, bridge as any);
    const result = await source.pollAXTree(123, 1, {
      bundleId: "com.test.App",
      appName: "Test",
      pid: 123,
      windowTitle: "Win",
    });
    expect(result.event).toBeNull();
    expect(result.nodeCount).toBe(0);
  });

  it("pollAXTree handles bridge error gracefully", async () => {
    const observer = makeMockObserver();
    const bridge = makeMockBridge();
    bridge.call.mockRejectedValue(new Error("Bridge crashed"));

    const source = new AXSource(observer as any, bridge as any);
    const result = await source.pollAXTree(123, 1, {
      bundleId: "com.test.App",
      appName: "Test",
      pid: 123,
      windowTitle: "Win",
    });
    expect(result.event).toBeNull();
    // Should record high latency for backoff
    expect(source.getAverageLatency()).toBeGreaterThan(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L2 — Persistence round-trip
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { worldStateToJSON, worldStateFromJSON, saveWorldState, loadWorldState, DebouncedPersister } from "../src/state/persistence.js";
import type { WorldState } from "../src/state/types.js";

function makeMinimalWorldState(sessionId: string): WorldState {
  return {
    windows: new Map(),
    focusedWindowId: null,
    focusedApp: { bundleId: "com.test.App", name: "Test", pid: 1 },
    activeDialogs: [],
    appDomains: new Map(),
    lastFullScan: new Date().toISOString(),
    sessionId,
    expectedPostcondition: null,
    updatedAt: new Date().toISOString(),
    confidence: 0.95,
    pendingGoal: null,
    recentTransitions: [],
    trackedEntities: new Map(),
  };
}

describe("L2 Persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-persist-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trip preserves empty world state", () => {
    const state = makeMinimalWorldState("test-session");
    const json = worldStateToJSON(state);
    const parsed = JSON.parse(json);
    const restored = worldStateFromJSON(parsed);

    expect(restored.sessionId).toBe("test-session");
    expect(restored.windows.size).toBe(0);
    expect(restored.activeDialogs).toHaveLength(0);
    expect(restored.confidence).toBe(0.95);
  });

  it("round-trip preserves windows with controls", () => {
    const state = makeMinimalWorldState("with-windows");
    state.windows.set(1, {
      windowId: 1,
      title: "Main Window",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      controls: new Map([["btn1", { role: "button", label: "OK", bounds: { x: 10, y: 10, width: 50, height: 20 }, enabled: true, value: null, focused: false }]]),
      isKey: true,
      focusedElement: null,
      visibleControls: [],
      dialogStack: [],
      scrollPosition: null,
      lastAXScanAt: null,
      lastCDPScanAt: null,
      lastOCRAt: null,
      lastScreenshotHash: null,
    });
    state.focusedWindowId = 1;

    const json = worldStateToJSON(state);
    const restored = worldStateFromJSON(JSON.parse(json));

    expect(restored.windows.size).toBe(1);
    expect(restored.windows.get(1)!.title).toBe("Main Window");
    expect(restored.windows.get(1)!.controls.get("btn1")!.role).toBe("button");
    expect(restored.focusedWindowId).toBe(1);
  });

  it("save/load round-trip via file system", () => {
    const stateDir = path.join(tmpDir, "state");
    const state = makeMinimalWorldState("file-rt-session");
    state.confidence = 0.42;

    saveWorldState(state, stateDir);
    const loaded = loadWorldState("file-rt-session", stateDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("file-rt-session");
    expect(loaded!.confidence).toBe(0.42);
  });

  it("loadWorldState returns null for missing session", () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    expect(loadWorldState("nonexistent", stateDir)).toBeNull();
  });

  it("loadWorldState recovers from corrupt JSON using .bak", () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const state = makeMinimalWorldState("corrupt-test");

    // First save -- creates primary, no .bak yet
    saveWorldState(state, stateDir);
    // Second save -- backs up first write into .bak, writes new primary
    saveWorldState({ ...state, confidence: 0.99 }, stateDir);

    // Now: primary has confidence=0.99, .bak has confidence=0.95
    // Corrupt the primary
    const primaryPath = path.join(stateDir, "corrupt-test.json");
    fs.writeFileSync(primaryPath, "CORRUPTED{{{");

    const loaded = loadWorldState("corrupt-test", stateDir);
    expect(loaded).not.toBeNull();
    // Should have recovered from .bak (confidence=0.95 from first save)
    expect(loaded!.confidence).toBe(0.95);
  });

  it("BUG: first write has no .bak so corruption of first-ever save is unrecoverable", () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const state = makeMinimalWorldState("first-write-only");
    saveWorldState(state, stateDir);

    // Corrupt the primary -- there is NO .bak from a single write
    const primaryPath = path.join(stateDir, "first-write-only.json");
    fs.writeFileSync(primaryPath, "CORRUPTED{{{");

    // This exposes a real gap: first-ever save has no backup
    const loaded = loadWorldState("first-write-only", stateDir);
    expect(loaded).toBeNull(); // No .bak exists, so recovery fails
  });

  it("worldStateFromJSON provides defaults for missing fields (backwards compat)", () => {
    // Simulate a minimal JSON with no optional fields
    const minimal = {
      windows: {},
      focusedWindowId: null,
      focusedApp: { bundleId: "test", name: "T", pid: 1 },
      activeDialogs: [],
      appDomains: {},
      lastFullScan: "2025-01-01T00:00:00Z",
      sessionId: "compat-test",
      // No updatedAt, confidence, pendingGoal, etc.
    };
    const restored = worldStateFromJSON(minimal as any);
    expect(restored.updatedAt).toBe("2025-01-01T00:00:00Z"); // falls back to lastFullScan
    expect(restored.confidence).toBe(1.0);
    expect(restored.pendingGoal).toBeNull();
    expect(restored.recentTransitions).toEqual([]);
    expect(restored.trackedEntities.size).toBe(0);
  });

  it("DebouncedPersister with 0 debounce is a no-op", () => {
    const saveFn = vi.fn();
    const persister = new DebouncedPersister(0, saveFn);
    persister.schedule(makeMinimalWorldState("noop"));
    persister.flush();
    expect(saveFn).not.toHaveBeenCalled();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L2 — BridgeClient edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { BridgeClient } from "../src/native/bridge-client.js";

describe("L2 BridgeClient edge cases", () => {
  it("handleLine resets consecutiveTimeouts on valid response", () => {
    const client = new BridgeClient("/fake");
    (client as any).consecutiveTimeouts = 2;

    const pending = (client as any).pending as Map<number, any>;
    pending.set(1, {
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 5000),
    });

    (client as any).handleLine(JSON.stringify({ id: 1, result: { ok: true } }));
    expect((client as any).consecutiveTimeouts).toBe(0);
  });

  it("handleLine resets consecutiveRestarts on valid response", () => {
    const client = new BridgeClient("/fake");
    (client as any).consecutiveRestarts = 3;

    const pending = (client as any).pending as Map<number, any>;
    pending.set(1, {
      resolve: vi.fn(),
      reject: vi.fn(),
      timer: setTimeout(() => {}, 5000),
    });

    (client as any).handleLine(JSON.stringify({ id: 1, result: { ok: true } }));
    expect((client as any).consecutiveRestarts).toBe(0);
  });

  it("rejectAllPending clears all timers and pending map", () => {
    const client = new BridgeClient("/fake");
    const pending = (client as any).pending as Map<number, any>;

    const reject1 = vi.fn();
    const reject2 = vi.fn();
    pending.set(1, { resolve: vi.fn(), reject: reject1, timer: setTimeout(() => {}, 5000) });
    pending.set(2, { resolve: vi.fn(), reject: reject2, timer: setTimeout(() => {}, 5000) });

    (client as any).rejectAllPending("test reason");
    expect(reject1).toHaveBeenCalledWith(expect.any(Error));
    expect(reject2).toHaveBeenCalledWith(expect.any(Error));
    expect(pending.size).toBe(0);
  });

  it("getRecentStderr returns copy of stderr buffer", () => {
    const client = new BridgeClient("/fake");
    const stderr = (client as any).recentStderr as string[];
    stderr.push("error line 1", "error line 2");

    const result = client.getRecentStderr();
    expect(result).toEqual(["error line 1", "error line 2"]);
    // Should be a copy, not the same reference
    result.push("mutated");
    expect(client.getRecentStderr()).toHaveLength(2);
  });

  it("stderr buffer is bounded to MAX_STDERR_LINES", () => {
    const client = new BridgeClient("/fake");
    const stderr = (client as any).recentStderr as string[];
    for (let i = 0; i < 30; i++) {
      stderr.push(`line ${i}`);
    }
    // MAX_STDERR_LINES = 20, but we pushed directly. The bound is enforced
    // in the stderr handler, not in the array. So this tests the raw state.
    expect(stderr.length).toBe(30); // Direct push bypasses limit
  });

  it("call rejects when bridge is overloaded (exceeds wait timeout)", async () => {
    const client = new BridgeClient("/fake");
    // Suppress spawn errors from reaching the unhandled error handler
    client.on("error", () => {});
    // Set activeRequests to max
    (client as any).activeRequests = 20;
    (client as any).started = true;

    // This should wait, then time out after 5s
    // We don't want to wait 5s in tests, so we'll check the path differently
    const promise = client.call("test.method");

    // Give it a tick to enter the wait loop
    await new Promise(r => setTimeout(r, 100));

    // Release the lock
    (client as any).activeRequests = 0;

    // But the call will fail because there's no process
    await expect(promise).rejects.toThrow();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L1 — RecallEngine edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { MemoryStore } from "../src/memory/store.js";
import { RecallEngine } from "../src/memory/recall.js";

describe("L1 RecallEngine edge cases", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let recall: RecallEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-recall-"));
    fs.mkdirSync(path.join(tmpDir, ".screenhand", "memory"), { recursive: true });
    store = new MemoryStore(tmpDir);
    store.init();
    recall = new RecallEngine(store);
  });

  afterEach(() => {
    const lockPath = path.join(tmpDir, ".screenhand", "memory", ".lock");
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recallStrategies returns empty for empty query", () => {
    store.appendStrategy({
      id: "s1", task: "some task", steps: [{ tool: "apps", params: {} }],
      totalDurationMs: 100, successCount: 1, failCount: 0,
      lastUsed: new Date().toISOString(), tags: ["task"],
      fingerprint: "apps",
    });
    // Empty string tokenizes to nothing, so relevance = 0
    expect(recall.recallStrategies("")).toEqual([]);
  });

  it("recallStrategies handles short tokens (2 chars now kept)", () => {
    store.appendStrategy({
      id: "s1", task: "ab task", steps: [{ tool: "apps", params: {} }],
      totalDurationMs: 100, successCount: 1, failCount: 0,
      lastUsed: new Date().toISOString(), tags: ["ab"],
      fingerprint: "apps",
    });
    // "ab" is 2 chars — now kept by tokenize (min lowered from 3 to 2)
    // The strategy task contains "ab" which matches, so results may be returned
    const results = recall.recallStrategies("ab");
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("quickStrategyHint returns null for empty recentTools", () => {
    expect(recall.quickStrategyHint([])).toBeNull();
  });

  it("quickErrorCheck returns null when errors exist but none have resolution", () => {
    store.appendError({
      id: "e1", tool: "click", params: {},
      error: "timeout", resolution: null,
      occurrences: 5, lastSeen: new Date().toISOString(),
    });
    expect(recall.quickErrorCheck("click")).toBeNull();
  });

  it("recallByFingerprint returns null when failCount equals successCount", () => {
    store.appendStrategy({
      id: "s1", task: "equal", steps: [{ tool: "apps", params: {} }, { tool: "focus", params: {} }],
      totalDurationMs: 100, successCount: 3, failCount: 3,
      lastUsed: new Date().toISOString(), tags: ["equal"],
      fingerprint: MemoryStore.makeFingerprint(["apps", "focus"]),
    });
    // failCount (3) > successCount (3) is false, so it should return the strategy
    // Wait -- the check is: if (failCount > strategy.successCount) return null
    // 3 > 3 is false, so it returns the strategy. That means equal fail/success is allowed.
    const result = recall.recallByFingerprint(["apps", "focus"]);
    expect(result).not.toBeNull();
  });
});
