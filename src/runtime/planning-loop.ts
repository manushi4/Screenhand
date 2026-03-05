import type { AppContext, UIEvent } from "../types.js";
import type { StateObserver } from "./state-observer.js";
import type { AppAdapter } from "./app-adapter.js";

export interface StateSnapshot {
  recentEvents: UIEvent[];
  appContext: AppContext | null;
  lastActionResult: unknown;
  observing: boolean;
  timestamp: string;
}

/**
 * Bidirectional planning loop that buffers UI events between LLM actions
 * and provides state snapshots for the LLM to react to.
 */
export class PlanningLoop {
  private lastActionResults = new Map<string, unknown>();

  constructor(
    private readonly observer: StateObserver,
    private readonly adapter: AppAdapter,
  ) {}

  /** Get a state snapshot for the LLM after an action. */
  async getStateSnapshot(sessionId: string): Promise<StateSnapshot> {
    const recentEvents = this.observer.drainEvents();

    let appContext: AppContext | null = null;
    try {
      appContext = await this.adapter.getAppContext(sessionId);
    } catch {
      // May not have an active session
    }

    return {
      recentEvents,
      appContext,
      lastActionResult: this.lastActionResults.get(sessionId) ?? null,
      observing: this.observer.isObserving,
      timestamp: new Date().toISOString(),
    };
  }

  /** Record the result of the last action for a session. */
  recordActionResult(sessionId: string, result: unknown): void {
    this.lastActionResults.set(sessionId, result);
  }

  /** Start observing a process for state changes. */
  async startObserving(sessionId: string, pid: number): Promise<void> {
    await this.observer.startObserving(pid);
  }

  /** Stop observing a process. */
  async stopObserving(sessionId: string, pid: number): Promise<void> {
    await this.observer.stopObserving(pid);
  }

  /** Peek at recent events without draining. */
  peekEvents(limit = 50): UIEvent[] {
    return this.observer.peekEvents(limit);
  }
}
