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

import crypto from "node:crypto";
import fs from "node:fs";
import type { ROI } from "./types.js";

/**
 * Fast frame differencing using content hashing.
 * Compares PNG buffers (in-memory, no disk I/O) and extracts changed regions
 * by dividing the frame into a grid and hashing each cell.
 */
export class FrameDiffer {
  private lastFrameHash: string | null = null;
  private lastFrameBuffer: Buffer | null = null;
  private lastGridHashes: Map<string, string> | null = null;

  /** Grid cell size for region detection (pixels). */
  private readonly cellSize: number;

  constructor(cellSize = 128) {
    this.cellSize = cellSize;
  }

  /**
   * Hash a frame buffer. Uses MD5 for speed (not security).
   */
  hashBuffer(buffer: Buffer): string {
    return crypto.createHash("md5").update(buffer).digest("hex");
  }

  /**
   * Compare a new frame against the last.
   * Returns whether anything changed and which regions differ.
   *
   * For PNG buffers, we do whole-frame hash for quick "anything changed?" check,
   * then grid-based hashing for region extraction.
   *
   * IMPORTANT: PNG is a compressed format, so byte-offset slicing does NOT map
   * to pixel coordinates. The grid-based region detection is an approximation
   * that detects *which chunk of the compressed stream* changed, not the exact
   * pixel region. The returned ROI coordinates are estimates — use them as hints
   * for OCR, not as precise bounding boxes. For exact pixel-level regions, use
   * the native bridge's `cg.captureWindowBuffer` (raw RGBA) + `vision.ocrRegion`.
   */
  diff(
    buffer: Buffer,
    frameWidth: number,
    frameHeight: number,
  ): { changed: boolean; hash: string; changedRegions: ROI[] } {
    const hash = this.hashBuffer(buffer);
    const changed = this.lastFrameHash !== null && hash !== this.lastFrameHash;

    let changedRegions: ROI[] = [];

    if (changed && this.lastGridHashes !== null) {
      changedRegions = this.detectChangedRegions(
        buffer,
        frameWidth,
        frameHeight,
      );
    }

    // Update grid hashes for next comparison
    this.lastGridHashes = this.computeGridHashes(
      buffer,
      frameWidth,
      frameHeight,
    );
    this.lastFrameHash = hash;
    this.lastFrameBuffer = buffer;

    return { changed, hash, changedRegions };
  }

  /**
   * Quick check: did anything change? (~0.1ms for hash comparison)
   */
  quickChanged(buffer: Buffer): boolean {
    const hash = this.hashBuffer(buffer);
    return this.lastFrameHash !== null && hash !== this.lastFrameHash;
  }

  /**
   * Hash a file on disk directly (skips base64 round-trip).
   */
  hashFile(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(buf).digest("hex");
  }

  /**
   * Quick change detection from a file path. Hashes file on disk,
   * compares against last frame hash. Skips grid hashing entirely.
   */
  quickChangedFile(filePath: string): { changed: boolean; hash: string } {
    const hash = this.hashFile(filePath);
    const changed = this.lastFrameHash !== null && hash !== this.lastFrameHash;
    this.lastFrameHash = hash;
    return { changed, hash };
  }

  /**
   * Full diff from a file path — detects changed regions using grid hashing.
   * More expensive than quickChangedFile (~5ms vs ~1ms) but returns ROIs
   * that can be used for region-based OCR.
   */
  diffFile(
    filePath: string,
    frameWidth: number,
    frameHeight: number,
  ): { changed: boolean; hash: string; changedRegions: ROI[] } {
    const buffer = fs.readFileSync(filePath);
    return this.diff(buffer, frameWidth, frameHeight);
  }

  /**
   * Merge adjacent ROI cells into larger rectangles and pad with extra pixels
   * to ensure OCR captures text at region boundaries. Returns at most
   * maxRegions merged ROIs, sorted by area (largest first).
   */
  static mergeRegions(
    regions: ROI[],
    maxRegions: number,
    padding: number,
    frameWidth: number,
    frameHeight: number,
    cellSize = 128,
  ): ROI[] {
    if (regions.length === 0) return [];
    if (regions.length === 1) {
      return [FrameDiffer.padRegion(regions[0]!, padding, frameWidth, frameHeight)];
    }

    // Sort by position (top-left to bottom-right) for merge pass
    const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);

    // Greedy merge: combine overlapping/adjacent regions
    const merged: ROI[] = [];
    let current = { ...sorted[0]! };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i]!;
      // Check if next region overlaps or is adjacent to current (within 1 cell gap)
      const currentRight = current.x + current.width;
      const currentBottom = current.y + current.height;
      const nextRight = next.x + next.width;
      const nextBottom = next.y + next.height;

      const GAP = cellSize; // one cell-sized gap tolerance for adjacency
      const horizontalOverlap =
        next.x <= currentRight + GAP && nextRight >= current.x;
      const verticalOverlap =
        next.y <= currentBottom + GAP && nextBottom >= current.y;

      if (horizontalOverlap && verticalOverlap) {
        // Merge: expand current to encompass next
        const newX = Math.min(current.x, next.x);
        const newY = Math.min(current.y, next.y);
        current = {
          x: newX,
          y: newY,
          width: Math.max(currentRight, nextRight) - newX,
          height: Math.max(currentBottom, nextBottom) - newY,
          reason: "changed_pixels",
        };
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    // Pad and sort by area (largest first), cap at maxRegions
    return merged
      .map((r) => FrameDiffer.padRegion(r, padding, frameWidth, frameHeight))
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, maxRegions);
  }

  private static padRegion(
    roi: ROI,
    padding: number,
    frameWidth: number,
    frameHeight: number,
  ): ROI {
    const x = Math.max(0, roi.x - padding);
    const y = Math.max(0, roi.y - padding);
    return {
      x,
      y,
      width: Math.min(roi.x + roi.width + padding, frameWidth) - x,
      height: Math.min(roi.y + roi.height + padding, frameHeight) - y,
      reason: roi.reason,
    };
  }

  /** Reset state (e.g., on context switch). */
  reset(): void {
    this.lastFrameHash = null;
    this.lastFrameBuffer = null;
    this.lastGridHashes = null;
  }

  /** Get last frame hash (for external state tracking). */
  getLastHash(): string | null {
    return this.lastFrameHash;
  }

  private computeGridHashes(
    buffer: Buffer,
    width: number,
    height: number,
  ): Map<string, string> {
    const hashes = new Map<string, string>();
    if (width <= 0 || height <= 0 || buffer.length === 0) return hashes;
    const cols = Math.ceil(width / this.cellSize);
    const rows = Math.ceil(height / this.cellSize);
    const bytesPerRow = Math.ceil(buffer.length / height) || 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const key = `${col},${row}`;
        const startByte = row * this.cellSize * bytesPerRow + col * this.cellSize;
        const endByte = Math.min(
          startByte + this.cellSize * bytesPerRow,
          buffer.length,
        );
        if (startByte >= buffer.length) continue;
        const slice = buffer.subarray(startByte, endByte);
        hashes.set(key, crypto.createHash("md5").update(slice).digest("hex"));
      }
    }
    return hashes;
  }

  private detectChangedRegions(
    buffer: Buffer,
    width: number,
    height: number,
  ): ROI[] {
    const currentGrid = this.computeGridHashes(buffer, width, height);
    const regions: ROI[] = [];

    for (const [key, hash] of currentGrid) {
      const prevHash = this.lastGridHashes?.get(key);
      if (prevHash && prevHash !== hash) {
        const [colStr, rowStr] = key.split(",");
        const col = Number(colStr);
        const row = Number(rowStr);
        regions.push({
          x: col * this.cellSize,
          y: row * this.cellSize,
          width: Math.min(this.cellSize, width - col * this.cellSize),
          height: Math.min(this.cellSize, height - row * this.cellSize),
          reason: "changed_pixels",
        });
      }
    }

    return regions;
  }

  // ── Raw RGBA pixel-accurate diffing ──

  private lastRawHash: string | null = null;
  private lastRawGridHashes: Map<string, string> | null = null;

  /**
   * Diff raw RGBA pixel data for accurate ROI detection.
   *
   * Unlike `diff()` which operates on compressed PNG bytes (approximate ROIs),
   * this method works with uncompressed RGBA buffers where byte offsets map
   * directly to pixel coordinates. Use with the native bridge's
   * `cg.captureWindowBuffer` which returns raw RGBA data.
   *
   * @param rgba Raw RGBA pixel buffer (4 bytes per pixel, row-major)
   * @param width Frame width in pixels
   * @param height Frame height in pixels
   */
  diffRaw(
    rgba: Buffer,
    width: number,
    height: number,
  ): { changed: boolean; hash: string; changedRegions: ROI[] } {
    const hash = this.hashBuffer(rgba);
    const changed = this.lastRawHash !== null && hash !== this.lastRawHash;

    let changedRegions: ROI[] = [];

    if (changed && this.lastRawGridHashes !== null) {
      changedRegions = this.detectRawChangedRegions(rgba, width, height);
    }

    this.lastRawGridHashes = this.computeRawGridHashes(rgba, width, height);
    this.lastRawHash = hash;

    return { changed, hash, changedRegions };
  }

  /**
   * Compute grid hashes from raw RGBA data using pixel-accurate slicing.
   * Each cell is hashed using its actual pixel rows, not byte-offset estimates.
   */
  private computeRawGridHashes(
    rgba: Buffer,
    width: number,
    height: number,
  ): Map<string, string> {
    const hashes = new Map<string, string>();
    const cols = Math.ceil(width / this.cellSize);
    const rows = Math.ceil(height / this.cellSize);
    const bytesPerPixel = 4; // RGBA
    const stride = width * bytesPerPixel;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const key = `${col},${row}`;
        const cellX = col * this.cellSize;
        const cellY = row * this.cellSize;
        const cellW = Math.min(this.cellSize, width - cellX);
        const cellH = Math.min(this.cellSize, height - cellY);

        // Hash the actual pixel data for this cell
        const hasher = crypto.createHash("md5");
        for (let y = cellY; y < cellY + cellH; y++) {
          const rowStart = y * stride + cellX * bytesPerPixel;
          const rowEnd = rowStart + cellW * bytesPerPixel;
          if (rowEnd <= rgba.length) {
            hasher.update(rgba.subarray(rowStart, rowEnd));
          }
        }
        hashes.set(key, hasher.digest("hex"));
      }
    }
    return hashes;
  }

  private detectRawChangedRegions(
    rgba: Buffer,
    width: number,
    height: number,
  ): ROI[] {
    const currentGrid = this.computeRawGridHashes(rgba, width, height);
    const regions: ROI[] = [];

    for (const [key, hash] of currentGrid) {
      const prevHash = this.lastRawGridHashes?.get(key);
      if (prevHash && prevHash !== hash) {
        const [colStr, rowStr] = key.split(",");
        const col = Number(colStr);
        const row = Number(rowStr);
        regions.push({
          x: col * this.cellSize,
          y: row * this.cellSize,
          width: Math.min(this.cellSize, width - col * this.cellSize),
          height: Math.min(this.cellSize, height - row * this.cellSize),
          reason: "changed_pixels",
        });
      }
    }

    return regions;
  }
}
