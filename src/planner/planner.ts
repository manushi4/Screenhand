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

import crypto from "node:crypto";
import type { PlaybookStore } from "../playbook/store.js";
import type { MemoryService } from "../memory/service.js";
import type { ContextTracker } from "../context-tracker.js";
import type { WorldModel } from "../state/world-model.js";
import type { LearningEngine } from "../learning/engine.js";
import type { AppMap } from "../state/app-map.js";
import type { NavEdge, StateDimension, StateTransition } from "../state/app-map-types.js";
import type { BlockerType } from "../recovery/types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type {
  Goal,
  Subgoal,
  ActionPlan,
  PlanStep,
  PlannerConfig,
  ReplanReason,
} from "./types.js";
import { DEFAULT_PLANNER_CONFIG } from "./types.js";
import { playbookToPlan, strategyToPlan, flowToPlan, type FlowRuntimeContext } from "./deterministic.js";

function uid(): string {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Decompose a goal description into subgoal parts.
 * Splits on: numbered steps ("1. ... 2. ..."), "and then", "then",
 * ", and " (Oxford comma), or semicolons.
 * Returns the original description as a single-element array if no split applies.
 */
function decomposeGoal(description: string): string[] {
  // 1. Try numbered steps: "1. do X 2. do Y" or "1) do X 2) do Y"
  const numberedPattern = /(?:^|\s)(\d+)[.)]\s+/g;
  const numberedMatches = [...description.matchAll(numberedPattern)];
  if (numberedMatches.length >= 2) {
    const parts: string[] = [];
    for (let i = 0; i < numberedMatches.length; i++) {
      const start = numberedMatches[i]!.index! + numberedMatches[i]![0].indexOf(numberedMatches[i]![1]!);
      const stepStart = start + numberedMatches[i]![0].trimStart().length;
      const end = i + 1 < numberedMatches.length
        ? numberedMatches[i + 1]!.index!
        : description.length;
      const text = description.slice(stepStart, end).trim();
      if (text) parts.push(text);
    }
    if (parts.length >= 2) return parts;
  }

  // 2. Try semicolons
  const semiParts = description.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  if (semiParts.length >= 2) return semiParts;

  // 3. Try "and then" or ", then"
  const thenParts = description.split(/\s+and\s+then\s+|,\s*then\s+/i).map((s) => s.trim()).filter((s) => s.length > 0);
  if (thenParts.length >= 2) return thenParts;

  // 4. Try ", and " (Oxford comma pattern — implies list of actions)
  const andParts = description.split(/,\s+and\s+/i).map((s) => s.trim()).filter((s) => s.length > 0);
  if (andParts.length >= 2) return andParts;

  // 5. No decomposition
  return [description];
}

/**
 * Planner — goal-oriented planning with deterministic fast-path.
 *
 * Priority:
 * 1. Playbook match → deterministic plan (0 LLM calls)
 * 2. Strategy recall → plan from memory (0 LLM calls)
 * 3. Reference flow → semi-deterministic (LLM interprets steps)
 * 4. LLM generation → full plan from scratch
 */
export class Planner {
  private readonly config: PlannerConfig;

  constructor(
    private readonly playbookStore: PlaybookStore,
    private readonly memory: MemoryService,
    private readonly contextTracker: ContextTracker,
    private readonly worldModel: WorldModel,
    configOrLearning?: Partial<PlannerConfig> | LearningEngine,
    learningOrConfig?: LearningEngine | Partial<PlannerConfig>,
  ) {
    // Support both (config, learning) and (learning, config) orderings
    let config: Partial<PlannerConfig> | undefined;
    let learning: LearningEngine | undefined;
    for (const arg of [configOrLearning, learningOrConfig]) {
      if (!arg) continue;
      if (typeof (arg as LearningEngine).recommendLocator === "function") {
        learning = arg as LearningEngine;
      } else {
        config = arg as Partial<PlannerConfig>;
      }
    }
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
    this.learningEngine = learning ?? null;
  }

  private readonly learningEngine: LearningEngine | null;
  private toolRegistry: ToolRegistry | null = null;
  private appMap: AppMap | null = null;

  /**
   * Set the tool registry for LLM plan generation.
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /**
   * Set the AppMap for navigation-aware planning and state-aware enrichment.
   */
  setAppMap(map: AppMap): void {
    this.appMap = map;
  }

  /**
   * Create a Goal from a description.
   * Decomposes complex goals into multiple subgoals when the description
   * contains "and then", "then", ", and", numbered steps, or semicolons.
   */
  createGoal(description: string): Goal {
    const parts = decomposeGoal(description);
    const subgoals: Subgoal[] = parts.map((part) => ({
      id: `sg_${uid()}`,
      description: part,
      status: "pending" as const,
      plan: null,
      attempts: 0,
      maxAttempts: this.config.defaultMaxAttempts,
      lastError: null,
    }));

    const goal: Goal = {
      id: `goal_${uid()}`,
      description,
      status: "pending",
      subgoals,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    return goal;
  }

  /**
   * Plan a subgoal: find the best ActionPlan from available sources.
   *
   * Priority: playbook > strategy > reference flow > LLM
   */
  async planSubgoal(subgoal: Subgoal): Promise<ActionPlan> {
    // 1. Try playbook match
    const playbookPlan = this.findPlaybookPlan(subgoal.description);
    if (playbookPlan) return this.annotateAndReturn(this.enrichWithStateContext(playbookPlan));

    // 2. Try strategy recall
    const strategyPlan = this.findStrategyPlan(subgoal.description);
    if (strategyPlan) return this.annotateAndReturn(this.enrichWithStateContext(strategyPlan));

    // 3. Try AppMap BFS navigation (Wire #6: L7→L4)
    // State enrichment is already done inside findNavigationPlan
    const navPlan = this.findNavigationPlan(subgoal.description);
    if (navPlan) return this.annotateAndReturn(navPlan);

    // 4. Try reference flow
    const flowPlan = this.findFlowPlan(subgoal.description);
    if (flowPlan) return this.annotateAndReturn(this.enrichWithStateContext(flowPlan));

    // 5. Fallback: LLM-generated plan (or stub if no API key)
    return this.annotateAndReturn(await this.createLLMPlan(subgoal.description));
  }

  /**
   * Wire #8: L7→L4 — Enrich any plan with state machine context.
   * Prepends state-fix steps if needed (e.g. expand sidebar before clicking sidebar items).
   */
  private enrichWithStateContext(plan: ActionPlan): ActionPlan {
    if (!this.appMap) return plan;
    const bundleId = this.getBundleId();
    if (!bundleId) return plan;

    const enrichedSteps = this.enrichStepsWithStateContext(plan.steps, bundleId);
    if (enrichedSteps === plan.steps) return plan;

    return {
      ...plan,
      steps: enrichedSteps,
    };
  }

  /**
   * Wire #13: L5→L4 — Annotate plan steps with known failure pattern warnings,
   * then return the plan. Called as the final step of planSubgoal().
   */
  private annotateAndReturn(plan: ActionPlan): ActionPlan {
    if (!this.learningEngine || typeof this.learningEngine.queryPatterns !== "function") return plan;
    const bundleId = this.getBundleId();
    if (!bundleId) return plan;

    for (const step of plan.steps) {
      const patterns = this.learningEngine.queryPatterns(bundleId, step.tool);
      // Find patterns with strong evidence of failure
      for (const pat of patterns) {
        if (pat.score < 0.4 && pat.failCount >= 3) {
          const target = step.params.target ?? step.params.selector ?? step.params.text ?? step.params.title ?? step.params.name ?? step.params.label ?? step.params.placeholder ?? "";
          // Only warn if target matches the failing pattern — skip if step has no locator-like param
          if (target && pat.locator === target) {
            // Sanitize locator text: strip newlines/control chars, cap length to prevent prompt injection
            const sanitizeLoc = (s: string) => s.replace(/[\n\r\t\x00-\x1f]/g, " ").slice(0, 100);
            step._patternWarning = `⚠ ${step.tool}: "${sanitizeLoc(pat.locator)}" fails ${pat.failCount}x (score ${pat.score.toFixed(2)})`;
            // Suggest best alternative if available
            const best = patterns.find((p) => p.score > 0.6 && p.locator !== pat.locator);
            if (best) {
              step._patternWarning += ` — try "${sanitizeLoc(best.locator)}" instead (score ${best.score.toFixed(2)})`;
            }
            break; // One warning per step is enough
          }
        }
      }
    }

    return plan;
  }

  /**
   * Plan all subgoals in a goal.
   */
  async planGoal(goal: Goal): Promise<void> {
    goal.status = "active";
    for (const sg of goal.subgoals) {
      if (sg.status === "completed" || sg.status === "skipped") continue;
      // Don't re-plan subgoals that already have a plan (e.g. from plan_goal)
      if (!sg.plan) {
        sg.plan = await this.planSubgoal(sg);
      }
      sg.status = "pending";
    }
  }

  /**
   * Replan a subgoal after failure.
   * Increments attempt count, resets plan, tries alternative sources.
   */
  async replan(subgoal: Subgoal, reason: ReplanReason, errorMsg?: string): Promise<ActionPlan | null> {
    subgoal.attempts++;
    subgoal.lastError = errorMsg ?? reason;

    if (subgoal.attempts >= subgoal.maxAttempts) {
      subgoal.status = "failed";
      return null;
    }

    subgoal.status = "pending";

    // Wire F2: Ask LearningEngine which recovery strategy works best (L5→L4)
    if (this.learningEngine && subgoal.plan) {
      const bundleId = this.getBundleId();
      if (bundleId) {
        const blockerMap: Record<string, BlockerType> = {
          unexpected_dialog: "unexpected_dialog",
          element_not_found: "element_gone",
          timeout: "loading_stuck",
        };
        const blockerType = blockerMap[reason];
        if (blockerType) {
          const ranked = this.learningEngine.rankRecoveryStrategies(blockerType, bundleId);
          if (ranked.length > 0 && ranked[0]!.score > 0.6) {
            const strategy = ranked[0]!;
            const recoveryStep = this.strategyToStep(strategy.strategyId, bundleId);
            if (recoveryStep) {
              subgoal.plan.steps.unshift(recoveryStep);
              subgoal.plan.currentStepIndex = 0;
            }
          }
        }
      }
    }

    // On replan, try alternative sources or adjust params
    const currentSource = subgoal.plan?.source;

    // If playbook failed, try strategy
    if (currentSource === "playbook") {
      const strategyPlan = this.findStrategyPlan(subgoal.description);
      if (strategyPlan) return this.annotateAndReturn(this.enrichWithStateContext(strategyPlan));
    }

    // If strategy failed, try reference flow
    if (currentSource === "playbook" || currentSource === "strategy") {
      const flowPlan = this.findFlowPlan(subgoal.description);
      if (flowPlan) return this.annotateAndReturn(this.enrichWithStateContext(flowPlan));
    }

    // Don't downgrade deterministic plans to LLM stubs.
    // A 9-step reference_flow failing on step 1 (bridge crash) shouldn't
    // be replaced with a 1-step "ask the human" stub. Better to retry
    // the original plan or fail cleanly.
    if (currentSource === "playbook" || currentSource === "strategy" || currentSource === "reference_flow") {
      // Reset the current plan to retry from the failed step
      if (subgoal.plan) {
        subgoal.plan.currentStepIndex = 0;
        // Reset step statuses so they can be re-executed
        for (const step of subgoal.plan.steps) {
          if (step.status === "failed") step.status = "pending";
        }
        return this.annotateAndReturn(subgoal.plan);
      }
    }

    // Only fall back to LLM when no deterministic plan existed
    return this.annotateAndReturn(await this.createLLMPlan(subgoal.description));
  }

  /**
   * Check if a goal is complete (all subgoals done or failed).
   */
  evaluateGoal(goal: Goal): void {
    const allDone = goal.subgoals.every(
      (sg) =>
        sg.status === "completed" ||
        sg.status === "failed" ||
        sg.status === "skipped",
    );

    if (!allDone) return;

    const anyFailed = goal.subgoals.some((sg) => sg.status === "failed");
    goal.status = anyFailed ? "failed" : "completed";
    goal.completedAt = new Date().toISOString();
  }

  /**
   * Serialize a goal to JSON (for persistence/transport).
   */
  static serializeGoal(goal: Goal): string {
    return JSON.stringify(goal);
  }

  /**
   * Deserialize a goal from JSON.
   */
  static deserializeGoal(json: string): Goal {
    const obj = JSON.parse(json) as Goal;
    if (!obj.id || !Array.isArray(obj.subgoals)) {
      throw new Error("Invalid Goal JSON: missing id or subgoals");
    }
    return obj;
  }

  // ── Private plan finding ──

  private getBundleId(): string {
    return this.worldModel.getState().focusedApp?.bundleId ?? "";
  }

  /**
   * Wire F2: Map a recovery strategy ID to a concrete plan step.
   */
  private strategyToStep(strategyId: string, _bundleId: string): PlanStep | null {
    const stepBase: Omit<PlanStep, "tool" | "params" | "description"> = {
      expectedPostcondition: null,
      timeout: 5000,
      fallbackTool: null,
      requiresLLM: false,
      status: "pending",
    };

    if (strategyId === "dismiss_dialog" || strategyId.startsWith("undo_")) {
      return { ...stepBase, tool: "key", params: { key: "Escape" }, description: `Recovery: ${strategyId}` };
    }
    if (strategyId === "refocus") {
      return { ...stepBase, tool: "focus", params: {}, description: "Recovery: refocus app" };
    }
    if (strategyId === "restart_app") {
      return { ...stepBase, tool: "launch", params: {}, timeout: 10000, description: "Recovery: restart app" };
    }
    return null;
  }

  /**
   * Wire #6: L7→L4 — BFS navigation plan from AppMap.
   *
   * Extracts navigation intent from the goal description (e.g. "navigate to Settings",
   * "go from Edit to Deliver", "open the Color page") and uses AppMap's BFS pathfinding
   * to generate a concrete plan without LLM.
   */
  private findNavigationPlan(description: string): ActionPlan | null {
    if (!this.appMap) return null;
    const bundleId = this.getBundleId();
    if (!bundleId) return null;

    const nav = this.parseNavigationIntent(description);
    if (!nav) return null;

    const path = this.appMap.findPath(bundleId, nav.from, nav.to);
    if (!path || path.length === 0) return null;

    // Convert NavEdge[] → PlanStep[]
    const steps = this.navEdgesToSteps(path, bundleId);
    if (steps.length === 0) return null;

    // Wire #8: Enrich with state context (prepend state-fix steps if needed)
    const enrichedSteps = this.enrichStepsWithStateContext(steps, bundleId);

    return {
      steps: enrichedSteps,
      currentStepIndex: 0,
      confidence: this.computeNavConfidence(path),
      source: "learned",
      sourceId: `bfs:${nav.from}→${nav.to}`,
    };
  }

  /**
   * Parse navigation intent from a goal description.
   * Patterns:
   *   "navigate to Settings" → from = current page, to = "Settings"
   *   "go from Edit to Deliver" → from = "Edit", to = "Deliver"
   *   "open the Color page" → from = current page, to = "Color"
   *   "switch to the Deliver tab" → from = current page, to = "Deliver"
   */
  private parseNavigationIntent(description: string): { from: string; to: string } | null {
    const desc = description.trim();

    // Pattern 1: "from X to Y" / "from X page to Y page"
    const fromToMatch = desc.match(
      /\bfrom\s+(?:the\s+)?["']?(\w[\w\s]*?)["']?\s+(?:page\s+|tab\s+)?to\s+(?:the\s+)?["']?(\w[\w\s]*?)["']?(?:\s+(?:page|tab|panel|view))?\s*$/i,
    );
    if (fromToMatch) {
      return { from: fromToMatch[1]!.trim(), to: fromToMatch[2]!.trim() };
    }

    // Pattern 2: "navigate/go/switch to X" / "open the X page/tab"
    const toMatch = desc.match(
      /\b(?:navigate|go|switch|move)\s+to\s+(?:the\s+)?["']?(\w[\w\s]*?)["']?(?:\s+(?:page|tab|panel|view))?\s*$/i,
    );
    if (toMatch) {
      const to = toMatch[1]!.trim();
      const from = this.getCurrentNavNode();
      return from ? { from, to } : null;
    }

    // Pattern 3: "open the X page/tab/panel"
    const openMatch = desc.match(
      /\bopen\s+(?:the\s+)?["']?(\w[\w\s]*?)["']?\s+(?:page|tab|panel|view)\s*$/i,
    );
    if (openMatch) {
      const to = openMatch[1]!.trim();
      const from = this.getCurrentNavNode();
      return from ? { from, to } : null;
    }

    return null;
  }

  /**
   * Get the current navigation node from world model state.
   * Matches the window title against known AppMap nav nodes to find the current page.
   * Falls back to null if no match found (BFS cannot start without a valid from-node).
   */
  private getCurrentNavNode(): string | null {
    if (!this.appMap) return null;
    const bundleId = this.getBundleId();
    if (!bundleId) return null;

    const state = this.worldModel.getState();
    if (!state.focusedWindowId) return null;
    const win = state.windows.get(state.focusedWindowId);
    if (!win?.title?.value) return null;

    const titleLower = win.title.value.toLowerCase();

    // Load the AppMap to access navigation graph node names
    const mapData = this.appMap.load(bundleId);
    if (!mapData) return null;

    const nodeKeys = Object.keys(mapData.navigationGraph.nodes);
    if (nodeKeys.length === 0) return null;

    // Try exact match first, then substring match against window title
    // Window titles are typically "AppName — PageName" or "PageName - AppName"
    for (const nodeKey of nodeKeys) {
      if (nodeKey.toLowerCase() === titleLower) return nodeKey;
    }
    for (const nodeKey of nodeKeys) {
      if (nodeKey.length >= 3 && titleLower.includes(nodeKey.toLowerCase())) return nodeKey;
    }

    return null;
  }

  /**
   * Convert a BFS path (NavEdge[]) into executable PlanStep[].
   * Parses the edge.action string to extract tool + params.
   */
  private navEdgesToSteps(path: NavEdge[], bundleId: string): PlanStep[] {
    const ctx = this.getRuntimeContext();
    const steps: PlanStep[] = [];

    for (const edge of path) {
      const step = this.parseEdgeAction(edge, bundleId, ctx);
      if (step) {
        steps.push(step);
      } else {
        // Can't parse this edge action — create an LLM-required step
        steps.push({
          tool: "",
          params: {},
          expectedPostcondition: { type: "text_visible", target: edge.to },
          timeout: this.config.defaultStepTimeout,
          fallbackTool: null,
          requiresLLM: true,
          status: "pending",
          description: `${edge.action} (navigate from ${edge.from} to ${edge.to})`,
        });
      }
    }

    return steps;
  }

  /**
   * Parse an edge action string into a PlanStep.
   * Edge actions are recorded as "click Submit", "navigate /settings",
   * "key cmd+,", "menu_click File > Preferences", etc.
   */
  private parseEdgeAction(
    edge: NavEdge,
    _bundleId: string,
    ctx: FlowRuntimeContext,
  ): PlanStep | null {
    const action = edge.action.trim();

    // "click X" or "click_text X"
    const clickMatch = action.match(/^(?:click_text|click)\s+(.+)$/i);
    if (clickMatch) {
      const target = clickMatch[1]!.replace(/^["']|["']$/g, "");
      return {
        tool: "click_text",
        params: { text: target, ...(ctx.windowId != null ? { windowId: ctx.windowId } : {}) },
        expectedPostcondition: { type: "text_visible", target: edge.to },
        timeout: this.config.defaultStepTimeout,
        fallbackTool: "click_with_fallback",
        requiresLLM: false,
        status: "pending",
        description: `Click "${target}" to navigate to ${edge.to}`,
      };
    }

    // "ui_press X" or "press X"
    const pressMatch = action.match(/^(?:ui_press|press)\s+(.+)$/i);
    if (pressMatch) {
      const target = pressMatch[1]!.replace(/^["']|["']$/g, "");
      return {
        tool: "ui_press",
        params: { title: target, ...(ctx.pid != null ? { pid: ctx.pid } : {}) },
        expectedPostcondition: { type: "text_visible", target: edge.to },
        timeout: this.config.defaultStepTimeout,
        fallbackTool: "click_text",
        requiresLLM: false,
        status: "pending",
        description: `Press "${target}" to navigate to ${edge.to}`,
      };
    }

    // "key cmd+," or "key Return"
    const keyMatch = action.match(/^key\s+(.+)$/i);
    if (keyMatch) {
      return {
        tool: "key",
        params: { key: keyMatch[1]!.trim() },
        expectedPostcondition: { type: "text_visible", target: edge.to },
        timeout: this.config.defaultStepTimeout,
        fallbackTool: null,
        requiresLLM: false,
        status: "pending",
        description: `Press ${keyMatch[1]!.trim()} to navigate to ${edge.to}`,
      };
    }

    // "navigate URL" or "browser_navigate URL"
    const navMatch = action.match(/^(?:navigate|browser_navigate)\s+(.+)$/i);
    if (navMatch) {
      return {
        tool: "browser_navigate",
        params: { url: navMatch[1]!.trim() },
        expectedPostcondition: { type: "text_visible", target: edge.to },
        timeout: this.config.defaultStepTimeout,
        fallbackTool: null,
        requiresLLM: false,
        status: "pending",
        description: `Navigate to ${navMatch[1]!.trim()}`,
      };
    }

    // "menu_click File > Preferences"
    const menuMatch = action.match(/^menu_click\s+(.+)$/i);
    if (menuMatch) {
      const menuPath = menuMatch[1]!.trim();
      const parts = menuPath.split(/\s*>\s*/);
      return {
        tool: "menu_click",
        params: {
          menu: parts[0]!,
          ...(parts.length > 1 ? { item: parts.slice(1).join(" > ") } : {}),
        },
        expectedPostcondition: { type: "text_visible", target: edge.to },
        timeout: this.config.defaultStepTimeout,
        fallbackTool: null,
        requiresLLM: false,
        status: "pending",
        description: `Menu: ${menuPath} to navigate to ${edge.to}`,
      };
    }

    return null;
  }

  /**
   * Compute plan confidence from BFS path edges.
   * Higher when all edges are verified with good success rates.
   */
  private computeNavConfidence(path: NavEdge[]): number {
    if (path.length === 0) return 0.5;

    let totalScore = 0;
    for (const edge of path) {
      const total = edge.successCount + edge.failCount;
      if (total === 0) {
        // Use L5 Bayesian score if available, otherwise default
        totalScore += edge.topologyScore ?? 0.3;
      } else {
        const rate = edge.successCount / total;
        const baseScore = edge.verified ? Math.max(0.5, rate) : rate * 0.8;
        // Blend raw rate with L5 TopologyPolicy score when available
        totalScore += edge.topologyScore != null
          ? (baseScore + edge.topologyScore) / 2
          : baseScore;
      }
    }
    return Math.min(0.95, totalScore / path.length);
  }

  /**
   * Wire #8: L7→L4 — Enrich plan steps with state machine context.
   *
   * Checks AppMap state dimensions. If a step's target element is only visible
   * in a specific state (e.g. sidebar must be expanded), and the current state
   * is wrong, prepends state-change steps using known transitions.
   */
  private enrichStepsWithStateContext(steps: PlanStep[], bundleId: string): PlanStep[] {
    if (!this.appMap) return steps;

    const currentState = this.appMap.getCurrentState(bundleId);
    if (Object.keys(currentState).length === 0) return steps;

    const visConditions = this.appMap.getConditionalElements(bundleId);
    if (visConditions.length === 0) return steps;

    const prependSteps: PlanStep[] = [];
    const handledDimensions = new Set<string>();

    for (const step of steps) {
      const target = (step.params.text ?? step.params.title ?? step.params.name) as string | undefined;
      if (!target) continue;

      // Check if this target has visibility conditions tied to state
      const targetLower = target.toLowerCase();
      for (const vc of visConditions) {
        if (vc.conditionType !== "state") continue;
        // Require minimum label length to avoid false positives ("Add" matching everything)
        if (vc.elementLabel.length < 4) continue;
        if (!vc.elementLabel.toLowerCase().includes(targetLower) &&
            !targetLower.includes(vc.elementLabel.toLowerCase())) continue;

        // This element is state-conditional. Check if we need to change state.
        // Look for state dimensions that might affect visibility
        const dimensions = this.appMap.getStateDimensions(bundleId);
        for (const dim of dimensions) {
          if (handledDimensions.has(dim.key)) continue;

          // Get transitions that might reveal this element
          const transitions = this.appMap.getStateTransitions(bundleId, dim.key);
          // Only fire when transition is unambiguous (single toggle) or leads
          // to a clearly "revealing" state (open/show/visible/expanded)
          const REVEAL_PATTERNS = /\b(open|show|visible|expanded|enabled|on|active)\b/i;
          for (const t of transitions) {
            if (t.fromValue === currentState[dim.key] && t.toValue !== currentState[dim.key]) {
              // Filter: only use this transition if it's unambiguous or leads to a reveal state
              if (transitions.length > 2 && !REVEAL_PATTERNS.test(t.toValue)) continue;
              const fixStep = this.parseTransitionTrigger(t, bundleId);
              if (fixStep) {
                prependSteps.push(fixStep);
                handledDimensions.add(dim.key);
                break; // one fix step per dimension
              }
            }
          }
        }
      }
    }

    // Wire F3: Zone spatial scroll prepend (L7→L4)
    // If a target element lives in a zone near the bottom of the window, prepend a scroll step.
    if (!handledDimensions.has("__scroll__")) {
      for (const step of steps) {
        const target = (step.params.text ?? step.params.title ?? step.params.name) as string | undefined;
        if (!target) continue;
        const zone = this.findElementZone(bundleId, target);
        if (!zone) continue;
        const pos = zone.relativePosition;
        if (pos.top > 0.85) {
          prependSteps.push({
            tool: "scroll", params: { direction: "down", amount: 300 },
            expectedPostcondition: null, timeout: 3000, fallbackTool: null,
            requiresLLM: false, status: "pending",
            description: "Scroll down to reveal off-screen element",
          });
          handledDimensions.add("__scroll__");
          break;
        } else if (pos.top < 0.05 && pos.height < 0.1) {
          prependSteps.push({
            tool: "scroll", params: { direction: "up", amount: 300 },
            expectedPostcondition: null, timeout: 3000, fallbackTool: null,
            requiresLLM: false, status: "pending",
            description: "Scroll up to reveal off-screen element",
          });
          handledDimensions.add("__scroll__");
          break;
        }
      }
    }

    return prependSteps.length > 0 ? [...prependSteps, ...steps] : steps;
  }

  /**
   * Wire F3: Find the zone containing a target element in AppMap.
   */
  private findElementZone(bundleId: string, label: string): { relativePosition: { top: number; left: number; width: number; height: number } } | null {
    if (!this.appMap) return null;
    const data = (this.appMap as AppMap).load(bundleId);
    if (!data) return null;
    const labelLower = label.toLowerCase();
    for (const zone of Object.values(data.zones)) {
      for (const el of zone.elements) {
        if (el.label.toLowerCase() === labelLower) {
          return zone;
        }
      }
    }
    return null;
  }

  /**
   * Parse a state transition trigger into a PlanStep.
   */
  private parseTransitionTrigger(transition: StateTransition, _bundleId: string): PlanStep | null {
    const trigger = transition.trigger.trim();
    if (!trigger) return null;

    // Try parsing as "click X", "key X", "press X", etc. — reuse edge action parsing
    const ctx = this.getRuntimeContext();
    const fakeEdge: NavEdge = {
      from: transition.fromValue,
      action: trigger,
      to: transition.toValue,
      verified: transition.observedCount >= 2,
      successCount: transition.observedCount,
      failCount: 0,
      lastUsed: transition.lastSeen,
    };

    const step = this.parseEdgeAction(fakeEdge, _bundleId, ctx);
    if (step) {
      step.description = `[L7→L4 state fix] ${trigger} (${transition.dimensionKey}: ${transition.fromValue} → ${transition.toValue})`;
      step.expectedPostcondition = null; // state change is the postcondition itself
    }
    return step;
  }

  private findPlaybookPlan(description: string): ActionPlan | null {
    // Try task-based match only — don't unconditionally use the active playbook
    // here, because that would shadow findFlowPlan() which also uses the active
    // playbook's flows. The active playbook's steps are only a good match if
    // matchByTask explicitly selects it.
    const playbook = this.playbookStore.matchByTask(description, this.getBundleId());
    if (playbook && playbook.steps.length > 0) {
      return playbookToPlan(playbook, this.config, this.learningEngine, this.getBundleId());
    }

    return null;
  }

  private findStrategyPlan(description: string): ActionPlan | null {
    const strategies = this.memory.recallStrategies(description, 3, this.getBundleId());
    if (strategies.length === 0) return null;

    // Prefer strategies whose task description mentions the current app
    const currentApp = this.worldModel?.getState()?.focusedApp?.appName?.toLowerCase() ?? "";
    const currentBundle = this.worldModel?.getState()?.focusedApp?.bundleId?.toLowerCase() ?? "";

    let best = strategies[0]!;
    for (const s of strategies) {
      const taskLower = s.task.toLowerCase();
      if (currentApp && taskLower.includes(currentApp)) { best = s; break; }
      if (currentBundle && taskLower.includes(currentBundle)) { best = s; break; }
    }

    if (best.score < 0.6) return null;

    // Reject strategies that only contain trivial steps (focus/screenshot/apps/windows)
    // — these are artifacts from testing, not useful automation plans
    const TRIVIAL_TOOLS = new Set(["focus", "screenshot", "apps", "windows", "screenshot_file"]);
    const hasSubstantiveStep = best.steps.some((s) => !TRIVIAL_TOOLS.has(s.tool));
    if (!hasSubstantiveStep) return null;

    return strategyToPlan(best, this.config, this.learningEngine, this.getBundleId());
  }

  private findFlowPlan(description: string): ActionPlan | null {
    // Collect all playbooks that have flows: active playbook first, then ALL loaded playbooks
    const active = this.contextTracker.getActivePlaybook();
    const allPlaybooks = this.playbookStore.getAll();

    // Find best matching flow across ALL playbooks with flows
    // Filter out common automation verbs/nouns that match almost any flow
    const FLOW_STOPWORDS = new Set([
      "open", "close", "click", "set", "get", "the", "and", "for", "from",
      "into", "with", "then", "this", "that", "use", "run", "start", "stop",
      "new", "add", "app", "settings", "window", "button", "text", "page",
      "file", "menu", "tab", "navigate", "type", "select", "find", "wait",
      "send", "save", "copy", "paste", "delete", "create", "edit", "view",
      "show", "hide", "move", "drag", "drop", "enter", "press", "about",
      "input", "form", "link", "image", "video", "upload", "download",
    ]);
    const tokens = description.toLowerCase().split(/\W+/).filter((w) => w.length >= 3 && !FLOW_STOPWORDS.has(w));
    // If all tokens are stopwords, there's nothing meaningful to match against flows
    if (tokens.length === 0) return null;
    let bestFlow: { name: string; flow: import("../playbook/types.js").PlaybookFlow } | null = null;
    let bestScore = 0;

    // Platform-aware scoring: detect current app for flow preference
    const state = this.worldModel.getState();
    const focusedBundle = state.focusedApp?.bundleId?.toLowerCase() ?? "";
    const focusedApp = state.focusedApp?.appName?.toLowerCase() ?? "";
    // Map known apps to flow name prefixes they should prefer
    const isSafari = focusedBundle.includes("safari") || focusedApp === "safari";
    const isChrome = focusedBundle.includes("chrome") || focusedApp === "chrome";
    const isBrowser = isSafari || isChrome;

    // Search active playbook first (gets priority via +2 bonus)
    const candidates = active?.flows ? [{ pb: active, bonus: 2 }] : [];
    for (const pb of allPlaybooks) {
      if (pb.flows && pb !== active) {
        candidates.push({ pb, bonus: 0 });
      }
    }

    for (const { pb, bonus } of candidates) {
      if (!pb.flows) continue;
      for (const [name, flow] of Object.entries(pb.flows)) {
        if (!Array.isArray(flow?.steps)) continue;
        const flowNameLower = name.toLowerCase();
        const flowTokens = flowNameLower.split(/[_\-\s]+/);
        const allTokens = [
          ...flowTokens,
          ...flow.steps.join(" ").toLowerCase().split(/\W+/),
        ];
        let score = bonus;
        for (const t of tokens) {
          if (allTokens.some((ft) => ft.includes(t))) score++;
        }

        // Platform-aware boost: prefer flows that match the focused app
        if (isSafari && flowNameLower.includes("safari")) score += 3;
        if (isChrome && flowNameLower.includes("browser")) score += 3;
        // Penalize browser/CDP flows when in Safari (no CDP available)
        if (isSafari && flowNameLower.includes("browser")) score -= 2;
        // Penalize safari-specific flows when in Chrome (use CDP instead)
        if (isChrome && flowNameLower.includes("safari")) score -= 2;
        // Penalize desktop_automation generic flows when a specific flow exists
        if (flowNameLower === "desktop_automation" && bestScore > 0) score -= 1;

        if (score > bestScore) {
          bestScore = score;
          bestFlow = { name, flow };
        }
      }
    }

    if (!bestFlow || bestScore <= 0) return null;

    // Require at least 40% of meaningful goal tokens to match flow tokens,
    // with a minimum absolute score of 2, to avoid spurious matches from
    // common verbs hitting unrelated flows.
    // Subtract the active-playbook bonus before comparing — the bonus is a
    // tiebreaker, not evidence that the goal text matches the flow.
    const activeBonus = (active?.flows && bestFlow && active.flows[bestFlow.name]) ? 2 : 0;
    const contentScore = bestScore - activeBonus;
    const minScore = Math.max(2, Math.ceil(tokens.length * 0.4));
    if (contentScore < minScore) return null;

    return flowToPlan(bestFlow.name, bestFlow.flow, this.config, this.getRuntimeContext());
  }

  private getRuntimeContext(): FlowRuntimeContext {
    const state = this.worldModel.getState();
    return {
      pid: state.focusedApp?.pid,
      windowId: state.focusedWindowId ?? undefined,
      bundleId: state.focusedApp?.bundleId,
    };
  }

  private createLLMPlanStub(description: string): ActionPlan {
    const step: PlanStep = {
      tool: "",
      params: {},
      expectedPostcondition: null,
      timeout: this.config.defaultStepTimeout,
      fallbackTool: null,
      requiresLLM: true,
      status: "pending",
      description,
    };

    return {
      steps: [step],
      currentStepIndex: 0,
      confidence: 0.3,
      source: "llm",
      sourceId: null,
    };
  }

  /**
   * Build a runtime context summary for the LLM prompt.
   * Includes focused app, window, and visible controls.
   */
  private buildRuntimeContextPrompt(): string {
    const state = this.worldModel.getState();
    const lines: string[] = [];

    if (state.focusedApp) {
      lines.push(`Focused app: ${state.focusedApp.appName} (${state.focusedApp.bundleId}), PID: ${state.focusedApp.pid}`);
    }
    if (state.focusedWindowId !== null) {
      lines.push(`Window ID: ${state.focusedWindowId}`);
    }

    // Include visible controls from world model (top 20)
    if (state.focusedWindowId !== null) {
      const win = state.windows.get(state.focusedWindowId);
      if (win && win.controls.size > 0) {
        const controls = [...win.controls.values()]
          .slice(0, 20)
          .map((c) => `${c.role}:${c.label.value ?? ""}`)
          .filter((s) => s.length > 1);
        if (controls.length > 0) {
          lines.push(`Visible controls: ${controls.join(", ")}`);
        }
      }
    }

    // Include active reference context if available
    const active = this.contextTracker.getActivePlaybook();
    if (active) {
      lines.push(`Platform reference loaded: ${active.platform ?? active.id}`);
    }

    // Wire #8: Include AppMap state dimensions for state-aware LLM planning
    if (this.appMap) {
      const bundleId = this.getBundleId();
      if (bundleId) {
        const currentState = this.appMap.getCurrentState(bundleId);
        const stateEntries = Object.entries(currentState);
        if (stateEntries.length > 0) {
          const stateStr = stateEntries.map(([k, v]) => `${k}=${v}`).join(", ");
          lines.push(`App state: ${stateStr}`);
        }
      }
    }

    return lines.length > 0 ? `\nRuntime context:\n${lines.join("\n")}` : "";
  }

  private async createLLMPlan(description: string): Promise<ActionPlan> {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey || !this.toolRegistry) {
      return this.createLLMPlanStub(description);
    }

    try {
      const toolNames = this.toolRegistry.getToolNames();
      const runtimeCtx = this.buildRuntimeContextPrompt();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const prompt = [
        "You are a desktop automation planner. Generate concrete tool steps with real parameter values.",
        runtimeCtx,
        "",
        "Key tool signatures:",
        "- screenshot() → captures current screen",
        "- click_text(windowId: number, text: string, prefer?: 'first'|'largest'|'topmost'|'leftmost') → OCR-click",
        "- ui_press(pid: number, title: string, role?: string) → AX button press",
        "- type_text(text: string) → keyboard typing",
        "- key(key: string) → keyboard shortcut (e.g. 'cmd+a', 'Return')",
        "- browser_navigate(url: string) → navigate browser",
        "- browser_click(selector: string) → click element in browser",
        "- browser_type(selector: string, text: string) → type in browser input",
        "- focus(appName: string) → focus app window",
        "- launch(bundleId: string) → launch app",
        "",
        `All available tools: ${toolNames.join(", ")}`,
        "",
        `Goal: ${description}`,
        "",
        'Return ONLY a JSON array of objects: [{"tool": "...", "params": {...}, "description": "..."}]',
        "Use concrete values from the runtime context above (pid, windowId, etc).",
        "No markdown, no explanation.",
      ].join("\n");

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return this.createLLMPlanStub(description);
      }

      const data = await response.json() as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = data.content?.[0]?.text?.trim();
      if (!text) return this.createLLMPlanStub(description);

      // Extract JSON array from response (may be wrapped in markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return this.createLLMPlanStub(description);

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        tool: string;
        params?: Record<string, unknown>;
        description?: string;
      }>;

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return this.createLLMPlanStub(description);
      }

      const steps: PlanStep[] = parsed.map((s) => ({
        tool: s.tool ?? "",
        params: s.params ?? {},
        expectedPostcondition: null,
        timeout: this.config.defaultStepTimeout,
        fallbackTool: null,
        requiresLLM: !s.tool,
        status: "pending" as const,
        description: s.description ?? s.tool ?? description,
      }));

      return {
        steps,
        currentStepIndex: 0,
        confidence: 0.5,
        source: "llm",
        sourceId: null,
      };
    } catch {
      return this.createLLMPlanStub(description);
    }
  }
}
