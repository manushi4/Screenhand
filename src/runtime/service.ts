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

import {
  DEFAULT_NAVIGATE_TIMEOUT_MS,
  DEFAULT_PROFILE,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "../config.js";
import type { TimelineLogger } from "../logging/timeline-logger.js";
import type {
  AXNode,
  AppContext,
  AppFocusInput,
  AppLaunchInput,
  DragInput,
  ElementTreeInput,
  ExtractInput,
  KeyComboInput,
  MenuClickInput,
  NavigateInput,
  ObserveStartInput,
  ObserveStopInput,
  PageMeta,
  PressInput,
  RunningApp,
  ScreenshotInput,
  ScrollInput,
  SessionInfo,
  ToolResult,
  TypeIntoInput,
  WaitForInput,
  WindowInfo,
} from "../types.js";
import type { AppAdapter } from "./app-adapter.js";
import { Executor } from "./executor.js";
import { LocatorCache } from "./locator-cache.js";
import { SessionManager } from "./session-manager.js";

export class AutomationRuntimeService {
  private readonly sessions: SessionManager;
  private readonly executor: Executor;

  constructor(
    private readonly adapter: AppAdapter,
    private readonly logger: TimelineLogger,
    cache = new LocatorCache(),
  ) {
    this.sessions = new SessionManager(adapter);
    this.executor = new Executor(adapter, cache, logger);
  }

  async sessionStart(profile = DEFAULT_PROFILE): Promise<SessionInfo> {
    return this.sessions.sessionStart(profile);
  }

  async navigate(input: NavigateInput): Promise<ToolResult<PageMeta>> {
    const telemetry = this.logger.start("navigate", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      const page = await this.adapter.navigate(
        input.sessionId,
        input.url,
        input.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS,
      );
      return {
        ok: true,
        data: page,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Navigate failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async waitFor(input: WaitForInput): Promise<ToolResult<{ matched: boolean }>> {
    const telemetry = this.logger.start("wait_for", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      const matched = await this.adapter.waitFor(
        input.sessionId,
        input.condition,
        input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      );
      return {
        ok: true,
        data: { matched },
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Wait failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async press(input: PressInput): Promise<ToolResult<PageMeta>> {
    await this.sessions.requireSessionResilent(input.sessionId);
    return this.executor.press(input);
  }

  async typeInto(input: TypeIntoInput): Promise<ToolResult<PageMeta>> {
    await this.sessions.requireSessionResilent(input.sessionId);
    return this.executor.typeInto(input);
  }

  async extract(input: ExtractInput): Promise<ToolResult<unknown>> {
    const telemetry = this.logger.start("extract", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      const data = await this.adapter.extract(
        input.sessionId,
        input.target,
        input.format,
      );
      return {
        ok: true,
        data,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Extract failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async screenshot(input: ScreenshotInput): Promise<ToolResult<{ path: string }>> {
    const telemetry = this.logger.start("screenshot", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      const path = await this.adapter.screenshot(input.sessionId, input.region);
      return {
        ok: true,
        data: { path },
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Screenshot failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  // ── Desktop-specific methods ──

  async appLaunch(input: AppLaunchInput): Promise<ToolResult<AppContext>> {
    const telemetry = this.logger.start("app_launch", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.launchApp) {
        throw new Error("Adapter does not support launchApp");
      }
      const ctx = await this.adapter.launchApp(input.sessionId, input.bundleId);
      return {
        ok: true,
        data: ctx,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "App launch failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async appFocus(input: AppFocusInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("app_focus", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.focusApp) {
        throw new Error("Adapter does not support focusApp");
      }
      await this.adapter.focusApp(input.sessionId, input.bundleId);
      return {
        ok: true,
        data: undefined,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "App focus failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async appList(sessionId: string): Promise<ToolResult<RunningApp[]>> {
    const telemetry = this.logger.start("app_list", sessionId);
    try {
      await this.sessions.requireSessionResilent(sessionId);
      if (!this.adapter.listApps) {
        throw new Error("Adapter does not support listApps");
      }
      const apps = await this.adapter.listApps(sessionId);
      return {
        ok: true,
        data: apps,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "App list failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async windowList(sessionId: string): Promise<ToolResult<WindowInfo[]>> {
    const telemetry = this.logger.start("window_list", sessionId);
    try {
      await this.sessions.requireSessionResilent(sessionId);
      if (!this.adapter.listWindows) {
        throw new Error("Adapter does not support listWindows");
      }
      const windows = await this.adapter.listWindows(sessionId);
      return {
        ok: true,
        data: windows,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Window list failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async menuClick(input: MenuClickInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("menu_click", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.menuClick) {
        throw new Error("Adapter does not support menuClick");
      }
      await this.adapter.menuClick(input.sessionId, input.menuPath);
      return {
        ok: true,
        data: undefined,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Menu click failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async keyCombo(input: KeyComboInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("key_combo", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.keyCombo) {
        throw new Error("Adapter does not support keyCombo");
      }
      await this.adapter.keyCombo(input.sessionId, input.keys);
      return {
        ok: true,
        data: undefined,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Key combo failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async elementTree(input: ElementTreeInput): Promise<ToolResult<AXNode>> {
    const telemetry = this.logger.start("element_tree", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.elementTree) {
        throw new Error("Adapter does not support elementTree");
      }
      const tree = await this.adapter.elementTree(
        input.sessionId,
        input.maxDepth,
        input.root,
      );
      return {
        ok: true,
        data: tree,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Element tree failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async drag(input: DragInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("drag", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.drag) {
        throw new Error("Adapter does not support drag");
      }
      const fromEl = await this.adapter.locate(input.sessionId, input.from, 800);
      const toEl = await this.adapter.locate(input.sessionId, input.to, 800);
      if (!fromEl || !toEl) {
        throw new Error("Could not locate drag source or destination");
      }
      await this.adapter.drag(input.sessionId, fromEl, toEl);
      return {
        ok: true,
        data: undefined,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Drag failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async scroll(input: ScrollInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("scroll", input.sessionId);
    try {
      await this.sessions.requireSessionResilent(input.sessionId);
      if (!this.adapter.scroll) {
        throw new Error("Adapter does not support scroll");
      }
      let element: import("../types.js").LocatedElement | undefined;
      if (input.target) {
        const found = await this.adapter.locate(input.sessionId, input.target, 800);
        if (found) element = found;
      }
      await this.adapter.scroll(
        input.sessionId,
        input.direction,
        input.amount ?? 3,
        element,
      );
      return {
        ok: true,
        data: undefined,
        telemetry: this.logger.finish(telemetry, "success"),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: error instanceof Error ? error.message : "Scroll failed",
        },
        telemetry: this.logger.finish(telemetry, "failed"),
      };
    }
  }

  async observeStart(_input: ObserveStartInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("observe_start", _input.sessionId);
    // Implemented in Phase 4 when StateObserver is available
    return {
      ok: true,
      data: undefined,
      telemetry: this.logger.finish(telemetry, "success"),
    };
  }

  async observeStop(_input: ObserveStopInput): Promise<ToolResult<void>> {
    const telemetry = this.logger.start("observe_stop", _input.sessionId);
    return {
      ok: true,
      data: undefined,
      telemetry: this.logger.finish(telemetry, "success"),
    };
  }

  getTimeline(limit = 100) {
    return this.logger.getRecent(limit);
  }
}
