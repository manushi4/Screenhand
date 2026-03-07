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

import type {
  AXNode,
  AppContext,
  ExtractFormat,
  LocatedElement,
  PageMeta,
  RunningApp,
  SessionInfo,
  Target,
  WaitCondition,
  WindowInfo,
} from "../types.js";

/**
 * Universal adapter interface for controlling any application.
 * Extends beyond browsers to support native desktop apps via
 * accessibility APIs, AppleScript, vision, and more.
 */
export interface AppAdapter {
  /** Connect/attach to an application session. */
  attach(profile: string): Promise<SessionInfo>;

  /** Get current app context (replaces browser-only PageMeta for context). */
  getAppContext(sessionId: string): Promise<AppContext>;

  /** Get page metadata — for browser adapters returns URL+title; for desktop adapters returns window title. */
  getPageMeta(sessionId: string): Promise<PageMeta>;

  /** Navigate to a URL (browser) or open a path/resource (desktop). */
  navigate(sessionId: string, url: string, timeoutMs: number): Promise<PageMeta>;

  /** Locate an element on screen. */
  locate(sessionId: string, target: Target, timeoutMs: number): Promise<LocatedElement | null>;

  /** Click/press an element. */
  click(sessionId: string, element: LocatedElement): Promise<void>;

  /** Set the value of an input element. */
  setValue(sessionId: string, element: LocatedElement, text: string, clear: boolean): Promise<void>;

  /** Get the current value of an element. */
  getValue(sessionId: string, element: LocatedElement): Promise<string>;

  /** Wait for a condition to be met. */
  waitFor(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<boolean>;

  /** Extract data from an element. */
  extract(sessionId: string, target: Target, format: ExtractFormat): Promise<unknown>;

  /** Capture a screenshot. */
  screenshot(
    sessionId: string,
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<string>;

  // ── Desktop-specific methods (optional, adapters may throw NOT_IMPLEMENTED) ──

  /** Launch an application by bundle ID. */
  launchApp?(sessionId: string, bundleId: string): Promise<AppContext>;

  /** Focus/bring an application to front. */
  focusApp?(sessionId: string, bundleId: string): Promise<void>;

  /** List all running applications. */
  listApps?(sessionId: string): Promise<RunningApp[]>;

  /** List all windows. */
  listWindows?(sessionId: string): Promise<WindowInfo[]>;

  /** Click a menu item by path (e.g., ["File", "New Window"]). */
  menuClick?(sessionId: string, menuPath: string[]): Promise<void>;

  /** Send a keyboard shortcut (e.g., ["cmd", "c"]). */
  keyCombo?(sessionId: string, keys: string[]): Promise<void>;

  /** Get the accessibility element tree. */
  elementTree?(sessionId: string, maxDepth?: number, root?: Target): Promise<AXNode>;

  /** Drag from one target to another. */
  drag?(
    sessionId: string,
    from: LocatedElement,
    to: LocatedElement,
  ): Promise<void>;

  /** Scroll in a direction. */
  scroll?(
    sessionId: string,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    element?: LocatedElement,
  ): Promise<void>;
}

/**
 * Placeholder adapter that returns stubs for all methods.
 * Used for testing or when no real adapter is configured.
 */
export class PlaceholderAppAdapter implements AppAdapter {
  async attach(profile: string): Promise<SessionInfo> {
    return {
      sessionId: `session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
    };
  }

  async getAppContext(_sessionId: string): Promise<AppContext> {
    return {
      bundleId: "com.placeholder",
      appName: "Placeholder",
      pid: 0,
      windowTitle: "Placeholder Session",
    };
  }

  async getPageMeta(_sessionId: string): Promise<PageMeta> {
    return { url: "about:blank", title: "Placeholder Session" };
  }

  async navigate(_sessionId: string, url: string, _timeoutMs: number): Promise<PageMeta> {
    return { url, title: "Placeholder Navigation" };
  }

  async locate(_sessionId: string, _target: Target, _timeoutMs: number): Promise<LocatedElement | null> {
    throw new Error("App adapter not implemented: locate");
  }

  async click(_sessionId: string, _element: LocatedElement): Promise<void> {
    throw new Error("App adapter not implemented: click");
  }

  async setValue(_sessionId: string, _element: LocatedElement, _text: string, _clear: boolean): Promise<void> {
    throw new Error("App adapter not implemented: setValue");
  }

  async getValue(_sessionId: string, _element: LocatedElement): Promise<string> {
    throw new Error("App adapter not implemented: getValue");
  }

  async waitFor(_sessionId: string, _condition: WaitCondition, _timeoutMs: number): Promise<boolean> {
    throw new Error("App adapter not implemented: waitFor");
  }

  async extract(_sessionId: string, _target: Target, _format: ExtractFormat): Promise<unknown> {
    throw new Error("App adapter not implemented: extract");
  }

  async screenshot(_sessionId: string, _region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    throw new Error("App adapter not implemented: screenshot");
  }
}
