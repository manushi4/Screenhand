// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { SensorPolicyEntry, SensorOutcome } from "./types.js";

type SensorType = "ax" | "cdp" | "ocr" | "vision" | "window_buffer";

/**
 * SensorPolicy — learns which perception source works best per app.
 *
 * Some apps are AX-friendly (VS Code, Finder), some need CDP (web apps),
 * some need OCR (canvas-heavy apps like Canva, Premiere Pro).
 * This policy tracks success rates and latency per source per app,
 * so the perception coordinator can prioritize the best source.
 */
export class SensorPolicy {
  private readonly entries = new Map<string, SensorPolicyEntry>();
  private readonly priorStrength: number;

  constructor(priorStrength = 2) {
    this.priorStrength = priorStrength;
  }

  /**
   * Record a sensor outcome.
   */
  record(outcome: SensorOutcome): void {
    const key = `${outcome.bundleId}::${outcome.sourceType}`;
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        key,
        bundleId: outcome.bundleId,
        sourceType: outcome.sourceType,
        successCount: 0,
        failCount: 0,
        score: 0.5,
        avgLatencyMs: 0,
        lastUsed: new Date().toISOString(),
      };
      this.entries.set(key, entry);
    }

    if (outcome.success) {
      entry.successCount++;
    } else {
      entry.failCount++;
    }

    // Running average for latency — guard against NaN
    const latency = Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : 0;
    const total = entry.successCount + entry.failCount;
    entry.avgLatencyMs =
      entry.avgLatencyMs * ((total - 1) / total) +
      latency / total;

    entry.score = this.bayesianScore(entry.successCount, entry.failCount);
    entry.lastUsed = new Date().toISOString();
  }

  /** Known browser bundle IDs where CDP should be boosted */
  private static readonly BROWSER_BUNDLES = new Set([
    "com.apple.Safari", "com.google.Chrome", "com.brave.Browser",
    "org.mozilla.firefox", "com.microsoft.edgemac",
    "org.chromium.Chromium", "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
  ]);

  /**
   * Rank perception sources for a given app, best first.
   * Score combines reliability (Bayesian) and speed (lower latency = better).
   * Browser apps get a CDP bootstrap boost when no CDP data exists yet.
   */
  rank(
    bundleId: string,
  ): Array<{ sourceType: SensorType; score: number; avgLatencyMs: number }> {
    const results: Array<{
      sourceType: SensorType;
      score: number;
      avgLatencyMs: number;
    }> = [];

    for (const entry of this.entries.values()) {
      if (entry.bundleId === bundleId) {
        results.push({
          sourceType: entry.sourceType,
          score: entry.score,
          avgLatencyMs: entry.avgLatencyMs,
        });
      }
    }

    // Bootstrap CDP for browser apps: if no CDP data exists yet,
    // inject a prior so CDP isn't ranked at 0 for browsers
    const isBrowser = SensorPolicy.BROWSER_BUNDLES.has(bundleId);
    if (isBrowser && !results.some((r) => r.sourceType === "cdp")) {
      results.push({ sourceType: "cdp", score: 0.7, avgLatencyMs: 100 });
    }

    // Sort by score descending, then by latency ascending for ties
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
      return a.avgLatencyMs - b.avgLatencyMs;
    });

    return results;
  }

  /**
   * Get the best source for a given app, or null if no data.
   */
  recommend(bundleId: string, minSamples = 5): SensorType | null {
    const ranked = this.rank(bundleId);
    const qualified = ranked.filter((r) => {
      const entry = this.entries.get(`${bundleId}::${r.sourceType}`);
      return entry && entry.successCount + entry.failCount >= minSamples;
    });
    return qualified.length > 0 ? qualified[0]!.sourceType : null;
  }

  /**
   * Seed a single entry if no real data exists for that key.
   * Used for cold-start bootstrap from AppMap ReadySignals / UIArchitecture.
   */
  seedEntry(entry: SensorPolicyEntry): void {
    if (this.entries.has(entry.key)) return; // already have real data
    this.entries.set(entry.key, { ...entry });
  }

  clear(): void {
    this.entries.clear();
  }

  getAllEntries(): SensorPolicyEntry[] {
    return [...this.entries.values()];
  }

  loadEntries(entries: SensorPolicyEntry[]): void {
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
