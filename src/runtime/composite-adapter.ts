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
import type { AppAdapter } from "./app-adapter.js";
import type { BridgeClient } from "../native/bridge-client.js";
// Legacy alias for backward compatibility
type MacOSBridgeClient = BridgeClient;
import { AccessibilityAdapter } from "./accessibility-adapter.js";
import { AppleScriptAdapter } from "./applescript-adapter.js";
import { CdpChromeAdapter, type CdpChromeAdapterOptions } from "./cdp-chrome-adapter.js";
import { VisionAdapter } from "./vision-adapter.js";

/** macOS bundle IDs routed to CDP. */
const BROWSER_BUNDLES = new Set([
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "com.vivaldi.Vivaldi",
  "org.chromium.Chromium",
]);

/** Windows process names routed to CDP. */
const BROWSER_PROCESS_NAMES = new Set([
  "chrome",
  "chrome.exe",
  "brave",
  "brave.exe",
  "msedge",
  "msedge.exe",
  "vivaldi",
  "vivaldi.exe",
  "chromium",
  "chromium.exe",
]);

const isWindows = process.platform === "win32";

interface SessionRouting {
  adapter: AppAdapter;
  adapterName: string;
}

/**
 * Composite adapter that auto-selects the best adapter per app:
 *   - Chromium browsers → CDP
 *   - Scriptable apps → AppleScript (with AX fallback)
 *   - Default → Accessibility
 *   - Fallback → Vision (if AX locate fails)
 */
export class CompositeAdapter implements AppAdapter {
  private readonly cdp: CdpChromeAdapter;
  private readonly accessibility: AccessibilityAdapter;
  private readonly applescript: AppleScriptAdapter;
  private readonly vision: VisionAdapter;

  private readonly sessionRouting = new Map<string, SessionRouting>();

  constructor(
    private readonly bridge: MacOSBridgeClient,
    cdpOptions?: CdpChromeAdapterOptions,
  ) {
    this.cdp = new CdpChromeAdapter(cdpOptions);
    this.accessibility = new AccessibilityAdapter(bridge);
    this.applescript = new AppleScriptAdapter();
    this.vision = new VisionAdapter(bridge);
  }

  async attach(profile: string): Promise<SessionInfo> {
    // Default to accessibility adapter; routing is set per-session when app is known
    const info = await this.accessibility.attach(profile);
    this.sessionRouting.set(info.sessionId, {
      adapter: this.accessibility,
      adapterName: "accessibility",
    });

    // Override adapterType
    return { ...info, adapterType: "composite" };
  }

  async getAppContext(sessionId: string): Promise<AppContext> {
    return this.getAdapter(sessionId).getAppContext(sessionId);
  }

  async getPageMeta(sessionId: string): Promise<PageMeta> {
    return this.getAdapter(sessionId).getPageMeta(sessionId);
  }

  async navigate(sessionId: string, url: string, timeoutMs: number): Promise<PageMeta> {
    return this.getAdapter(sessionId).navigate(sessionId, url, timeoutMs);
  }

  async locate(sessionId: string, target: Target, timeoutMs: number): Promise<LocatedElement | null> {
    const primary = this.getAdapter(sessionId);
    const result = await primary.locate(sessionId, target, timeoutMs);
    if (result) return result;

    // Fallback to vision if primary (accessibility/applescript) fails
    const routing = this.sessionRouting.get(sessionId);
    if (routing && routing.adapterName !== "vision" && routing.adapterName !== "cdp") {
      try {
        return await this.vision.locate(sessionId, target, Math.min(timeoutMs, 2000));
      } catch {
        // Vision also failed
      }
    }

    return null;
  }

  async click(sessionId: string, element: LocatedElement): Promise<void> {
    // If the element was found by vision (coordinates-based), use vision adapter for click
    if (element.locatorUsed.startsWith("vision:") && element.coordinates) {
      return this.vision.click(sessionId, element);
    }
    return this.getAdapter(sessionId).click(sessionId, element);
  }

  async setValue(sessionId: string, element: LocatedElement, text: string, clear: boolean): Promise<void> {
    return this.getAdapter(sessionId).setValue(sessionId, element, text, clear);
  }

  async getValue(sessionId: string, element: LocatedElement): Promise<string> {
    return this.getAdapter(sessionId).getValue(sessionId, element);
  }

  async waitFor(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    return this.getAdapter(sessionId).waitFor(sessionId, condition, timeoutMs);
  }

  async extract(sessionId: string, target: Target, format: ExtractFormat): Promise<unknown> {
    return this.getAdapter(sessionId).extract(sessionId, target, format);
  }

  async screenshot(sessionId: string, region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    return this.getAdapter(sessionId).screenshot(sessionId, region);
  }

  // ── Desktop methods (delegate to the best adapter that supports them) ──

  async launchApp(sessionId: string, bundleId: string): Promise<AppContext> {
    // Route to the appropriate adapter based on the app being launched
    this.routeSession(sessionId, bundleId);

    const adapter = this.getAdapter(sessionId);
    if (adapter.launchApp) {
      return adapter.launchApp(sessionId, bundleId);
    }
    // Fallback to accessibility
    return this.accessibility.launchApp(sessionId, bundleId);
  }

  async focusApp(sessionId: string, bundleId: string): Promise<void> {
    this.routeSession(sessionId, bundleId);
    const adapter = this.getAdapter(sessionId);
    if (adapter.focusApp) {
      return adapter.focusApp(sessionId, bundleId);
    }
    return this.accessibility.focusApp(sessionId, bundleId);
  }

  async listApps(sessionId: string): Promise<RunningApp[]> {
    return this.accessibility.listApps(sessionId);
  }

  async listWindows(sessionId: string): Promise<WindowInfo[]> {
    return this.accessibility.listWindows(sessionId);
  }

  async menuClick(sessionId: string, menuPath: string[]): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    if (adapter.menuClick) {
      return adapter.menuClick(sessionId, menuPath);
    }
    return this.accessibility.menuClick(sessionId, menuPath);
  }

  async keyCombo(sessionId: string, keys: string[]): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    if (adapter.keyCombo) {
      return adapter.keyCombo(sessionId, keys);
    }
    return this.accessibility.keyCombo(sessionId, keys);
  }

  async elementTree(sessionId: string, maxDepth?: number, root?: Target): Promise<AXNode> {
    const adapter = this.getAdapter(sessionId);
    if (adapter.elementTree) {
      return adapter.elementTree(sessionId, maxDepth, root);
    }
    return this.accessibility.elementTree(sessionId, maxDepth, root);
  }

  async drag(sessionId: string, from: LocatedElement, to: LocatedElement): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    if (adapter.drag) {
      return adapter.drag(sessionId, from, to);
    }
    return this.accessibility.drag(sessionId, from, to);
  }

  async scroll(sessionId: string, direction: "up" | "down" | "left" | "right", amount: number, element?: LocatedElement): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    if (adapter.scroll) {
      return adapter.scroll(sessionId, direction, amount, element);
    }
    return this.accessibility.scroll(sessionId, direction, amount, element);
  }

  // ── Routing logic ──

  private routeSession(sessionId: string, bundleId: string): void {
    let adapter: AppAdapter;
    let adapterName: string;

    if (isWindows) {
      // On Windows: route by process name
      const processName = bundleId.toLowerCase().replace(/\.exe$/, "");
      if (BROWSER_PROCESS_NAMES.has(processName) || BROWSER_PROCESS_NAMES.has(bundleId.toLowerCase())) {
        adapter = this.cdp;
        adapterName = "cdp";
      } else {
        // No AppleScript on Windows — always use accessibility (UI Automation)
        adapter = this.accessibility;
        adapterName = "accessibility";
      }
    } else {
      // On macOS: route by bundle ID
      if (BROWSER_BUNDLES.has(bundleId)) {
        adapter = this.cdp;
        adapterName = "cdp";
      } else if (AppleScriptAdapter.isScriptable(bundleId)) {
        adapter = this.applescript;
        adapterName = "applescript";
      } else {
        adapter = this.accessibility;
        adapterName = "accessibility";
      }
    }

    this.sessionRouting.set(sessionId, { adapter, adapterName });
  }

  private getAdapter(sessionId: string): AppAdapter {
    const routing = this.sessionRouting.get(sessionId);
    return routing?.adapter ?? this.accessibility;
  }
}
