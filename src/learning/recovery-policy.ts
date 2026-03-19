// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { BlockerType } from "../recovery/types.js";
import type { RecoveryPolicyEntry, RecoveryOutcomeEvent } from "./types.js";

/**
 * RecoveryPolicy — ranks recovery strategies per blocker×app.
 *
 * When the RecoveryEngine needs to pick a strategy, this policy
 * provides a ranked list based on past success rates. Over time,
 * the best strategy surfaces to the top.
 */
export class RecoveryPolicy {
  /** Map<compoundKey, RecoveryPolicyEntry[]> */
  private readonly entries = new Map<string, RecoveryPolicyEntry[]>();
  private readonly priorStrength: number;

  constructor(priorStrength = 2) {
    this.priorStrength = priorStrength;
  }

  /**
   * Record a recovery outcome.
   */
  record(outcome: RecoveryOutcomeEvent): void {
    const compoundKey = `${outcome.blockerType}::${outcome.bundleId}`;
    let list = this.entries.get(compoundKey);
    if (!list) {
      list = [];
      this.entries.set(compoundKey, list);
    }

    let entry = list.find((e) => e.strategyId === outcome.strategyId);
    if (!entry) {
      entry = {
        key: compoundKey,
        strategyId: outcome.strategyId,
        successCount: 0,
        failCount: 0,
        score: 0.5,
        avgDurationMs: 0,
        lastUsed: new Date().toISOString(),
      };
      list.push(entry);
    }

    if (outcome.success) {
      entry.successCount++;
    } else {
      entry.failCount++;
    }

    // Running average for duration — guard against NaN
    const duration = Number.isFinite(outcome.durationMs) ? outcome.durationMs : 0;
    const total = entry.successCount + entry.failCount;
    entry.avgDurationMs =
      entry.avgDurationMs * ((total - 1) / total) +
      duration / total;

    entry.score = this.bayesianScore(entry.successCount, entry.failCount);
    entry.lastUsed = new Date().toISOString();
  }

  /**
   * Rank strategies for a given blocker×app, best first.
   * Returns strategy IDs sorted by score (descending).
   */
  rank(
    blockerType: BlockerType,
    bundleId: string,
  ): Array<{ strategyId: string; score: number }> {
    const compoundKey = `${blockerType}::${bundleId}`;
    const list = this.entries.get(compoundKey);
    if (!list || list.length === 0) return [];

    return [...list]
      .sort((a, b) => b.score - a.score)
      .map((e) => ({ strategyId: e.strategyId, score: e.score }));
  }

  /**
   * Get the best strategy for a blocker×app pair, or null if no data.
   */
  recommend(
    blockerType: BlockerType,
    bundleId: string,
    minSamples = 3,
  ): string | null {
    const compoundKey = `${blockerType}::${bundleId}`;
    const list = this.entries.get(compoundKey);
    if (!list || list.length === 0) return null;

    const qualified = list.filter(
      (e) => e.successCount + e.failCount >= minSamples,
    );
    if (qualified.length === 0) return null;

    qualified.sort((a, b) => b.score - a.score);
    return qualified[0]!.strategyId;
  }

  clear(): void {
    this.entries.clear();
  }

  getAllEntries(): RecoveryPolicyEntry[] {
    const result: RecoveryPolicyEntry[] = [];
    for (const list of this.entries.values()) {
      result.push(...list);
    }
    return result;
  }

  loadEntries(entries: RecoveryPolicyEntry[]): void {
    for (const entry of entries) {
      let list = this.entries.get(entry.key);
      if (!list) {
        list = [];
        this.entries.set(entry.key, list);
      }
      const existing = list.find((e) => e.strategyId === entry.strategyId);
      if (existing) {
        existing.successCount = entry.successCount;
        existing.failCount = entry.failCount;
        existing.score = entry.score;
        existing.avgDurationMs = entry.avgDurationMs;
        existing.lastUsed = entry.lastUsed;
      } else {
        list.push({ ...entry });
      }
    }
  }

  private bayesianScore(successes: number, failures: number): number {
    return (
      (successes + this.priorStrength) /
      (successes + failures + 2 * this.priorStrength)
    );
  }
}
