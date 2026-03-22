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

import fs from "node:fs";
import type { BridgeClient } from "../native/bridge-client.js";
import type { Bounds } from "../state/types.js";
import type { ROI, PerceptionEvent } from "./types.js";
import { FrameDiffer } from "./frame-differ.js";

/**
 * Vision perception source — screenshot diff + ROI OCR.
 *
 * Uses the native bridge for capture and OCR. Keeps last frame in memory
 * to avoid file I/O on the diff path. Falls back to file-based capture
 * if in-memory buffer capture is not available from the bridge.
 */
export class VisionSource {
  private readonly differ: FrameDiffer;
  /** When true, always use CLI fallback for captures (avoids CG API SIGSEGV on browser windows) */
  private safeCLI = false;

  constructor(
    private readonly bridge: BridgeClient,
    cellSize = 128,
  ) {
    this.differ = new FrameDiffer(cellSize);
  }

  /** Enable safe CLI mode for browser windows that crash CGWindowListCreateImage */
  setSafeCLI(enabled: boolean): void {
    this.safeCLI = enabled;
  }

  /**
   * SLOW rate: capture window and diff against last frame.
   * Returns changed status and regions needing OCR.
   */
  async captureAndDiff(windowId: number): Promise<PerceptionEvent | null> {
    const start = Date.now();
    try {
      // Try in-memory buffer capture first (cg.captureWindowBuffer — not yet in native bridges),
      // fall back to file-based capture (cg.captureWindow — always available)
      let buffer: Buffer;
      let width: number;
      let height: number;

      try {
        const result = await this.bridge.call<{
          base64: string;
          width: number;
          height: number;
        }>("cg.captureWindowBuffer", { windowId, safeCLI: this.safeCLI });
        buffer = Buffer.from(result.base64, "base64");
        width = result.width;
        height = result.height;
      } catch {
        // Fallback: file-based capture
        const fileResult = await this.bridge.call<{
          path: string;
          width: number;
          height: number;
        }>("cg.captureWindow", { windowId, safeCLI: this.safeCLI });
        buffer = fs.readFileSync(fileResult.path);
        width = fileResult.width;
        height = fileResult.height;
        // Clean up temp file
        try {
          fs.unlinkSync(fileResult.path);
        } catch {
          /* ignore */
        }
      }

      const diffResult = this.differ.diff(buffer, width, height);
      const captureMs = Date.now() - start;

      return {
        source: "vision_diff",
        rate: "slow",
        timestamp: new Date().toISOString(),
        data: {
          type: "vision_diff",
          changed: diffResult.changed,
          hash: diffResult.hash,
          changedRegions: diffResult.changedRegions,
          captureMs,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * OCR a specific region of interest.
   * Uses bridge's vision.ocrRegion if available (not yet in native bridges),
   * falls back to full capture + full OCR via vision.ocr.
   */
  async ocrRegion(
    windowId: number,
    roi: ROI,
    mode: "fast" | "accurate" = "fast",
  ): Promise<PerceptionEvent | null> {
    const start = Date.now();
    try {
      let text: string;
      let regions: Array<{ text: string; bounds: Bounds }>;

      try {
        // Try ROI-specific OCR
        const result = await this.bridge.call<{
          text: string;
          regions: Array<{ text: string; bounds: Bounds }>;
        }>("vision.ocrRegion", {
          windowId,
          region: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
          mode,
        });
        text = result.text;
        regions = result.regions;
      } catch {
        // Fallback: full capture + OCR (less efficient)
        const shot = await this.bridge.call<{ path: string }>(
          "cg.captureWindow",
          { windowId, safeCLI: this.safeCLI },
        );
        const ocrResult = await this.bridge.call<{
          text: string;
          regions?: Array<{ text: string; bounds: Bounds }>;
        }>("vision.ocr", { imagePath: shot.path, mode: "fast" });
        text = ocrResult.text;
        regions = ocrResult.regions ?? [];
        try {
          fs.unlinkSync(shot.path);
        } catch {
          /* ignore */
        }
      }

      const latencyMs = Date.now() - start;
      return {
        source: "vision_ocr",
        rate: "slow",
        timestamp: new Date().toISOString(),
        data: {
          type: "vision_ocr",
          roi,
          text,
          regions,
          latencyMs,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture window to a temp file (no base64 round-trip).
   * Returns the file path and dimensions, or null on failure.
   */
  async captureToFile(windowId: number): Promise<{path: string; width: number; height: number} | null> {
    try {
      return await this.bridge.call<{path: string; width: number; height: number}>(
        "cg.captureWindow", { windowId, safeCLI: this.safeCLI }
      );
    } catch { return null; }
  }

  /**
   * OCR an existing image file (no new capture needed).
   */
  async ocrFile(imagePath: string, roi?: ROI, mode: "fast" | "accurate" = "accurate"): Promise<PerceptionEvent | null> {
    const start = Date.now();
    try {
      const result = await this.bridge.call<{
        text: string;
        regions?: Array<{ text: string; bounds: Bounds }>;
      }>("vision.ocr", { imagePath, mode });
      return {
        source: "vision_ocr", rate: "slow",
        timestamp: new Date().toISOString(),
        data: {
          type: "vision_ocr",
          roi: roi ?? { x: 0, y: 0, width: 0, height: 0, reason: "changed_pixels" },
          text: result.text,
          regions: result.regions ?? [],
          latencyMs: Date.now() - start,
        },
      };
    } catch { return null; }
  }

  /**
   * Optimized single-capture pipeline: capture ONCE to file, diff for change
   * detection with region extraction, OCR only changed regions.
   *
   * Performance: unchanged ~113ms, changed ~175ms (vs ~370ms before Phase 2).
   * Phase 1 (FAST OCR) + Phase 2 (region OCR) combined.
   */
  async captureAndDiffOptimized(windowId: number, maxROIs = 3, priorityROIs?: ROI[]): Promise<{
    diffEvent: PerceptionEvent | null;
    ocrEvent: PerceptionEvent | null;
    yoloElements?: Array<{ class: string; confidence: number; bounds: Bounds }>;
  }> {
    const start = Date.now();
    // 1. Capture: stream frame (~0ms) or one-shot (~112ms)
    const capture = await this.captureToFileOrStream(windowId);
    if (!capture) return { diffEvent: null, ocrEvent: null };

    try {
      // 2. Full diff with grid hashing — detects changed regions (~5ms)
      const { changed, hash, changedRegions } = this.differ.diffFile(
        capture.path, capture.width, capture.height,
      );
      const captureMs = Date.now() - start;

      const diffEvent: PerceptionEvent = {
        source: "vision_diff", rate: "slow",
        timestamp: new Date().toISOString(),
        data: { type: "vision_diff", changed, hash, changedRegions, captureMs },
      };

      // 3. If unchanged → done (~113ms total)
      if (!changed) {
        if (!capture.fromStream) { try { fs.unlinkSync(capture.path); } catch {} }
        return { diffEvent, ocrEvent: null };
      }

      // 4. Run OCR and YOLO in parallel on the same captured frame
      const mergedRegions = FrameDiffer.mergeRegions(
        changedRegions, maxROIs, 64, capture.width, capture.height,
      );

      // OCR (region-based or full)
      // Wire #10: When too many changed regions, use zone ROIs (priorityROIs) for
      // targeted OCR instead of expensive full-screen OCR fallback.
      const useRegionOCR = mergedRegions.length > 0 && mergedRegions.length <= maxROIs;
      const useZoneOCR = !useRegionOCR && mergedRegions.length > maxROIs && priorityROIs && priorityROIs.length > 0;
      const ocrTargets = useRegionOCR ? mergedRegions : useZoneOCR ? priorityROIs! : null;

      const ocrPromise = ocrTargets
        ? (async () => {
            const regionResults: Array<{ text: string; bounds: Bounds }> = [];
            for (const roi of ocrTargets) {
              const regionEvent = await this.ocrRegion(windowId, roi);
              if (regionEvent?.data.type === "vision_ocr" && regionEvent.data.regions) {
                // Re-anchor OCR bounds from ROI-relative to window-relative coordinates
                for (const region of regionEvent.data.regions) {
                  region.bounds.x += roi.x;
                  region.bounds.y += roi.y;
                }
                regionResults.push(...regionEvent.data.regions);
              }
            }
            const fullText = regionResults.map((r) => r.text).join("\n");
            return {
              source: "vision_ocr" as const, rate: "slow" as const,
              timestamp: new Date().toISOString(),
              data: {
                type: "vision_ocr" as const,
                roi: ocrTargets[0] ?? { x: 0, y: 0, width: 0, height: 0, reason: "changed_pixels" as const },
                text: fullText,
                regions: regionResults,
                latencyMs: Date.now() - start - captureMs,
              },
            } satisfies PerceptionEvent;
          })()
        : this.ocrFile(capture.path, undefined, "fast");

      // YOLO element detection (~2-5ms on ANE, runs parallel with OCR)
      const yoloPromise = this.detectElements(capture.path, 0.25);

      const [ocrEvent, yoloElements] = await Promise.all([ocrPromise, yoloPromise]);

      // 5. Cleanup (don't delete stream frames — they're owned by the native bridge)
      if (!capture.fromStream) { try { fs.unlinkSync(capture.path); } catch {} }
      return { diffEvent, ocrEvent, yoloElements };
    } catch {
      if (!capture.fromStream) { try { fs.unlinkSync(capture.path); } catch {} }
      return { diffEvent: null, ocrEvent: null };
    }
  }

  // ── YOLO element detection ──

  /**
   * Detect UI elements in an image using the YOLO CoreML model.
   * Returns classified elements (button, field, heading, image, label, link, text)
   * with bounding boxes and confidence scores.
   */
  async detectElements(
    imagePath: string,
    confidence = 0.25,
  ): Promise<Array<{ class: string; confidence: number; bounds: Bounds }>> {
    try {
      const result = await this.bridge.call<{
        elements: Array<{ class: string; confidence: number; bounds: Bounds }>;
        count: number;
      }>("vision.detectElements", { imagePath, confidence });
      return result.elements;
    } catch {
      return []; // Model not available — degrade gracefully
    }
  }

  /**
   * Fuse OCR text regions with YOLO element detections.
   * Matches YOLO bounding boxes to nearest OCR text to produce labeled elements.
   * E.g., YOLO "button at (450,200)" + OCR "Submit at (460,205)" → "Submit button"
   */
  static fuseOcrAndYolo(
    ocrRegions: Array<{ text: string; bounds: Bounds }>,
    yoloElements: Array<{ class: string; confidence: number; bounds: Bounds }>,
    maxDistance = 50,
  ): Array<{ text: string; class: string; confidence: number; bounds: Bounds; source: "fused" | "ocr" | "yolo" }> {
    const results: Array<{ text: string; class: string; confidence: number; bounds: Bounds; source: "fused" | "ocr" | "yolo" }> = [];
    const usedOcr = new Set<number>();

    // For each YOLO detection, find nearest OCR text
    for (const elem of yoloElements) {
      const elemCenterX = elem.bounds.x + elem.bounds.width / 2;
      const elemCenterY = elem.bounds.y + elem.bounds.height / 2;
      let bestIdx = -1;
      let bestDist = maxDistance + 1;

      for (let i = 0; i < ocrRegions.length; i++) {
        if (usedOcr.has(i)) continue;
        const ocr = ocrRegions[i]!;
        const ocrCenterX = ocr.bounds.x + ocr.bounds.width / 2;
        const ocrCenterY = ocr.bounds.y + ocr.bounds.height / 2;
        const dist = Math.sqrt((elemCenterX - ocrCenterX) ** 2 + (elemCenterY - ocrCenterY) ** 2);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        // Fused: YOLO class + OCR text
        usedOcr.add(bestIdx);
        results.push({
          text: ocrRegions[bestIdx]!.text,
          class: elem.class,
          confidence: elem.confidence,
          bounds: elem.bounds,
          source: "fused",
        });
      } else {
        // YOLO only (no nearby text — unlabeled icon/button)
        results.push({
          text: "",
          class: elem.class,
          confidence: elem.confidence,
          bounds: elem.bounds,
          source: "yolo",
        });
      }
    }

    // Add remaining OCR-only elements (text not matched to any YOLO detection)
    for (let i = 0; i < ocrRegions.length; i++) {
      if (usedOcr.has(i)) continue;
      const ocr = ocrRegions[i]!;
      results.push({
        text: ocr.text,
        class: "text",
        confidence: 0.7, // Default OCR confidence
        bounds: ocr.bounds,
        source: "ocr",
      });
    }

    return results;
  }

  // ── Stream capture mode ──

  private streamRunning = false;

  /**
   * Start continuous SCStream capture for a window.
   * Frames are buffered in the native bridge — getLatestFrame returns instantly.
   */
  async startStream(windowId: number, fps = 30): Promise<boolean> {
    try {
      await this.bridge.call("vision.startStream", { windowId, fps });
      this.streamRunning = true;
      return true;
    } catch {
      this.streamRunning = false;
      return false;
    }
  }

  /**
   * Stop the continuous capture stream.
   */
  async stopStream(): Promise<void> {
    try {
      await this.bridge.call("vision.stopStream", {});
    } catch { /* ignore */ }
    this.streamRunning = false;
  }

  get isStreaming(): boolean {
    return this.streamRunning;
  }

  /**
   * Get the latest frame from the running stream (~0ms, already captured).
   * Returns null if stream is not running or no frame available yet.
   */
  async getStreamFrame(): Promise<{ path: string; width: number; height: number; ageMs: number } | null> {
    if (!this.streamRunning) return null;
    try {
      return await this.bridge.call<{ path: string; width: number; height: number; ageMs: number }>(
        "vision.latestFrame", {},
      );
    } catch {
      return null;
    }
  }

  /**
   * Optimized capture: use stream frame if available (~0ms), else fall back to one-shot (~200ms).
   */
  async captureToFileOrStream(windowId: number): Promise<{ path: string; width: number; height: number; fromStream: boolean } | null> {
    // Try stream frame first (instant)
    if (this.streamRunning) {
      const frame = await this.getStreamFrame();
      if (frame && frame.ageMs < 200) { // Only use if fresh (<200ms old)
        return { path: frame.path, width: frame.width, height: frame.height, fromStream: true };
      }
    }
    // Fall back to one-shot capture
    const result = await this.captureToFile(windowId);
    return result ? { ...result, fromStream: false } : null;
  }

  /**
   * Reset differ state (e.g., on context switch to new window).
   */
  reset(): void {
    this.differ.reset();
  }
}
