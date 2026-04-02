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
 * StateWatcher — Continuous observation event bus.
 *
 * Monitors WorldModel at a configurable interval and fires registered
 * handlers when conditions are met. Decouples "what to watch for" from
 * "what to do about it."
 *
 * Pattern: register("if app X shows element Y, run action Z")
 */

import type { WorldModel } from "./world-model.js";
import type { WorldState } from "./types.js";

export type ToolExecutor = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: string; error?: string }>;

/** A registered watch condition + action. */
export interface WatchRule {
  /** Unique ID for this rule (for removal). */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Check function — receives current world state, returns true to trigger. */
  condition: (state: Readonly<WorldState>) => boolean;
  /** Action to execute when condition is met. */
  action: { tool: string; params: Record<string, unknown> };
  /** Max times this rule can fire (0 = unlimited). Default: 1. */
  maxFires: number;
  /** Cooldown between fires in ms. Default: 10000. */
  cooldownMs: number;
  /** Optional: only match when this bundleId is focused. */
  bundleId?: string;
}

interface RuleState {
  rule: WatchRule;
  fireCount: number;
  lastFiredAt: number;
}

export class StateWatcher {
  private readonly rules = new Map<string, RuleState>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;

  constructor(
    private readonly worldModel: WorldModel,
    private readonly execute: ToolExecutor,
    pollMs = 2_000,
  ) {
    this.pollMs = pollMs;
  }

  private static readonly MAX_RULES = 50;

  /**
   * Register a watch rule. Returns the rule ID for later removal.
   */
  register(rule: WatchRule): string {
    if (this.rules.size >= StateWatcher.MAX_RULES && !this.rules.has(rule.id)) {
      throw new Error(`Maximum watch rules (${StateWatcher.MAX_RULES}) reached. Remove existing rules first.`);
    }
    this.rules.set(rule.id, {
      rule,
      fireCount: 0,
      lastFiredAt: 0,
    });
    return rule.id;
  }

  /** Register a convenience rule: fire action when a control with matching title appears. */
  watchForElement(
    id: string,
    elementTitle: string,
    action: { tool: string; params: Record<string, unknown> },
    bundleId?: string,
  ): string {
    const titleLower = elementTitle.toLowerCase();
    return this.register({
      id,
      description: `Watch for element "${elementTitle}"`,
      condition: (state) => {
        for (const win of state.windows.values()) {
          for (const ctrl of win.controls.values()) {
            if (ctrl.label?.value?.toLowerCase().includes(titleLower)) {
              return true;
            }
          }
        }
        return false;
      },
      action,
      maxFires: 1,
      cooldownMs: 10_000,
      ...(bundleId ? { bundleId } : {}),
    });
  }

  /** Register: fire action when a dialog appears with matching text. */
  watchForDialog(
    id: string,
    titlePattern: RegExp,
    action: { tool: string; params: Record<string, unknown> },
  ): string {
    return this.register({
      id,
      description: `Watch for dialog matching ${titlePattern}`,
      condition: (state) =>
        state.activeDialogs.some((d) => titlePattern.test(d.title ?? "")),
      action,
      maxFires: 0, // unlimited — dialogs can recur
      cooldownMs: 5_000,
    });
  }

  /** Remove a watch rule by ID. */
  unregister(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Remove all rules. */
  clear(): void {
    this.rules.clear();
  }

  /** Get all registered rules. */
  getRules(): Array<{ id: string; description: string; fireCount: number }> {
    return [...this.rules.values()].map((rs) => ({
      id: rs.rule.id,
      description: rs.rule.description,
      fireCount: rs.fireCount,
    }));
  }

  /** Start the polling loop. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  get isRunning(): boolean {
    return this.interval !== null;
  }

  private async tick(): Promise<void> {
    const state = this.worldModel.getState();
    const now = Date.now();
    const focusedBundleId = state.focusedApp?.bundleId;

    for (const [id, rs] of this.rules) {
      // Max fires check
      if (rs.rule.maxFires > 0 && rs.fireCount >= rs.rule.maxFires) continue;
      // Cooldown check
      if (now - rs.lastFiredAt < rs.rule.cooldownMs) continue;
      // BundleId filter
      if (rs.rule.bundleId && rs.rule.bundleId !== focusedBundleId) continue;

      try {
        if (rs.rule.condition(state)) {
          rs.fireCount++;
          rs.lastFiredAt = now;
          process.stderr.write(`[state-watcher] Rule "${id}" fired (${rs.fireCount}x): ${rs.rule.description}\n`);

          // Fire and forget — don't block the poll loop
          this.execute(rs.rule.action.tool, rs.rule.action.params).catch((err) => {
            process.stderr.write(`[state-watcher] Rule "${id}" action failed: ${err instanceof Error ? err.message : String(err)}\n`);
          });

          // Remove exhausted rules
          if (rs.rule.maxFires > 0 && rs.fireCount >= rs.rule.maxFires) {
            this.rules.delete(id);
          }
        }
      } catch (err) {
        process.stderr.write(`[state-watcher] Rule "${id}" condition threw: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
