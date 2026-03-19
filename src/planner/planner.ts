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

  /**
   * Set the tool registry for LLM plan generation.
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
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
    if (playbookPlan) return playbookPlan;

    // 2. Try strategy recall
    const strategyPlan = this.findStrategyPlan(subgoal.description);
    if (strategyPlan) return strategyPlan;

    // 3. Try reference flow
    const flowPlan = this.findFlowPlan(subgoal.description);
    if (flowPlan) return flowPlan;

    // 4. Fallback: LLM-generated plan (or stub if no API key)
    return this.createLLMPlan(subgoal.description);
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

    // On replan, try alternative sources or adjust params
    const currentSource = subgoal.plan?.source;

    // If playbook failed, try strategy
    if (currentSource === "playbook") {
      const strategyPlan = this.findStrategyPlan(subgoal.description);
      if (strategyPlan) return strategyPlan;
    }

    // If strategy failed, try reference flow
    if (currentSource === "playbook" || currentSource === "strategy") {
      const flowPlan = this.findFlowPlan(subgoal.description);
      if (flowPlan) return flowPlan;
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
        return subgoal.plan;
      }
    }

    // Only fall back to LLM when no deterministic plan existed
    return this.createLLMPlan(subgoal.description);
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
