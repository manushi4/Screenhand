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

/** Screenshot/OCR tools that should be auto-pruned from strategy hints */
const SCREENSHOT_TOOL_NAMES = new Set(["screenshot", "screenshot_file", "ocr"]);

export class RecallEngine {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Find strategies matching a task description (~0ms, in-memory).
   * Strategies with high fail rates are penalized.
   */
  recallStrategies(query: string, limit = 5, currentBundleId?: string): Array<Strategy & { score: number }> {
    const strategies = this.store.readStrategies();
    if (strategies.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored = strategies.map((s) => {
      // Only match against task description, tags, and tool names.
      // Step params (JS code, URLs, selectors) contain too many generic words
      // and cause false positives against unrelated strategies.
      const targetTokens = new Set([
        ...tokenize(s.task),
        ...s.tags,
        ...s.steps.map((step) => step.tool),
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
      const ageDays = Number.isFinite(ageMs) ? ageMs / (1000 * 60 * 60 * 24) : 0;
      const recency = Math.max(0.5, 1.0 - ageDays / 365);

      const successBoost = 1 + Math.log2(Math.max(1, s.successCount)) * 0.1;

      // Penalty for strategies that have failed — reduces score proportionally
      const failCount = s.failCount ?? 0;
      const totalAttempts = s.successCount + failCount;
      const reliabilityPenalty = totalAttempts > 0
        ? s.successCount / totalAttempts
        : 1;

      // App-context filtering: penalize strategies whose steps target a different app
      let appContextFactor = 1.0;
      if (currentBundleId) {
        const stepsStr = s.steps.map((step) => JSON.stringify(step.params)).join(" ").toLowerCase();
        const taskStr = s.task.toLowerCase();
        const bundleLower = currentBundleId.toLowerCase();
        // Extract app name from bundleId (e.g. "com.apple.Safari" → "safari")
        const appName = bundleLower.split(".").pop() ?? "";
        const mentionsCurrentApp = taskStr.includes(bundleLower) || taskStr.includes(appName)
          || stepsStr.includes(bundleLower);
        // Check if strategy targets a DIFFERENT app via focus/launch steps
        const hasFocusStep = s.steps.some((step) =>
          (step.tool === "focus" || step.tool === "launch") &&
          step.params && "bundleId" in step.params &&
          typeof (step.params as any).bundleId === "string" &&
          (step.params as any).bundleId.toLowerCase() !== bundleLower,
        );
        if (hasFocusStep && !mentionsCurrentApp) {
          appContextFactor = 0.1; // Heavy penalty for wrong-app strategies
        } else if (mentionsCurrentApp) {
          appContextFactor = 1.5; // Boost for matching strategies
        }
      }

      // Require at least 50% token overlap to be considered relevant
      if (relevance < 0.5) return { ...s, score: 0 };
      const score = relevance * recency * successBoost * reliabilityPenalty * appContextFactor;
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
  quickStrategyHint(recentTools: string[], currentBundleId?: string): { strategy: Strategy; nextStep: Strategy["steps"][number]; fingerprint: string } | null {
    if (recentTools.length === 0) return null;
    // Require at least 2 tools in the sequence to reduce false positives
    // from single-tool matches (e.g. just "focus" matching every strategy)
    if (recentTools.length < 2) return null;

    const strategies = this.store.readStrategies();

    for (const s of strategies) {
      if (s.steps.length <= recentTools.length) continue;
      // Skip unreliable strategies
      const failCount = s.failCount ?? 0;
      if (failCount > s.successCount) continue;

      // If we know the current app, prefer strategies that mention it
      // and skip strategies clearly for a different app
      if (currentBundleId) {
        const taskLower = s.task.toLowerCase();
        const bundleLower = currentBundleId.toLowerCase();
        // Extract app name from bundleId (e.g. "com.apple.Safari" → "safari")
        const appName = bundleLower.split(".").pop() ?? "";
        const mentionsCurrentApp = taskLower.includes(appName) || taskLower.includes(bundleLower);
        const mentionsOtherApp = !mentionsCurrentApp && /com\.\w+\.\w+/.test(s.task);
        if (mentionsOtherApp) continue; // strategy is for a different app
      }

      const strategyToolPrefix = s.steps.slice(0, recentTools.length).map((st) => st.tool);
      const matches = recentTools.every((t, i) => t === strategyToolPrefix[i]);
      if (matches) {
        // Auto-prune: skip screenshot/ocr steps — they add latency on browser apps
        // and the world model already provides UI state visibility
        let nextIdx = recentTools.length;
        while (nextIdx < s.steps.length && SCREENSHOT_TOOL_NAMES.has(s.steps[nextIdx]!.tool)) {
          nextIdx++;
        }
        if (nextIdx >= s.steps.length) continue; // entire remainder was screenshots — skip strategy
        return {
          strategy: s,
          nextStep: s.steps[nextIdx]!,
          fingerprint: s.fingerprint ?? MemoryStore.makeFingerprint(s.steps.map((st) => st.tool)),
        };
      }
    }
    return null;
  }

  /**
   * Check if the current tool sequence matches a PROVEN strategy that can be
   * auto-executed without LLM intervention.
   *
   * Requirements for auto-execution (conservative):
   * - 10+ successes, 0 failures
   * - Remaining steps are all concrete tools (no LLM/screenshot steps)
   * - At least 2 tools in the prefix match (no single-tool triggers)
   *
   * Returns ALL remaining steps (not just next) so the caller can batch-execute.
   */
  getAutoExecutableStrategy(
    recentTools: string[],
    currentBundleId?: string,
  ): { strategy: Strategy; remainingSteps: Strategy["steps"]; fingerprint: string } | null {
    if (recentTools.length < 2) return null;

    const strategies = this.store.readStrategies();
    const MIN_SUCCESS = 10;

    for (const s of strategies) {
      if (s.steps.length <= recentTools.length) continue;

      // Must be proven: 10+ successes, 0 failures
      const failCount = s.failCount ?? 0;
      if (s.successCount < MIN_SUCCESS || failCount > 0) continue;

      // App context check
      if (currentBundleId) {
        const taskLower = s.task.toLowerCase();
        const bundleLower = currentBundleId.toLowerCase();
        const appName = bundleLower.split(".").pop() ?? "";
        const mentionsCurrentApp = taskLower.includes(appName) || taskLower.includes(bundleLower);
        const mentionsOtherApp = !mentionsCurrentApp && /com\.\w+\.\w+/.test(s.task);
        if (mentionsOtherApp) continue;
      }

      // Check prefix match
      const strategyToolPrefix = s.steps.slice(0, recentTools.length).map((st) => st.tool);
      const matches = recentTools.every((t, i) => t === strategyToolPrefix[i]);
      if (!matches) continue;

      // Collect remaining steps, skipping screenshot/ocr
      const remaining = s.steps.slice(recentTools.length).filter(
        (st) => !SCREENSHOT_TOOL_NAMES.has(st.tool),
      );
      if (remaining.length === 0) continue;

      // All remaining steps must be concrete tools (no "llm_interpret" or similar)
      const LLM_TOOLS = new Set(["llm_interpret", "llm_decide", "ask_user"]);
      if (remaining.some((st) => LLM_TOOLS.has(st.tool))) continue;

      return {
        strategy: s,
        remainingSteps: remaining,
        fingerprint: s.fingerprint ?? MemoryStore.makeFingerprint(s.steps.map((st) => st.tool)),
      };
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
/** Common automation verbs/nouns that match almost any strategy — filter them out */
const RECALL_STOPWORDS = new Set([
  "open", "close", "click", "set", "get", "the", "and", "for", "from",
  "into", "with", "then", "this", "that", "use", "run", "start", "stop",
  "new", "add", "app", "settings", "window", "button", "text", "page",
  "file", "menu", "tab", "navigate", "type", "select", "find", "wait",
  "send", "save", "copy", "paste", "delete", "create", "edit", "view",
  "show", "hide", "move", "drag", "drop", "enter", "press", "about",
  "input", "form", "link", "image", "video", "upload", "download",
  "first", "last", "next", "take", "result", "search",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\W_]+/)
    .filter((w) => w.length >= 2 && !RECALL_STOPWORDS.has(w));
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
