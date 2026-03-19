// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  TimingSample,
  TimingDistribution,
  AdaptiveBudget,
  ToolTimingEvent,
} from "./types.js";

/** Default budgets from src/config.ts — used when insufficient data. */
const DEFAULT_LOCATE_MS = 800;
const DEFAULT_ACT_MS = 200;
const DEFAULT_VERIFY_MS = 2000;

/** Tools categorized by their role in the locate→act→verify pipeline. */
const LOCATE_TOOLS = new Set([
  "ui_find", "locate_with_fallback", "browser_dom",
]);
const ACT_TOOLS = new Set([
  "click", "click_text", "click_with_fallback", "type_text",
  "type_with_fallback", "key", "drag", "scroll", "scroll_with_fallback",
  "browser_click", "browser_type", "browser_human_click",
  "select_with_fallback", "ui_press", "ui_set_value", "menu_click",
]);
const VERIFY_TOOLS = new Set([
  "screenshot", "screenshot_file", "ocr", "ui_tree",
  "browser_wait", "wait_for_state", "read_with_fallback",
  "browser_page_info",
]);

/**
 * TimingModel — learns per-tool×app timing distributions and produces
 * adaptive budgets that replace fixed defaults.
 *
 * Keeps a sliding window of samples per key. Computes p50/p95 lazily
 * when a budget is requested.
 */
export class TimingModel {
  /** Map<compoundKey, TimingSample[]> — sliding window */
  private readonly samples = new Map<string, TimingSample[]>();
  /** Cached distributions — invalidated on new sample */
  private readonly distributions = new Map<string, TimingDistribution>();
  private readonly maxSamples: number;

  constructor(maxSamples = 100) {
    this.maxSamples = maxSamples;
  }

  /**
   * Record a timing event.
   */
  record(event: ToolTimingEvent): void {
    const key = `${event.tool}::${event.bundleId}`;
    let list = this.samples.get(key);
    if (!list) {
      list = [];
      this.samples.set(key, list);
    }

    // Cap individual samples at 10s to prevent outliers (timeouts, stalls)
    // from poisoning the adaptive budgets
    const MAX_SAMPLE_MS = 10_000;
    const rawDur = Number.isFinite(event.durationMs) && event.durationMs >= 0
      ? event.durationMs
      : 0;
    const dur = Math.min(rawDur, MAX_SAMPLE_MS);
    list.push({
      tool: event.tool,
      bundleId: event.bundleId,
      durationMs: dur,
      success: event.success,
      timestamp: new Date().toISOString(),
    });

    // Sliding window: keep only recent samples
    if (list.length > this.maxSamples) {
      list.splice(0, list.length - this.maxSamples);
    }

    // Invalidate cached distribution
    this.distributions.delete(key);
  }

  /**
   * Get the timing distribution for a specific tool×app pair.
   */
  getDistribution(tool: string, bundleId: string): TimingDistribution | null {
    const key = `${tool}::${bundleId}`;

    const cached = this.distributions.get(key);
    if (cached) return cached;

    const list = this.samples.get(key);
    if (!list || list.length === 0) return null;

    // Only use successful samples for timing (failures may have arbitrary durations)
    const successDurations = list
      .filter((s) => s.success)
      .map((s) => s.durationMs);

    if (successDurations.length === 0) return null;

    successDurations.sort((a, b) => a - b);

    const dist: TimingDistribution = {
      key,
      sampleCount: successDurations.length,
      p50: percentile(successDurations, 0.5),
      p95: percentile(successDurations, 0.95),
      mean:
        successDurations.reduce((a, b) => a + b, 0) / successDurations.length,
      min: successDurations[0]!,
      max: successDurations[successDurations.length - 1]!,
      lastUpdated: new Date().toISOString(),
    };

    this.distributions.set(key, dist);
    return dist;
  }

  /**
   * Compute adaptive budgets for a given app by aggregating
   * timing data across all tools of each category (locate/act/verify).
   *
   * Returns defaults for categories with insufficient data.
   */
  getAdaptiveBudget(bundleId: string, minSamples = 5): AdaptiveBudget {
    return {
      locateMs: this.budgetForCategory(LOCATE_TOOLS, bundleId, DEFAULT_LOCATE_MS, minSamples),
      actMs: this.budgetForCategory(ACT_TOOLS, bundleId, DEFAULT_ACT_MS, minSamples),
      verifyMs: this.budgetForCategory(VERIFY_TOOLS, bundleId, DEFAULT_VERIFY_MS, minSamples),
    };
  }

  /**
   * Clear all samples and cached distributions.
   */
  clear(): void {
    this.samples.clear();
    this.distributions.clear();
  }

  /**
   * Get all timing distributions (for persistence/inspection).
   */
  getAllDistributions(): TimingDistribution[] {
    // Ensure all distributions are computed
    for (const key of this.samples.keys()) {
      if (!this.distributions.has(key)) {
        const [tool, bundleId] = key.split("::");
        if (tool && bundleId) {
          this.getDistribution(tool, bundleId);
        }
      }
    }
    return [...this.distributions.values()];
  }

  /**
   * Get all raw samples (for persistence).
   */
  getAllSamples(): TimingSample[] {
    const result: TimingSample[] = [];
    for (const list of this.samples.values()) {
      result.push(...list);
    }
    return result;
  }

  /**
   * Load samples from persisted data.
   */
  loadSamples(samples: TimingSample[]): void {
    const MAX_SAMPLE_MS = 10_000;
    for (const sample of samples) {
      const key = `${sample.tool}::${sample.bundleId}`;
      let list = this.samples.get(key);
      if (!list) {
        list = [];
        this.samples.set(key, list);
      }
      // Cap loaded samples to prevent old poisoned data from inflating budgets
      list.push({ ...sample, durationMs: Math.min(sample.durationMs, MAX_SAMPLE_MS) });
      if (list.length > this.maxSamples) {
        list.splice(0, list.length - this.maxSamples);
      }
    }
    // Clear all cached distributions
    this.distributions.clear();
  }

  /**
   * Compute budget for a category of tools by taking the max p95
   * across all tools in that category for the given app.
   */
  private budgetForCategory(
    toolSet: Set<string>,
    bundleId: string,
    defaultMs: number,
    minSamples: number,
  ): number {
    let maxP95 = 0;
    let hasData = false;

    for (const tool of toolSet) {
      const dist = this.getDistribution(tool, bundleId);
      if (dist && dist.sampleCount >= minSamples) {
        maxP95 = Math.max(maxP95, dist.p95);
        hasData = true;
      }
    }

    if (!hasData) return defaultMs;

    // Use p95 with a 20% margin, but never below the minimum sensible value
    // and never above 5x the default to prevent budget explosion from outliers
    const minFloor = defaultMs * 0.25;
    const maxCeiling = defaultMs * 5;
    return Math.min(Math.max(Math.ceil(maxP95 * 1.2), minFloor), maxCeiling);
  }
}

/**
 * Compute the p-th percentile of a sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const idx = p * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);

  if (lower === upper) return sorted[lower]!;

  const frac = idx - lower;
  return sorted[lower]! * (1 - frac) + sorted[upper]! * frac;
}
