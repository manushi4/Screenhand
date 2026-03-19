// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Planner } from "../src/planner/planner.js";
import { playbookToPlan, strategyToPlan, flowToPlan } from "../src/planner/deterministic.js";
import type { PlaybookStore } from "../src/playbook/store.js";
import type { MemoryService } from "../src/memory/service.js";
import type { ContextTracker } from "../src/context-tracker.js";
import type { WorldModel } from "../src/state/world-model.js";
import type { LearningEngine } from "../src/learning/engine.js";
import type { Playbook, PlaybookFlow } from "../src/playbook/types.js";
import type { Strategy } from "../src/memory/types.js";

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "test-playbook",
    name: "Test Playbook",
    description: "A test playbook",
    platform: "test",
    version: "1.0.0",
    tags: ["test", "export"],
    successCount: 8,
    failCount: 2,
    steps: [
      { action: "navigate", url: "https://example.com", description: "Open site" },
      { action: "press", target: "#submit", description: "Click submit" },
      { action: "wait", target: ".success", verify: ".success", description: "Wait for result" },
    ],
    ...overrides,
  };
}

function makeStrategy(overrides?: Partial<Strategy>): Strategy {
  return {
    id: "strat_abc",
    task: "export premiere timeline",
    steps: [
      { tool: "focus", params: { bundleId: "com.adobe.Premiere" } },
      { tool: "key", params: { keys: ["cmd", "m"] } },
      { tool: "click_with_fallback", params: { target: "H.264" } },
    ],
    totalDurationMs: 3000,
    successCount: 5,
    failCount: 1,
    lastUsed: new Date().toISOString(),
    tags: ["premiere", "export"],
    fingerprint: "focus_key_click",
    ...overrides,
  };
}

function makeMockStore(): PlaybookStore {
  return {
    matchByTask: vi.fn().mockReturnValue(null),
    matchByDomain: vi.fn().mockReturnValue(null),
    matchByBundleId: vi.fn().mockReturnValue(null),
    matchByUrl: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
    save: vi.fn(),
    load: vi.fn(),
    recordOutcome: vi.fn(),
  } as unknown as PlaybookStore;
}

function makeMockMemory(): MemoryService {
  return {
    recallStrategies: vi.fn().mockReturnValue([]),
    quickStrategyHint: vi.fn().mockReturnValue(null),
    quickErrorCheck: vi.fn().mockReturnValue(null),
    recordEvent: vi.fn(),
    getSessionId: vi.fn().mockReturnValue("test"),
    getRecentToolNames: vi.fn().mockReturnValue([]),
    recordStrategyOutcome: vi.fn(),
  } as unknown as MemoryService;
}

function makeMockTracker(): ContextTracker {
  return {
    getActivePlaybook: vi.fn().mockReturnValue(null),
    updateContext: vi.fn(),
    getHints: vi.fn().mockReturnValue([]),
    recordOutcome: vi.fn(),
    flush: vi.fn(),
  } as unknown as ContextTracker;
}

function makeMockWorldModel(): WorldModel {
  return {
    getState: vi.fn().mockReturnValue({ windows: new Map(), activeDialogs: [] }),
    assertState: vi.fn().mockReturnValue(true),
    getActiveDialogs: vi.fn().mockReturnValue([]),
    toSummary: vi.fn().mockReturnValue(""),
    init: vi.fn(),
    ingestAXTree: vi.fn(),
    ingestUIEvents: vi.fn(),
    updateFocusedApp: vi.fn(),
    getWindowState: vi.fn().mockReturnValue(null),
    getFocusedWindow: vi.fn().mockReturnValue(null),
    getControl: vi.fn().mockReturnValue(null),
    getAppDomain: vi.fn().mockReturnValue(null),
    getStaleControls: vi.fn().mockReturnValue([]),
    flush: vi.fn(),
  } as unknown as WorldModel;
}

describe("planner", () => {
  let store: ReturnType<typeof makeMockStore>;
  let memory: ReturnType<typeof makeMockMemory>;
  let tracker: ReturnType<typeof makeMockTracker>;
  let worldModel: ReturnType<typeof makeMockWorldModel>;
  let planner: Planner;

  beforeEach(() => {
    store = makeMockStore();
    memory = makeMockMemory();
    tracker = makeMockTracker();
    worldModel = makeMockWorldModel();
    planner = new Planner(
      store as unknown as PlaybookStore,
      memory as unknown as MemoryService,
      tracker as unknown as ContextTracker,
      worldModel as unknown as WorldModel,
    );
  });

  it("decomposes goal into subgoals", () => {
    const goal = planner.createGoal("Export Premiere Pro timeline as H.264");
    expect(goal.id).toMatch(/^goal_/);
    expect(goal.status).toBe("pending");
    expect(goal.subgoals).toHaveLength(1);
    expect(goal.subgoals[0]!.description).toBe(
      "Export Premiere Pro timeline as H.264",
    );
    expect(goal.subgoals[0]!.maxAttempts).toBe(3);
  });

  it("finds deterministic plan from playbook", async () => {
    const playbook = makePlaybook();
    (store.matchByTask as ReturnType<typeof vi.fn>).mockReturnValue(playbook);

    const goal = planner.createGoal("Run test playbook");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan).not.toBeNull();
    expect(plan.source).toBe("playbook");
    expect(plan.sourceId).toBe("test-playbook");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.tool).toBe("browser_navigate");
    expect(plan.steps[0]!.requiresLLM).toBe(false);
    expect(plan.confidence).toBeCloseTo(0.8, 1);
  });

  it("finds plan from strategy recall", async () => {
    const strategy = makeStrategy();
    (memory.recallStrategies as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...strategy, score: 0.8 },
    ]);

    const goal = planner.createGoal("export premiere timeline");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan.source).toBe("strategy");
    expect(plan.sourceId).toBe("strat_abc");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.tool).toBe("focus");
  });

  it("finds plan from reference flow", async () => {
    const flow: PlaybookFlow = {
      steps: ["Open export dialog", "Select H.264 format", "Click Export"],
    };
    const playbook = makePlaybook({
      flows: { export_timeline: flow },
    });
    (tracker.getActivePlaybook as ReturnType<typeof vi.fn>).mockReturnValue(playbook);

    const goal = planner.createGoal("export timeline");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    // Falls through to active playbook since matchByTask returns null
    // but getActivePlaybook returns a playbook with steps
    expect(plan).not.toBeNull();
  });

  it("falls back to LLM when no match", async () => {
    const goal = planner.createGoal("do something completely novel");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan.source).toBe("llm");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.requiresLLM).toBe(true);
    expect(plan.confidence).toBe(0.3);
  });

  it("replans on postcondition mismatch", async () => {
    const playbook = makePlaybook();
    (store.matchByTask as ReturnType<typeof vi.fn>).mockReturnValue(playbook);

    const goal = planner.createGoal("Run test playbook");
    await planner.planGoal(goal);

    const subgoal = goal.subgoals[0]!;
    expect(subgoal.plan!.source).toBe("playbook");

    // Replan
    const newPlan = await planner.replan(subgoal, "postcondition_mismatch", "verify failed");
    expect(newPlan).not.toBeNull();
    expect(subgoal.attempts).toBe(1);
    expect(subgoal.lastError).toBe("verify failed");
    // Deterministic plans (playbook/strategy/reference_flow) are retried, not downgraded to LLM
    expect(newPlan!.source).toBe("playbook");
  });

  it("respects maxAttempts", async () => {
    const goal = planner.createGoal("fail repeatedly");
    await planner.planGoal(goal);

    const subgoal = goal.subgoals[0]!;
    subgoal.maxAttempts = 2;
    subgoal.attempts = 0;

    await planner.replan(subgoal, "timeout", "first fail");
    expect(subgoal.status).toBe("pending");
    expect(subgoal.attempts).toBe(1);

    const result = await planner.replan(subgoal, "timeout", "second fail");
    expect(result).toBeNull();
    expect(subgoal.status).toBe("failed");
    expect(subgoal.attempts).toBe(2);
  });

  it("serializes and deserializes goals", async () => {
    const goal = planner.createGoal("Test serialization");
    await planner.planGoal(goal);

    const json = Planner.serializeGoal(goal);
    const restored = Planner.deserializeGoal(json);

    expect(restored.id).toBe(goal.id);
    expect(restored.description).toBe(goal.description);
    expect(restored.subgoals).toHaveLength(1);
    expect(restored.subgoals[0]!.plan).not.toBeNull();
  });

  // ── 4.3 multi-subgoal decomposition ──

  it("decomposes numbered steps into multiple subgoals", () => {
    const goal = planner.createGoal("1. Open Premiere 2. Import footage 3. Export as H.264");
    expect(goal.subgoals.length).toBe(3);
    expect(goal.subgoals[0]!.description).toBe("Open Premiere");
    expect(goal.subgoals[1]!.description).toBe("Import footage");
    expect(goal.subgoals[2]!.description).toBe("Export as H.264");
  });

  it("decomposes 'and then' into multiple subgoals", () => {
    const goal = planner.createGoal("Export video and then upload to YouTube");
    expect(goal.subgoals.length).toBe(2);
    expect(goal.subgoals[0]!.description).toBe("Export video");
    expect(goal.subgoals[1]!.description).toBe("upload to YouTube");
  });

  it("decomposes semicolons into multiple subgoals", () => {
    const goal = planner.createGoal("Open project; add title card; render preview");
    expect(goal.subgoals.length).toBe(3);
    expect(goal.subgoals[0]!.description).toBe("Open project");
    expect(goal.subgoals[1]!.description).toBe("add title card");
    expect(goal.subgoals[2]!.description).toBe("render preview");
  });

  it("decomposes Oxford comma ', and' into multiple subgoals", () => {
    const goal = planner.createGoal("Export as H.264, and verify captions");
    expect(goal.subgoals.length).toBe(2);
    expect(goal.subgoals[0]!.description).toBe("Export as H.264");
    expect(goal.subgoals[1]!.description).toBe("verify captions");
  });

  it("keeps simple goals as single subgoal", () => {
    const goal = planner.createGoal("Click the submit button");
    expect(goal.subgoals.length).toBe(1);
    expect(goal.subgoals[0]!.description).toBe("Click the submit button");
  });

  it("decomposes ', then' into multiple subgoals", () => {
    const goal = planner.createGoal("Open the file, then save as PDF");
    expect(goal.subgoals.length).toBe(2);
    expect(goal.subgoals[0]!.description).toBe("Open the file");
    expect(goal.subgoals[1]!.description).toBe("save as PDF");
  });

  it("planGoal plans all subgoals from a decomposed goal", async () => {
    (store.matchByTask as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (memory.recallStrategies as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (tracker.getActivePlaybook as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const goal = planner.createGoal("1. Focus app 2. Click button");
    await planner.planGoal(goal);

    expect(goal.subgoals.length).toBe(2);
    expect(goal.subgoals[0]!.plan).not.toBeNull();
    expect(goal.subgoals[1]!.plan).not.toBeNull();
    expect(goal.status).toBe("active");
  });
});

describe("deterministic converters", () => {
  it("playbookToPlan converts steps correctly", () => {
    const playbook = makePlaybook();
    const plan = playbookToPlan(playbook);

    expect(plan.source).toBe("playbook");
    expect(plan.sourceId).toBe("test-playbook");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.tool).toBe("browser_navigate");
    expect(plan.steps[0]!.params.url).toBe("https://example.com");
    expect(plan.steps[1]!.tool).toBe("click_with_fallback");
    expect(plan.steps[2]!.expectedPostcondition).toEqual({
      type: "control_exists",
      target: ".success",
    });
    expect(plan.confidence).toBeCloseTo(0.8, 1);
  });

  it("strategyToPlan converts steps correctly", () => {
    const strategy = makeStrategy();
    const plan = strategyToPlan(strategy);

    expect(plan.source).toBe("strategy");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.tool).toBe("focus");
    expect(plan.steps[1]!.tool).toBe("key");
  });

  it("flowToPlan marks steps as requiresLLM", () => {
    const flow: PlaybookFlow = {
      steps: ["Open the export dialog", "Choose H.264 format"],
    };
    const plan = flowToPlan("export_timeline", flow);

    expect(plan.source).toBe("reference_flow");
    expect(plan.sourceId).toBe("export_timeline");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.requiresLLM).toBe(true);
    expect(plan.steps[0]!.description).toBe("Open the export dialog");
    expect(plan.confidence).toBe(0.3);
  });

  it("flowToPlan parses tool names from step descriptions", () => {
    const flow: PlaybookFlow = {
      steps: [
        "browser_navigate to canva.com",
        "browser_click on 'Create a design'",
        "screenshot to see current state",
        "Choose a template from the gallery",
      ],
    };
    const plan = flowToPlan("browser_create", flow, undefined, { pid: 123, windowId: 456 });

    expect(plan.steps).toHaveLength(4);

    // Step 1: browser_navigate parsed with URL
    expect(plan.steps[0]!.tool).toBe("browser_navigate");
    expect(plan.steps[0]!.params.url).toBe("https://canva.com");
    expect(plan.steps[0]!.requiresLLM).toBe(false);

    // Step 2: browser_click parsed with selector
    expect(plan.steps[1]!.tool).toBe("browser_click");
    expect(plan.steps[1]!.params.selector).toBe("Create a design");
    expect(plan.steps[1]!.requiresLLM).toBe(false);

    // Step 3: screenshot parsed (no params needed)
    expect(plan.steps[2]!.tool).toBe("screenshot");
    expect(plan.steps[2]!.requiresLLM).toBe(false);

    // Step 4: unparseable — requires LLM
    expect(plan.steps[3]!.requiresLLM).toBe(true);

    // Confidence: 3/4 executable = 0.3 + 0.4 * 0.75 ≈ 0.6
    expect(plan.confidence).toBeCloseTo(0.6, 5);
  });

  it("flowToPlan parses function call syntax", () => {
    const flow: PlaybookFlow = {
      steps: ["launch(bundleId: 'com.canva.CanvaDesktop')"],
    };
    const plan = flowToPlan("launch_canva", flow);

    expect(plan.steps[0]!.tool).toBe("launch");
    expect(plan.steps[0]!.params.bundleId).toBe("com.canva.CanvaDesktop");
    expect(plan.steps[0]!.requiresLLM).toBe(false);
  });
});

function makeMockLearningEngine(
  locator?: { locator: string; method: string; score: number; successCount: number; failCount: number },
): LearningEngine {
  return {
    recommendLocator: vi.fn().mockReturnValue(
      locator
        ? { key: "test", locator: locator.locator, method: locator.method, score: locator.score, successCount: locator.successCount, failCount: locator.failCount, lastUsed: new Date().toISOString() }
        : null,
    ),
    init: vi.fn(),
    recordLocatorOutcome: vi.fn(),
    recordRecoveryOutcome: vi.fn(),
    recordToolTiming: vi.fn(),
    recordSensorOutcome: vi.fn(),
  } as unknown as LearningEngine;
}

describe("learned locator wiring", () => {
  it("playbookToPlan overlays learned locator when score > 0.7", () => {
    const playbook = makePlaybook({
      steps: [
        { action: "press", target: "#old-submit", description: "Click submit" },
      ],
    });
    const engine = makeMockLearningEngine({
      locator: "#learned-submit",
      method: "ax",
      score: 0.85,
      successCount: 12,
      failCount: 2,
    });

    const plan = playbookToPlan(playbook, undefined, engine, "com.test.app");
    const step = plan.steps[0]!;

    expect(step.params.target).toBe("#learned-submit");
    expect(step.params._originalTarget).toBe("#old-submit");
    expect(step.params._learnedLocator).toBe(true);
  });

  it("playbookToPlan keeps original target when score < 0.7", () => {
    const playbook = makePlaybook({
      steps: [
        { action: "press", target: "#old-submit", description: "Click submit" },
      ],
    });
    const engine = makeMockLearningEngine({
      locator: "#unreliable",
      method: "ax",
      score: 0.5,
      successCount: 3,
      failCount: 3,
    });

    const plan = playbookToPlan(playbook, undefined, engine, "com.test.app");
    expect(plan.steps[0]!.params.target).toBe("#old-submit");
    expect(plan.steps[0]!.params._learnedLocator).toBeUndefined();
  });

  it("playbookToPlan keeps original target when no learning engine", () => {
    const playbook = makePlaybook({
      steps: [
        { action: "press", target: "#submit", description: "Click submit" },
      ],
    });

    const plan = playbookToPlan(playbook);
    expect(plan.steps[0]!.params.target).toBe("#submit");
  });

  it("strategyToPlan overlays learned locator", () => {
    const strategy = makeStrategy({
      steps: [
        { tool: "click_with_fallback", params: { target: "#old-btn" } },
      ],
    });
    const engine = makeMockLearningEngine({
      locator: "#learned-btn",
      method: "cdp",
      score: 0.9,
      successCount: 18,
      failCount: 2,
    });

    const plan = strategyToPlan(strategy, undefined, engine, "com.test.app");
    const step = plan.steps[0]!;

    expect(step.params.target).toBe("#learned-btn");
    expect(step.params.selector).toBe("#learned-btn");
    expect(step.params._originalTarget).toBe("#old-btn");
  });

  it("does not overlay learned locator on non-target params (url, keys)", () => {
    const playbook = makePlaybook({
      steps: [
        { action: "navigate", url: "https://example.com", description: "Navigate" },
      ],
    });
    const engine = makeMockLearningEngine({
      locator: "#something",
      method: "ax",
      score: 0.95,
      successCount: 20,
      failCount: 1,
    });

    const plan = playbookToPlan(playbook, undefined, engine, "com.test.app");
    expect(plan.steps[0]!.params.url).toBe("https://example.com");
    expect(plan.steps[0]!.params._learnedLocator).toBeUndefined();
  });

  it("planner passes learning engine through to playbook plans", async () => {
    const store = makeMockStore();
    const memory = makeMockMemory();
    const tracker = makeMockTracker();
    const wm = makeMockWorldModel();
    (wm.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      windows: new Map(),
      activeDialogs: [],
      focusedApp: { bundleId: "com.test.app", appName: "Test", pid: 1 },
    });

    const engine = makeMockLearningEngine({
      locator: "#learned-submit",
      method: "ax",
      score: 0.85,
      successCount: 12,
      failCount: 2,
    });

    const planner = new Planner(store, memory, tracker, wm, engine);

    const playbook = makePlaybook({
      steps: [
        { action: "press", target: "#old-submit", description: "Click submit" },
      ],
    });
    (store.matchByTask as ReturnType<typeof vi.fn>).mockReturnValue(playbook);

    const goal = planner.createGoal("Click submit");
    await planner.planGoal(goal);

    const step = goal.subgoals[0]!.plan!.steps[0]!;
    expect(step.params.target).toBe("#learned-submit");
    expect(step.params._originalTarget).toBe("#old-submit");
    expect(engine.recommendLocator).toHaveBeenCalledWith("com.test.app", "click_with_fallback");
  });
});

describe("LLM plan generation", () => {
  it("returns stub when no API key", async () => {
    const origKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    const store = makeMockStore();
    const memory = makeMockMemory();
    const tracker = makeMockTracker();
    const wm = makeMockWorldModel();
    const planner = new Planner(store, memory, tracker, wm);

    const goal = planner.createGoal("do something novel with no playbook");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan.source).toBe("llm");
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0]!.requiresLLM).toBe(true);
    expect(plan.confidence).toBe(0.3);

    // Restore
    if (origKey !== undefined) process.env["ANTHROPIC_API_KEY"] = origKey;
  });

  it("returns parsed steps on successful API call (mock fetch)", async () => {
    const origKey = process.env["ANTHROPIC_API_KEY"];
    const origFetch = globalThis.fetch;
    process.env["ANTHROPIC_API_KEY"] = "test-key";

    // Mock fetch to return LLM response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify([
            { tool: "focus", params: { bundleId: "com.app.test" }, description: "Focus app" },
            { tool: "click_text", params: { text: "Submit" }, description: "Click submit" },
          ]),
        }],
      }),
    }) as any;

    const store = makeMockStore();
    const memory = makeMockMemory();
    const tracker = makeMockTracker();
    const wm = makeMockWorldModel();
    const planner = new Planner(store, memory, tracker, wm);

    // Inject a mock tool registry
    const mockRegistry = { getToolNames: () => ["focus", "click_text", "key"] };
    planner.setToolRegistry(mockRegistry as any);

    const goal = planner.createGoal("novel task requiring LLM");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan.source).toBe("llm");
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0]!.tool).toBe("focus");
    expect(plan.steps[1]!.tool).toBe("click_text");
    expect(plan.steps[0]!.requiresLLM).toBe(false);
    expect(plan.confidence).toBe(0.5);

    // Restore
    globalThis.fetch = origFetch;
    if (origKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = origKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("falls back to stub on API error", async () => {
    const origKey = process.env["ANTHROPIC_API_KEY"];
    const origFetch = globalThis.fetch;
    process.env["ANTHROPIC_API_KEY"] = "test-key";

    // Mock fetch to fail
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

    const store = makeMockStore();
    const memory = makeMockMemory();
    const tracker = makeMockTracker();
    const wm = makeMockWorldModel();
    const planner = new Planner(store, memory, tracker, wm);
    const mockRegistry = { getToolNames: () => ["focus", "click_text"] };
    planner.setToolRegistry(mockRegistry as any);

    const goal = planner.createGoal("novel task that will fail LLM");
    await planner.planGoal(goal);

    const plan = goal.subgoals[0]!.plan!;
    expect(plan.source).toBe("llm");
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0]!.requiresLLM).toBe(true);
    expect(plan.confidence).toBe(0.3);

    // Restore
    globalThis.fetch = origFetch;
    if (origKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = origKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });
});
