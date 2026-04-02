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

/**
 * PlanRefiner — Self-improving plans.
 *
 * After a successful plan execution, diffs the original plan vs what actually
 * happened (steps skipped, fallbacks used, extra retries). Produces a refined
 * plan stripped of dead steps. After 3 successful refinements of the same goal
 * pattern, graduates the plan to a playbook.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import type { Goal, PlanStep, PlanResult } from "./types.js";
import type { Playbook, PlaybookStep } from "../playbook/types.js";

/** A refined plan stored on disk. */
interface RefinedPlan {
  /** Normalized goal description (lowercase, trimmed). */
  goalKey: string;
  /** Original goal description. */
  goalDescription: string;
  /** The refined step sequence (only completed steps). */
  steps: Array<{ tool: string; params: Record<string, unknown> }>;
  /** How many times this goal has been refined. */
  refinementCount: number;
  /** Average duration across refinements. */
  avgDurationMs: number;
  /** Last refined timestamp. */
  lastRefinedAt: string;
  /** Was this graduated to a playbook? */
  graduated: boolean;
}

const GRADUATION_THRESHOLD = 3;
const MAX_REFINED_PLANS = 200;

export class PlanRefiner {
  private cache = new Map<string, RefinedPlan>();
  private readonly filePath: string;

  constructor(private readonly stateDir: string) {
    this.filePath = path.join(stateDir, "refined-plans.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry.goalKey && typeof entry.goalKey === "string") {
              this.cache.set(entry.goalKey, entry);
            }
          }
        }
      }
    } catch {
      // Corrupted file — start fresh
      this.cache.clear();
    }
  }

  private save(): void {
    try {
      // Evict oldest graduated plans if over limit
      if (this.cache.size > MAX_REFINED_PLANS) {
        const sorted = [...this.cache.entries()]
          .sort((a, b) => new Date(a[1].lastRefinedAt).getTime() - new Date(b[1].lastRefinedAt).getTime());
        while (this.cache.size > MAX_REFINED_PLANS && sorted.length > 0) {
          const oldest = sorted.shift()!;
          this.cache.delete(oldest[0]);
        }
      }
      const data = [...this.cache.values()];
      writeFileAtomicSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      process.stderr.write(`[plan-refiner] Save failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private normalizeGoal(description: string): string {
    return description.toLowerCase().trim().replace(/\s+/g, " ");
  }

  /**
   * Refine a plan after successful execution.
   * Extracts only the steps that actually completed (strips skipped/failed).
   * Returns the refinement count and whether the plan was graduated.
   */
  refine(
    goal: Goal,
    result: PlanResult,
  ): { refinementCount: number; graduated: boolean; playbookId?: string } {
    if (!result.success) return { refinementCount: 0, graduated: false };

    const goalKey = this.normalizeGoal(goal.description);

    // Extract completed steps from all subgoals
    const completedSteps: Array<{ tool: string; params: Record<string, unknown> }> = [];
    for (const sg of goal.subgoals) {
      if (sg.plan) {
        for (const step of sg.plan.steps) {
          if (step.status === "completed") {
            completedSteps.push({ tool: step.tool, params: step.params });
          }
        }
      }
    }

    if (completedSteps.length === 0) return { refinementCount: 0, graduated: false };

    const existing = this.cache.get(goalKey);
    const refinementCount = (existing?.refinementCount ?? 0) + 1;
    const prevAvg = existing?.avgDurationMs ?? result.durationMs;
    const avgDurationMs = Math.round((prevAvg * (refinementCount - 1) + result.durationMs) / refinementCount);

    const refined: RefinedPlan = {
      goalKey,
      goalDescription: goal.description,
      steps: completedSteps,
      refinementCount,
      avgDurationMs,
      lastRefinedAt: new Date().toISOString(),
      graduated: existing?.graduated ?? false,
    };

    this.cache.set(goalKey, refined);
    this.save();

    return { refinementCount, graduated: refined.graduated };
  }

  /**
   * Check if a goal should graduate to a playbook.
   * Returns the playbook if ready, null otherwise.
   */
  checkGraduation(
    goalDescription: string,
    bundleId: string,
    appName: string,
  ): Playbook | null {
    const goalKey = this.normalizeGoal(goalDescription);
    const refined = this.cache.get(goalKey);
    if (!refined) return null;
    if (refined.graduated) return null;
    if (refined.refinementCount < GRADUATION_THRESHOLD) return null;

    // Graduate: create a playbook from the refined steps
    const playbookSteps: PlaybookStep[] = [];
    for (let i = 0; i < refined.steps.length; i++) {
      const s = refined.steps[i]!;
      const mapped = mapToolToPlaybookStep(s.tool, s.params, i);
      if (mapped) playbookSteps.push(mapped);
    }

    const playbook: Playbook = {
      id: `graduated_${goalKey.replace(/[^a-z0-9]/g, "_").slice(0, 40)}_${Date.now().toString(36)}`,
      name: refined.goalDescription,
      description: `Auto-graduated from ${refined.refinementCount} successful plan executions (avg ${refined.avgDurationMs}ms)`,
      platform: appName.toLowerCase(),
      bundleId,
      version: "1.0.0",
      steps: playbookSteps,
      tags: [appName.toLowerCase(), "auto-graduated", "refined"],
      successCount: refined.refinementCount,
      failCount: 0,
      selectors: {},
      errors: [],
    };

    // Mark as graduated
    refined.graduated = true;
    this.save();

    return playbook;
  }

  /** Get all refined plans (for debugging/status). */
  getAll(): RefinedPlan[] {
    return [...this.cache.values()];
  }

  /** Look up a refined plan for a goal. */
  lookup(goalDescription: string): RefinedPlan | null {
    return this.cache.get(this.normalizeGoal(goalDescription)) ?? null;
  }
}

/** Map MCP tool name + params to a PlaybookStep. Returns null if unmappable. */
function mapToolToPlaybookStep(
  tool: string,
  params: Record<string, unknown>,
  index: number,
): PlaybookStep | null {
  const TOOL_TO_ACTION: Record<string, PlaybookStep["action"]> = {
    ui_press: "press",
    click_text: "press",
    click: "press",
    click_with_fallback: "press",
    type_text: "type_into",
    type_with_fallback: "type_into",
    key: "key",
    browser_navigate: "navigate",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_human_click: "browser_human_click",
    browser_js: "browser_js",
    menu_click: "menu_click",
    scroll: "scroll",
    scroll_with_fallback: "scroll",
    screenshot: "screenshot",
    applescript: "applescript",
  };

  const action = TOOL_TO_ACTION[tool];
  if (!action) return null; // focus, launch, etc. are not playbook-able

  const step: PlaybookStep = {
    action,
    description: `Step ${index + 1}: ${tool}`,
  };

  // Map params to playbook step fields
  const target = params.title ?? params.text ?? params.selector ?? params.target;
  if (typeof target === "string") step.target = target;

  if (typeof params.text === "string") step.text = params.text;
  if (typeof params.url === "string") step.url = params.url;
  if (typeof params.combo === "string") step.keys = [params.combo];
  if (typeof params.key === "string") step.keys = [params.key];
  if (Array.isArray(params.menuPath)) step.menuPath = params.menuPath as string[];
  if (typeof params.direction === "string") step.direction = params.direction as "up" | "down";
  if (typeof params.amount === "number") step.amount = params.amount;

  return step;
}
