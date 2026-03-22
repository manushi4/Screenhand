// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import { LocatorPolicy } from "./locator-policy.js";
import { RecoveryPolicy } from "./recovery-policy.js";
import { TimingModel } from "./timing-model.js";
import { SensorPolicy } from "./sensor-policy.js";
import { PatternPolicy } from "./pattern-policy.js";
import { TopologyPolicy } from "./topology-policy.js";
import type {
  LearningEngineConfig,
  LocatorOutcome,
  RecoveryOutcomeEvent,
  ToolTimingEvent,
  SensorOutcome,
  PatternOutcome,
  TopologyOutcome,
  AdaptiveBudget,
  LocatorEntry,
  PatternEntry,
  TopologyEntry,
  RecoveryPolicyEntry,
  SensorPolicyEntry,
  TimingSample,
} from "./types.js";
import { DEFAULT_LEARNING_CONFIG } from "./types.js";
import type { BlockerType } from "../recovery/types.js";

/**
 * Prune an array to `max` entries, keeping the most recent by date field.
 */
function pruneByDate<T>(
  entries: T[],
  max: number,
  getDate: (entry: T) => string,
): T[] {
  return [...entries]
    .sort((a, b) => getDate(b).localeCompare(getDate(a)))
    .slice(0, max);
}

/**
 * LearningEngine — the central coordinator for all learning policies.
 *
 * Observes outcomes from tool execution, recovery, and perception,
 * updates the four sub-policies, and provides recommendations that
 * make the system smarter over time.
 *
 * Persistence: each policy writes its own JSONL file in the data directory.
 * Loading is eager (on init), saving is debounced.
 */
export class LearningEngine {
  readonly locators: LocatorPolicy;
  readonly recovery: RecoveryPolicy;
  readonly timing: TimingModel;
  readonly sensors: SensorPolicy;
  readonly patterns: PatternPolicy;
  readonly topology: TopologyPolicy;
  private readonly config: LearningEngineConfig;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<LearningEngineConfig>) {
    const defaultDir = path.join(os.homedir(), ".screenhand", "learning");
    const resolvedDir = config?.dataDir || defaultDir;
    this.config = {
      ...DEFAULT_LEARNING_CONFIG,
      ...config,
      // Ensure dataDir is never empty — applied last to override any empty string from spread
      dataDir: resolvedDir,
    };
    this.locators = new LocatorPolicy(this.config.priorStrength);
    this.recovery = new RecoveryPolicy(this.config.priorStrength);
    this.timing = new TimingModel(this.config.maxTimingSamples);
    this.sensors = new SensorPolicy(this.config.priorStrength);
    this.patterns = new PatternPolicy(this.config.priorStrength);
    this.topology = new TopologyPolicy(this.config.priorStrength);
  }

  /**
   * Initialize: create data directory and load persisted data.
   */
  init(): void {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    this.load();
  }

  // ── Record Outcomes ─────────────────────────────────────────────

  recordLocatorOutcome(outcome: LocatorOutcome): void {
    this.locators.record(outcome);
    this.scheduleSave();
  }

  recordRecoveryOutcome(outcome: RecoveryOutcomeEvent): void {
    this.recovery.record(outcome);
    this.scheduleSave();
  }

  recordToolTiming(event: ToolTimingEvent): void {
    this.timing.record(event);
    this.scheduleSave();
  }

  recordSensorOutcome(outcome: SensorOutcome): void {
    this.sensors.record(outcome);
    this.scheduleSave();
  }

  recordPattern(outcome: PatternOutcome): void {
    this.patterns.record(outcome);
    this.scheduleSave();
  }

  recordTopologyOutcome(outcome: TopologyOutcome): void {
    this.topology.record(outcome);
    this.scheduleSave();
  }

  // ── Recommendations ─────────────────────────────────────────────

  /**
   * Get the best locator for a given app×action.
   */
  recommendLocator(
    bundleId: string,
    actionKey: string,
  ): LocatorEntry | null {
    return this.locators.recommend(
      bundleId,
      actionKey,
      this.config.minSamplesForConfidence,
    );
  }

  /**
   * Get ranked recovery strategies for a blocker×app pair.
   */
  rankRecoveryStrategies(
    blockerType: BlockerType,
    bundleId: string,
  ): Array<{ strategyId: string; score: number }> {
    return this.recovery.rank(blockerType, bundleId);
  }

  /**
   * Get adaptive timeouts for a given app.
   */
  getAdaptiveBudget(bundleId: string): AdaptiveBudget {
    return this.timing.getAdaptiveBudget(
      bundleId,
      this.config.minSamplesForConfidence,
    );
  }

  /**
   * Get per-app source confidence using Bayesian posterior from observed accuracy.
   * Falls back to hardcoded defaults if insufficient data.
   */
  getSourceConfidence(
    bundleId: string,
    source: "ax" | "cdp" | "ocr" | "vision",
  ): number {
    const DEFAULTS: Record<string, number> = { ax: 0.9, cdp: 0.85, ocr: 0.7, vision: 0.6 };
    const ranked = this.sensors.rank(bundleId);
    const match = ranked.find((r) => r.sourceType === source);
    if (match && match.score > 0) {
      // Bayesian posterior from sensor policy is already computed
      return match.score;
    }
    return DEFAULTS[source] ?? 0.5;
  }

  /**
   * Get ranked perception sources for a given app.
   */
  rankSensors(
    bundleId: string,
  ): Array<{ sourceType: string; score: number; avgLatencyMs: number }> {
    return this.sensors.rank(bundleId);
  }

  /**
   * Query verified UI patterns for a given app, optionally filtered by tool.
   */
  queryPatterns(bundleId: string, tool?: string): PatternEntry[] {
    return this.patterns.query(bundleId, tool);
  }

  /**
   * Get the best verified pattern for a given app×tool.
   */
  recommendPattern(bundleId: string, tool: string): PatternEntry | null {
    return this.patterns.recommend(
      bundleId,
      tool,
      this.config.minSamplesForConfidence,
    );
  }

  /**
   * Query all topology entries (navigation edges) for a given app.
   */
  queryTopology(bundleId: string): TopologyEntry[] {
    return this.topology.query(bundleId);
  }

  /**
   * Get the best navigation edge from a given node.
   */
  recommendNextNavigation(bundleId: string, fromNode: string): TopologyEntry | null {
    return this.topology.recommend(
      bundleId,
      fromNode,
      this.config.minSamplesForConfidence,
    );
  }

  /**
   * Get a summary of learning stats for a given app.
   */
  getAppSummary(bundleId: string): {
    locatorEntries: number;
    recoveryEntries: number;
    timingSamples: number;
    sensorEntries: number;
    patternEntries: number;
    topologyEntries: number;
    topLocatorMethod: string | null;
    topSensor: string | null;
    adaptiveBudget: AdaptiveBudget;
  } {
    const locPrefix = `${bundleId.length}:${bundleId}\0`;
    const locEntries = this.locators
      .getAllEntries()
      .filter((e) => e.key.startsWith(locPrefix));
    const recEntries = this.recovery
      .getAllEntries()
      .filter((e) => {
        const parts = e.key.split("::");
        return parts[parts.length - 1] === bundleId;
      });
    const timSamples = this.timing
      .getAllSamples()
      .filter((s) => s.bundleId === bundleId);
    const senEntries = this.sensors
      .getAllEntries()
      .filter((e) => e.bundleId === bundleId);
    const patEntries = this.patterns.query(bundleId);
    const topoEntries = this.topology.query(bundleId);

    const topSensor = this.sensors.recommend(bundleId, 1);
    const topLoc = locEntries.sort((a, b) => b.score - a.score)[0];

    return {
      locatorEntries: locEntries.length,
      recoveryEntries: recEntries.length,
      timingSamples: timSamples.length,
      sensorEntries: senEntries.length,
      patternEntries: patEntries.length,
      topologyEntries: topoEntries.length,
      topLocatorMethod: topLoc?.method ?? null,
      topSensor,
      adaptiveBudget: this.getAdaptiveBudget(bundleId),
    };
  }

  // ── Persistence ─────────────────────────────────────────────────

  /**
   * Clear all learning data and flush empty state to disk.
   */
  reset(): void {
    this.locators.clear();
    this.recovery.clear();
    this.timing.clear();
    this.sensors.clear();
    this.patterns.clear();
    this.topology.clear();
    // Explicitly delete JSONL files — save() skips empty data (falsy guard),
    // so stale files would resurrect on next init().
    const dir = this.config.dataDir;
    const files = [
      "locators.jsonl",
      "recoveries.jsonl",
      "timings.jsonl",
      "sensors.jsonl",
      "patterns.jsonl",
      "topology.jsonl",
    ];
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {
        // File may not exist — that's fine
      }
    }
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Force save all policies to disk.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.save();
      }
    }, 500);
  }

  private save(): void {
    try {
      const dir = this.config.dataDir;
      const max = this.config.maxEntriesPerFile;

      // Locator entries — prune by lastUsed
      let locatorEntries = this.locators.getAllEntries();
      if (locatorEntries.length > max) {
        locatorEntries = pruneByDate(locatorEntries, max, (e) => e.lastUsed);
        this.locators.loadEntries(locatorEntries);
      }
      const locatorData = locatorEntries.map((e) => JSON.stringify(e)).join("\n");
      if (locatorData) {
        writeFileAtomicSync(path.join(dir, "locators.jsonl"), locatorData + "\n");
      }

      // Recovery entries — prune by lastUsed
      let recoveryEntries = this.recovery.getAllEntries();
      if (recoveryEntries.length > max) {
        recoveryEntries = pruneByDate(recoveryEntries, max, (e) => e.lastUsed);
        this.recovery.loadEntries(recoveryEntries);
      }
      const recoveryData = recoveryEntries.map((e) => JSON.stringify(e)).join("\n");
      if (recoveryData) {
        writeFileAtomicSync(path.join(dir, "recoveries.jsonl"), recoveryData + "\n");
      }

      // Timing samples — prune by timestamp
      let timingSamples = this.timing.getAllSamples();
      if (timingSamples.length > max) {
        timingSamples = pruneByDate(timingSamples, max, (s) => s.timestamp);
        this.timing.loadSamples(timingSamples);
      }
      const timingData = timingSamples.map((s) => JSON.stringify(s)).join("\n");
      if (timingData) {
        writeFileAtomicSync(path.join(dir, "timings.jsonl"), timingData + "\n");
      }

      // Sensor entries — prune by lastUsed
      let sensorEntries = this.sensors.getAllEntries();
      if (sensorEntries.length > max) {
        sensorEntries = pruneByDate(sensorEntries, max, (e) => e.lastUsed);
        this.sensors.loadEntries(sensorEntries);
      }
      const sensorData = sensorEntries.map((e) => JSON.stringify(e)).join("\n");
      if (sensorData) {
        writeFileAtomicSync(path.join(dir, "sensors.jsonl"), sensorData + "\n");
      }

      // Pattern entries — prune by lastSeen
      let patternEntries = this.patterns.getAllEntries();
      if (patternEntries.length > max) {
        patternEntries = pruneByDate(patternEntries, max, (e) => e.lastSeen);
        this.patterns.loadEntries(patternEntries);
      }
      const patternData = patternEntries.map((e) => JSON.stringify(e)).join("\n");
      if (patternData) {
        writeFileAtomicSync(path.join(dir, "patterns.jsonl"), patternData + "\n");
      }

      // Topology entries — prune by lastUsed
      let topologyEntries = this.topology.getAllEntries();
      if (topologyEntries.length > max) {
        topologyEntries = pruneByDate(topologyEntries, max, (e) => e.lastUsed);
        this.topology.loadEntries(topologyEntries);
      }
      const topologyData = topologyEntries.map((e) => JSON.stringify(e)).join("\n");
      if (topologyData) {
        writeFileAtomicSync(path.join(dir, "topology.jsonl"), topologyData + "\n");
      }

      // Only clear dirty AFTER all writes succeed — if any write throws,
      // dirty stays true so the next scheduled save will retry
      this.dirty = false;
    } catch {
      // Persistence failure is non-fatal — data stays in memory
    }
  }

  private load(): void {
    const dir = this.config.dataDir;

    // Load locators
    const locatorEntries = this.readJsonl<LocatorEntry>(
      path.join(dir, "locators.jsonl"),
    );
    if (locatorEntries.length > 0) {
      this.locators.loadEntries(locatorEntries);
    }

    // Load recoveries
    const recoveryEntries = this.readJsonl<RecoveryPolicyEntry>(
      path.join(dir, "recoveries.jsonl"),
    );
    if (recoveryEntries.length > 0) {
      this.recovery.loadEntries(recoveryEntries);
    }

    // Load timings
    const timingSamples = this.readJsonl<TimingSample>(
      path.join(dir, "timings.jsonl"),
    );
    if (timingSamples.length > 0) {
      this.timing.loadSamples(timingSamples);
    }

    // Load sensors
    const sensorEntries = this.readJsonl<SensorPolicyEntry>(
      path.join(dir, "sensors.jsonl"),
    );
    if (sensorEntries.length > 0) {
      this.sensors.loadEntries(sensorEntries);
    }

    // Load patterns
    const patternEntries = this.readJsonl<PatternEntry>(
      path.join(dir, "patterns.jsonl"),
    );
    if (patternEntries.length > 0) {
      this.patterns.loadEntries(patternEntries);
    }

    // Load topology
    const topologyEntries = this.readJsonl<TopologyEntry>(
      path.join(dir, "topology.jsonl"),
    );
    if (topologyEntries.length > 0) {
      this.topology.loadEntries(topologyEntries);
    }
  }

  private readJsonl<T>(filePath: string): T[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      // Guard against oversized files: truncate to recent entries if larger than 10MB
      const stat = fs.statSync(filePath);
      if (stat.size > 10 * 1024 * 1024) {
        console.error(`[Learning] WARN: Oversized file: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB) — truncating to recent entries`);
        // Read the last 5MB (most recent entries are at the end)
        const fd = fs.openSync(filePath, "r");
        const tailSize = 5 * 1024 * 1024;
        const buf = Buffer.alloc(tailSize);
        fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
        fs.closeSync(fd);
        const tailContent = buf.toString("utf-8");
        // Drop first partial line
        const firstNewline = tailContent.indexOf("\n");
        const cleanContent = firstNewline >= 0 ? tailContent.slice(firstNewline + 1) : tailContent;
        // Overwrite with truncated content so it doesn't grow forever
        try { writeFileAtomicSync(filePath, cleanContent); } catch { /* non-fatal */ }
        const results: T[] = [];
        const maxEntries = this.config.maxEntriesPerFile;
        for (const line of cleanContent.split("\n")) {
          if (results.length >= maxEntries) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { results.push(JSON.parse(trimmed) as T); } catch { /* skip corrupt */ }
        }
        return results;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const results: T[] = [];
      const maxEntries = this.config.maxEntriesPerFile;
      for (const line of content.split("\n")) {
        if (results.length >= maxEntries) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          results.push(JSON.parse(trimmed) as T);
        } catch {
          // Skip corrupt lines
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
