// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

import type { WorldModel } from "../state/world-model.js";
import type { RecoveryEngine } from "../recovery/engine.js";
import type { RecoveryBudget } from "../recovery/types.js";
import { DEFAULT_RECOVERY_BUDGET } from "../recovery/types.js";
import type { LearningEngine } from "../learning/engine.js";
import type { AppMap } from "../state/app-map.js";
import type { StateAssertion } from "../state/types.js";
import type {
  Goal,
  Subgoal,
  ActionPlan,
  PlanStep,
  PlanResult,
  StepResult,
  PlannerConfig,
  ReplanReason,
  ExecutionPause,
} from "./types.js";
import { DEFAULT_PLANNER_CONFIG } from "./types.js";
import type { Planner } from "./planner.js";

/**
 * Function signature for executing a single tool call.
 * This is injected by the caller (mcp-desktop.ts) to avoid coupling
 * the executor to the MCP server internals.
 */
export type ToolExecutor = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: string; error?: string }>;

/**
 * PlanExecutor — runs ActionPlans step by step, verifying postconditions
 * against the world model after each step.
 *
 * On failure, delegates to the Planner for replanning.
 * On LLM steps, pauses and returns control to the client.
 */
export class PlanExecutor {
  private readonly config: PlannerConfig;
  /** Accumulated execution trace for current goal — reset on each executeGoal() call */
  private log: string[] = [];
  private appMap: AppMap | null = null;

  constructor(
    private readonly worldModel: WorldModel,
    private readonly planner: Planner,
    private readonly executeTool: ToolExecutor,
    config?: Partial<PlannerConfig>,
    private readonly recovery?: RecoveryEngine,
    private readonly learningEngine?: LearningEngine,
  ) {
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
  }

  /**
   * Set the AppMap for contract-based precondition checks and postcondition validation.
   * Wire #7: L7→L4.
   */
  setAppMap(map: AppMap): void {
    this.appMap = map;
  }

  private dbg(msg: string): void {
    const line = `[${new Date().toISOString().substring(11, 23)}] ${msg}`;
    this.log.push(line);
    process.stderr.write(line + "\n");
  }

  /**
   * Execute a full goal: iterate subgoals, execute plans, replan on failure.
   * Pauses at LLM steps and returns an ExecutionPause for the client to resolve.
   */
  async executeGoal(goal: Goal): Promise<PlanResult | ExecutionPause> {
    const start = Date.now();
    let stepsExecuted = 0;
    let replans = 0;
    this.log = []; // reset log for this goal

    // Capture the expected app at goal start for app_switched detection
    const expectedBundleId = this.worldModel.getState().focusedApp?.bundleId ?? null;

    this.dbg(`═══ GOAL START: "${goal.description}" ═══`);
    this.dbg(`Focused app: ${expectedBundleId ?? "none"} | Windows: ${this.worldModel.getState().windows.size} | Controls: ${[...this.worldModel.getState().windows.values()].reduce((n, w) => n + w.controls.size, 0)}`);

    // Recovery budget for the entire goal lifetime
    const recoveryBudget: RecoveryBudget = {
      ...DEFAULT_RECOVERY_BUDGET,
      usedStrategyIds: new Set<string>(),
    };

    // Plan any unplanned subgoals
    await this.planner.planGoal(goal);

    // Resume from pausedAt if set
    const startSubgoalIdx = goal.pausedAt?.subgoalIndex ?? 0;
    delete goal.pausedAt;

    for (let sgIdx = startSubgoalIdx; sgIdx < goal.subgoals.length; sgIdx++) {
      const subgoal = goal.subgoals[sgIdx]!;
      if (subgoal.status === "completed" || subgoal.status === "skipped")
        continue;

      this.dbg(`── Subgoal ${sgIdx + 1}/${goal.subgoals.length}: "${subgoal.description}"`);
      subgoal.status = "active";

      while (
        subgoal.status === "active" &&
        subgoal.attempts < subgoal.maxAttempts
      ) {
        if (!subgoal.plan) {
          this.dbg(`  ✗ No plan available`);
          subgoal.status = "failed";
          subgoal.lastError = "No plan available";
          break;
        }

        this.dbg(`  Plan: ${subgoal.plan.source} | ${subgoal.plan.steps.length} steps | attempt ${subgoal.attempts + 1}/${subgoal.maxAttempts}`);
        const result = await this.executePlan(subgoal.plan, recoveryBudget);

        // Check if we hit an LLM pause
        if ("paused" in result) {
          this.dbg(`  ⏸ Paused at step ${result.stepIndex}: ${result.stepDescription}`);
          // Save resume point on the goal
          goal.pausedAt = {
            subgoalIndex: sgIdx,
            stepIndex: result.stepIndex,
          };
          goal.status = "active";
          return {
            ...result,
            subgoalIndex: sgIdx,
          };
        }

        stepsExecuted += result.stepsExecuted;

        if (result.success) {
          this.dbg(`  ✓ Subgoal completed`);
          subgoal.status = "completed";
          break;
        }

        this.dbg(`  ✗ Plan failed: ${result.error}`);

        // Plan failed — try replanning
        replans++;
        const reason = this.diagnoseFailure(result, expectedBundleId);
        this.dbg(`  → Replan #${replans}, reason: ${reason}`);
        const newPlan = await this.planner.replan(subgoal, reason, result.error ?? undefined);

        if (!newPlan) {
          this.dbg(`  ✗ No replan available — giving up`);
          break;
        }

        this.dbg(`  → New plan: ${newPlan.source} | ${newPlan.steps.length} steps`);
        subgoal.plan = newPlan;
        subgoal.status = "active";
      }
    }

    this.planner.evaluateGoal(goal);

    const finalError = goal.status === "failed"
      ? goal.subgoals.find((sg) => sg.status === "failed")?.lastError ?? "Unknown error"
      : null;
    this.dbg(`═══ GOAL ${goal.status.toUpperCase()} in ${Date.now() - start}ms | steps=${stepsExecuted} replans=${replans}${finalError ? ` error="${finalError}"` : ""} ═══`);

    return {
      goalId: goal.id,
      success: goal.status === "completed",
      subgoalsCompleted: goal.subgoals.filter((sg) => sg.status === "completed").length,
      totalSubgoals: goal.subgoals.length,
      stepsExecuted,
      replans,
      durationMs: Date.now() - start,
      error: finalError,
      executionLog: [...this.log],
    };
  }

  /**
   * Execute the next single step of a goal. Returns the step result,
   * or an ExecutionPause if the next step requires LLM interpretation.
   */
  async executeNextStep(goal: Goal): Promise<StepResult | ExecutionPause | PlanResult> {
    // Find the current active subgoal and step
    for (let sgIdx = 0; sgIdx < goal.subgoals.length; sgIdx++) {
      const subgoal = goal.subgoals[sgIdx]!;
      if (subgoal.status === "completed" || subgoal.status === "skipped" || subgoal.status === "failed")
        continue;

      if (!subgoal.plan) {
        subgoal.plan = await this.planner.planSubgoal(subgoal);
      }
      subgoal.status = "active";

      const plan = subgoal.plan;
      if (plan.currentStepIndex >= plan.steps.length) {
        subgoal.status = "completed";
        continue;
      }

      const step = plan.steps[plan.currentStepIndex]!;

      // If step requires LLM and has no tool assigned, pause
      if (step.requiresLLM && !step.tool) {
        return {
          paused: true,
          reason: "requires_llm",
          stepIndex: plan.currentStepIndex,
          stepDescription: step.description,
          subgoalIndex: sgIdx,
          completedSteps: plan.currentStepIndex,
          totalSteps: plan.steps.length,
        };
      }

      const nextStep = findNextMeaningfulStep(plan.steps, plan.currentStepIndex);
      const result = await this.executeStepInternal(step, nextStep);

      if (result.success) {
        step.status = "completed";
        step.resolvedBy = "auto";
        plan.currentStepIndex++;

        // Check if subgoal is complete
        if (plan.currentStepIndex >= plan.steps.length) {
          subgoal.status = "completed";
          this.planner.evaluateGoal(goal);
        }
      } else {
        step.status = "failed";
      }

      return result;
    }

    // All subgoals done
    this.planner.evaluateGoal(goal);
    return {
      goalId: goal.id,
      success: goal.status === "completed",
      subgoalsCompleted: goal.subgoals.filter((sg) => sg.status === "completed").length,
      totalSubgoals: goal.subgoals.length,
      stepsExecuted: 0,
      replans: 0,
      durationMs: 0,
      error: goal.status === "failed"
        ? goal.subgoals.find((sg) => sg.status === "failed")?.lastError ?? "Unknown error"
        : null,
      executionLog: [...this.log],
    };
  }

  /**
   * Resolve an LLM step: the client provides the tool + params to use.
   * Executes the tool, advances the plan, and returns the result.
   */
  async resolveStep(
    goal: Goal,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<StepResult> {
    // Find the paused step
    const sgIdx = goal.pausedAt?.subgoalIndex ?? 0;
    const stepIdx = goal.pausedAt?.stepIndex ?? 0;
    const subgoal = goal.subgoals[sgIdx];
    if (!subgoal?.plan) {
      return {
        step: { tool: "", params: {}, expectedPostcondition: null, timeout: 0, fallbackTool: null, requiresLLM: true, status: "failed", description: "No plan" },
        success: false,
        durationMs: 0,
        postconditionMet: false,
        error: "No active plan to resolve",
        usedFallback: false,
      };
    }

    const plan = subgoal.plan;
    const step = plan.steps[stepIdx];
    if (!step) {
      return {
        step: { tool: "", params: {}, expectedPostcondition: null, timeout: 0, fallbackTool: null, requiresLLM: true, status: "failed", description: "No step" },
        success: false,
        durationMs: 0,
        postconditionMet: false,
        error: "Step not found at pause index",
        usedFallback: false,
      };
    }

    // Resolve the LLM step with client-provided tool+params
    step.tool = tool;
    step.params = params;
    step.resolvedBy = "client";

    const result = await this.executeStepInternal(step);

    if (result.success) {
      step.status = "completed";
      plan.currentStepIndex = stepIdx + 1;
      delete goal.pausedAt;

      if (plan.currentStepIndex >= plan.steps.length) {
        subgoal.status = "completed";
        this.planner.evaluateGoal(goal);
      }
    } else {
      step.status = "failed";
    }

    return result;
  }

  /**
   * Execute a single ActionPlan's steps sequentially.
   * Pauses at LLM steps instead of failing.
   */
  async executePlan(
    plan: ActionPlan,
    recoveryBudget?: RecoveryBudget,
  ): Promise<{
    success: boolean;
    stepsExecuted: number;
    error: string | null;
    stepResults: StepResult[];
  } | ExecutionPause> {
    const stepResults: StepResult[] = [];

    for (let i = plan.currentStepIndex; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      plan.currentStepIndex = i;

      // Pause at LLM-required steps for client resolution
      if (step.requiresLLM && !step.tool) {
        return {
          paused: true,
          reason: "requires_llm",
          stepIndex: i,
          stepDescription: step.description,
          subgoalIndex: 0,
          completedSteps: stepResults.length,
          totalSteps: plan.steps.length,
        };
      }

      // Find the next meaningful step (skip screenshots/OCR — they have no target)
      const nextStep = findNextMeaningfulStep(plan.steps, i);
      const result = await this.executeStepInternal(step, nextStep);
      stepResults.push(result);

      if (!result.success) {
        step.status = "failed";

        // Attempt recovery before reporting failure
        if (this.recovery && recoveryBudget) {
          const expectedBundleId = this.worldModel.getState().focusedApp?.bundleId ?? null;
          const recoveryOutcome = await this.recovery.attemptRecovery(
            result.error ?? "unknown failure",
            expectedBundleId,
            recoveryBudget,
          );
          if (recoveryOutcome.recovered) {
            // Retry the failed step once after recovery
            step.status = "pending";
            const retryResult = await this.executeStepInternal(step);
            stepResults.push(retryResult);
            if (retryResult.success) {
              step.status = "completed";
              continue;
            }
            step.status = "failed";
          }
        }

        return {
          success: false,
          stepsExecuted: stepResults.length,
          error: result.error,
          stepResults,
        };
      }

      step.status = "completed";
    }

    return {
      success: true,
      stepsExecuted: stepResults.length,
      error: null,
      stepResults,
    };
  }

  /**
   * Execute a single PlanStep and verify its postcondition.
   */
  /**
   * Execute a single PlanStep with world-model-aware LOOK → ACT → VERIFY loop.
   * Uses the world model (0ms reads) for awareness — NOT screenshots.
   */
  private async executeStepInternal(step: PlanStep, nextStep?: PlanStep | null): Promise<StepResult> {
    const start = Date.now();
    step.status = "executing";
    let usedFallback = false;

    // ── LOOK: Pre-step awareness from world model (0ms, consistent snapshot) ──

    const preState = this.worldModel.getConsistentSnapshot();
    const preControls = [...preState.windows.values()].reduce((n, w) => n + w.controls.size, 0);
    const paramStr = Object.entries(step.params)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    this.dbg(`  ▶ ${step.tool}(${paramStr})`);
    this.dbg(`    PRE  | app=${preState.focusedApp?.bundleId ?? "none"} | win=${preState.focusedWindowId ?? "none"} | controls=${preControls} | dialogs=${preState.activeDialogs.length}`);
    if (nextStep) {
      const npStr = Object.entries(nextStep.params).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      this.dbg(`    NEXT | ${nextStep.tool}(${npStr})`);
    }

    // 1. Dialog check: if a dialog is blocking, fail fast so recovery can handle it
    if (preState.activeDialogs.length > 0) {
      const dialog = preState.activeDialogs[0]!;
      const err = `Dialog blocking: ${dialog.type} "${dialog.title ?? dialog.message ?? "unknown"}" [buttons: ${dialog.buttons.join(", ")}]`;
      this.dbg(`    BLOCK| ${err}`);
      return {
        step,
        success: false,
        durationMs: Date.now() - start,
        postconditionMet: false,
        error: err,
        usedFallback: false,
      };
    }

    // 2. Target validation: for ANY tool that targets a UI element, verify it exists
    if (INTERACTION_TOOLS.has(step.tool)) {
      const target = (step.params.title ?? step.params.text ?? step.params.name ?? step.params.selector) as string | undefined;
      if (typeof target === "string") {
        const focusedWinId = preState.focusedWindowId;
        if (focusedWinId !== null) {
          const win = preState.windows.get(focusedWinId);
          if (win && win.controls.size > 5) {
            const targetLower = target.toLowerCase();
            const found = [...win.controls.values()].some(
              (c) => c.label.value?.toLowerCase().includes(targetLower),
            );
            if (!found) {
              const available = [...win.controls.values()]
                .slice(0, 15)
                .map((c) => `${c.role}:"${c.label.value ?? ""}"`)
                .filter((s) => s.length > 3)
                .join(", ");
              const err = `Pre-check: "${target}" not found in world model (${win.controls.size} controls tracked). Available: ${available}`;
              this.dbg(`    MISS | ${err}`);
              return {
                step,
                success: false,
                durationMs: Date.now() - start,
                postconditionMet: false,
                error: err,
                usedFallback: false,
              };
            }
            this.dbg(`    FOUND| "${target}" in world model ✓`);
          }
        }
      }
    }

    // 3. Contract precondition check (Wire #7: L7→L4)
    //    If AppMap has a contract for this element+action, verify preconditions are met.
    //    Violations are surfaced as structured warnings in the tool result.
    const preconditionWarnings: string[] = [];
    if (this.appMap && INTERACTION_TOOLS.has(step.tool)) {
      const target = (step.params.title ?? step.params.text ?? step.params.name) as string | undefined;
      const bundleId = preState.focusedApp?.bundleId;
      if (target && bundleId) {
        try {
          // Normalize action key for contract lookup
          const actionKey = step.tool
            .replace(/_with_fallback$/, "")
            .replace(/^browser_/, "")
            .replace(/^click_text$/, "click")
            .replace(/^ui_press$/, "click")
            .replace(/^ui_set_value$/, "type");
          const contractInfo = this.appMap.getContract(bundleId, target, actionKey);
          if (contractInfo) {
            const contract = contractInfo.contract;
            // Verify preconditions
            for (const precondition of contract.preconditions) {
              const precLower = precondition.toLowerCase();
              // Check "no dialogs" precondition
              if (precLower.includes("no dialog") && preState.activeDialogs.length > 0) {
                this.dbg(`    L7PC | Precondition failed: "${precondition}" — dialog present`);
                preconditionWarnings.push(`dialog present — ${precondition}`);
              }
              // Check "input focused" precondition for type tools
              if (precLower.includes("focused") && step.tool.includes("type")) {
                const win = preState.focusedWindowId ? preState.windows.get(preState.focusedWindowId) : null;
                if (win?.focusedElement) {
                  const role = win.focusedElement.role.toLowerCase();
                  if (!role.includes("text") && !role.includes("field") && !role.includes("area")) {
                    this.dbg(`    L7PC | Precondition warning: "${precondition}" — focused: ${win.focusedElement.role}`);
                    preconditionWarnings.push(`wrong focus (${win.focusedElement.role}) — ${precondition}`);
                  }
                }
              }
            }
          }
        } catch (e) { process.stderr.write(`[planner] contract precondition check failed: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    }

    // 4. Focus validation: for type_text, verify a text field is focused
    if (step.tool === "type_text") {
      const focusedWinId = preState.focusedWindowId;
      if (focusedWinId !== null) {
        const win = preState.windows.get(focusedWinId);
        if (win?.focusedElement) {
          const role = win.focusedElement.role.toLowerCase();
          const isTextInput = role.includes("text") || role.includes("search") ||
            role.includes("combobox") || role.includes("field") || role.includes("area");
          if (!isTextInput && win.controls.size > 5) {
            // Focused element isn't a text field — warn but don't block
            // (some apps use non-standard roles)
            step.description = `${step.description} [⚠ focused: ${win.focusedElement.role}:"${win.focusedElement.label.value ?? ""}"]`;
          }
        }
      }
    }

    // Surface precondition warnings in step description (visible to calling agent)
    if (preconditionWarnings.length > 0) {
      const warningText = preconditionWarnings.map((w) => `[⚠ PRECONDITION: ${w}]`).join(" ");
      step.description = `${warningText} ${step.description}`;
    }

    // ── ACT: Execute the tool ──

    // Auto-upgrade click_text → ui_press when world model already has the target via AX.
    // click_text uses cg.captureWindow (crashes on GPU-heavy pages) + OCR (slow, sometimes wrong tab).
    // ui_press uses AX directly — 10x faster, no screenshots, no crash risk.
    if (step.tool === "click_text" && preState.focusedApp) {
      const clickTarget = step.params.text as string | undefined;
      if (clickTarget) {
        for (const win of preState.windows.values()) {
          const match = [...win.controls.values()].find(
            (c) => c.label.value?.toLowerCase().includes(clickTarget.toLowerCase()),
          );
          if (match) {
            // Get real pid: window.pid (from AX scan) > focusedApp.pid (often 0 from feedWorldModel)
            const pid = win.pid || preState.focusedApp.pid;
            if (pid) {
              this.dbg(`    SWAP | click_text → ui_press (found "${match.label.value}" as ${match.role} in AX, pid=${pid})`);
              step.tool = "ui_press";
              step.params = { pid, title: clickTarget };
            } else {
              this.dbg(`    SWAP | pid=0, cannot use ui_press — failing to avoid bridge crash`);
              return {
                step, success: false, durationMs: Date.now() - start, postconditionMet: false,
                error: `Cannot click "${clickTarget}": element found in AX but pid unknown. Use focus first.`,
                usedFallback: false,
              };
            }
            break;
          }
        }
      }
    }

    // Skip screenshot steps for browser apps when world model is populated.
    // CGWindowListCreateImage crashes on GPU-heavy pages (WebGL/canvas).
    // The world model already has full UI visibility — screenshot adds nothing.
    if (SCREENSHOT_TOOLS.has(step.tool) && preState.focusedApp) {
      const appDomain = preState.appDomains?.get(preState.focusedApp.bundleId);
      const family = appDomain?.family;
      const hasControls = preState.windows.size > 0 &&
        [...preState.windows.values()].some((w) => w.controls.size > 10);
      if (family === "browser" && hasControls) {
        this.dbg(`    SKIP | ${step.tool} — browser+world model active (${preControls} controls)`);
        step.description = `${step.description} [skipped — browser+world model active]`;
        return {
          step,
          success: true,
          durationMs: Date.now() - start,
          postconditionMet: true,
          error: null,
          usedFallback: false,
        };
      }
    }

    const params = { ...step.params };

    // Auto-inject windowId for click_text/screenshot_file/ocr when not provided by plan.
    // These tools require windowId but strategies often omit it — use focused window.
    if (WINDOW_ID_TOOLS.has(step.tool) && !params.windowId) {
      const winId = preState.focusedWindowId ?? [...preState.windows.keys()][0];
      if (winId != null) {
        params.windowId = winId;
        this.dbg(`    INJ  | windowId=${winId} injected for ${step.tool}`);
      }
    }

    if (this.learningEngine && !params._budget) {
      const bundleId = preState.focusedApp?.bundleId;
      if (bundleId) {
        params._budget = this.learningEngine.getAdaptiveBudget(bundleId);
      }
    }

    // Wire F4: Inject AppMap verified positions as fallback coordinates (L4→L1)
    if (this.appMap && INTERACTION_TOOLS.has(step.tool)) {
      const target = (params.title ?? params.text ?? params.name) as string | undefined;
      const bundleId = preState.focusedApp?.bundleId;
      if (target && bundleId && !params.x && !params.y) {
        if (this.appMap.isElementVerified(bundleId, target)) {
          const winId = preState.focusedWindowId;
          const win = winId != null ? preState.windows.get(winId) : null;
          if (win) {
            const pos = this.appMap.resolvePosition(bundleId, target, win.bounds.value);
            if (pos) {
              params._mapHintX = pos.x;
              params._mapHintY = pos.y;
            }
          }
        }
      }
    }

    // Wire F1: Blend adaptive budget into step timeout (L5→L4)
    let adaptiveTimeout = this.config.defaultStepTimeout;
    const budget = params._budget as { locateMs: number; actMs: number; verifyMs: number } | undefined;
    if (budget) {
      adaptiveTimeout = Math.max(budget.locateMs + budget.actMs + budget.verifyMs, 3000);
    }
    const stepTimeout = Math.max(step.timeout || 0, adaptiveTimeout);
    this.dbg(`    ACT  | calling ${step.tool} (timeout=${stepTimeout}ms)`);
    let result = await this.tryToolWithTimeout(step.tool, params, stepTimeout);
    this.dbg(`    ACT  | ok=${result.ok}${result.ok ? "" : ` error="${result.error}"`}`);

    if (!result.ok && step.fallbackTool) {
      this.dbg(`    ACT  | trying fallback: ${step.fallbackTool}`);
      result = await this.tryToolWithTimeout(step.fallbackTool, params, stepTimeout);
      this.dbg(`    ACT  | fallback ok=${result.ok}${result.ok ? "" : ` error="${result.error}"`}`);
      usedFallback = true;
    }

    if (!result.ok) {
      const durationMs = Date.now() - start;
      this.dbg(`    FAIL | ${step.tool} failed in ${durationMs}ms: ${result.error}`);
      this.recordLearningOutcomes(
        usedFallback ? (step.fallbackTool ?? step.tool) : step.tool,
        params,
        false,
        durationMs,
      );
      return {
        step,
        success: false,
        durationMs,
        postconditionMet: false,
        error: result.error ?? "Tool execution failed",
        usedFallback,
      };
    }

    this.feedWorldModel(usedFallback ? step.fallbackTool! : step.tool, params, result);
    this.recordLearningOutcomes(
      usedFallback ? step.fallbackTool! : step.tool,
      params,
      true,
      Date.now() - start,
    );

    // ── VERIFY: Post-step awareness from world model ──

    // For state-changing tools, wait briefly for perception to update the world model
    if (STATE_CHANGING_TOOLS.has(step.tool)) {
      await sleep(150); // AX refreshes in ~50ms, 150ms gives margin
    }

    const postState = this.worldModel.getConsistentSnapshot();
    const postControls = [...postState.windows.values()].reduce((n, w) => n + w.controls.size, 0);
    this.dbg(`    POST | app=${postState.focusedApp?.bundleId ?? "none"} | win=${postState.focusedWindowId ?? "none"} | controls=${postControls} | dialogs=${postState.activeDialogs.length}`);

    // 1. Check if a dialog appeared after the action
    if (postState.activeDialogs.length > 0 && preState.activeDialogs.length === 0) {
      const dialog = postState.activeDialogs[0]!;
      const err = `Dialog appeared after ${step.tool}: ${dialog.type} "${dialog.title ?? dialog.message ?? "unknown"}" [buttons: ${dialog.buttons.join(", ")}]`;
      this.dbg(`    FAIL | ${err}`);
      return {
        step,
        success: false,
        durationMs: Date.now() - start,
        postconditionMet: false,
        error: err,
        usedFallback,
      };
    }

    // 2. Check if focus was lost (app switched unexpectedly)
    if (preState.focusedApp?.bundleId && postState.focusedApp?.bundleId &&
        preState.focusedApp.bundleId !== postState.focusedApp.bundleId &&
        !FOCUS_TOOLS.has(step.tool)) {
      const err = `Focus lost: was ${preState.focusedApp.bundleId}, now ${postState.focusedApp.bundleId}`;
      this.dbg(`    FAIL | ${err}`);
      return {
        step,
        success: false,
        durationMs: Date.now() - start,
        postconditionMet: false,
        error: err,
        usedFallback,
      };
    }

    // 3. For navigation tools, wait for world model to reflect new page
    const isNavigation = NAVIGATION_TOOLS.has(step.tool) ||
      (step.tool === "key" && isEnterKey(step.params));
    if (isNavigation) {
      const nextTarget = nextStep
        ? (nextStep.params.text ?? nextStep.params.title ?? nextStep.params.name) as string | undefined
        : undefined;
      const maxWait = nextTarget ? 8000 : 3000;
      const pollMs = 200;
      this.dbg(`    NAV  | waiting for ${nextTarget ? `"${nextTarget}"` : "any state change"} (max ${maxWait}ms)`);
      const waited = await this.waitForWorldModelChange(
        preState.focusedWindowId,
        preState,
        maxWait,
        pollMs,
        nextTarget,
      );
      this.dbg(`    NAV  | waited=${waited}`);
      if (!waited && nextTarget) {
        const err = `Navigation failed: "${nextTarget}" not found after ${maxWait}ms. Page may not have loaded or URL was wrong.`;
        this.dbg(`    FAIL | ${err}`);
        return {
          step,
          success: false,
          durationMs: Date.now() - start,
          postconditionMet: false,
          error: err,
          usedFallback,
        };
      }
      if (!waited) {
        step.description = `${step.description} [⚠ no state change detected after ${maxWait}ms]`;
      }
    }

    // 4. Verify postcondition
    let postconditionMet = true;
    let postconditionActual: string | null = null;
    let postconditionSoft = false;

    const assertion = step.expectedPostcondition ?? this.inferPostcondition(step, nextStep);
    if (!step.expectedPostcondition && assertion) {
      postconditionSoft = true;
    }

    if (assertion) {
      this.dbg(`    PC   | checking ${assertion.type}="${assertion.target}" (${postconditionSoft ? "soft" : "hard"})`);
      await sleep(Math.min(this.config.postconditionWaitMs, 500));
      if (this.worldModel.getState().windows.size > 0) {
        const pcResult = this.worldModel.assertStateDetailed(assertion);
        postconditionMet = pcResult.matched;
        postconditionActual = pcResult.actual;
        this.dbg(`    PC   | matched=${postconditionMet} actual="${postconditionActual ?? "nothing"}"`);
      } else {
        this.dbg(`    PC   | skipped — no windows in world model`);
      }
    }

    if (!postconditionMet && postconditionSoft) {
      this.dbg(`    WARN | soft postcondition miss: "${assertion!.target}" not visible (continuing)`);
      step.description = `${step.description} [⚠ soft postcondition: "${assertion!.target}" not yet visible]`;
      return {
        step,
        success: true,
        durationMs: Date.now() - start,
        postconditionMet: false,
        error: null,
        usedFallback,
      };
    }

    const finalDuration = Date.now() - start;
    if (postconditionMet) {
      this.dbg(`    ✓ OK in ${finalDuration}ms`);
    } else {
      this.dbg(`    FAIL | postcondition not met: expected ${assertion?.type}="${assertion?.target}", got "${postconditionActual ?? "nothing"}"`);
    }
    return {
      step,
      success: postconditionMet,
      durationMs: finalDuration,
      postconditionMet,
      error: postconditionMet ? null : `Postcondition not met: expected ${assertion?.type}="${assertion?.target}", got ${postconditionActual ?? "nothing"}`,
      usedFallback,
    };
  }

  /**
   * Wait for the world model to reflect a state change (e.g. after navigation).
   * Polls the world model (0ms reads) — NOT screenshots.
   * Returns true if a change was detected, false if timed out.
   */
  private async waitForWorldModelChange(
    windowId: number | null,
    preState: ReturnType<WorldModel["getState"]>,
    maxWaitMs: number,
    pollMs: number,
    waitForTarget?: string,
  ): Promise<boolean> {
    if (windowId === null) return true;
    const preWin = preState.windows.get(windowId);
    const preTitle = preWin?.title.value ?? "";
    const preControlCount = preWin?.controls.size ?? 0;
    const targetLower = waitForTarget?.toLowerCase();
    const deadline = Date.now() + maxWaitMs;
    let genericChangeDetected = false;

    while (Date.now() < deadline) {
      await sleep(pollMs);
      const current = this.worldModel.getState();
      const curWin = current.windows.get(windowId);
      if (!curWin) continue;

      // If waiting for specific content, check ALL windows (page may load in different window)
      if (targetLower) {
        for (const [, win] of current.windows) {
          const found = [...win.controls.values()].some(
            (c) => c.label.value?.toLowerCase().includes(targetLower),
          );
          if (found) return true; // Target content appeared — page is ready
        }
      }

      // Generic change detection (title, control count, dialogs)
      if (!genericChangeDetected) {
        if (curWin.title.value !== preTitle && curWin.title.value) genericChangeDetected = true;
        const countDelta = Math.abs(curWin.controls.size - preControlCount);
        if (countDelta > 10) genericChangeDetected = true;
        if (current.activeDialogs.length > preState.activeDialogs.length) return true;
      }

      // If no specific target requested, return on generic change
      if (!targetLower && genericChangeDetected) return true;
    }
    // If we detected a generic change but target never appeared, still return true
    return genericChangeDetected;
  }

  /**
   * Auto-infer a soft postcondition from the current and next step.
   * Returns null if no useful postcondition can be inferred.
   *
   * Inference rules:
   * - Navigation → next step's target text should become visible
   * - focus/launch → target app should be focused
   * - click/press on element → if next step targets different text, that text should appear
   */
  private inferPostcondition(step: PlanStep, nextStep?: PlanStep | null): StateAssertion | null {
    // focus/launch → app should be focused
    if (step.tool === "focus" || step.tool === "launch") {
      const bundleId = (step.params.bundleId ?? step.params.appName) as string | undefined;
      if (bundleId) {
        return { type: "app_focused", target: bundleId };
      }
    }

    // Wire #7: L7→L4 — Contract-based postcondition inference.
    // If AppMap has a reliable outcome for this element+action, use it.
    if (this.appMap && INTERACTION_TOOLS.has(step.tool)) {
      const target = (step.params.title ?? step.params.text ?? step.params.name) as string | undefined;
      const bundleId = this.worldModel.getState().focusedApp?.bundleId;
      if (target && bundleId) {
        try {
          // Normalize action key for contract lookup
          const postActionKey = step.tool
            .replace(/_with_fallback$/, "")
            .replace(/^browser_/, "")
            .replace(/^click_text$/, "click")
            .replace(/^ui_press$/, "click")
            .replace(/^ui_set_value$/, "type");
          const contractInfo = this.appMap.getContract(bundleId, target, postActionKey);
          if (contractInfo) {
            const contract = contractInfo.contract;
            // Find the most reliable outcome that can be checked via world model
            const reliableOutcome = contract.outcomes.find((o) => o.reliable && o.seenCount >= 3);
            if (reliableOutcome) {
              const desc = reliableOutcome.description.toLowerCase();
              // Map outcome descriptions to assertions:
              // "dialog closed", "modal dismissed" → dialog_absent
              if (desc.includes("dialog") && (desc.includes("closed") || desc.includes("dismissed"))) {
                return { type: "dialog_absent", target: "" };
              }
              // "X visible", "X appears", "shows X" → text_visible
              const visibleMatch = reliableOutcome.description.match(/["']?(\w[\w\s]*?)["']?\s+(?:visible|appears|shown|displayed)/i);
              if (visibleMatch) {
                return { type: "text_visible", target: visibleMatch[1]!.trim() };
              }
              // Generic: use outcome description as text_visible target
              if (reliableOutcome.description.length >= 3 && reliableOutcome.description.length < 50) {
                this.dbg(`    L7PC | Using contract outcome: "${reliableOutcome.description}"`);
                return { type: "text_visible", target: reliableOutcome.description };
              }
            }
          }
        } catch (e) { process.stderr.write(`[planner] contract outcome inference failed: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    }

    // Navigation or state-changing click → next step's target should be visible
    if (nextStep && STATE_CHANGING_TOOLS.has(step.tool)) {
      const nextTarget = (nextStep.params.text ?? nextStep.params.title ?? nextStep.params.name) as string | undefined;
      if (nextTarget && typeof nextTarget === "string" && nextTarget.length >= 3) {
        // Don't infer if current step targets the same text (redundant)
        const currentTarget = (step.params.text ?? step.params.title ?? step.params.name) as string | undefined;
        if (!currentTarget || currentTarget.toLowerCase() !== nextTarget.toLowerCase()) {
          return { type: "text_visible", target: nextTarget };
        }
      }
    }

    return null;
  }

  /**
   * Feed tool execution results into the world model to keep state fresh
   * between perception cycles. Best-effort — parse failures are silently ignored.
   */
  private feedWorldModel(
    tool: string,
    params: Record<string, unknown>,
    result: { ok: boolean; result?: string },
  ): void {
    if (!result.ok || !result.result) return;

    try {
      if (FOCUS_TOOLS.has(tool)) {
        const bundleId = (params.bundleId as string) ?? (params.appName as string);
        if (bundleId) {
          this.worldModel.updateFocusedApp({
            bundleId,
            appName: (params.appName as string) ?? bundleId,
            pid: 0,
            windowTitle: "",
          });
        }
      } else if (BROWSER_TOOLS.has(tool)) {
        // Extract URL and title from result for CDP snapshot
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(result.result) as Record<string, unknown>; } catch { /* not JSON */ }
        const url = (parsed?.url as string) ?? (params.url as string) ?? "";
        const title = (parsed?.title as string) ?? "";
        const bundleId = this.worldModel.getState().focusedApp?.bundleId;
        if (bundleId && url) {
          this.worldModel.ingestCDPSnapshot(bundleId, url, title);
        }
      } else if (tool === "ocr") {
        // OCR results may contain text regions
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(result.result) as Record<string, unknown>; } catch { /* not JSON */ }
        if (parsed?.regions && Array.isArray(parsed.regions)) {
          const windowId = (params.windowId as number) ??
            this.worldModel.getState().focusedWindowId ?? 0;
          const regions = (parsed.regions as Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>);
          if (regions.length > 0 && windowId) {
            this.worldModel.ingestOCRRegions(windowId, regions);
          }
        }
      }
    } catch {
      // Best-effort: don't let world model feeding break execution
    }
  }

  /**
   * Record tool timing and locator outcomes to the learning engine.
   * Best-effort — errors are silently ignored.
   */
  private recordLearningOutcomes(
    tool: string,
    params: Record<string, unknown>,
    success: boolean,
    durationMs: number,
  ): void {
    if (!this.learningEngine) return;

    try {
      const bundleId = this.worldModel.getState().focusedApp?.bundleId;
      if (!bundleId) return;

      // Record tool timing for adaptive budget learning
      this.learningEngine.recordToolTiming({
        tool,
        bundleId,
        durationMs,
        success,
      });

      // Record locator outcome when a target/selector was used
      const target = (params.target ?? params.selector) as string | undefined;
      if (target && LOCATOR_TOOLS.has(tool)) {
        const method = tool.startsWith("browser_") ? "cdp" as const :
          tool === "ocr" ? "ocr" as const : "ax" as const;
        this.learningEngine.recordLocatorOutcome({
          bundleId,
          actionKey: tool,
          locator: target,
          method,
          success,
        });
      }
    } catch {
      // Best-effort
    }
  }

  private async tryToolWithTimeout(
    tool: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    return Promise.race([
      this.tryTool(tool, params),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: `Step timeout after ${timeoutMs}ms` }),
          timeoutMs,
        ),
      ),
    ]);
  }

  private async tryTool(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.executeTool(tool, params);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private diagnoseFailure(planResult: {
    error: string | null;
    stepResults: StepResult[];
  }, expectedBundleId?: string | null): ReplanReason {
    // Check if the focused app changed (app_switched)
    if (expectedBundleId) {
      const currentBundleId = this.worldModel.getState().focusedApp?.bundleId;
      if (currentBundleId && currentBundleId !== expectedBundleId) {
        return "app_switched";
      }
    }

    const lastFailed = [...planResult.stepResults].reverse().find((r: StepResult) => !r.success);
    if (!lastFailed) return "postcondition_mismatch";

    const error = lastFailed.error ?? "";

    if (error.includes("dialog") || error.includes("Dialog"))
      return "unexpected_dialog";
    if (error.includes("not found") || error.includes("LOCATE_FAILED"))
      return "element_not_found";
    if (error.includes("timeout") || error.includes("TIMEOUT"))
      return "timeout";
    if (error.includes("Postcondition")) return "postcondition_mismatch";

    return "postcondition_mismatch";
  }
}

/**
 * Tool categories for world-model-aware execution.
 */

/** Tools that change which app is focused */
const FOCUS_TOOLS = new Set(["focus", "launch"]);

/** Tools that cause page/state transitions (need settle time) */
const STATE_CHANGING_TOOLS = new Set([
  "focus", "launch", "key", "click", "click_text", "click_with_fallback",
  "ui_press", "browser_click", "browser_navigate", "browser_open",
  "menu_click",
]);

/** Tools that navigate (URL change, page load — need title/control change verification) */
const NAVIGATION_TOOLS = new Set([
  "browser_navigate", "browser_open",
  // Note: key("enter") after typing a URL is also navigation, but we detect
  // that via the step sequence in executePlan, not here.
]);

/** Tools that interact with specific UI elements (need target validation) */
const INTERACTION_TOOLS = new Set([
  "click", "click_text", "click_with_fallback",
  "ui_press", "ui_set_value", "ui_find",
  "browser_click", "browser_type",
  "type_with_fallback", "select_with_fallback",
  "read_with_fallback", "locate_with_fallback",
]);

/** Tools that call CGWindowListCreateImage — crash on GPU-heavy browser windows */
const SCREENSHOT_TOOLS = new Set(["screenshot", "screenshot_file", "ocr"]);

/** Tools that require a windowId param — auto-injected from world model if missing */
const WINDOW_ID_TOOLS = new Set(["click_text", "screenshot_file", "ocr", "observer_ocr_roi"]);

/** Feed world model from tool results */
const BROWSER_TOOLS = new Set(["browser_navigate", "browser_open", "browser_dom", "browser_page_info"]);
const LOCATOR_TOOLS = new Set([
  "click", "click_text", "click_with_fallback",
  "type_text", "type_with_fallback",
  "ui_press", "ui_set_value", "ui_find",
  "browser_click", "browser_type",
  "select_with_fallback", "read_with_fallback", "locate_with_fallback",
]);

/**
 * Find the next step that has a meaningful target (text, title, name).
 * Skips screenshot/ocr steps which have no target params.
 * Used to extract content-based readiness targets for navigation waits.
 */
function findNextMeaningfulStep(steps: PlanStep[], currentIndex: number): PlanStep | null {
  for (let j = currentIndex + 1; j < steps.length; j++) {
    const s = steps[j]!;
    if (SCREENSHOT_TOOLS.has(s.tool)) continue; // skip screenshot/ocr
    return s;
  }
  return null;
}

/** Check if a key step is pressing Enter/Return (likely navigation after URL typing) */
function isEnterKey(params: Record<string, unknown>): boolean {
  const key = ((params.key ?? params.combo ?? "") as string).toLowerCase();
  return key === "enter" || key === "return" || key.endsWith("+enter") || key.endsWith("+return");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
