// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { ControlState } from "./types.js";
import type { WorldModel } from "./world-model.js";
import type { LearningEngine } from "../learning/engine.js";
import type { AXNode, AppContext } from "../types.js";

export interface SourceUpdate {
  source: "ax" | "cdp" | "ocr" | "observer";
  timestamp: string;
  confidence: number;
  windowId: number;
  axTree?: AXNode;
  appContext?: AppContext;
  ocrRegions?: Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>;
  cdpSnapshot?: { bundleId: string; url: string; title: string };
}

/** Clamp confidence to [0, 1], replacing NaN/Infinity with a safe default. */
function sanitizeConfidence(c: number): number {
  if (isNaN(c) || !isFinite(c)) return 0.5;
  return Math.max(0, Math.min(1, c));
}

/**
 * FusionPipeline — unified ingestion point that queues source updates
 * and flushes them into the world model in timestamp order.
 *
 * Benefits over direct ingest calls:
 * - Deduplication by source+windowId (keeps latest per source+window)
 * - Timestamp-ordered processing
 * - Learning-adaptive confidence via LearningEngine
 */
const MAX_QUEUE_SIZE = 100;

export class FusionPipeline {
  private queue: SourceUpdate[] = [];
  private learningEngine: LearningEngine | null = null;

  setLearningEngine(engine: LearningEngine): void {
    this.learningEngine = engine;
  }

  /**
   * Enqueue a source update for batch processing.
   */
  enqueue(update: SourceUpdate): void {
    // Sanitize confidence: clamp to [0, 1], replace NaN with 0.5
    update.confidence = sanitizeConfidence(update.confidence);

    // Deduplicate: if there's already an update for the same source+windowId,
    // keep the newer one (by timestamp)
    const existingIdx = this.queue.findIndex(
      (u) => u.source === update.source && u.windowId === update.windowId,
    );
    if (existingIdx >= 0) {
      const existing = this.queue[existingIdx]!;
      if (update.timestamp >= existing.timestamp) {
        this.queue[existingIdx] = update;
      }
      // else: existing is newer, drop the incoming
      return;
    }
    // Cap queue size to prevent unbounded growth during slow flushes
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Drop oldest non-deduplicated entry
      this.queue.shift();
    }
    this.queue.push(update);
  }

  /**
   * Process all queued updates in timestamp order and flush into the world model.
   */
  flush(worldModel: WorldModel): void {
    if (this.queue.length === 0) return;

    // Sort by timestamp
    this.queue.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const update of this.queue) {
      // Resolve adaptive confidence and apply it to the update
      update.confidence = this.resolveConfidence(update);

      if (update.source === "ax" && update.axTree && update.appContext) {
        worldModel.ingestAXTree(update.windowId, update.axTree, update.appContext, update.confidence);
      } else if (update.source === "ocr" && update.ocrRegions) {
        worldModel.ingestOCRRegions(update.windowId, update.ocrRegions, update.confidence);
      } else if (update.source === "cdp" && update.cdpSnapshot) {
        worldModel.ingestCDPSnapshot(
          update.cdpSnapshot.bundleId,
          update.cdpSnapshot.url,
          update.cdpSnapshot.title,
          update.windowId,
        );
      }
    }

    this.queue = [];
  }

  /**
   * Get the number of queued updates.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Resolve source confidence — use learning engine if available,
   * otherwise fall back to hardcoded defaults.
   */
  private resolveConfidence(update: SourceUpdate): number {
    if (!this.learningEngine) return sanitizeConfidence(update.confidence);

    // Get bundleId from the update context
    const bundleId = update.appContext?.bundleId ?? update.cdpSnapshot?.bundleId;
    if (!bundleId) return sanitizeConfidence(update.confidence);

    const ranked = this.learningEngine.rankSensors(bundleId);
    const match = ranked.find((r) => r.sourceType === update.source);
    if (match && match.score > 0) {
      return sanitizeConfidence(match.score);
    }

    return sanitizeConfidence(update.confidence);
  }
}
