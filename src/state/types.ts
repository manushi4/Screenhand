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

export interface Tracked<T> {
  value: T;
  confidence: number;
  updatedAt: string;
  stableId?: string;
}

export interface WorldState {
  windows: Map<number, WindowState>;
  focusedWindowId: number | null;
  focusedApp: AppIdentity | null;
  activeDialogs: DialogState[];
  appDomains: Map<string, AppDomainState>;
  lastFullScan: string;
  sessionId: string;
  expectedPostcondition: StateAssertion | null;
  /** ISO timestamp of last state mutation */
  updatedAt: string;
  /** Top-level confidence (0-1), decays over time */
  confidence: number;
  /** Set by planner when a goal is active */
  pendingGoal: string | null;
  /** Rolling buffer of recent state transitions (max 50) */
  recentTransitions: StateTransition[];
  /** Persistent entity tracking across frames */
  trackedEntities: Map<string, TrackedEntity>;
}

export interface AppIdentity {
  bundleId: string;
  appName: string;
  pid: number;
}

export interface WindowState {
  windowId: number;
  title: Tracked<string>;
  bundleId: string;
  pid: number;
  bounds: Tracked<Bounds>;
  controls: Map<string, ControlState>;
  isOnScreen: boolean;
  /** Currently focused control in this window */
  focusedElement: ControlState | null;
  /** Top-level interactive elements (subset of controls) */
  visibleControls: ControlState[];
  /** Per-window dialog stack */
  dialogStack: DialogState[];
  /** Current scroll position */
  scrollPosition: { x: number; y: number } | null;
  /** ISO timestamp of last AX scan for this window */
  lastAXScanAt: string | null;
  /** ISO timestamp of last CDP scan for this window */
  lastCDPScanAt: string | null;
  /** ISO timestamp of last OCR for this window */
  lastOCRAt: string | null;
  /** Hash of last screenshot for change detection */
  lastScreenshotHash: string | null;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControlState {
  stableId: string;
  role: string;
  label: Tracked<string>;
  value: Tracked<string | null>;
  enabled: Tracked<boolean>;
  focused: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Which perception source produced this control */
  source?: "ax" | "cdp" | "ocr" | "observer";
  /** Confidence of the source (0-1), set by ingestion. AX=0.9, CDP=0.85, OCR=0.7 */
  sourceConfidence?: number;
  /** ISO timestamp when this control was last seen by any source */
  lastSeenAt?: string;
}

export interface DialogState {
  type: "modal" | "sheet" | "alert" | "popover" | "permission" | "save" | "unknown";
  title: string;
  windowId: number;
  controls: Map<string, ControlState>;
  detectedAt: string;
  /** Dialog message text (e.g. "Do you want to save?") */
  message: string | null;
  /** Button labels extracted from dialog controls */
  buttons: string[];
  /** Which perception source detected this dialog */
  source: "ax" | "cdp" | "ocr" | "observer";
}

export type AppDomainState =
  | VideoEditorState
  | ImageEditorState
  | DesignToolState
  | BrowserState
  | GenericAppState;

export interface VideoEditorState {
  family: "video_editor";
  timeline: Tracked<{
    currentFrame: number;
    totalFrames: number;
    fps: number;
  }> | null;
  activeTrack: Tracked<string> | null;
  playbackState: Tracked<"playing" | "paused" | "stopped">;
  /** Timecode string e.g. "00:01:23:15" */
  playheadPosition: Tracked<string> | null;
  selectedClips: Tracked<string[]>;
  /** Timeline/sequence name */
  activeSequence: Tracked<string> | null;
  /** Current page e.g. "Edit" | "Color" | "Fairlight" | "Deliver" (DaVinci) */
  activePage: Tracked<string> | null;
  /** Current tool e.g. "Selection" | "Razor" | "Pen" */
  activeTool: Tracked<string> | null;
  /** Render status: "idle" | "rendering" | "queued" */
  renderStatus: Tracked<string> | null;
  mediaOffline: Tracked<boolean>;
}

export interface ImageEditorState {
  family: "image_editor";
  canvasSize: Tracked<{ width: number; height: number }> | null;
  activeTool: Tracked<string> | null;
  activeLayer: Tracked<string> | null;
  zoom: Tracked<number>;
  layerCount: Tracked<number>;
  selectedLayers: Tracked<string[]>;
  documentSize: Tracked<{ width: number; height: number }> | null;
}

export interface DesignToolState {
  family: "design_tool";
  activePage: Tracked<string> | null;
  selectedElements: Tracked<string[]>;
  zoom: Tracked<number>;
  activeTool: Tracked<string> | null;
  sidebarPanel: Tracked<string> | null;
  canvasSize: Tracked<{ width: number; height: number }> | null;
}

export interface BrowserTab {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

export interface BrowserState {
  family: "browser";
  url: Tracked<string> | null;
  title: Tracked<string> | null;
  tabs?: BrowserTab[];
}

export interface GenericAppState {
  family: "generic";
}

export interface WorldModelConfig {
  confidenceDecayRate: number;
  staleThresholdMs: number;
  maxControlsPerWindow: number;
  persistDebounceMs: number;
  /** Directory for state persistence. Undefined = ~/.screenhand/state */
  stateDir?: string;
  /** Directory for reference JSON files. Undefined = ./references */
  referencesDir?: string;
}

export interface TrackedEntity {
  entityId: string;
  type: "window" | "panel" | "dialog" | "tab" | "selection" | "playhead";
  label: string;
  windowId: number;
  stableIds: string[];
  firstSeen: string;
  lastSeen: string;
  positions: Array<{ x: number; y: number; timestamp: string }>;
  properties: Record<string, unknown>;
}

export interface StateTransition {
  from: string;
  to: string;
  trigger: string;
  timestamp: string;
}

export interface StateAssertion {
  type:
    | "control_exists"
    | "value_equals"
    | "window_focused"
    | "dialog_absent"
    | "dialog_present"
    | "app_focused"
    | "url_equals"
    | "control_enabled"
    | "control_absent"
    | "text_visible";
  target: string;
  expected?: unknown;
}

export interface PostconditionResult {
  matched: boolean;
  actual: string | null;
  confidence: number;
}
