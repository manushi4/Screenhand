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

import fs from "node:fs";
import path from "node:path";
import type { WorldModel } from "../state/world-model.js";
import type { ToolExecutor } from "../planner/executor.js";
import type { MemoryService } from "../memory/service.js";
import type {
  Blocker,
  RecoveryBudget,
  RecoveryOutcome,
  RecoveryStrategy,
  RecoveryEvent,
} from "./types.js";
import { detectBlockers } from "./detectors.js";
import {
  getBuiltinStrategies,
  parseReferenceStrategies,
  buildStrategyWithContext,
} from "./strategies.js";
import type { LearningEngine } from "../learning/engine.js";

interface ReferenceError {
  error: string;
  context?: string;
  solution: string;
  severity?: string;
}

interface ReferenceFile {
  bundleId?: string;
  errors?: ReferenceError[];
}

export interface RecoveryEngineConfig {
  referencesDir: string;
}

const DEFAULT_CONFIG: RecoveryEngineConfig = {
  referencesDir: path.join(process.cwd(), "references"),
};

/**
 * RecoveryEngine — detects blockers from the world model, selects and executes
 * recovery strategies, and verifies success. Sits between PlanExecutor step
 * failure and planner.replan().
 */
/** Cooldown entry: tracks when a strategy last failed for a given blocker type */
interface CooldownEntry {
  failedAt: number;
}

const STRATEGY_COOLDOWN_MS = 30_000; // 30 seconds

export class RecoveryEngine {
  private readonly config: RecoveryEngineConfig;
  private readonly referenceCache = new Map<string, ReferenceError[]>();
  /** Map of "blockerType:strategyId" → cooldown entry */
  private readonly strategyCooldowns = new Map<string, CooldownEntry>();

  private learningEngine: LearningEngine | null = null;

  constructor(
    private readonly worldModel: WorldModel,
    private readonly executeTool: ToolExecutor,
    private readonly memory: MemoryService,
    config?: Partial<RecoveryEngineConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Inject the learning engine for recording recovery outcomes.
   * Called after both engines are constructed (avoids circular dependency).
   */
  setLearningEngine(engine: LearningEngine): void {
    this.learningEngine = engine;
  }

  /**
   * Get the current status of the recovery engine.
   */
  getStatus(): {
    cooldownCount: number;
    referenceCacheSize: number;
    learningEngineConnected: boolean;
  } {
    return {
      cooldownCount: this.strategyCooldowns.size,
      referenceCacheSize: this.referenceCache.size,
      learningEngineConnected: this.learningEngine !== null,
    };
  }

  /**
   * Update the default recovery budget configuration.
   */
  configure(partial: Partial<RecoveryEngineConfig>): void {
    Object.assign(this.config, partial);
  }

  /**
   * Attempt to recover from a step failure.
   * Called by PlanExecutor after a step fails, before replanning.
   */
  async attemptRecovery(
    failedStepError: string,
    expectedBundleId: string | null,
    budget: RecoveryBudget,
  ): Promise<RecoveryOutcome> {
    const budgetStart = Date.now();

    // Detect blockers
    const blockers = detectBlockers(this.worldModel, failedStepError, expectedBundleId);

    // Try strategies for each blocker in priority order
    for (const blocker of blockers) {
      if (Date.now() - budgetStart >= budget.maxRecoveryTimeMs) {
        return { recovered: false, reason: "budget_exhausted" };
      }

      const strategies = this.selectStrategies(blocker, budget);

      for (const strategy of strategies) {
        if (Date.now() - budgetStart >= budget.maxRecoveryTimeMs) {
          return { recovered: false, reason: "budget_exhausted" };
        }
        if (budget.usedStrategyIds.size >= budget.maxStrategies) {
          return { recovered: false, reason: "budget_exhausted" };
        }

        budget.usedStrategyIds.add(strategy.id);
        const outcome = await this.executeStrategy(strategy, blocker, budgetStart, budget);
        if (outcome.recovered) return outcome;
      }
    }

    return { recovered: false, reason: "all_strategies_failed" };
  }

  /**
   * Select strategies for a blocker: reference-based first, then built-in.
   * Excludes already-used strategies.
   */
  private selectStrategies(
    blocker: Blocker,
    budget: RecoveryBudget,
  ): RecoveryStrategy[] {
    const candidates: RecoveryStrategy[] = [];

    // Reference strategies first (app-specific)
    if (blocker.bundleId) {
      const refErrors = this.loadReferenceErrors(blocker.bundleId);
      candidates.push(...parseReferenceStrategies(refErrors, blocker.type));
    }

    // Then built-in
    candidates.push(...getBuiltinStrategies(blocker.type));

    const now = Date.now();
    const available = candidates.filter((s) => {
      if (budget.usedStrategyIds.has(s.id)) return false;
      // Check cooldown — skip strategies that failed recently for this blocker type
      const cooldownKey = `${blocker.type}:${s.id}`;
      const entry = this.strategyCooldowns.get(cooldownKey);
      if (entry && now - entry.failedAt < STRATEGY_COOLDOWN_MS) return false;
      return true;
    });

    // Re-order by learning engine ranking if available
    if (this.learningEngine && blocker.bundleId) {
      const ranked = this.learningEngine.rankRecoveryStrategies(blocker.type, blocker.bundleId);
      if (ranked.length > 0) {
        const rankMap = new Map(ranked.map((r, i) => [r.strategyId, i]));
        available.sort((a, b) => {
          const ra = rankMap.get(a.id) ?? 999;
          const rb = rankMap.get(b.id) ?? 999;
          return ra - rb;
        });
      }
    }

    return available;
  }

  /**
   * Execute a strategy's steps and verify recovery.
   */
  private async executeStrategy(
    rawStrategy: RecoveryStrategy,
    blocker: Blocker,
    budgetStart: number,
    budget: RecoveryBudget,
  ): Promise<RecoveryOutcome> {
    const start = Date.now();
    const strategy = buildStrategyWithContext(rawStrategy, blocker.bundleId, blocker.pid);

    // Escalation strategies (empty steps) — cannot auto-recover
    if (strategy.steps.length === 0) {
      this.recordEvent({
        timestamp: new Date().toISOString(),
        blocker,
        strategyId: strategy.id,
        strategyLabel: strategy.label,
        success: false,
        durationMs: 0,
        error: "escalation_required",
      });
      return { recovered: false, reason: "all_strategies_failed" };
    }

    // Execute each step
    for (const step of strategy.steps) {
      if (Date.now() - budgetStart >= budget.maxRecoveryTimeMs) {
        return { recovered: false, reason: "budget_exhausted" };
      }

      try {
        const result = await this.executeTool(step.tool, step.params);
        if (!result.ok) {
          this.recordEvent({
            timestamp: new Date().toISOString(),
            blocker,
            strategyId: strategy.id,
            strategyLabel: strategy.label,
            success: false,
            durationMs: Date.now() - start,
            error: result.error ?? "tool failed",
          });
          this.strategyCooldowns.set(`${blocker.type}:${strategy.id}`, { failedAt: Date.now() });
          return { recovered: false, reason: "all_strategies_failed" };
        }
      } catch (err) {
        this.recordEvent({
          timestamp: new Date().toISOString(),
          blocker,
          strategyId: strategy.id,
          strategyLabel: strategy.label,
          success: false,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        this.strategyCooldowns.set(`${blocker.type}:${strategy.id}`, { failedAt: Date.now() });
        return { recovered: false, reason: "all_strategies_failed" };
      }
    }

    // Verify recovery
    await sleep(300);
    const verified = this.verifyRecovery(blocker);
    const durationMs = Date.now() - start;

    this.recordEvent({
      timestamp: new Date().toISOString(),
      blocker,
      strategyId: strategy.id,
      strategyLabel: strategy.label,
      success: verified,
      durationMs,
      error: verified ? null : "verification failed",
    });

    // Feed learning engine with recovery outcome
    if (this.learningEngine && blocker.bundleId) {
      this.learningEngine.recordRecoveryOutcome({
        bundleId: blocker.bundleId,
        blockerType: blocker.type,
        strategyId: strategy.id,
        success: verified,
        durationMs,
      });
    }

    if (verified) {
      // Clear cooldown on success
      this.strategyCooldowns.delete(`${blocker.type}:${strategy.id}`);
      return { recovered: true, strategyId: strategy.id, durationMs };
    }

    // Record cooldown for failed strategy
    this.strategyCooldowns.set(`${blocker.type}:${strategy.id}`, { failedAt: Date.now() });

    return { recovered: false, reason: "all_strategies_failed" };
  }

  /**
   * Verify the blocker is resolved by re-checking world model state.
   */
  private verifyRecovery(blocker: Blocker): boolean {
    switch (blocker.type) {
      case "unexpected_dialog":
      case "permission_dialog":
      case "login_required":
      case "captcha": {
        const dialogs = this.worldModel.getActiveDialogs();
        if (blocker.dialogTitle) {
          return !dialogs.some((d) => d.title === blocker.dialogTitle);
        }
        return dialogs.length === 0;
      }
      case "focus_lost": {
        if (!blocker.bundleId) return false;
        return this.worldModel.getState().focusedApp?.bundleId === blocker.bundleId;
      }
      case "app_crashed": {
        return this.worldModel.getState().windows.size > 0;
      }
      case "element_gone": {
        // The element should be back — verify focused window has controls
        const win = this.worldModel.getFocusedWindow();
        if (!win) return false;
        return win.controls.size > 0;
      }
      case "selector_drift": {
        // After recovery, controls should be findable — verify the focused window
        // has recently updated controls (not all stale)
        const win = this.worldModel.getFocusedWindow();
        if (!win) return false;
        if (win.controls.size === 0) return false;
        const stale = this.worldModel.getStaleControls(5_000);
        return stale.length < win.controls.size;
      }
      case "unknown_state": {
        // State should be less stale after recovery — check stale count is low
        const state = this.worldModel.getState();
        if (state.windows.size === 0) return false;
        const stale = this.worldModel.getStaleControls(5_000);
        let totalControls = 0;
        for (const w of state.windows.values()) {
          totalControls += w.controls.size;
        }
        // Pass if fewer than half of controls are stale
        return totalControls > 0 && stale.length < totalControls / 2;
      }
      case "loading_stuck": {
        // UI should have changed — verify state was updated recently (within 2s)
        const state = this.worldModel.getState();
        const ageMs = Date.now() - new Date(state.updatedAt).getTime();
        return ageMs < 2_000;
      }
      case "network_error":
      case "rate_limited": {
        // Transient errors — verify state was refreshed recently (within 3s)
        const state = this.worldModel.getState();
        const ageMs = Date.now() - new Date(state.updatedAt).getTime();
        return ageMs < 3_000;
      }
    }
  }

  /**
   * Load and cache reference errors for a bundleId.
   */
  private loadReferenceErrors(bundleId: string): ReferenceError[] {
    const cached = this.referenceCache.get(bundleId);
    if (cached !== undefined) return cached;

    let errors: ReferenceError[] = [];
    try {
      const files = fs.readdirSync(this.config.referencesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          // Guard against oversized files (same 10MB limit as LearningEngine)
          const filePath = path.join(this.config.referencesDir, file);
          const stat = fs.statSync(filePath);
          if (stat.size > 10 * 1024 * 1024) continue;
          const raw = fs.readFileSync(filePath, "utf-8");
          const ref = JSON.parse(raw) as ReferenceFile;
          if (ref.bundleId === bundleId && Array.isArray(ref.errors)) {
            errors = ref.errors.filter(
              (e): e is ReferenceError =>
                typeof e.error === "string" && typeof e.solution === "string",
            );
            break;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* dir doesn't exist */ }

    this.referenceCache.set(bundleId, errors);
    return errors;
  }

  private recordEvent(event: RecoveryEvent): void {
    try {
      this.memory.recordError(
        `recovery:${event.strategyId}`,
        event.error ?? "",
        event.success ? event.strategyLabel : null,
        event.blocker.bundleId ?? undefined,
      );
    } catch { /* best-effort */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
