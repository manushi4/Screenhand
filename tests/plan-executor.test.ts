// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanExecutor, type ToolExecutor } from "../src/planner/executor.js";
import { Planner } from "../src/planner/planner.js";
import type { WorldModel } from "../src/state/world-model.js";
import type { LearningEngine } from "../src/learning/engine.js";
import type { PlaybookStore } from "../src/playbook/store.js";
import type { MemoryService } from "../src/memory/service.js";
import type { ContextTracker } from "../src/context-tracker.js";
import type { Goal, ActionPlan, PlanStep, PlanResult, ExecutionPause } from "../src/planner/types.js";

function makeMockWorldModel(hasWindows = false, focusedApp?: { bundleId: string }): WorldModel {
  const windows = new Map();
  if (hasWindows) {
    windows.set(1, { windowId: 1, controls: new Map(), title: { value: "" }, focusedElement: null });
  }
  const mock = {
    getState: vi.fn().mockReturnValue({
      windows,
      activeDialogs: [],
      focusedApp: focusedApp ?? null,
      focusedWindowId: hasWindows ? 1 : null,
    }),
    assertState: vi.fn().mockReturnValue(true),
    assertStateDetailed: vi.fn().mockReturnValue({ matched: true, actual: null, confidence: 1.0 }),
    getActiveDialogs: vi.fn().mockReturnValue([]),
    toSummary: vi.fn().mockReturnValue(""),
    init: vi.fn(),
    ingestAXTree: vi.fn(),
    ingestUIEvents: vi.fn(),
    ingestCDPSnapshot: vi.fn(),
    ingestOCRRegions: vi.fn(),
    updateFocusedApp: vi.fn(),
    getWindowState: vi.fn().mockReturnValue(null),
    getFocusedWindow: vi.fn().mockReturnValue(null),
    getControl: vi.fn().mockReturnValue(null),
    getAppDomain: vi.fn().mockReturnValue(null),
    getStaleControls: vi.fn().mockReturnValue([]),
    flush: vi.fn(),
  } as any;

  // getConsistentSnapshot delegates to getState so test overrides propagate
  mock.getConsistentSnapshot = vi.fn().mockImplementation(() => mock.getState());

  return mock as WorldModel;
}

function makePlanner(): Planner {
  const store = {
    matchByTask: vi.fn().mockReturnValue(null),
    matchByDomain: vi.fn().mockReturnValue(null),
    matchByBundleId: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
  } as unknown as PlaybookStore;

  const memory = {
    recallStrategies: vi.fn().mockReturnValue([]),
    quickStrategyHint: vi.fn().mockReturnValue(null),
    quickErrorCheck: vi.fn().mockReturnValue(null),
  } as unknown as MemoryService;

  const tracker = {
    getActivePlaybook: vi.fn().mockReturnValue(null),
    updateContext: vi.fn(),
    getHints: vi.fn().mockReturnValue([]),
    recordOutcome: vi.fn(),
  } as unknown as ContextTracker;

  const worldModel = makeMockWorldModel();
  return new Planner(store, memory, tracker, worldModel);
}

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    tool: "click_with_fallback",
    params: { target: "#btn" },
    expectedPostcondition: null,
    timeout: 5000,
    fallbackTool: null,
    requiresLLM: false,
    status: "pending",
    description: "Click button",
    ...overrides,
  };
}

function makePlan(steps: PlanStep[]): ActionPlan {
  return {
    steps,
    currentStepIndex: 0,
    confidence: 0.8,
    source: "playbook",
    sourceId: "test",
  };
}

describe("plan-executor", () => {
  let worldModel: ReturnType<typeof makeMockWorldModel>;
  let planner: Planner;
  let successExecutor: ToolExecutor;
  let failExecutor: ToolExecutor;

  beforeEach(() => {
    worldModel = makeMockWorldModel();
    planner = makePlanner();
    successExecutor = vi.fn(async () => ({ ok: true, result: "done" }));
    failExecutor = vi.fn(async () => ({
      ok: false,
      error: "Element not found",
    }));
  });

  it("executes steps in order", async () => {
    const steps = [
      makeStep({ tool: "focus", description: "Focus app" }),
      makeStep({ tool: "key", description: "Press key" }),
      makeStep({ tool: "click_with_fallback", description: "Click" }),
    ];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(true);
    expect("stepsExecuted" in result && result.stepsExecuted).toBe(3);
    expect(successExecutor).toHaveBeenCalledTimes(3);

    // Check order
    const calls = (successExecutor as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe("focus");
    expect(calls[1]![0]).toBe("key");
    expect(calls[2]![0]).toBe("click_with_fallback");
  });

  it("verifies postconditions after each step", async () => {
    // Use a world model with windows so postconditions are checked
    const wmWithWindows = makeMockWorldModel(true);
    (wmWithWindows.assertStateDetailed as ReturnType<typeof vi.fn>).mockReturnValue({ matched: true, actual: "#result found", confidence: 1.0 });

    const steps = [
      makeStep({
        expectedPostcondition: { type: "control_exists", target: "#result" },
      }),
    ];

    const executor = new PlanExecutor(
      wmWithWindows as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(true);
    expect(wmWithWindows.assertStateDetailed).toHaveBeenCalledWith({
      type: "control_exists",
      target: "#result",
    });
  });

  it("fails when postcondition not met", async () => {
    // Use a world model with windows so postconditions are checked
    const wmWithWindows = makeMockWorldModel(true);
    (wmWithWindows.assertStateDetailed as ReturnType<typeof vi.fn>).mockReturnValue({ matched: false, actual: null, confidence: 0 });

    const steps = [
      makeStep({
        expectedPostcondition: { type: "control_exists", target: "#result" },
      }),
    ];

    const executor = new PlanExecutor(
      wmWithWindows as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(false);
    expect("error" in result && result.error).toContain("Postcondition");
  });

  it("triggers replan on failure via executeGoal", async () => {
    const goal = planner.createGoal("test replanning");
    goal.subgoals[0]!.maxAttempts = 2;

    // Override planSubgoal to return a deterministic (non-LLM) plan
    vi.spyOn(planner, "planSubgoal").mockReturnValue(makePlan([makeStep()]));

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      failExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executeGoal(goal);
    // First plan fails, replan produces LLM stub which may pause
    if ("paused" in result) {
      expect(goal.subgoals[0]!.attempts).toBeGreaterThanOrEqual(1);
    } else {
      expect(result.success).toBe(false);
      expect(result.replans).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses fallback tool when primary fails", async () => {
    let callCount = 0;
    const mixedExecutor: ToolExecutor = vi.fn(async (tool) => {
      callCount++;
      if (tool === "click_with_fallback" && callCount === 1) {
        return { ok: false, error: "AX failed" };
      }
      return { ok: true, result: "done" };
    });

    const steps = [
      makeStep({
        tool: "click_with_fallback",
        fallbackTool: "browser_click",
      }),
    ];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      mixedExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(true);
    expect("stepResults" in result && result.stepResults[0]!.usedFallback).toBe(true);
    expect(mixedExecutor).toHaveBeenCalledWith("browser_click", { target: "#btn" });
  });

  it("skips completed subgoals", async () => {
    const goal = planner.createGoal("test skip");
    goal.subgoals[0]!.status = "completed";

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executeGoal(goal);
    expect("success" in result && result.success).toBe(true);
    if (!("paused" in result)) {
      expect(result.stepsExecuted).toBe(0);
    }
    expect(successExecutor).not.toHaveBeenCalled();
  });

  it("executes step normally when dialogs present but no recovery engine", async () => {
    // Without RecoveryEngine, dialogs don't block steps — steps run normally.
    // Recovery is the responsibility of the RecoveryEngine when injected.
    (worldModel.getActiveDialogs as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "modal", title: "Save changes?", windowId: 1, controls: new Map(), detectedAt: new Date().toISOString() },
    ]);

    const steps = [makeStep()];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(true);
    expect(successExecutor).toHaveBeenCalledTimes(1);
  });

  it("handles tool execution throwing", async () => {
    const throwingExecutor: ToolExecutor = vi.fn(async () => {
      throw new Error("Bridge crashed");
    });

    const steps = [makeStep()];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      throwingExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(false);
    expect("error" in result && result.error).toContain("Bridge crashed");
  });

  it("pauses at LLM-required steps", async () => {
    const steps = [
      makeStep({ tool: "", requiresLLM: true, description: "Navigate to the settings page" }),
    ];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("paused" in result).toBe(true);
    if ("paused" in result) {
      expect(result.reason).toBe("requires_llm");
      expect(result.stepDescription).toBe("Navigate to the settings page");
    }
  });

  it("resolveStep executes client-provided tool and advances plan", async () => {
    const goal = planner.createGoal("test resolve");
    goal.subgoals[0]!.plan = makePlan([
      makeStep({ tool: "", requiresLLM: true, description: "Click something" }),
    ]);
    goal.pausedAt = { subgoalIndex: 0, stepIndex: 0 };

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.resolveStep(goal, "browser_click", { selector: "#btn" });
    expect(result.success).toBe(true);
    expect(result.step.tool).toBe("browser_click");
    expect(result.step.resolvedBy).toBe("client");
    expect(goal.subgoals[0]!.plan!.currentStepIndex).toBe(1);
  });

  it("executeNextStep returns one step at a time", async () => {
    const goal = planner.createGoal("test incremental");
    goal.subgoals[0]!.plan = makePlan([
      makeStep({ tool: "focus", description: "Step 1" }),
      makeStep({ tool: "key", description: "Step 2" }),
    ]);

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      successExecutor,
      { postconditionWaitMs: 0 },
    );

    const r1 = await executor.executeNextStep(goal);
    expect("step" in r1).toBe(true);
    if ("step" in r1) {
      expect(r1.step.tool).toBe("focus");
      expect(r1.success).toBe(true);
    }

    const r2 = await executor.executeNextStep(goal);
    expect("step" in r2).toBe(true);
    if ("step" in r2) {
      expect(r2.step.tool).toBe("key");
      expect(r2.success).toBe(true);
    }

    // Goal should be completed now
    const r3 = await executor.executeNextStep(goal);
    expect("goalId" in r3).toBe(true);
  });

  it("injects adaptive budget from learning engine into step params", async () => {
    const wmWithApp = makeMockWorldModel();
    (wmWithApp.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      windows: new Map(),
      activeDialogs: [],
      focusedApp: { bundleId: "com.fast.app", appName: "Fast", pid: 1 },
    });

    const mockLearning = {
      getAdaptiveBudget: vi.fn().mockReturnValue({ locateMs: 120, actMs: 50, verifyMs: 300 }),
      recommendLocator: vi.fn().mockReturnValue(null),
    } as unknown as LearningEngine;

    const captureExecutor: ToolExecutor = vi.fn(async (_tool, params) => {
      // Capture what params were passed
      return { ok: true, result: "done" };
    });

    const steps = [makeStep({ tool: "click_with_fallback", params: { target: "#btn" } })];

    const executor = new PlanExecutor(
      wmWithApp as unknown as WorldModel,
      planner,
      captureExecutor,
      { postconditionWaitMs: 0 },
      undefined,
      mockLearning,
    );

    await executor.executePlan(makePlan(steps));

    expect(captureExecutor).toHaveBeenCalledTimes(1);
    const callParams = (captureExecutor as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(callParams._budget).toEqual({ locateMs: 120, actMs: 50, verifyMs: 300 });
    expect(callParams.target).toBe("#btn");
    expect(mockLearning.getAdaptiveBudget).toHaveBeenCalledWith("com.fast.app");
  });

  it("does not inject budget when no learning engine", async () => {
    const captureExecutor: ToolExecutor = vi.fn(async () => ({ ok: true, result: "done" }));
    const steps = [makeStep({ tool: "click_with_fallback", params: { target: "#btn" } })];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      captureExecutor,
      { postconditionWaitMs: 0 },
    );

    await executor.executePlan(makePlan(steps));

    const callParams = (captureExecutor as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(callParams._budget).toBeUndefined();
  });

  it("does not overwrite existing _budget in params", async () => {
    const wmWithApp = makeMockWorldModel();
    (wmWithApp.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      windows: new Map(),
      activeDialogs: [],
      focusedApp: { bundleId: "com.fast.app", appName: "Fast", pid: 1 },
    });

    const mockLearning = {
      getAdaptiveBudget: vi.fn().mockReturnValue({ locateMs: 120, actMs: 50, verifyMs: 300 }),
      recommendLocator: vi.fn().mockReturnValue(null),
    } as unknown as LearningEngine;

    const captureExecutor: ToolExecutor = vi.fn(async () => ({ ok: true, result: "done" }));
    const existingBudget = { locateMs: 999, actMs: 999, verifyMs: 999 };
    const steps = [makeStep({ tool: "click_with_fallback", params: { target: "#btn", _budget: existingBudget } })];

    const executor = new PlanExecutor(
      wmWithApp as unknown as WorldModel,
      planner,
      captureExecutor,
      { postconditionWaitMs: 0 },
      undefined,
      mockLearning,
    );

    await executor.executePlan(makePlan(steps));

    const callParams = (captureExecutor as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(callParams._budget).toEqual(existingBudget);
    // Learning engine should NOT be called since _budget already exists
    expect(mockLearning.getAdaptiveBudget).not.toHaveBeenCalled();
  });

  it("enforces step timeout when tool hangs", async () => {
    // Tool that never resolves
    const hangingExecutor: ToolExecutor = vi.fn(
      () => new Promise(() => {}),
    );

    const steps = [makeStep({ tool: "hang_forever", timeout: 100 })];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      hangingExecutor,
      { postconditionWaitMs: 0, defaultStepTimeout: 100 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(false);
    expect("error" in result && result.error).toContain("Step timeout");
  }, 5000);

  it("does not timeout when tool completes within budget", async () => {
    const fastExecutor: ToolExecutor = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, result: "done" };
    });

    const steps = [makeStep({ tool: "fast_tool", timeout: 5000 })];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      fastExecutor,
      { postconditionWaitMs: 0 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(true);
  });

  it("uses defaultStepTimeout when step.timeout is 0", async () => {
    const hangingExecutor: ToolExecutor = vi.fn(
      () => new Promise(() => {}),
    );

    // timeout=0 should fall back to defaultStepTimeout
    const steps = [makeStep({ tool: "hang_forever", timeout: 0 })];

    const executor = new PlanExecutor(
      worldModel as unknown as WorldModel,
      planner,
      hangingExecutor,
      { postconditionWaitMs: 0, defaultStepTimeout: 100 },
    );

    const result = await executor.executePlan(makePlan(steps));
    expect("success" in result && result.success).toBe(false);
    expect("error" in result && result.error).toContain("Step timeout");
  }, 5000);

  // ── 4.4 executor → world model updates ──

  it("feeds focus tool result into world model updateFocusedApp", async () => {
    const worldModel = makeMockWorldModel();
    const planner = makePlanner();
    const toolExec: ToolExecutor = vi.fn(async () => ({ ok: true, result: "focused" }));

    const executor = new PlanExecutor(worldModel, planner, toolExec, { postconditionWaitMs: 0 });

    const steps = [makeStep({ tool: "focus", params: { bundleId: "com.test.App", appName: "TestApp" } })];
    await executor.executePlan(makePlan(steps));

    expect(worldModel.updateFocusedApp).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "com.test.App" }),
    );
  });

  it("feeds browser_navigate result into world model ingestCDPSnapshot", async () => {
    const worldModel = makeMockWorldModel(true, { bundleId: "com.google.Chrome" });
    const planner = makePlanner();
    const toolExec: ToolExecutor = vi.fn(async () => ({
      ok: true,
      result: JSON.stringify({ url: "https://example.com", title: "Example" }),
    }));

    const executor = new PlanExecutor(worldModel, planner, toolExec, { postconditionWaitMs: 0 });

    const steps = [makeStep({ tool: "browser_navigate", params: { url: "https://example.com" } })];
    await executor.executePlan(makePlan(steps));

    expect(worldModel.ingestCDPSnapshot).toHaveBeenCalledWith(
      "com.google.Chrome",
      "https://example.com",
      "Example",
    );
  });

  it("feeds ocr result regions into world model ingestOCRRegions", async () => {
    const worldModel = makeMockWorldModel(true, { bundleId: "com.test.App" });
    const planner = makePlanner();
    const regions = [{ text: "Hello", bounds: { x: 10, y: 20, width: 100, height: 30 } }];
    const toolExec: ToolExecutor = vi.fn(async () => ({
      ok: true,
      result: JSON.stringify({ text: "Hello", regions }),
    }));

    const executor = new PlanExecutor(worldModel, planner, toolExec, { postconditionWaitMs: 0 });

    const steps = [makeStep({ tool: "ocr", params: { windowId: 1 } })];
    await executor.executePlan(makePlan(steps));

    expect(worldModel.ingestOCRRegions).toHaveBeenCalledWith(1, regions);
  });

  it("returns app_switched when focused app differs", async () => {
    // Start with app A focused
    const wmSwitched = makeMockWorldModel(false, { bundleId: "com.app.A" });

    const planner = makePlanner();
    vi.spyOn(planner, "planSubgoal").mockReturnValue(makePlan([makeStep()]));

    // After plan execution, the focused app has changed to app B
    let callCount = 0;
    const switchExecutor: ToolExecutor = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate app switch during execution
        (wmSwitched.getState as ReturnType<typeof vi.fn>).mockReturnValue({
          windows: new Map(),
          activeDialogs: [],
          focusedApp: { bundleId: "com.app.B", appName: "AppB", pid: 2 },
          focusedWindowId: null,
        });
        return { ok: false, error: "Element not found" };
      }
      return { ok: true, result: "done" };
    });

    const executor = new PlanExecutor(
      wmSwitched as unknown as WorldModel,
      planner,
      switchExecutor,
      { postconditionWaitMs: 0 },
    );

    const goal = planner.createGoal("test app switch detection");
    goal.subgoals[0]!.maxAttempts = 2;

    const result = await executor.executeGoal(goal);
    // The replan should have been called with "app_switched" reason
    // Since planner mock returns a plan, it will try again
    expect(result).toBeDefined();
    if (!("paused" in result)) {
      expect(result.replans).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not feed world model on failed tool execution", async () => {
    const worldModel = makeMockWorldModel();
    const planner = makePlanner();
    const toolExec: ToolExecutor = vi.fn(async () => ({ ok: false, error: "failed" }));

    const executor = new PlanExecutor(worldModel, planner, toolExec, { postconditionWaitMs: 0 });

    const steps = [makeStep({ tool: "focus", params: { bundleId: "com.test.App" } })];
    await executor.executePlan(makePlan(steps));

    expect(worldModel.updateFocusedApp).not.toHaveBeenCalled();
  });
});
