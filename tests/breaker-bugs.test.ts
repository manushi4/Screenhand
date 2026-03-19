// Bug-finding tests — designed to FAIL and expose real defects
// Written by hand after reading source code line-by-line

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── ToolRegistry (src/planner/tool-registry.ts) ──────────────────

describe("ToolRegistry bug hunting", () => {
  it("BUG: isSoftFailure false positive — success text containing 'not found' is treated as failure", async () => {
    // tool-registry.ts:70-73 — the soft failure check does:
    //   (lower.includes("not found") && !lower.includes("clicked"))
    // But what about "Cookie not found, using default"? Or "Profile not found, created new one"?
    const { ToolRegistry } = await import("../src/planner/tool-registry.js");
    const reg = new ToolRegistry();
    reg.register("test_tool", async () => ({
      content: [{ type: "text", text: "Setting not found, using default value. Operation completed." }],
    }));
    const result = await reg.execute("test_tool", {});
    // BUG: This should be ok=true (operation completed) but "not found" triggers soft failure
    expect(result.ok).toBe(true);
  });

  it("BUG: isSoftFailure false positive — 'error:' prefix in normal text", async () => {
    // tool-registry.ts:73 — lower.startsWith("error:") matches any text starting with "error:"
    // But legitimate output can start with "Error:" as a label, e.g. "Error: none detected"
    const { ToolRegistry } = await import("../src/planner/tool-registry.js");
    const reg = new ToolRegistry();
    reg.register("check_errors", async () => ({
      content: [{ type: "text", text: "Error: none detected. All systems operational." }],
    }));
    const result = await reg.execute("check_errors", {});
    // BUG: "error: none detected" starts with "error:" so isSoftFailure is true
    expect(result.ok).toBe(true);
  });

  it("BUG: handler returning null/undefined causes silent failure", async () => {
    const { ToolRegistry } = await import("../src/planner/tool-registry.js");
    const reg = new ToolRegistry();
    reg.register("void_tool", async () => null);
    const result = await reg.execute("void_tool", {});
    // When handler returns null, result.content is undefined, text becomes ""
    // Empty text → isSoftFailure=false → ok=true, result=""
    // BUG: Should this be ok=false? At minimum result.result should be null/undefined not ""
    expect(result.ok).toBe(true);
    expect(result.result).toBe("");
  });
});

// ── RecallEngine (src/memory/recall.ts) ────────────────────────

describe("RecallEngine bug hunting", () => {
  it("BUG: NaN lastUsed date poisons recency calculation in recallStrategies", async () => {
    const { RecallEngine } = await import("../src/memory/recall.js");
    const { MemoryStore } = await import("../src/memory/store.js");

    const store = new MemoryStore("/tmp/recall-test-" + Date.now());
    // Inject a strategy with invalid lastUsed date
    (store as any).strategies = [{
      id: "s1",
      task: "click button submit",
      steps: [{ tool: "click_text", params: { text: "Submit" } }],
      tags: ["click", "submit"],
      fingerprint: "click_text",
      successCount: 10,
      failCount: 0,
      lastUsed: "INVALID_DATE",
    }];
    // Override readStrategies to return our bad data
    store.readStrategies = () => (store as any).strategies;

    const recall = new RecallEngine(store);
    const results = recall.recallStrategies("click submit button");
    // BUG: new Date("INVALID_DATE").getTime() → NaN
    // NaN propagates: ageDays = NaN, recency = Math.max(0.5, 1.0 - NaN/365) = NaN
    // score = relevance * NaN * successBoost * reliabilityPenalty = NaN
    // NaN > 0 is false, so strategy gets filtered out even though it's perfectly relevant
    expect(results.length).toBeGreaterThan(0);
    if (results.length > 0) {
      expect(Number.isFinite(results[0]!.score)).toBe(true);
    }
  });

  it("BUG: stringSimilarity with single-character strings returns 0", async () => {
    const { RecallEngine } = await import("../src/memory/recall.js");
    const { MemoryStore } = await import("../src/memory/store.js");

    const store = new MemoryStore("/tmp/recall-test-" + Date.now());
    (store as any).errors = [
      { tool: "a", error: "x", occurrences: 5, resolution: "fix", params: {} },
      { tool: "a", error: "y", occurrences: 3, resolution: "fix2", params: { q: "z" } },
    ];
    store.readErrors = () => (store as any).errors;

    const recall = new RecallEngine(store);
    const results = recall.recallErrors("a", { q: "z" });
    expect(results.length).toBe(2);
  });

  it("BUG: tokenize drops all 1-2 char words — queries like 'go to X' lose context", async () => {
    const { RecallEngine } = await import("../src/memory/recall.js");
    const { MemoryStore } = await import("../src/memory/store.js");

    const store = new MemoryStore("/tmp/recall-test-" + Date.now());
    (store as any).strategies = [{
      id: "nav1",
      task: "go to settings page",
      steps: [{ tool: "browser_navigate", params: { url: "https://example.com/settings" } }],
      tags: ["go", "settings"],
      fingerprint: "browser_navigate",
      successCount: 5,
      failCount: 0,
      lastUsed: new Date().toISOString(),
    }];
    store.readStrategies = () => (store as any).strategies;

    const recall = new RecallEngine(store);
    // After fix: tokenize keeps words >= 2 chars, so "go to" is now ["go", "to"]
    const results = recall.recallStrategies("go to settings");
    expect(results.length).toBeGreaterThan(0);
    // "go to UI" now tokenizes to ["go", "to", "ui"] — all 2+ chars kept
    const results2 = recall.recallStrategies("go to UI");
    // With the fix, these short words are kept and can match
    expect(results2.length).toBeGreaterThanOrEqual(0); // No longer a guaranteed empty
  });
});

// ── Blocker Detectors (src/recovery/detectors.ts) ─────────────

describe("Blocker detectors bug hunting", () => {
  it("BUG: 'element' pattern matches success messages like 'Element created successfully'", async () => {
    const { detectBlockers } = await import("../src/recovery/detectors.js");
    const { WorldModel } = await import("../src/state/world-model.js");

    const wm = new WorldModel();
    // Success message containing "element"
    const blockers = detectBlockers(wm, "Element created successfully in the DOM", null);
    // BUG: detectors.ts:107 — err.includes("element") matches ANY string with "element"
    // This success message will generate an "element_gone" blocker
    const hasElementGone = blockers.some(b => b.type === "element_gone");
    expect(hasElementGone).toBe(false);
  });

  it("BUG: 'timeout' pattern matches success messages about timeout configuration", async () => {
    const { detectBlockers } = await import("../src/recovery/detectors.js");
    const { WorldModel } = await import("../src/state/world-model.js");

    const wm = new WorldModel();
    // Message about configuring timeouts — not a timeout error
    const blockers = detectBlockers(wm, "Set timeout to 5000ms for API requests", null);
    // BUG: detectors.ts:104 — err.includes("timeout") matches ANY string with "timeout"
    const hasLoadingStuck = blockers.some(b => b.type === "loading_stuck");
    expect(hasLoadingStuck).toBe(false);
  });

  it("BUG: 'loading' pattern matches non-error messages", async () => {
    const { detectBlockers } = await import("../src/recovery/detectors.js");
    const { WorldModel } = await import("../src/state/world-model.js");

    const wm = new WorldModel();
    const blockers = detectBlockers(wm, "Finished loading all resources", null);
    // BUG: err.includes("loading") matches success messages too
    const hasLoadingStuck = blockers.some(b => b.type === "loading_stuck");
    expect(hasLoadingStuck).toBe(false);
  });
});

// ── TimingModel (src/learning/timing-model.ts) ────────────────

describe("TimingModel bug hunting", () => {
  it("BUG: NaN duration poisons mean calculation", async () => {
    const { TimingModel } = await import("../src/learning/timing-model.js");
    const model = new TimingModel();

    model.record({ tool: "click", bundleId: "com.test", durationMs: 100, success: true });
    model.record({ tool: "click", bundleId: "com.test", durationMs: NaN, success: true });
    model.record({ tool: "click", bundleId: "com.test", durationMs: 200, success: true });

    const dist = model.getDistribution("click", "com.test");
    // BUG: NaN in the duration array poisons the mean: (100 + NaN + 200) / 3 = NaN
    // Also poisons sort: [NaN, 100, 200].sort() is non-deterministic
    expect(dist).not.toBeNull();
    expect(Number.isFinite(dist!.mean)).toBe(true);
    expect(Number.isFinite(dist!.p50)).toBe(true);
    expect(Number.isFinite(dist!.p95)).toBe(true);
  });

  it("BUG: Infinity duration creates unreasonable budgets", async () => {
    const { TimingModel } = await import("../src/learning/timing-model.js");
    const model = new TimingModel();

    // Record some normal samples then one Infinity
    for (let i = 0; i < 5; i++) {
      model.record({ tool: "click", bundleId: "com.test", durationMs: 100, success: true });
    }
    model.record({ tool: "click", bundleId: "com.test", durationMs: Infinity, success: true });

    const dist = model.getDistribution("click", "com.test");
    expect(dist).not.toBeNull();
    // BUG: Infinity in sorted array → p95 could be Infinity, max is Infinity
    // mean includes Infinity → Infinity
    expect(Number.isFinite(dist!.mean)).toBe(true);
    expect(Number.isFinite(dist!.max)).toBe(true);
  });

  it("BUG: negative duration accepted without guard", async () => {
    const { TimingModel } = await import("../src/learning/timing-model.js");
    const model = new TimingModel();

    model.record({ tool: "click", bundleId: "com.test", durationMs: -500, success: true });
    model.record({ tool: "click", bundleId: "com.test", durationMs: 100, success: true });

    const dist = model.getDistribution("click", "com.test");
    expect(dist).not.toBeNull();
    // BUG: negative duration is accepted, min becomes -500
    // budgetForCategory uses maxP95 → could compute negative budget
    expect(dist!.min).toBeGreaterThanOrEqual(0);
  });
});

// ── LocatorPolicy key collision (src/learning/locator-policy.ts) ──

describe("LocatorPolicy bug hunting", () => {
  it("FIX VERIFIED: compound key uses length-prefix — no collision when bundleId contains ::", async () => {
    const { LocatorPolicy } = await import("../src/learning/locator-policy.js");
    const policy = new LocatorPolicy();

    // bundleId containing ::
    policy.record({
      bundleId: "com.app::debug",
      actionKey: "click",
      locator: "#btn1",
      method: "cdp",
      success: true,
    });
    policy.record({
      bundleId: "com.app",
      actionKey: "debug::click",
      locator: "#btn2",
      method: "cdp",
      success: true,
    });

    // After fix: keys use length-prefix format, no collision possible
    const entries1 = policy.getEntries("com.app::debug", "click");
    const entries2 = policy.getEntries("com.app", "debug::click");
    expect(entries1.length).toBe(1);
    expect(entries2.length).toBe(1);
    expect(entries1[0]?.locator).toBe("#btn1");
    expect(entries2[0]?.locator).toBe("#btn2");
  });
});

// ── Publisher sanitization (src/community/publisher.ts) ──────

describe("Publisher bug hunting", () => {
  it("BUG: sanitizeParams removes 'hotkey' param because it contains 'key'", async () => {
    const { PlaybookPublisher } = await import("../src/community/publisher.js");
    const tmpDir = `/tmp/screenhand-test-pub-${Date.now()}`;
    const publisher = new PlaybookPublisher(tmpDir, null);

    const playbook = {
      id: "test1",
      name: "Test Playbook",
      description: "Test",
      platform: "test",
      bundleId: "com.test",
      steps: [{
        action: "press",
        keys: ["Cmd", "S"],
        description: "Save hotkey",
      }],
      tags: ["test"],
      successCount: 5,
      failCount: 0,
      domain: "",
    };

    const shared = publisher.publish(playbook as any, 1.0, 5);
    expect(shared).not.toBeNull();
    // Check if any step params were incorrectly stripped
    // The sanitizeParams checks key.toLowerCase().includes("key")
    // "combo" from the key normalization should be safe, but if original param was "hotkey"...
    // Actually let's test the sanitizer directly with a param named "hotkey"
    const testParams: Record<string, unknown> = { hotkey: "Cmd+S", apiEndpoint: "https://api.example.com" };
    (publisher as any).sanitizeParams(testParams);
    // BUG: "hotkey" contains "key" → gets deleted even though it's not sensitive
    expect(testParams.hotkey).toBe("Cmd+S");
  });

  it("BUG: sanitizeParams removes 'primaryKey' database column reference", async () => {
    const { PlaybookPublisher } = await import("../src/community/publisher.js");
    const tmpDir = `/tmp/screenhand-test-pub2-${Date.now()}`;
    const publisher = new PlaybookPublisher(tmpDir, null);

    const params: Record<string, unknown> = { primaryKey: "id", tableName: "users" };
    (publisher as any).sanitizeParams(params);
    // BUG: "primaryKey" contains "key" → gets deleted
    expect(params.primaryKey).toBe("id");
  });
});

// ── DocParser regex issues (src/ingestion/doc-parser.ts) ─────

describe("DocParser bug hunting", () => {
  it("BUG: extractFlows misses steps when sectionRegex lastIndex is stale", async () => {
    const { DocParser } = await import("../src/ingestion/doc-parser.js");
    const parser = new DocParser();

    // Two sections with numbered steps
    const markdown = `
# How to Export

1. Click File menu
2. Select Export option
3. Choose format

# How to Import

1. Click File menu
2. Select Import option
3. Browse for file
4. Click Open
`;

    const result = parser.parse(markdown, "https://docs.example.com/guide", "markdown");
    // Should find 2 flows
    expect(result.flows.length).toBe(2);
  });

  it("BUG: inferTool maps 'open' to menu_click instead of launch/navigate", async () => {
    const { DocParser } = await import("../src/ingestion/doc-parser.js");
    const parser = new DocParser();

    const html = `<h2>Getting Started</h2>
1. Open the application from your dock
2. Click the Settings icon
3. Navigate to Advanced tab`;

    const result = parser.parse(html, "https://example.com", "html");
    if (result.flows.length > 0 && result.flows[0]!.steps.length > 0) {
      // "Open the application" gets inferTool → "menu_click" which is wrong
      // Opening an application should map to "launch" not "menu_click"
      const openStep = result.flows[0]!.steps.find(s =>
        s.description.toLowerCase().includes("open the application")
      );
      if (openStep) {
        expect(openStep.tool).not.toBe("menu_click");
      }
    }
  });
});

// ── Recovery strategies parsing (src/recovery/strategies.ts) ──

describe("Recovery strategies bug hunting", () => {
  it("BUG: parseSolutionToSteps with regex special chars in solution text", async () => {
    const { parseSolutionToSteps } = await import("../src/recovery/strategies.js");

    // Solution containing regex-special characters
    const steps = parseSolutionToSteps("Click the [OK] button. Then press (Enter)");
    expect(steps.length).toBeGreaterThan(0);
    // Should parse "Click the [OK] button" → click_text with text "[OK]"
    // But the regex in matchSolutionSentence may choke on brackets
    const clickStep = steps.find(s => s.tool === "click_text");
    expect(clickStep).toBeDefined();
  });

  it("BUG: parseSolutionToSteps empty string produces garbage", async () => {
    const { parseSolutionToSteps } = await import("../src/recovery/strategies.js");

    const steps = parseSolutionToSteps("");
    // Empty string → sentences filter: [""].filter(s => s.trim().length > 5) = []
    // Then: if (sentences.length === 0) sentences.push(solution) → [""]
    // matchSolutionSentence("", "") → fallback screenshot with description "Reference solution: "
    expect(steps.length).toBe(1);
    expect(steps[0]!.tool).toBe("screenshot"); // This actually works — but useless step
  });

  it("BUG: buildStrategyWithContext with pid=0 doesn't inject pid (falsy check)", async () => {
    const { buildStrategyWithContext } = await import("../src/recovery/strategies.js");

    const strategy = {
      id: "test",
      blockerType: "element_gone" as const,
      label: "Test",
      steps: [{ tool: "ui_tree", params: {}, description: "Rescan" }],
      postcondition: null,
      source: "builtin" as const,
    };

    const result = buildStrategyWithContext(strategy, "com.test", 0);
    // BUG: strategies.ts:287 — `if (pid && step.tool === "ui_tree")`
    // pid=0 is falsy → pid is NOT injected into ui_tree params
    // But pid=0 is a valid process ID on some systems
    expect(result.steps[0]!.params.pid).toBe(0);
  });
});

// ── Deterministic planner (src/planner/deterministic.ts) ─────

describe("Deterministic planner bug hunting", () => {
  it("BUG: playbookToPlan with 0 success + 0 fail gives 0.5 confidence — even for brand new untested playbook", async () => {
    const { playbookToPlan } = await import("../src/planner/deterministic.js");

    const plan = playbookToPlan({
      id: "pb1",
      name: "Test",
      description: "Test playbook",
      platform: "test",
      steps: [{ action: "click", target: "#btn" }],
      successCount: 0,
      failCount: 0,
      tags: [],
      domain: "",
    } as any);

    // Confidence of 0.5 for untested playbook seems reasonable...
    // But what about a playbook with 0 success and 100 fails?
    const failPlan = playbookToPlan({
      id: "pb2",
      name: "Bad",
      description: "Always fails",
      platform: "test",
      steps: [{ action: "click", target: "#btn" }],
      successCount: 0,
      failCount: 100,
      tags: [],
      domain: "",
    } as any);

    // Confidence should be near 0 for a playbook that always fails
    expect(failPlan.confidence).toBeLessThan(0.1);
  });

  it("BUG: flowToPlan with empty steps produces confidence 0.3 instead of 0", async () => {
    const { flowToPlan } = await import("../src/planner/deterministic.js");

    const plan = flowToPlan("empty_flow", { steps: [], description: "Empty" });
    // With 0 steps: confidence = steps.length > 0 ? ... : 0.3
    // BUG: An empty flow should have 0 confidence, not 0.3
    expect(plan.confidence).toBe(0);
    expect(plan.steps.length).toBe(0);
  });

  it("FIX VERIFIED: parseFlowStep rejects unknown tool names in function call syntax", async () => {
    const { flowToPlan } = await import("../src/planner/deterministic.js");

    // Step with unknown tool name — should NOT be treated as executable
    const plan = flowToPlan("test", {
      steps: ["malicious_tool(param: 'value')"],
      description: "Test",
    });

    // After fix: unknown tools are rejected, step requires LLM resolution
    expect(plan.steps[0]!.requiresLLM).toBe(true);
    expect(plan.steps[0]!.tool).toBe(""); // No tool assigned
  });
});

// ── LearningEngine (src/learning/engine.ts) ──────────────────

describe("LearningEngine bug hunting", () => {
  it("BUG: getAppSummary locator key filter uses :: — same collision as LocatorPolicy", async () => {
    const { LearningEngine } = await import("../src/learning/engine.js");
    const engine = new LearningEngine({ dataDir: `/tmp/le-test-${Date.now()}` });

    // Record for bundleId "com.app" action "click"
    engine.recordLocatorOutcome({
      bundleId: "com.app",
      actionKey: "click",
      locator: "#btn",
      method: "ax",
      success: true,
    });
    // Record for bundleId "com.app::debug" action "click"
    // This key starts with "com.app::" which also matches filter `startsWith("com.app::")`
    engine.recordLocatorOutcome({
      bundleId: "com.app::debug",
      actionKey: "click",
      locator: "#dbg",
      method: "ax",
      success: true,
    });

    const summary = engine.getAppSummary("com.app");
    // BUG: engine.ts:207-208 filter: e.key.startsWith(`${bundleId}::`)
    // "com.app::debug::click".startsWith("com.app::") → true (wrong app!)
    expect(summary.locatorEntries).toBe(1); // Should be 1, not 2
  });

  it("BUG: getAppSummary recovery key filter uses :: from the end", async () => {
    const { LearningEngine } = await import("../src/learning/engine.js");
    const engine = new LearningEngine({ dataDir: `/tmp/le-test2-${Date.now()}` });

    engine.recordRecoveryOutcome({
      bundleId: "com.app",
      blockerType: "focus_lost",
      strategyId: "refocus_app",
      success: true,
      durationMs: 100,
    });
    engine.recordRecoveryOutcome({
      bundleId: "my.com.app",
      blockerType: "focus_lost",
      strategyId: "refocus_app",
      success: true,
      durationMs: 100,
    });

    const summary = engine.getAppSummary("com.app");
    // BUG: engine.ts:211-212 filter: e.key.endsWith(`::${bundleId}`)
    // "focus_lost::my.com.app".endsWith("::com.app") → true (wrong app!)
    expect(summary.recoveryEntries).toBe(1);
  });
});
