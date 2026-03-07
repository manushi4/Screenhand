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

/**
 * Learning Memory — Recall engine (in-memory)
 *
 * All searches run against cached data — no disk IO.
 * Provides fast methods for the interceptor to call on every tool invocation.
 */

import type { Strategy, ErrorPattern } from "./types.js";
import { MemoryStore } from "./store.js";

export class RecallEngine {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Find strategies matching a task description (~0ms, in-memory).
   * Strategies with high fail rates are penalized.
   */
  recallStrategies(query: string, limit = 5): Array<Strategy & { score: number }> {
    const strategies = this.store.readStrategies();
    if (strategies.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored = strategies.map((s) => {
      const targetTokens = new Set([
        ...tokenize(s.task),
        ...s.tags,
        ...s.steps.map((step) => step.tool),
        ...s.steps.flatMap((step) =>
          Object.values(step.params)
            .filter((v): v is string => typeof v === "string")
            .flatMap(tokenize)
        ),
      ]);

      let matches = 0;
      for (const qt of queryTokens) {
        for (const tt of targetTokens) {
          if (tt.includes(qt) || qt.includes(tt)) {
            matches++;
            break;
          }
        }
      }
      const relevance = matches / queryTokens.length;

      const ageMs = Date.now() - new Date(s.lastUsed).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recency = Math.max(0.5, 1.0 - ageDays / 365);

      const successBoost = 1 + Math.log2(Math.max(1, s.successCount)) * 0.1;

      // Penalty for strategies that have failed — reduces score proportionally
      const failCount = s.failCount ?? 0;
      const totalAttempts = s.successCount + failCount;
      const reliabilityPenalty = totalAttempts > 0
        ? s.successCount / totalAttempts
        : 1;

      const score = relevance * recency * successBoost * reliabilityPenalty;
      return { ...s, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * O(1) exact match by tool sequence fingerprint.
   * Returns the strategy if found and it has a positive reliability score.
   */
  recallByFingerprint(tools: string[]): Strategy | null {
    const fp = MemoryStore.makeFingerprint(tools);
    const strategy = this.store.lookupByFingerprint(fp);
    if (!strategy) return null;
    // Skip strategies that fail more than they succeed
    const failCount = strategy.failCount ?? 0;
    if (failCount > strategy.successCount) return null;
    return strategy;
  }

  /**
   * Quick error lookup for a tool — used by interceptor on every call (~0ms).
   * Returns the most relevant error pattern or null.
   */
  quickErrorCheck(tool: string): ErrorPattern | null {
    const errors = this.store.readErrors();
    let best: ErrorPattern | null = null;
    for (const e of errors) {
      if (e.tool === tool && e.resolution) {
        if (!best || e.occurrences > best.occurrences) best = e;
      }
    }
    return best;
  }

  /**
   * Quick strategy hint for a tool sequence — used by interceptor.
   * Tries fingerprint prefix match first (O(1)), then falls back to scan.
   * Skips unreliable strategies (failCount > successCount).
   */
  quickStrategyHint(recentTools: string[]): { strategy: Strategy; nextStep: Strategy["steps"][number]; fingerprint: string } | null {
    if (recentTools.length === 0) return null;

    const strategies = this.store.readStrategies();

    for (const s of strategies) {
      if (s.steps.length <= recentTools.length) continue;
      // Skip unreliable strategies
      const failCount = s.failCount ?? 0;
      if (failCount > s.successCount) continue;

      const strategyToolPrefix = s.steps.slice(0, recentTools.length).map((st) => st.tool);
      const matches = recentTools.every((t, i) => t === strategyToolPrefix[i]);
      if (matches) {
        return {
          strategy: s,
          nextStep: s.steps[recentTools.length]!,
          fingerprint: s.fingerprint ?? MemoryStore.makeFingerprint(s.steps.map((st) => st.tool)),
        };
      }
    }
    return null;
  }

  /** Find error patterns for a specific tool or all tools */
  recallErrors(tool?: string, params?: Record<string, unknown>): ErrorPattern[] {
    const errors = this.store.readErrors();
    if (!tool) return errors;

    let filtered = errors.filter((e) => e.tool === tool);

    if (params && filtered.length > 1) {
      const paramStr = JSON.stringify(params).toLowerCase();
      filtered.sort((a, b) => {
        const aScore = stringSimilarity(paramStr, JSON.stringify(a.params).toLowerCase());
        const bScore = stringSimilarity(paramStr, JSON.stringify(b.params).toLowerCase());
        return bScore - aScore;
      });
    }

    return filtered;
  }
}

/** Tokenize a string into lowercase keywords (3+ chars) */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\W_]+/)
    .filter((w) => w.length >= 3);
}

/** Simple string similarity: shared character bigrams / total bigrams */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  let matches = 0;
  let total = 0;
  for (let i = 0; i < b.length - 1; i++) {
    total++;
    if (bigramsA.has(b.slice(i, i + 2))) matches++;
  }
  return total > 0 ? matches / total : 0;
}
