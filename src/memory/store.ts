/**
 * Learning Memory — JSONL persistence layer
 *
 * All data is stored as newline-delimited JSON in .screenhand/memory/.
 * Actions auto-rotate at 10 MB.
 */

import fs from "node:fs";
import path from "node:path";
import type { ActionEntry, Strategy, ErrorPattern, MemoryStats } from "./types.js";

const MAX_ACTION_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export class MemoryStore {
  private dir: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, ".screenhand", "memory");
  }

  // ── helpers ────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  private appendLine(file: string, obj: Record<string, unknown>): void {
    this.ensureDir();
    fs.appendFileSync(this.filePath(file), JSON.stringify(obj) + "\n");
  }

  private readLines<T>(file: string): T[] {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return [];
    const text = fs.readFileSync(fp, "utf-8").trim();
    if (!text) return [];
    return text.split("\n").map((line) => JSON.parse(line) as T);
  }

  private writeLines(file: string, items: Record<string, unknown>[]): void {
    this.ensureDir();
    const data = items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "");
    fs.writeFileSync(this.filePath(file), data);
  }

  private fileSize(file: string): number {
    const fp = this.filePath(file);
    if (!fs.existsSync(fp)) return 0;
    return fs.statSync(fp).size;
  }

  // ── actions ────────────────────────────────────

  appendAction(entry: ActionEntry): void {
    this.rotateActionsIfNeeded();
    this.appendLine("actions.jsonl", entry as unknown as Record<string, unknown>);
  }

  private rotateActionsIfNeeded(): void {
    if (this.fileSize("actions.jsonl") >= MAX_ACTION_FILE_BYTES) {
      const src = this.filePath("actions.jsonl");
      const dst = this.filePath("actions.1.jsonl");
      // Overwrite previous rotation
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
      fs.renameSync(src, dst);
    }
  }

  readActions(): ActionEntry[] {
    return this.readLines<ActionEntry>("actions.jsonl");
  }

  // ── strategies ─────────────────────────────────

  appendStrategy(strategy: Strategy): void {
    const existing = this.readStrategies();
    const idx = existing.findIndex((s) => s.task === strategy.task);
    if (idx >= 0) {
      // Update existing: merge success count, keep latest steps
      const old = existing[idx]!;
      existing[idx] = {
        ...strategy,
        successCount: old.successCount + 1,
        lastUsed: strategy.lastUsed,
      };
      this.writeLines("strategies.jsonl", existing as unknown as Record<string, unknown>[]);
    } else {
      this.appendLine("strategies.jsonl", strategy as unknown as Record<string, unknown>);
    }
  }

  readStrategies(): Strategy[] {
    return this.readLines<Strategy>("strategies.jsonl");
  }

  // ── errors ─────────────────────────────────────

  appendError(pattern: ErrorPattern): void {
    const existing = this.readErrors();
    const idx = existing.findIndex(
      (e) => e.tool === pattern.tool && e.error === pattern.error
    );
    if (idx >= 0) {
      existing[idx] = {
        ...existing[idx]!,
        occurrences: existing[idx]!.occurrences + 1,
        lastSeen: pattern.lastSeen,
        // Preserve existing resolution if new one is null
        resolution: pattern.resolution ?? existing[idx]!.resolution,
      };
      this.writeLines("errors.jsonl", existing as unknown as Record<string, unknown>[]);
    } else {
      this.appendLine("errors.jsonl", pattern as unknown as Record<string, unknown>);
    }
  }

  readErrors(): ErrorPattern[] {
    return this.readLines<ErrorPattern>("errors.jsonl");
  }

  // ── stats ──────────────────────────────────────

  getStats(): MemoryStats {
    const actions = this.readActions();
    const strategies = this.readStrategies();
    const errors = this.readErrors();

    const toolCounts = new Map<string, number>();
    let successes = 0;
    for (const a of actions) {
      toolCounts.set(a.tool, (toolCounts.get(a.tool) ?? 0) + 1);
      if (a.success) successes++;
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    const diskUsageBytes =
      this.fileSize("actions.jsonl") +
      this.fileSize("strategies.jsonl") +
      this.fileSize("errors.jsonl");

    return {
      totalActions: actions.length,
      totalStrategies: strategies.length,
      totalErrors: errors.length,
      diskUsageBytes,
      topTools,
      successRate: actions.length > 0 ? successes / actions.length : 0,
    };
  }

  // ── clear ──────────────────────────────────────

  clear(what: "all" | "actions" | "strategies" | "errors"): void {
    const targets =
      what === "all"
        ? ["actions.jsonl", "strategies.jsonl", "errors.jsonl"]
        : [`${what}.jsonl`];
    for (const file of targets) {
      const fp = this.filePath(file);
      if (fs.existsSync(fp)) fs.writeFileSync(fp, "");
    }
  }
}
