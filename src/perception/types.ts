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

import type { UIEvent, AXNode, AppContext } from "../types.js";
import type { Bounds } from "../state/types.js";

export type PerceptionRate = "fast" | "medium" | "slow" | "background";

export type PerceptionSourceType = "ax_events" | "ax_tree" | "cdp_mutations" | "cdp_snapshot" | "vision_diff" | "vision_ocr";

export interface ROI {
  x: number;
  y: number;
  width: number;
  height: number;
  reason: "changed_pixels" | "low_confidence_control" | "dialog_area" | "focused_element" | "known_zone";
}

export interface PerceptionEvent {
  source: PerceptionSourceType;
  rate: PerceptionRate;
  timestamp: string;
  data: PerceptionEventData;
}

export type PerceptionEventData =
  | AXEventsData
  | AXTreeData
  | CDPMutationData
  | CDPSnapshotData
  | VisionDiffData
  | VisionOCRData;

export interface AXEventsData {
  type: "ax_events";
  events: UIEvent[];
}

export interface AXTreeData {
  type: "ax_tree";
  windowId: number;
  tree: AXNode;
  appContext: AppContext;
}

export interface CDPMutationData {
  type: "cdp_mutations";
  mutations: Array<{
    selector: string;
    attribute?: string;
    oldValue?: string;
    newValue?: string;
    addedNodes?: number;
    removedNodes?: number;
  }>;
}

export interface CDPSnapshotData {
  type: "cdp_snapshot";
  url: string;
  title: string;
  nodeCount: number;
}

export interface VisionDiffData {
  type: "vision_diff";
  changed: boolean;
  hash: string;
  changedRegions: ROI[];
  captureMs: number;
}

export interface VisionOCRData {
  type: "vision_ocr";
  roi: ROI;
  text: string;
  regions: Array<{ text: string; bounds: Bounds }>;
  latencyMs: number;
}

export interface PerceptionCoordinatorConfig {
  fastIntervalMs: number;
  mediumIntervalMs: number;
  slowIntervalMs: number;
  enableAX: boolean;
  enableCDP: boolean;
  enableVision: boolean;
  /** Use GPU window buffer capture + OCR for vision-only apps (where AX is blind to content) */
  enableWindowBuffer: boolean;
  maxROIsPerCycle: number;
  /** Skip filesystem capture lock (for testing) */
  skipCaptureLock: boolean;
}

export const DEFAULT_PERCEPTION_CONFIG: PerceptionCoordinatorConfig = {
  fastIntervalMs: 100,
  mediumIntervalMs: 300,
  slowIntervalMs: 1000,
  enableAX: true,
  enableCDP: true,
  enableVision: true,
  enableWindowBuffer: true,
  maxROIsPerCycle: 3,
  skipCaptureLock: false,
};

export interface PerceptionStats {
  started: boolean;
  startedAt: string | null;
  fastCycles: number;
  mediumCycles: number;
  slowCycles: number;
  axEventsProcessed: number;
  axTreePolls: number;
  cdpMutationsProcessed: number;
  cdpSnapshots: number;
  visionDiffs: number;
  visionOCRs: number;
  lastFastAt: string | null;
  lastMediumAt: string | null;
  lastSlowAt: string | null;
  /** Per-source last-success timestamps */
  lastAXAt: string | null;
  lastCDPAt: string | null;
  lastVisionAt: string | null;
}

export function createEmptyStats(): PerceptionStats {
  return {
    started: false,
    startedAt: null,
    fastCycles: 0,
    mediumCycles: 0,
    slowCycles: 0,
    axEventsProcessed: 0,
    axTreePolls: 0,
    cdpMutationsProcessed: 0,
    cdpSnapshots: 0,
    visionDiffs: 0,
    visionOCRs: 0,
    lastFastAt: null,
    lastMediumAt: null,
    lastSlowAt: null,
    lastAXAt: null,
    lastCDPAt: null,
    lastVisionAt: null,
  };
}
