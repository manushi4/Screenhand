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

export type ToolName =
  | "session_start"
  | "navigate"
  | "press"
  | "type_into"
  | "wait_for"
  | "extract"
  | "screenshot"
  | "app_launch"
  | "app_focus"
  | "app_list"
  | "window_list"
  | "menu_click"
  | "key_combo"
  | "element_tree"
  | "observe_start"
  | "observe_stop"
  | "drag"
  | "scroll";

export type Target =
  | { type: "selector"; value: string }
  | { type: "text"; value: string; exact?: boolean }
  | { type: "role"; role: string; name: string; exact?: boolean }
  | { type: "ax_path"; path: string[] }
  | { type: "ax_attribute"; attribute: string; value: string }
  | { type: "coordinates"; x: number; y: number }
  | { type: "image"; base64: string; confidence?: number };

export type WaitCondition =
  | { type: "selector_visible"; selector: string }
  | { type: "selector_hidden"; selector: string }
  | { type: "url_matches"; regex: string }
  | { type: "text_appears"; text: string }
  | { type: "spinner_disappears"; selector: string }
  | { type: "element_exists"; target: Target }
  | { type: "element_gone"; target: Target }
  | { type: "window_title_matches"; regex: string }
  | { type: "app_idle"; bundleId: string; timeoutMs?: number };

export type ExtractFormat = "text" | "table" | "json";

export type ActionStatus = "success" | "failed";

export interface ActionBudget {
  locateMs: number;
  actMs: number;
  verifyMs: number;
  maxRetries: number;
}

export interface SessionInfo {
  sessionId: string;
  profile: string;
  createdAt: string;
  adapterType?: "cdp" | "accessibility" | "applescript" | "vision" | "composite";
}

export interface PageMeta {
  url: string;
  title: string;
}

export interface AppContext {
  bundleId: string;
  appName: string;
  pid: number;
  windowTitle: string;
  windowId?: number;
  url?: string;
}

export interface LocatedElement {
  handleId: string;
  locatorUsed: string;
  role?: string;
  label?: string;
  coordinates?: { x: number; y: number; width: number; height: number };
}

export interface LocatorAttempt {
  strategy: string;
  target: string;
  timeoutMs: number;
  matched: boolean;
  reason?: string;
}

export interface RuntimeError {
  code:
    | "SESSION_NOT_FOUND"
    | "LOCATE_FAILED"
    | "ACTION_FAILED"
    | "VERIFY_FAILED"
    | "TIMEOUT"
    | "NOT_IMPLEMENTED"
    | "PERMISSION_DENIED"
    | "APP_NOT_FOUND"
    | "BRIDGE_ERROR";
  message: string;
  page?: PageMeta;
  appContext?: AppContext;
  attempts?: LocatorAttempt[];
  cause?: string;
}

export interface ActionTelemetry {
  action: string;
  sessionId: string;
  startedAt: string;
  finishedAt?: string;
  totalMs?: number;
  locateMs: number;
  actMs: number;
  verifyMs: number;
  retries: number;
  status?: ActionStatus;
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
  telemetry: ActionTelemetry;
}

export interface ToolFailure {
  ok: false;
  error: RuntimeError;
  telemetry: ActionTelemetry;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export interface PressInput {
  sessionId: string;
  target: Target;
  verify?: WaitCondition;
  budget?: Partial<ActionBudget>;
}

export interface TypeIntoInput {
  sessionId: string;
  target: Target;
  text: string;
  clear?: boolean;
  verifyValue?: boolean;
  verify?: WaitCondition;
  budget?: Partial<ActionBudget>;
}

export interface NavigateInput {
  sessionId: string;
  url: string;
  timeoutMs?: number;
}

export interface WaitForInput {
  sessionId: string;
  condition: WaitCondition;
  timeoutMs?: number;
}

export interface ExtractInput {
  sessionId: string;
  target: Target;
  format: ExtractFormat;
}

export interface ScreenshotInput {
  sessionId: string;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AppLaunchInput {
  sessionId: string;
  bundleId: string;
  waitForReady?: boolean;
}

export interface AppFocusInput {
  sessionId: string;
  bundleId: string;
}

export interface MenuClickInput {
  sessionId: string;
  menuPath: string[];
}

export interface KeyComboInput {
  sessionId: string;
  keys: string[];
}

export interface ElementTreeInput {
  sessionId: string;
  maxDepth?: number;
  root?: Target;
}

export interface DragInput {
  sessionId: string;
  from: Target;
  to: Target;
  budget?: Partial<ActionBudget>;
}

export interface ScrollInput {
  sessionId: string;
  target?: Target;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface ObserveStartInput {
  sessionId: string;
  events?: UIEventType[];
}

export interface ObserveStopInput {
  sessionId: string;
}

export type UIEventType =
  | "value_changed"
  | "focus_changed"
  | "window_created"
  | "window_closed"
  | "dialog_appeared"
  | "menu_opened"
  | "title_changed"
  | "layout_changed"
  | "app_activated"
  | "app_deactivated";

export interface UIEvent {
  type: UIEventType;
  timestamp: string;
  pid: number;
  bundleId?: string;
  elementRole?: string;
  elementLabel?: string;
  oldValue?: string;
  newValue?: string;
  windowTitle?: string;
}

export interface RunningApp {
  bundleId: string;
  name: string;
  pid: number;
  isActive: boolean;
}

export interface WindowInfo {
  windowId: number;
  title: string;
  bundleId: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  isOnScreen: boolean;
}

export interface AXNode {
  role: string;
  title?: string;
  value?: string;
  description?: string;
  identifier?: string;
  enabled?: boolean;
  focused?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  children?: AXNode[];
}
