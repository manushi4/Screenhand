// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { TopologyEntry, TopologyOutcome } from "./types.js";

/**
 * TopologyPolicy — learns which navigation edges are reliable per app.
 *
 * Persisted to `topology.jsonl`. Each entry tracks success/fail counts
 * for a specific bundleId×fromNode×action×toNode quad, scored with
 * Bayesian averaging.
 *
 * Used alongside the AppMap to determine which navigation paths
 * through an application are verified and reliable.
 */
export class TopologyPolicy {
  private readonly entries = new Map<string, TopologyEntry>();
  private readonly priorStrength: number;

  constructor(priorStrength = 2) {
    this.priorStrength = priorStrength;
  }

  /**
   * Record a navigation edge outcome (success/failure for an app).
   */
  record(outcome: TopologyOutcome): void {
    const key = `${outcome.bundleId}::${outcome.fromNode}::${outcome.action}::${outcome.toNode}`;
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        key,
        bundleId: outcome.bundleId,
        fromNode: outcome.fromNode,
        action: outcome.action,
        toNode: outcome.toNode,
        successCount: 0,
        failCount: 0,
        score: 0.5,
        lastUsed: new Date().toISOString(),
      };
      this.entries.set(key, entry);
    }

    if (outcome.success) {
      entry.successCount++;
    } else {
      entry.failCount++;
    }

    entry.score = this.bayesianScore(entry.successCount, entry.failCount);
    entry.lastUsed = new Date().toISOString();
  }

  /**
   * Query all navigation edges for a given app, sorted by score descending.
   * Optionally filter by source node.
   */
  query(bundleId: string, fromNode?: string): TopologyEntry[] {
    const results: TopologyEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.bundleId !== bundleId) continue;
      if (fromNode && entry.fromNode !== fromNode) continue;
      results.push(entry);
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Get the best navigation edge from a given node, or null if insufficient data.
   */
  recommend(bundleId: string, fromNode: string, minSamples = 3): TopologyEntry | null {
    const candidates = this.query(bundleId, fromNode);
    for (const entry of candidates) {
      if (entry.successCount + entry.failCount >= minSamples && entry.score > 0.5) {
        return entry;
      }
    }
    return null;
  }

  clear(): void {
    this.entries.clear();
  }

  getAllEntries(): TopologyEntry[] {
    return [...this.entries.values()];
  }

  loadEntries(entries: TopologyEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.key, { ...entry });
    }
  }

  private bayesianScore(successes: number, failures: number): number {
    return (
      (successes + this.priorStrength) /
      (successes + failures + 2 * this.priorStrength)
    );
  }
}
