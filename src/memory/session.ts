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
 * Learning Memory — Session tracking with auto-save
 *
 * Tracks a rolling buffer of actions within a "task session".
 * Auto-saves strategies when a successful sequence is detected:
 * - 3+ consecutive successes followed by a gap (>60s) or session end
 * - Or explicit endSession() call
 */

import type { ActionEntry, Strategy, StrategyStep } from "./types.js";
import { MemoryStore } from "./store.js";
import type { RecallEngine } from "./recall.js";

const SESSION_GAP_MS = 60_000; // 60s gap = new session
const MAX_BUFFER_SIZE = 100;
const MIN_AUTO_SAVE_STEPS = 3; // Need at least 3 successful steps to auto-save

export class SessionTracker {
  private store: MemoryStore;
  private sessionId: string;
  private taskDescription: string | null = null;
  private buffer: ActionEntry[] = [];
  private lastActionTime = 0;

  constructor(store: MemoryStore) {
    this.store = store;
    this.sessionId = SessionTracker.generateId();
  }

  private static generateId(): string {
    return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Start (or restart) a named task session */
  startSession(taskDescription?: string): string {
    // Auto-save previous session if it had successful actions
    this.tryAutoSave();

    this.sessionId = SessionTracker.generateId();
    this.taskDescription = taskDescription ?? null;
    this.buffer = [];
    this.lastActionTime = Date.now();
    return this.sessionId;
  }

  /** Get the current session ID, auto-rotating if stale */
  getSessionId(): string {
    const now = Date.now();
    if (this.lastActionTime > 0 && now - this.lastActionTime > SESSION_GAP_MS) {
      // Session gap detected — auto-save previous sequence then start fresh
      this.tryAutoSave();
      this.sessionId = SessionTracker.generateId();
      this.buffer = [];
      this.taskDescription = null;
    }
    return this.sessionId;
  }

  /** Record an action into the current session buffer */
  recordAction(entry: ActionEntry): void {
    const now = Date.now();
    if (this.lastActionTime > 0 && now - this.lastActionTime > SESSION_GAP_MS) {
      // Gap detected — auto-save then start new session
      this.tryAutoSave();
      this.sessionId = SessionTracker.generateId();
      this.buffer = [];
      this.taskDescription = null;
    }
    this.lastActionTime = now;

    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  /** End the session and save a strategy if successful */
  endSession(success: boolean, taskDescription?: string): Strategy | null {
    const task = taskDescription ?? this.taskDescription;
    if (!success || !task || this.buffer.length === 0) {
      this.buffer = [];
      return null;
    }

    const strategy = this.buildStrategy(task, this.buffer);
    this.store.appendStrategy(strategy);
    this.buffer = [];
    return strategy;
  }

  /** Get the current session's action buffer */
  getBuffer(): ActionEntry[] {
    return [...this.buffer];
  }

  /** Get recent tool names (for strategy hint matching) */
  getRecentToolNames(limit = 10): string[] {
    return this.buffer.slice(-limit).map((a) => a.tool);
  }

  /** Get current task description */
  getTaskDescription(): string | null {
    return this.taskDescription;
  }

  // ── auto-save logic ────────────────────────────

  /**
   * Try to auto-save the current buffer as a strategy.
   * Only saves if there are MIN_AUTO_SAVE_STEPS+ consecutive successes.
   * Uses tool sequence as task description if no explicit one was given.
   */
  private tryAutoSave(): void {
    if (this.buffer.length < MIN_AUTO_SAVE_STEPS) return;

    // Find the longest trailing streak of successes
    let successStreak: ActionEntry[] = [];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.success) {
        successStreak.unshift(this.buffer[i]!);
      } else {
        break;
      }
    }

    if (successStreak.length < MIN_AUTO_SAVE_STEPS) return;

    // Build a task description from the tool sequence if none provided
    const task = this.taskDescription ?? this.inferTaskDescription(successStreak);

    const strategy = this.buildStrategy(task, successStreak);
    this.store.appendStrategy(strategy);
  }

  /** Infer a task description from a sequence of actions */
  private inferTaskDescription(actions: ActionEntry[]): string {
    const tools = [...new Set(actions.map((a) => a.tool))];
    // Extract key param values (bundle IDs, titles, URLs, etc.)
    const keyParams: string[] = [];
    for (const a of actions) {
      for (const [key, val] of Object.entries(a.params)) {
        if (typeof val === "string" && val.length > 2 && val.length < 60) {
          if (["bundleId", "title", "url", "text", "script", "selector", "menuPath"].includes(key)) {
            keyParams.push(val);
          }
        }
      }
    }
    const paramHint = keyParams.length > 0 ? ` (${keyParams.slice(0, 3).join(", ")})` : "";
    return `${tools.join(" → ")}${paramHint}`;
  }

  private buildStrategy(task: string, actions: ActionEntry[]): Strategy {
    const steps: StrategyStep[] = actions.map((a) => ({
      tool: a.tool,
      params: a.params,
    }));

    const totalDurationMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
    const tags = extractTags(task, steps);
    const fingerprint = MemoryStore.makeFingerprint(steps.map((s) => s.tool));

    return {
      id: "str_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      task,
      steps,
      totalDurationMs,
      successCount: 1,
      failCount: 0,
      lastUsed: new Date().toISOString(),
      tags,
      fingerprint,
    };
  }
}

/** Extract tags from task description and tool names */
function extractTags(task: string, steps: StrategyStep[]): string[] {
  const tags = new Set<string>();
  const words = task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  for (const w of words) tags.add(w);
  for (const s of steps) tags.add(s.tool);
  return [...tags];
}
