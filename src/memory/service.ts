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
 * MemoryService — unified facade over MemoryStore, SessionTracker, and RecallEngine
 *
 * Single entry-point for all memory operations. Adds:
 * - state.json snapshot (debounced, written on every action)
 * - learnings.jsonl (verified patterns, separate from strategies)
 * - MemoryPolicy (error/stall thresholds)
 * - Mission tracking
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import { MemoryStore } from "./store.js";
import { SessionTracker } from "./session.js";
import { RecallEngine } from "./recall.js";
import type { ActionEntry, Strategy, ErrorPattern, MemoryStats } from "./types.js";
import { seedLearningsFromPlaybooks } from "./playbook-seeds.js";

// ── New types ────────────────────────────────────

export interface Learning {
  id: string;
  scope: string;       // e.g., "chrome/github.com" or "vscode/terminal"
  pattern: string;     // what worked or failed
  method: string;      // "ax" | "cdp" | "ocr" | "coordinates"
  confidence: number;  // 0-1
  successCount: number;
  failCount: number;
  lastSeen: string;
  fix: string | null;
}

export interface MemoryPolicy {
  maxConsecutiveErrors: number;  // default 5
  stallThresholdMs: number;     // default 300000
  escalateAfterRetries: number; // default 3
  pauseBetweenActionsMs: number; // default 500
}

export interface MemorySnapshot {
  session: { id: string; client: string; startedAt: string; lastActionAt: string };
  mission: { current: string | null; phase: string };
  health: {
    actionsTotal: number;
    actionsFailed: number;
    successRate: number;
    lastError: string | null;
    consecutiveErrors: number;
  };
  patterns: { topWorking: string[]; topFailing: string[]; knownBlockers: string[] };
  policy: MemoryPolicy;
}

// Re-export existing types so consumers can import everything from service
export type { ActionEntry, Strategy, ErrorPattern, MemoryStats };

// ── Defaults ─────────────────────────────────────

const DEFAULT_POLICY: MemoryPolicy = {
  maxConsecutiveErrors: 5,
  stallThresholdMs: 300_000,
  escalateAfterRetries: 3,
  pauseBetweenActionsMs: 500,
};

const SNAPSHOT_DEBOUNCE_MS = 200;
const MAX_LEARNINGS = 1000;

// ── Service ──────────────────────────────────────

export class MemoryService {
  private store: MemoryStore;
  private session: SessionTracker;
  private recall: RecallEngine;

  private baseDir: string;
  private memDir: string;

  private learningsCache: Learning[] = [];
  private snapshot: MemorySnapshot;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private actionsFailed = 0;
  private actionsTotal = 0;
  private sessionStartedAt: string;

  private initialized = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.memDir = path.join(baseDir, ".screenhand", "memory");

    this.store = new MemoryStore(baseDir);
    this.session = new SessionTracker(this.store);
    this.recall = new RecallEngine(this.store);

    this.sessionStartedAt = new Date().toISOString();

    this.snapshot = {
      session: {
        id: this.session.getSessionId(),
        client: "unknown",
        startedAt: this.sessionStartedAt,
        lastActionAt: this.sessionStartedAt,
      },
      mission: { current: null, phase: "idle" },
      health: {
        actionsTotal: 0,
        actionsFailed: 0,
        successRate: 1,
        lastError: null,
        consecutiveErrors: 0,
      },
      patterns: { topWorking: [], topFailing: [], knownBlockers: [] },
      policy: { ...DEFAULT_POLICY },
    };
  }

  // ── Initialization ───────────────────────────────

  /** Load all caches from disk. Call once at startup. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.store.init();
    this.ensureMemDir();

    // Load learnings
    this.learningsCache = this.readJsonlSafe<Learning>("learnings.jsonl");

    // Seed learnings from playbooks — selectors, detection, policy notes.
    // These have scope prefixes like "chrome/figma" so they merge cleanly
    // with runtime-discovered learnings without duplicating.
    const playbooksDir = path.join(this.baseDir, "references");
    const pbLearnings = seedLearningsFromPlaybooks(playbooksDir);
    if (pbLearnings.length > 0) {
      const existingKeys = new Set(
        this.learningsCache.map(l => `${l.scope}::${l.pattern}::${l.method}`)
      );
      let added = 0;
      for (const pl of pbLearnings) {
        const key = `${pl.scope}::${pl.pattern}::${pl.method}`;
        if (!existingKeys.has(key)) {
          this.learningsCache.push({
            id: `pb_lrn_${added}`,
            ...pl,
          });
          existingKeys.add(key);
          added++;
        }
      }
    }

    // Load existing snapshot if present (to restore mission/policy across restarts)
    const snapPath = this.filePath("state.json");
    if (fs.existsSync(snapPath)) {
      try {
        const raw = fs.readFileSync(snapPath, "utf-8");
        const loaded = JSON.parse(raw) as Partial<MemorySnapshot>;
        // Validate shape before merging — reject obviously corrupted data
        if (loaded.mission && typeof loaded.mission === "string") {
          this.snapshot.mission = loaded.mission;
        }
        if (loaded.policy && typeof loaded.policy === "object" && !Array.isArray(loaded.policy)) {
          // Validate numeric fields before merging
          const p = loaded.policy as unknown as Record<string, unknown>;
          if (typeof p.maxConsecutiveErrors !== "number" || !Number.isFinite(p.maxConsecutiveErrors)) {
            delete p.maxConsecutiveErrors;
          }
          if (typeof p.maxErrorsBeforeBlock !== "number" || !Number.isFinite(p.maxErrorsBeforeBlock)) {
            delete p.maxErrorsBeforeBlock;
          }
          this.snapshot.policy = { ...DEFAULT_POLICY, ...p };
        }
      } catch {
        // Corrupted snapshot — start fresh
      }
    }

    // Sync stats from store
    const stats = this.store.getStats();
    this.actionsTotal = stats.totalActions;
    this.actionsFailed = stats.totalActions - Math.round(stats.successRate * stats.totalActions);

    this.rebuildPatterns();
    this.updateHealthInSnapshot();
    this.writeSnapshotSync();
  }

  // ── Snapshot ─────────────────────────────────────

  /** Get the current in-memory snapshot (zero-cost). */
  getSnapshot(): MemorySnapshot {
    return this.snapshot;
  }

  private scheduleSnapshotWrite(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.writeSnapshotSync();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private writeSnapshotSync(): void {
    this.ensureMemDir();
    try {
      writeFileAtomicSync(this.filePath("state.json"), JSON.stringify(this.snapshot, null, 2));
    } catch {
      // Non-critical
    }
  }

  private updateHealthInSnapshot(): void {
    this.snapshot.health = {
      actionsTotal: this.actionsTotal,
      actionsFailed: this.actionsFailed,
      successRate: this.actionsTotal > 0 ? (this.actionsTotal - this.actionsFailed) / this.actionsTotal : 1,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  private rebuildPatterns(): void {
    // Top working: learnings with high confidence, sorted desc
    const working = this.learningsCache
      .filter((l) => l.confidence >= 0.6 && l.successCount > l.failCount)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map((l) => `${l.scope}: ${l.pattern} (${l.method})`);

    // Top failing: learnings with low confidence or high fail count
    const failing = this.learningsCache
      .filter((l) => l.failCount > l.successCount)
      .sort((a, b) => b.failCount - a.failCount)
      .slice(0, 10)
      .map((l) => `${l.scope}: ${l.pattern} (${l.method})`);

    // Known blockers: errors with no resolution
    const errors = this.store.readErrors();
    const blockers = errors
      .filter((e) => !e.resolution && e.occurrences >= 2)
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10)
      .map((e) => `${e.tool}: ${e.error}`);

    this.snapshot.patterns = {
      topWorking: working,
      topFailing: failing,
      knownBlockers: blockers,
    };
  }

  // ── Recording ────────────────────────────────────

  /** Record an action event. Delegates to store + session tracker, updates snapshot. */
  recordEvent(entry: ActionEntry): void {
    this.store.appendAction(entry);
    this.session.recordAction(entry);

    this.actionsTotal++;
    if (!entry.success) {
      this.actionsFailed++;
      this.consecutiveErrors++;
      this.lastError = entry.error;
    } else {
      this.consecutiveErrors = 0;
    }

    this.snapshot.session.id = this.session.getSessionId();
    this.snapshot.session.lastActionAt = entry.timestamp;
    this.updateHealthInSnapshot();
    this.scheduleSnapshotWrite();
  }

  /** Record an error pattern. Delegates to store, optionally creates a learning. */
  recordError(tool: string, error: string, fix: string | null, scope?: string): void {
    const pattern: ErrorPattern = {
      id: "err_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      tool,
      params: {},
      error,
      resolution: fix,
      occurrences: 1,
      lastSeen: new Date().toISOString(),
    };
    this.store.appendError(pattern);

    // If a fix is provided, record it as a learning
    if (fix && scope) {
      this.recordLearning({
        scope,
        pattern: error,
        method: "ax",
        confidence: 0.5,
        successCount: 0,
        failCount: 1,
        lastSeen: new Date().toISOString(),
        fix,
      });
    }

    this.rebuildPatterns();
    this.scheduleSnapshotWrite();
  }

  // ── Learnings ────────────────────────────────────

  /** Append a verified learning to learnings.jsonl. */
  recordLearning(learning: Omit<Learning, "id">): void {
    const full: Learning = {
      id: "lrn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...learning,
    };

    // Check for existing learning with same scope + pattern + method
    const idx = this.learningsCache.findIndex(
      (l) => l.scope === full.scope && l.pattern === full.pattern && l.method === full.method
    );

    if (idx >= 0) {
      const existing = this.learningsCache[idx]!;
      this.learningsCache[idx] = {
        ...existing,
        successCount: existing.successCount + full.successCount,
        failCount: existing.failCount + full.failCount,
        confidence: this.computeConfidence(
          existing.successCount + full.successCount,
          existing.failCount + full.failCount
        ),
        lastSeen: full.lastSeen,
        fix: full.fix ?? existing.fix,
      };
    } else {
      this.learningsCache.push(full);
      this.enforceLearningsLimit();
    }

    this.writeLearningsAsync();
    this.rebuildPatterns();
    this.scheduleSnapshotWrite();
  }

  /** Search learnings by scope and/or method. */
  queryPatterns(scope?: string, method?: string): Learning[] {
    let results = this.learningsCache;
    if (scope) {
      results = results.filter((l) => l.scope === scope || l.scope.startsWith(scope + "/"));
    }
    if (method) {
      results = results.filter((l) => l.method === method);
    }
    return results;
  }

  private computeConfidence(success: number, fail: number): number {
    const total = success + fail;
    if (total === 0) return 0;
    return success / total;
  }

  private enforceLearningsLimit(): void {
    if (this.learningsCache.length <= MAX_LEARNINGS) return;
    // Evict lowest-confidence, oldest learnings
    this.learningsCache.sort((a, b) => {
      const confDiff = a.confidence - b.confidence;
      if (Math.abs(confDiff) > 0.1) return confDiff;
      return new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
    });
    this.learningsCache = this.learningsCache.slice(-MAX_LEARNINGS);
  }

  private writeLearningsAsync(): void {
    this.ensureMemDir();
    const data = this.learningsCache.map((l) => JSON.stringify(l)).join("\n") + (this.learningsCache.length ? "\n" : "");
    // Use atomic write to prevent race conditions: two rapid calls would clobber
    // each other with fs.writeFile's async no-op callback.
    try {
      writeFileAtomicSync(this.filePath("learnings.jsonl"), data);
    } catch {
      // Non-critical — in-memory cache is still correct
    }
  }

  // ── Recall (delegates to RecallEngine) ───────────

  /** Search error patterns, optionally filtered by tool. */
  queryErrors(tool?: string): ErrorPattern[] {
    return this.recall.recallErrors(tool);
  }

  /** Fuzzy-match strategies by query string. Optionally filter by current app. */
  recallStrategies(query: string, limit?: number, currentBundleId?: string): Array<Strategy & { score: number }> {
    return this.recall.recallStrategies(query, limit, currentBundleId);
  }

  /** Quick error check for interceptor (~0ms). */
  quickErrorCheck(tool: string): ErrorPattern | null {
    return this.recall.quickErrorCheck(tool);
  }

  /** Quick strategy hint for interceptor (~0ms). */
  quickStrategyHint(recentTools: string[], currentBundleId?: string): ReturnType<RecallEngine["quickStrategyHint"]> {
    return this.recall.quickStrategyHint(recentTools, currentBundleId);
  }

  /** Check if the current tool sequence matches a proven strategy for auto-execution. */
  getAutoExecutableStrategy(recentTools: string[], currentBundleId?: string): ReturnType<RecallEngine["getAutoExecutableStrategy"]> {
    return this.recall.getAutoExecutableStrategy(recentTools, currentBundleId);
  }

  /** Record strategy outcome for feedback loop. */
  recordStrategyOutcome(fingerprint: string, success: boolean): void {
    this.store.recordStrategyOutcome(fingerprint, success);
  }

  // ── Session / Strategy ───────────────────────────

  /** Get the current session ID. */
  getSessionId(): string {
    return this.session.getSessionId();
  }

  /** Get recent tool names from session buffer. */
  getRecentToolNames(limit?: number): string[] {
    return this.session.getRecentToolNames(limit);
  }

  /** End current session and save a strategy if successful. */
  saveStrategy(task: string, tags?: string[]): Strategy | null {
    const strategy = this.session.endSession(true, task);
    if (strategy && tags && tags.length > 0) {
      // Merge additional tags
      const merged = new Set([...strategy.tags, ...tags]);
      strategy.tags = [...merged];
    }
    return strategy;
  }

  /** Read raw actions from store (for exports/playbooks). */
  readActions(): ActionEntry[] {
    return this.store.readActions();
  }

  /** Read raw errors from store. */
  readErrors(): ErrorPattern[] {
    return this.store.readErrors();
  }

  /** Read raw strategies from store. */
  readStrategies(): Strategy[] {
    return this.store.readStrategies();
  }

  /** Append an error pattern directly (for interceptor compatibility). */
  appendError(pattern: ErrorPattern): void {
    this.store.appendError(pattern);
  }

  /** Append a strategy directly. */
  appendStrategy(strategy: Strategy): void {
    this.store.appendStrategy(strategy);
  }

  // ── Stats ────────────────────────────────────────

  /** Get aggregate memory stats. */
  getStats(): MemoryStats {
    return this.store.getStats();
  }

  // ── Mission ──────────────────────────────────────

  /** Set the current mission and optionally a phase. */
  setMission(mission: string, phase?: string): void {
    this.snapshot.mission.current = mission;
    if (phase) this.snapshot.mission.phase = phase;
    this.scheduleSnapshotWrite();
  }

  /** Set the client identifier (e.g., "claude-code", "mcp-desktop"). */
  setClient(client: string): void {
    this.snapshot.session.client = client;
    this.scheduleSnapshotWrite();
  }

  // ── Clear ────────────────────────────────────────

  /** Clear specific memory categories or everything. */
  clear(what: "all" | "actions" | "strategies" | "errors" | "learnings"): void {
    if (what === "learnings" || what === "all") {
      this.learningsCache = [];
      const fp = this.filePath("learnings.jsonl");
      if (fs.existsSync(fp)) fs.writeFileSync(fp, "");
    }

    if (what !== "learnings") {
      // Delegate non-learnings clears to the store
      const storeWhat = what === "all" ? "all" : what as "actions" | "strategies" | "errors";
      this.store.clear(storeWhat);
    }

    if (what === "all" || what === "actions") {
      this.actionsTotal = 0;
      this.actionsFailed = 0;
      this.consecutiveErrors = 0;
      this.lastError = null;
    }

    this.updateHealthInSnapshot();
    this.rebuildPatterns();
    this.writeSnapshotSync();
  }

  // ── Helpers ──────────────────────────────────────

  private ensureMemDir(): void {
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
  }

  private filePath(name: string): string {
    return path.join(this.memDir, name);
  }

  private readJsonlSafe<T>(file: string): T[] {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return [];
    let text: string;
    try {
      // Guard against oversized files (same 10MB limit as LearningEngine)
      const stat = fs.statSync(fp);
      if (stat.size > 10 * 1024 * 1024) return [];
      text = fs.readFileSync(fp, "utf-8").trim();
    } catch {
      return [];
    }
    if (!text) return [];

    const results: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed) as T);
      } catch {
        // Skip corrupted line
      }
    }
    return results;
  }
}
