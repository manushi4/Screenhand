/**
 * Learning Memory — JSONL persistence layer (cached)
 *
 * All data is cached in-memory for zero-latency reads.
 * Disk writes are non-blocking (fire-and-forget).
 * Call init() once at startup to hydrate caches.
 */

import fs from "node:fs";
import path from "node:path";
import type { ActionEntry, Strategy, ErrorPattern, MemoryStats } from "./types.js";

const MAX_ACTION_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export class MemoryStore {
  private dir: string;

  // ── in-memory caches ──
  private strategiesCache: Strategy[] = [];
  private errorsCache: ErrorPattern[] = [];
  private actionCount = 0;
  private actionSuccessCount = 0;
  private toolCounts = new Map<string, number>();
  private initialized = false;
  private dirCreated = false;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, ".screenhand", "memory");
  }

  /** Load caches from disk. Call once at startup. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.ensureDir();
    this.strategiesCache = this.readLinesSync<Strategy>("strategies.jsonl");
    this.errorsCache = this.readLinesSync<ErrorPattern>("errors.jsonl");

    // Build action stats from current actions file (without caching all entries)
    const actions = this.readLinesSync<ActionEntry>("actions.jsonl");
    this.actionCount = actions.length;
    for (const a of actions) {
      if (a.success) this.actionSuccessCount++;
      this.toolCounts.set(a.tool, (this.toolCounts.get(a.tool) ?? 0) + 1);
    }
  }

  // ── helpers ────────────────────────────────────

  private ensureDir(): void {
    if (!this.dirCreated) {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      this.dirCreated = true;
    }
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  /** Non-blocking append — fire and forget */
  private appendLineAsync(file: string, obj: Record<string, unknown>): void {
    this.ensureDir();
    const data = JSON.stringify(obj) + "\n";
    fs.appendFile(this.filePath(file), data, () => {});
  }

  /** Non-blocking full rewrite — fire and forget */
  private writeLinesAsync(file: string, items: Record<string, unknown>[]): void {
    this.ensureDir();
    const data = items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "");
    fs.writeFile(this.filePath(file), data, () => {});
  }

  /** Synchronous read for init only */
  private readLinesSync<T>(file: string): T[] {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return [];
    try {
      const text = fs.readFileSync(fp, "utf-8").trim();
      if (!text) return [];
      return text.split("\n").map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  }

  private fileSize(file: string): number {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return 0;
    try { return fs.statSync(fp).size; } catch { return 0; }
  }

  // ── actions (async write, in-memory stats) ─────

  appendAction(entry: ActionEntry): void {
    // Update in-memory stats
    this.actionCount++;
    if (entry.success) this.actionSuccessCount++;
    this.toolCounts.set(entry.tool, (this.toolCounts.get(entry.tool) ?? 0) + 1);

    // Rotate if needed (sync check, async rename)
    this.rotateActionsIfNeeded();

    // Non-blocking write
    this.appendLineAsync("actions.jsonl", entry as unknown as Record<string, unknown>);
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

  /** Read actions from disk (only used by stats tool, not in hot path) */
  readActions(): ActionEntry[] {
    return this.readLinesSync<ActionEntry>("actions.jsonl");
  }

  // ── strategies (cached) ────────────────────────

  appendStrategy(strategy: Strategy): void {
    const idx = this.strategiesCache.findIndex((s) => s.task === strategy.task);
    if (idx >= 0) {
      const old = this.strategiesCache[idx]!;
      this.strategiesCache[idx] = {
        ...strategy,
        successCount: old.successCount + 1,
        lastUsed: strategy.lastUsed,
      };
    } else {
      this.strategiesCache.push(strategy);
    }
    // Async full rewrite (strategies file is small)
    this.writeLinesAsync("strategies.jsonl", this.strategiesCache as unknown as Record<string, unknown>[]);
  }

  /** Read from cache — ~0ms */
  readStrategies(): Strategy[] {
    return this.strategiesCache;
  }

  // ── errors (cached) ────────────────────────────

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
    }
    // Async full rewrite
    this.writeLinesAsync("errors.jsonl", this.errorsCache as unknown as Record<string, unknown>[]);
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
      } else if (category === "strategies") {
        this.strategiesCache = [];
      } else if (category === "errors") {
        this.errorsCache = [];
      }
    }
  }
}
