// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { PatternEntry, PatternOutcome } from "./types.js";

/**
 * PatternPolicy — learns which tool+locator combos work for each app.
 *
 * Persisted to `patterns.jsonl`. Each entry tracks success/fail counts
 * for a specific bundleId×tool×locator triple, scored with Bayesian averaging.
 *
 * Used by the intelligence wrapper to recommend known-good selectors
 * and warn about known-bad ones.
 */
export class PatternPolicy {
  private readonly entries = new Map<string, PatternEntry>();
  private readonly priorStrength: number;

  constructor(priorStrength = 2) {
    this.priorStrength = priorStrength;
  }

  /**
   * Record a pattern outcome (tool+locator success/failure for an app).
   */
  record(outcome: PatternOutcome): void {
    const key = `${outcome.bundleId}::${outcome.tool}::${outcome.locator}`;
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        key,
        bundleId: outcome.bundleId,
        tool: outcome.tool,
        locator: outcome.locator,
        method: outcome.method,
        successCount: 0,
        failCount: 0,
        score: 0.5,
        lastSeen: new Date().toISOString(),
      };
      this.entries.set(key, entry);
    }

    if (outcome.success) {
      entry.successCount++;
    } else {
      entry.failCount++;
    }

    entry.score = this.bayesianScore(entry.successCount, entry.failCount);
    entry.lastSeen = new Date().toISOString();
  }

  /**
   * Query patterns for a given app, optionally filtered by tool.
   * Returns entries sorted by score descending.
   */
  query(bundleId: string, tool?: string): PatternEntry[] {
    const results: PatternEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.bundleId !== bundleId) continue;
      if (tool && entry.tool !== tool) continue;
      results.push(entry);
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Get the best pattern for a given app×tool, or null if insufficient data.
   */
  recommend(bundleId: string, tool: string, minSamples = 3): PatternEntry | null {
    const candidates = this.query(bundleId, tool);
    for (const entry of candidates) {
      if (entry.successCount + entry.failCount >= minSamples && entry.score > 0.5) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Seed a single entry if no real data exists for that key.
   * Used for cold-start bootstrap from AppMap contracts.
   */
  seedEntry(entry: PatternEntry): void {
    if (this.entries.has(entry.key)) return; // already have real data
    this.entries.set(entry.key, { ...entry });
  }

  clear(): void {
    this.entries.clear();
  }

  getAllEntries(): PatternEntry[] {
    return [...this.entries.values()];
  }

  loadEntries(entries: PatternEntry[]): void {
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
