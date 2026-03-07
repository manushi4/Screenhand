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
