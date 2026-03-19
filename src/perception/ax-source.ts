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

import type { StateObserver } from "../runtime/state-observer.js";
import type { BridgeClient } from "../native/bridge-client.js";
import type { AXNode, AppContext } from "../types.js";
import type { PerceptionEvent } from "./types.js";

/**
 * Result metadata from an AX tree poll, used for adaptive polling decisions.
 */
export interface AXPollResult {
  event: PerceptionEvent | null;
  latencyMs: number;
  nodeCount: number;
}

/**
 * AX perception source — wraps StateObserver for push events
 * and provides periodic AX tree polling for structured snapshots.
 */
export class AXSource {
  /** Rolling average of recent poll latencies for adaptive backoff */
  private recentLatencies: number[] = [];
  private static readonly LATENCY_WINDOW = 5;

  constructor(
    private readonly observer: StateObserver,
    private readonly bridge: BridgeClient,
  ) {}

  /**
   * FAST rate: drain buffered AX events from StateObserver.
   * Returns a PerceptionEvent if there are events, null otherwise.
   */
  drainEvents(): PerceptionEvent | null {
    const events = this.observer.drainEvents();
    if (events.length === 0) return null;

    return {
      source: "ax_events",
      rate: "fast",
      timestamp: new Date().toISOString(),
      data: {
        type: "ax_events",
        events,
      },
    };
  }

  /** Known browser bundle IDs — use lower AX tree depth to avoid blowing up on heavy web DOMs */
  private static readonly BROWSER_BUNDLE_IDS = new Set([
    "com.apple.Safari",
    "com.google.Chrome",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "com.operasoftware.Opera",
    "company.thebrowser.Browser", // Arc
  ]);

  /**
   * MEDIUM rate: poll the full AX tree for the active window.
   * More expensive but gives a complete structural snapshot.
   * Uses lower depth for browsers to prevent crash on heavy web apps (Canva, Figma).
   */
  /**
   * Get the adaptive max depth based on recent poll performance.
   * If recent polls are slow or returning huge trees, reduce depth automatically.
   */
  getAdaptiveMaxDepth(bundleId: string): number {
    const isBrowser = AXSource.BROWSER_BUNDLE_IDS.has(bundleId);
    const baseDepth = isBrowser ? 5 : 10;

    if (this.recentLatencies.length < 2) return baseDepth;

    const avgLatency = this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length;

    // If average latency > 3s, reduce depth aggressively
    if (avgLatency > 3000) return Math.max(2, baseDepth - 3);
    // If average latency > 1.5s, reduce depth by 1
    if (avgLatency > 1500) return Math.max(3, baseDepth - 1);

    return baseDepth;
  }

  /**
   * Check if AX polling should be skipped this cycle due to recent instability.
   * Returns true if the last few polls were extremely slow (>5s average).
   */
  shouldSkipPoll(): boolean {
    if (this.recentLatencies.length < 3) return false;
    const avgLatency = this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length;
    return avgLatency > 5000;
  }

  /**
   * Get average recent poll latency (ms). Returns 0 if no data.
   */
  getAverageLatency(): number {
    if (this.recentLatencies.length === 0) return 0;
    return this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length;
  }

  async pollAXTree(
    pid: number,
    windowId: number,
    appContext: AppContext,
    maxDepth?: number,
  ): Promise<AXPollResult> {
    // Use adaptive depth if not explicitly provided
    if (maxDepth === undefined) {
      maxDepth = this.getAdaptiveMaxDepth(appContext.bundleId);
    }

    const start = Date.now();
    try {
      const tree = await this.bridge.call<AXNode & { _nodeCount?: number }>("ax.getElementTree", {
        pid,
        maxDepth,
        windowId: windowId > 0 ? windowId : undefined,
      });
      const latencyMs = Date.now() - start;
      const nodeCount = (tree as any)?._nodeCount ?? 0;

      // Track latency for adaptive backoff
      this.recentLatencies.push(latencyMs);
      if (this.recentLatencies.length > AXSource.LATENCY_WINDOW) {
        this.recentLatencies.shift();
      }

      if (!tree) return { event: null, latencyMs, nodeCount: 0 };

      return {
        event: {
          source: "ax_tree",
          rate: "medium",
          timestamp: new Date().toISOString(),
          data: {
            type: "ax_tree",
            windowId,
            tree,
            appContext,
          },
        },
        latencyMs,
        nodeCount,
      };
    } catch {
      const latencyMs = Date.now() - start;
      // Track failures as high-latency for backoff purposes
      this.recentLatencies.push(latencyMs > 1000 ? latencyMs : 5000);
      if (this.recentLatencies.length > AXSource.LATENCY_WINDOW) {
        this.recentLatencies.shift();
      }
      return { event: null, latencyMs, nodeCount: 0 };
    }
  }

  /**
   * Start observing a process for AX events.
   */
  async startObserving(pid: number): Promise<void> {
    await this.observer.startObserving(pid);
  }

  /**
   * Stop observing a process.
   */
  async stopObserving(pid: number): Promise<void> {
    await this.observer.stopObserving(pid);
  }

  get isObserving(): boolean {
    return this.observer.isObserving;
  }
}
