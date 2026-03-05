/**
 * Learning Memory — Session tracking
 *
 * Tracks a rolling buffer of actions within a "task session".
 * When a task succeeds, extracts the winning sequence as a Strategy.
 */

import type { ActionEntry, Strategy, StrategyStep } from "./types.js";
import { MemoryStore } from "./store.js";

const SESSION_GAP_MS = 60_000; // 60s gap = new session
const MAX_BUFFER_SIZE = 100;

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
      this.sessionId = SessionTracker.generateId();
      this.buffer = [];
      this.taskDescription = null;
    }
    return this.sessionId;
  }

  /** Record an action into the current session buffer */
  recordAction(entry: ActionEntry): void {
    // Auto-detect new session on gap
    const now = Date.now();
    if (this.lastActionTime > 0 && now - this.lastActionTime > SESSION_GAP_MS) {
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

    const steps: StrategyStep[] = this.buffer.map((a) => ({
      tool: a.tool,
      params: a.params,
    }));

    const totalDurationMs = this.buffer.reduce((sum, a) => sum + a.durationMs, 0);

    const tags = extractTags(task, steps);

    const strategy: Strategy = {
      id: "str_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      task,
      steps,
      totalDurationMs,
      successCount: 1,
      lastUsed: new Date().toISOString(),
      tags,
    };

    this.store.appendStrategy(strategy);
    this.buffer = [];
    return strategy;
  }

  /** Get the current session's action buffer */
  getBuffer(): ActionEntry[] {
    return [...this.buffer];
  }

  /** Get current task description */
  getTaskDescription(): string | null {
    return this.taskDescription;
  }
}

/** Extract tags from task description and tool names */
function extractTags(task: string, steps: StrategyStep[]): string[] {
  const tags = new Set<string>();

  // Extract meaningful words from task (3+ chars, lowercase)
  const words = task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  for (const w of words) tags.add(w);

  // Add unique tool names
  for (const s of steps) tags.add(s.tool);

  return [...tags];
}
