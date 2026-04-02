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
 * Learning Memory — JSONL persistence layer (production-ready)
 *
 * - All data cached in-memory for zero-latency reads
 * - Disk writes are non-blocking, buffered, flushed on exit
 * - Per-line JSONL parsing — corrupted lines are skipped, not fatal
 * - Cache size limits with LRU eviction
 * - File locking for multi-instance safety
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import { redactPII } from "../util/sanitize.js";
import type { ActionEntry, Strategy, ErrorPattern, MemoryStats } from "./types.js";
import { SEED_STRATEGIES } from "./seeds.js";
import { seedErrorsFromPlaybooks } from "./playbook-seeds.js";

const MAX_ACTION_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STRATEGIES = 500;
const MAX_ERRORS = 200;

export class MemoryStore {
  private dir: string;

  // ── in-memory caches ──
  private strategiesCache: Strategy[] = [];
  private errorsCache: ErrorPattern[] = [];
  /** Fingerprint → Strategy index for O(1) exact lookup */
  private fingerprintIndex = new Map<string, Strategy>();
  private actionCount = 0;
  private actionSuccessCount = 0;
  private toolCounts = new Map<string, number>();
  private initialized = false;
  private dirCreated = false;
  /** True if ensureDir() had to create the memory directory (first boot) */
  private justCreatedDir = false;

  // ── write buffer for flush-on-exit ──
  private pendingActionWrites: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lockPath: string;
  private hasLock = false;

  // Global flag — only register exit handlers once across all instances
  private static exitHandlerRegistered = false;
  private static activeInstance: MemoryStore | null = null;

  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.dir = path.join(baseDir, ".screenhand", "memory");
    this.lockPath = path.join(this.dir, ".lock");
  }

  /** Load caches from disk. Call once at startup. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.ensureDir();
    this.acquireLock();
    this.registerExitHandler();

    // Detect first boot: memory directory was just created (didn't exist before ensureDir)
    const isFirstBoot = this.justCreatedDir;
    this.strategiesCache = this.readLinesSafe<Strategy>("strategies.jsonl");
    if (this.strategiesCache.length === 0 && isFirstBoot) {
      for (const s of SEED_STRATEGIES) this.strategiesCache.push(s);
      this.writeStrategiesRedacted();
    }
    this.enforceStrategyLimit();
    this.rebuildFingerprintIndex();
    this.errorsCache = this.readLinesSafe<ErrorPattern>("errors.jsonl");

    // Seed errors from playbooks — merge curated platform knowledge into memory.
    // Uses pb_err_ prefix IDs so we can identify and refresh them on each boot.
    const playbooksDir = path.join(this.baseDir, "references");
    const pbErrors = seedErrorsFromPlaybooks(playbooksDir);
    if (pbErrors.length > 0) {
      // Remove stale playbook-seeded errors (they'll be re-added with fresh data)
      this.errorsCache = this.errorsCache.filter(e => !e.id.startsWith("pb_err_"));
      // Merge fresh playbook errors
      for (const e of pbErrors) {
        this.errorsCache.push(e);
      }
    }

    this.enforceErrorLimit();

    // Build action stats without caching all entries
    const actions = this.readLinesSafe<ActionEntry>("actions.jsonl");
    this.actionCount = actions.length;
    for (const a of actions) {
      if (a.success) this.actionSuccessCount++;
      this.toolCounts.set(a.tool, (this.toolCounts.get(a.tool) ?? 0) + 1);
    }
  }

  // ── file locking ──────────────────────────────

  private acquireLock(): void {
    // Retry loop closes the TOCTOU window: if another process grabs the lock
    // between our unlink and write, the wx flag fails and we retry.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Atomic create — fails if file already exists
        fs.writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
        this.hasLock = true;
        return;
      } catch {
        // Lock file exists — check if stale
        try {
          const lockContent = fs.readFileSync(this.lockPath, "utf-8").trim();
          const lockPid = parseInt(lockContent, 10);
          if (lockPid && !this.isProcessRunning(lockPid)) {
            // Stale lock — remove and retry (another process may also remove it)
            try { fs.unlinkSync(this.lockPath); } catch { /* already removed by competitor */ }
            continue; // Retry the wx write
          }
          // Lock held by active process — don't retry
          break;
        } catch {
          // Can't read lock file (removed between our check) — retry
          continue;
        }
      }
    }
    // All retries failed — work in read-only mode
    process.stderr.write(`[MemoryStore] Lock acquisition failed after ${MAX_RETRIES} attempts — writes disabled\n`);
    this.hasLock = false;
  }

  private releaseLock(): void {
    if (this.hasLock) {
      try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
      this.hasLock = false;
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ── exit handling ─────────────────────────────

  private registerExitHandler(): void {
    MemoryStore.activeInstance = this;
    if (MemoryStore.exitHandlerRegistered) return;
    MemoryStore.exitHandlerRegistered = true;

    const flush = () => MemoryStore.activeInstance?.flushSync();
    process.on("beforeExit", flush);
    process.on("exit", flush);
    // SIGINT/SIGTERM — flush then re-raise
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        flush();
        process.exit(128 + (sig === "SIGINT" ? 2 : 15));
      });
    }
  }

  /** Synchronously flush all pending action writes to disk */
  private flushSync(): void {
    if (this.pendingActionWrites.length === 0) return;
    if (!this.hasLock) return;
    try {
      this.ensureDir();
      const data = this.pendingActionWrites.join("");
      fs.appendFileSync(this.filePath("actions.jsonl"), data);
      this.pendingActionWrites = [];
    } catch {
      // Non-critical on exit
    }
    this.releaseLock();
  }

  // ── helpers ────────────────────────────────────

  private ensureDir(): void {
    if (!this.dirCreated) {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.justCreatedDir = true;
      }
      this.dirCreated = true;
    }
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  /**
   * Parse JSONL safely — skip corrupted lines instead of crashing.
   * Returns all successfully parsed entries.
   */
  private readLinesSafe<T>(file: string): T[] {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return [];
    let text: string;
    try {
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
        // Skip corrupted line — don't crash
      }
    }
    return results;
  }

  /** Sync full rewrite — atomic temp+rename (only if we hold lock). */
  private writeLinesSync(file: string, items: Record<string, unknown>[]): void {
    if (!this.hasLock) return;
    this.ensureDir();
    const data = items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "");
    writeFileAtomicSync(this.filePath(file), data);
  }

  /** Flush all pending action writes to disk synchronously. */
  async flush(): Promise<void> {
    // Cancel any debounced timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingActionWrites.length > 0 && this.hasLock) {
      this.ensureDir();
      const data = this.pendingActionWrites.join("");
      this.pendingActionWrites = [];
      fs.appendFileSync(this.filePath("actions.jsonl"), data);
    }
  }

  private fileSize(file: string): number {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return 0;
    try { return fs.statSync(fp).size; } catch { return 0; }
  }

  // ── actions (buffered async write) ─────────────

  appendAction(entry: ActionEntry): void {
    // Update in-memory stats
    this.actionCount++;
    if (entry.success) this.actionSuccessCount++;
    this.toolCounts.set(entry.tool, (this.toolCounts.get(entry.tool) ?? 0) + 1);

    if (!this.hasLock) return;

    this.rotateActionsIfNeeded();

    // S75 Option C: Redact PII before persisting to disk (not in live responses)
    const TYPING_TOOLS = new Set(["type_text", "browser_type", "browser_fill_form", "type_with_fallback"]);
    const redactedParams = TYPING_TOOLS.has(entry.tool) && entry.params && "text" in entry.params
      ? { ...entry.params, text: "[REDACTED]" }
      : entry.params;
    const redacted = { ...entry, params: redactedParams, result: entry.result ? redactPII(entry.result) : entry.result };
    this.pendingActionWrites.push(JSON.stringify(redacted) + "\n");

    // Schedule batch flush (debounced 100ms)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.pendingActionWrites.length === 0) return;
        this.ensureDir();
        const data = this.pendingActionWrites.join("");
        this.pendingActionWrites = [];
        try {
          fs.appendFileSync(this.filePath("actions.jsonl"), data);
        } catch {
          // Non-critical — push data back for next flush attempt
          this.pendingActionWrites.unshift(data);
        }
      }, 100);
    }
  }

  private rotateActionsIfNeeded(): void {
    if (this.fileSize("actions.jsonl") >= MAX_ACTION_FILE_BYTES) {
      const src = this.filePath("actions.jsonl");
      const dst = this.filePath("actions.1.jsonl");
      try {
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      } catch {
        // Non-critical
      }
    }
  }

  /** Read actions from disk (only used by stats/clear, not in hot path) */
  readActions(): ActionEntry[] {
    return this.readLinesSafe<ActionEntry>("actions.jsonl");
  }

  // ── strategies (cached + fingerprint indexed + LRU capped) ──

  private rebuildFingerprintIndex(): void {
    this.fingerprintIndex.clear();
    for (const s of this.strategiesCache) {
      if (s.fingerprint) {
        this.fingerprintIndex.set(s.fingerprint, s);
      }
    }
  }

  /** Evict least-recently-used strategies beyond MAX_STRATEGIES */
  private enforceStrategyLimit(): void {
    if (this.strategiesCache.length <= MAX_STRATEGIES) return;
    // Sort by lastUsed ascending (oldest first), remove from the front
    this.strategiesCache.sort((a, b) =>
      new Date(a.lastUsed).getTime() - new Date(b.lastUsed).getTime()
    );
    this.strategiesCache = this.strategiesCache.slice(-MAX_STRATEGIES);
  }

  appendStrategy(strategy: Strategy): void {
    // Auto-prune screenshot/ocr steps — they add latency on browser apps
    // and the world model provides UI visibility without them
    const PRUNE_TOOLS = new Set(["screenshot", "screenshot_file", "ocr"]);
    strategy.steps = strategy.steps.filter((s) => !PRUNE_TOOLS.has(s.tool));
    if (strategy.steps.length === 0) return; // strategy was all screenshots — discard

    // Ensure fingerprint exists (recompute after pruning)
    strategy.fingerprint = MemoryStore.makeFingerprint(strategy.steps.map((s) => s.tool));

    const idx = this.strategiesCache.findIndex((s) => s.task === strategy.task);
    if (idx >= 0) {
      const old = this.strategiesCache[idx]!;
      this.strategiesCache[idx] = {
        ...strategy,
        successCount: old.successCount + 1,
        failCount: old.failCount ?? 0,
        lastUsed: strategy.lastUsed,
      };
      this.fingerprintIndex.set(strategy.fingerprint, this.strategiesCache[idx]!);
    } else {
      this.strategiesCache.push(strategy);
      this.fingerprintIndex.set(strategy.fingerprint, strategy);
      this.enforceStrategyLimit();
      // Rebuild index after eviction
      if (this.strategiesCache.length >= MAX_STRATEGIES) {
        this.rebuildFingerprintIndex();
      }
    }
    this.writeStrategiesRedacted();
  }

  /** S75 Option C: Redact PII from strategies before any disk write */
  private writeStrategiesRedacted(): void {
    const redacted = this.strategiesCache.map(s => ({
      ...s,
      task: redactPII(s.task),
      steps: s.steps.map(st => ({
        ...st,
        params: Object.fromEntries(
          Object.entries(st.params).map(([k, v]) => [k, typeof v === "string" ? redactPII(v) : v])
        ),
      })),
    }));
    this.writeLinesSync("strategies.jsonl", redacted as unknown as Record<string, unknown>[]);
  }

  /** O(1) exact lookup by tool sequence fingerprint */
  lookupByFingerprint(fingerprint: string): Strategy | undefined {
    return this.fingerprintIndex.get(fingerprint);
  }

  /** Record that a recalled strategy succeeded or failed */
  recordStrategyOutcome(fingerprint: string, success: boolean): void {
    const strategy = this.fingerprintIndex.get(fingerprint);
    if (!strategy) return;

    if (success) {
      strategy.successCount++;
      strategy.lastUsed = new Date().toISOString();
    } else {
      strategy.failCount = (strategy.failCount ?? 0) + 1;
    }
    this.writeStrategiesRedacted();
  }

  /** Read from cache — ~0ms */
  readStrategies(): Strategy[] {
    return this.strategiesCache;
  }

  /** Generate a fingerprint from a tool sequence */
  static makeFingerprint(tools: string[]): string {
    return tools.join("→");
  }

  // ── errors (cached + LRU capped) ──────────────

  /** Evict least-recently-seen errors beyond MAX_ERRORS */
  private enforceErrorLimit(): void {
    if (this.errorsCache.length <= MAX_ERRORS) return;
    this.errorsCache.sort((a, b) =>
      new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime()
    );
    this.errorsCache = this.errorsCache.slice(-MAX_ERRORS);
  }

  appendError(pattern: ErrorPattern): void {
    const idx = this.errorsCache.findIndex(
      (e) => e.tool === pattern.tool && e.error === pattern.error
    );
    if (idx >= 0) {
      this.errorsCache[idx] = {
        ...this.errorsCache[idx]!,
        occurrences: this.errorsCache[idx]!.occurrences + 1,
        lastSeen: pattern.lastSeen,
        resolution: pattern.resolution ?? this.errorsCache[idx]!.resolution,
      };
    } else {
      this.errorsCache.push(pattern);
      this.enforceErrorLimit();
    }
    this.writeLinesSync("errors.jsonl", this.errorsCache as unknown as Record<string, unknown>[]);
  }

  /** Read from cache — ~0ms */
  readErrors(): ErrorPattern[] {
    return this.errorsCache;
  }

  // ── stats (from in-memory counters) ────────────

  getStats(): MemoryStats {
    const topTools = [...this.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    const diskUsageBytes =
      this.fileSize("actions.jsonl") +
      this.fileSize("strategies.jsonl") +
      this.fileSize("errors.jsonl");

    return {
      totalActions: this.actionCount,
      totalStrategies: this.strategiesCache.length,
      totalErrors: this.errorsCache.length,
      diskUsageBytes,
      topTools,
      successRate: this.actionCount > 0 ? this.actionSuccessCount / this.actionCount : 0,
    };
  }

  // ── clear ──────────────────────────────────────

  clear(what: "all" | "actions" | "strategies" | "errors"): void {
    const targets =
      what === "all"
        ? ["actions", "strategies", "errors"] as const
        : [what] as const;

    for (const category of targets) {
      const fp = this.filePath(`${category}.jsonl`);
      if (fs.existsSync(fp)) fs.writeFileSync(fp, "");

      if (category === "actions") {
        this.actionCount = 0;
        this.actionSuccessCount = 0;
        this.toolCounts.clear();
        this.pendingActionWrites = [];
      } else if (category === "strategies") {
        this.strategiesCache = [];
        this.fingerprintIndex.clear();
      } else if (category === "errors") {
        this.errorsCache = [];
      }
    }
  }
}
