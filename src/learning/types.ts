// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { BlockerType } from "../recovery/types.js";

// ── Locator Policy ──────────────────────────────────────────────────

/** Tracks how reliable a locator is for a specific app×action pair. */
export interface LocatorEntry {
  /** Compound key: `bundleId::actionKey` */
  key: string;
  /** The locator string (CSS selector, AX label, OCR text, etc.) */
  locator: string;
  /** Which method found/used this locator */
  method: "ax" | "cdp" | "ocr" | "coordinates";
  successCount: number;
  failCount: number;
  /** Bayesian score: successCount / (successCount + failCount) with prior */
  score: number;
  lastUsed: string;
}

// ── Recovery Policy ─────────────────────────────────────────────────

/** Tracks how effective a recovery strategy is for a blocker×app pair. */
export interface RecoveryPolicyEntry {
  /** Compound key: `blockerType::bundleId` */
  key: string;
  strategyId: string;
  successCount: number;
  failCount: number;
  score: number;
  avgDurationMs: number;
  lastUsed: string;
}

// ── Timing Model ────────────────────────────────────────────────────

/** Raw timing sample for a tool×app pair. */
export interface TimingSample {
  tool: string;
  bundleId: string;
  durationMs: number;
  success: boolean;
  timestamp: string;
}

/** Computed timing distribution for a tool×app pair. */
export interface TimingDistribution {
  /** Compound key: `tool::bundleId` */
  key: string;
  sampleCount: number;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  lastUpdated: string;
}

/** Adaptive budget computed from timing data. */
export interface AdaptiveBudget {
  locateMs: number;
  actMs: number;
  verifyMs: number;
}

// ── Sensor Policy ───────────────────────────────────────────────────

/** Tracks which perception source works best for a given app. */
export interface SensorPolicyEntry {
  /** Compound key: `bundleId::sourceType` */
  key: string;
  bundleId: string;
  sourceType: "ax" | "cdp" | "ocr" | "vision" | "window_buffer";
  successCount: number;
  failCount: number;
  score: number;
  avgLatencyMs: number;
  lastUsed: string;
}

// ── Pattern Policy ──────────────────────────────────────────────────

/** Tracks verified UI state patterns (tool + locator combos) per app. */
export interface PatternEntry {
  /** Compound key: `bundleId::tool::locator` */
  key: string;
  bundleId: string;
  tool: string;
  locator: string;
  method: "ax" | "cdp" | "ocr" | "coordinates";
  successCount: number;
  failCount: number;
  /** Bayesian score */
  score: number;
  lastSeen: string;
}

/** Input event for recording a pattern outcome. */
export interface PatternOutcome {
  bundleId: string;
  tool: string;
  locator: string;
  method: "ax" | "cdp" | "ocr" | "coordinates";
  success: boolean;
}

// ── Learning Engine Config ──────────────────────────────────────────

export interface LearningEngineConfig {
  /** Directory for persisting learning data */
  dataDir: string;
  /** Minimum samples before producing a confident recommendation */
  minSamplesForConfidence: number;
  /** Bayesian prior strength (higher = slower to move from 0.5) */
  priorStrength: number;
  /** Max JSONL entries per file before pruning old entries */
  maxEntriesPerFile: number;
  /** Max timing samples kept in memory per tool×app pair */
  maxTimingSamples: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningEngineConfig = {
  dataDir: "",
  minSamplesForConfidence: 5,
  priorStrength: 2,
  maxEntriesPerFile: 5000,
  maxTimingSamples: 100,
};

// ── Outcome Events (input to the learning engine) ───────────────────

export interface LocatorOutcome {
  bundleId: string;
  actionKey: string;
  locator: string;
  method: "ax" | "cdp" | "ocr" | "coordinates";
  success: boolean;
}

export interface RecoveryOutcomeEvent {
  bundleId: string;
  blockerType: BlockerType;
  strategyId: string;
  success: boolean;
  durationMs: number;
}

export interface ToolTimingEvent {
  tool: string;
  bundleId: string;
  durationMs: number;
  success: boolean;
}

export interface SensorOutcome {
  bundleId: string;
  sourceType: "ax" | "cdp" | "ocr" | "vision" | "window_buffer";
  success: boolean;
  latencyMs: number;
  nodeCount?: number;
}

// ── Topology Policy ─────────────────────────────────────────────────

/** Tracks navigation edge reliability for a specific app. */
export interface TopologyEntry {
  /** Compound key: `bundleId::fromNode::action::toNode` */
  key: string;
  bundleId: string;
  fromNode: string;
  action: string;
  toNode: string;
  successCount: number;
  failCount: number;
  /** Bayesian score */
  score: number;
  lastUsed: string;
}

/** Input event for recording a topology outcome. */
export interface TopologyOutcome {
  bundleId: string;
  fromNode: string;
  action: string;
  toNode: string;
  success: boolean;
}
