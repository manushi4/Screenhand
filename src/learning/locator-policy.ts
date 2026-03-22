// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocatorEntry, LocatorOutcome } from "./types.js";

/**
 * LocatorPolicy — tracks per-app×action locator reliability.
 *
 * After enough data points, recommends the highest-scoring locator
 * for a given action in a given app. Uses Bayesian scoring so
 * a locator with 3/3 successes doesn't beat one with 50/55.
 */
export class LocatorPolicy {
  /** Map<compoundKey, LocatorEntry[]> — multiple locators per key */
  private readonly entries = new Map<string, LocatorEntry[]>();
  private readonly priorStrength: number;

  constructor(priorStrength = 2) {
    this.priorStrength = priorStrength;
  }

  /**
   * Record a locator outcome and update the score.
   */
  static makeKey(bundleId: string, actionKey: string): string {
    return `${bundleId.length}:${bundleId}\0${actionKey}`;
  }

  record(outcome: LocatorOutcome): void {
    const compoundKey = LocatorPolicy.makeKey(outcome.bundleId, outcome.actionKey);
    let list = this.entries.get(compoundKey);
    if (!list) {
      list = [];
      this.entries.set(compoundKey, list);
    }

    let entry = list.find(
      (e) => e.locator === outcome.locator && e.method === outcome.method,
    );

    if (!entry) {
      entry = {
        key: compoundKey,
        locator: outcome.locator,
        method: outcome.method,
        successCount: 0,
        failCount: 0,
        score: 0.5,
        lastUsed: new Date().toISOString(),
      };
      list.push(entry);
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
   * Get the best locator for a given app×action.
   * Returns null if no data or insufficient samples.
   */
  recommend(
    bundleId: string,
    actionKey: string,
    minSamples = 5,
  ): LocatorEntry | null {
    const compoundKey = LocatorPolicy.makeKey(bundleId, actionKey);
    const list = this.entries.get(compoundKey);
    if (!list || list.length === 0) return null;

    const qualified = list.filter(
      (e) => e.successCount + e.failCount >= minSamples,
    );
    if (qualified.length === 0) return null;

    qualified.sort((a, b) => b.score - a.score);
    return qualified[0]!;
  }

  /**
   * Get all entries for a given app×action (for inspection/debugging).
   */
  getEntries(bundleId: string, actionKey: string): LocatorEntry[] {
    const compoundKey = LocatorPolicy.makeKey(bundleId, actionKey);
    return this.entries.get(compoundKey) ?? [];
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get all entries across all keys (for persistence).
   */
  getAllEntries(): LocatorEntry[] {
    const result: LocatorEntry[] = [];
    for (const list of this.entries.values()) {
      result.push(...list);
    }
    return result;
  }

  /**
   * Seed a single entry if no real data exists for that key+locator+method.
   * Used for cold-start bootstrap from AppMap data.
   */
  seedEntry(entry: LocatorEntry): void {
    const list = this.entries.get(entry.key);
    if (list && list.some((e) => e.locator === entry.locator && e.method === entry.method)) {
      return; // already have real data for this locator+method
    }
    if (!list) {
      this.entries.set(entry.key, [{ ...entry }]);
    } else {
      list.push({ ...entry });
    }
  }

  /**
   * Load entries from persisted data.
   */
  loadEntries(entries: LocatorEntry[]): void {
    for (const entry of entries) {
      let list = this.entries.get(entry.key);
      if (!list) {
        list = [];
        this.entries.set(entry.key, list);
      }
      const existing = list.find(
        (e) => e.locator === entry.locator && e.method === entry.method,
      );
      if (existing) {
        existing.successCount = entry.successCount;
        existing.failCount = entry.failCount;
        existing.score = entry.score;
        existing.lastUsed = entry.lastUsed;
      } else {
        list.push({ ...entry });
      }
    }
  }

  /**
   * Bayesian score: (successes + prior) / (total + 2*prior)
   * With prior=2: starts at 0.5, converges to true rate with more data.
   */
  private bayesianScore(successes: number, failures: number): number {
    return (
      (successes + this.priorStrength) /
      (successes + failures + 2 * this.priorStrength)
    );
  }
}
