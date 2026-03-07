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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
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

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 100;

/** Apps known to have AppleScript scripting dictionaries. */
const SCRIPTABLE_APPS: Record<string, string> = {
  "com.apple.finder": "Finder",
  "com.apple.Safari": "Safari",
  "com.apple.mail": "Mail",
  "com.apple.iWork.Pages": "Pages",
  "com.apple.iWork.Keynote": "Keynote",
  "com.apple.iWork.Numbers": "Numbers",
  "com.apple.Notes": "Notes",
  "com.apple.reminders": "Reminders",
  "com.apple.iCal": "Calendar",
  "com.apple.TextEdit": "TextEdit",
  "com.apple.Preview": "Preview",
  "com.apple.systempreferences": "System Preferences",
  "com.apple.Terminal": "Terminal",
  "com.apple.Music": "Music",
  "com.apple.TV": "TV",
  "com.apple.Podcasts": "Podcasts",
};

interface ASSessionState {
  info: SessionInfo;
  appName: string;
  bundleId: string;
}

export class AppleScriptAdapter implements AppAdapter {
  private readonly sessions = new Map<string, ASSessionState>();
  private readonly sessionsByProfile = new Map<string, ASSessionState>();

  /** Check if a bundle ID is scriptable. */
  static isScriptable(bundleId: string): boolean {
    return bundleId in SCRIPTABLE_APPS;
  }

  async attach(profile: string, reuseSessionId?: string): Promise<SessionInfo> {
    const existing = this.sessionsByProfile.get(profile);
    if (existing) return existing.info;

    const info: SessionInfo = {
      sessionId: reuseSessionId ?? `as_session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
      adapterType: "applescript",
    };

    // Default to Finder
    const state: ASSessionState = {
      info,
      appName: "Finder",
      bundleId: "com.apple.finder",
    };

    this.sessions.set(info.sessionId, state);
    this.sessionsByProfile.set(profile, state);
    return info;
  }

  async getAppContext(sessionId: string): Promise<AppContext> {
    const state = this.requireSession(sessionId);
    const windowTitle = await this.runScript(
      `tell application "${state.appName}" to get name of front window`,
    ).catch(() => state.appName);

    const pidStr = await this.runScript(
      `tell application "System Events" to get unix id of (first process whose bundle identifier is "${state.bundleId}")`,
    ).catch(() => "0");

    return {
      bundleId: state.bundleId,
      appName: state.appName,
      pid: parseInt(pidStr, 10) || 0,
      windowTitle,
    };
  }

  async getPageMeta(sessionId: string): Promise<PageMeta> {
    const ctx = await this.getAppContext(sessionId);
    let url = `app://${ctx.bundleId}`;

    // For Safari, get the current URL
    if (ctx.bundleId === "com.apple.Safari") {
      try {
        url = await this.runScript(
          'tell application "Safari" to get URL of current tab of front window',
        );
      } catch {
        // Ignore
      }
    }

    return { url, title: ctx.windowTitle };
  }

  async navigate(sessionId: string, url: string, _timeoutMs: number): Promise<PageMeta> {
    const state = this.requireSession(sessionId);

    if (url.startsWith("app://")) {
      const bundleId = url.slice(6);
      const appName = SCRIPTABLE_APPS[bundleId] ?? bundleId;
      state.bundleId = bundleId;
      state.appName = appName;
      await this.runScript(`tell application "${appName}" to activate`);
    } else if (state.bundleId === "com.apple.Safari") {
      await this.runScript(
        `tell application "Safari" to set URL of current tab of front window to "${this.escapeAS(url)}"`,
      );
    } else if (state.bundleId === "com.apple.finder") {
      // Open path in Finder
      await this.runScript(
        `tell application "Finder" to open POSIX file "${this.escapeAS(url)}"`,
      );
    }

    return this.getPageMeta(sessionId);
  }

  async locate(sessionId: string, target: Target, timeoutMs: number): Promise<LocatedElement | null> {
    const state = this.requireSession(sessionId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const script = this.buildLocateScript(state, target);
        const result = await this.runScript(script);
        if (result && result !== "missing value") {
          return {
            handleId: `as_${result.replace(/\s+/g, "_").slice(0, 50)}`,
            locatorUsed: `applescript:${target.type}`,
            label: result,
          };
        }
      } catch {
        // Not found yet
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async click(sessionId: string, element: LocatedElement): Promise<void> {
    const state = this.requireSession(sessionId);
    await this.runScript(
      `tell application "System Events" to tell process "${state.appName}" to click button "${this.escapeAS(element.label ?? element.handleId)}" of front window`,
    );
  }

  async setValue(sessionId: string, element: LocatedElement, text: string, _clear: boolean): Promise<void> {
    const state = this.requireSession(sessionId);
    await this.runScript(
      `tell application "System Events" to tell process "${state.appName}" to set value of text field "${this.escapeAS(element.label ?? "")}" of front window to "${this.escapeAS(text)}"`,
    );
  }

  async getValue(sessionId: string, element: LocatedElement): Promise<string> {
    const state = this.requireSession(sessionId);
    return this.runScript(
      `tell application "System Events" to tell process "${state.appName}" to get value of text field "${this.escapeAS(element.label ?? "")}" of front window`,
    );
  }

  async waitFor(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (condition.type === "text_appears") {
          const found = await this.locate(
            sessionId,
            { type: "text", value: condition.text },
            200,
          );
          if (found) return true;
        } else if (condition.type === "window_title_matches") {
          const ctx = await this.getAppContext(sessionId);
          if (new RegExp(condition.regex).test(ctx.windowTitle)) return true;
        }
      } catch {
        // Keep trying
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  async extract(sessionId: string, target: Target, format: ExtractFormat): Promise<unknown> {
    const state = this.requireSession(sessionId);

    if (state.bundleId === "com.apple.finder" && format === "json") {
      // Get selected files
      const result = await this.runScript(
        'tell application "Finder" to get name of every item of (target of front window) as list',
      );
      return { items: result.split(", ") };
    }

    // Generic: extract UI element text
    const element = await this.locate(sessionId, target, 1500);
    if (!element) throw new Error("Extract target not found");
    return element.label ?? "";
  }

  async screenshot(_sessionId: string, _region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const path = `/tmp/as_screenshot_${Date.now()}.png`;
    await this.runScript(
      `do shell script "screencapture -x '${path}'"`,
    );
    return path;
  }

  // ── Desktop methods ──

  async launchApp(sessionId: string, bundleId: string): Promise<AppContext> {
    const state = this.requireSession(sessionId);
    const appName = SCRIPTABLE_APPS[bundleId] ?? bundleId;
    await this.runScript(`tell application "${appName}" to activate`);
    state.bundleId = bundleId;
    state.appName = appName;
    return this.getAppContext(sessionId);
  }

  async focusApp(sessionId: string, bundleId: string): Promise<void> {
    const appName = SCRIPTABLE_APPS[bundleId] ?? bundleId;
    await this.runScript(`tell application "${appName}" to activate`);
    const state = this.requireSession(sessionId);
    state.bundleId = bundleId;
    state.appName = appName;
  }

  async listApps(_sessionId: string): Promise<RunningApp[]> {
    const result = await this.runScript(
      'tell application "System Events" to get {bundle identifier, name, unix id, frontmost} of every application process whose background only is false',
    );
    // Parse the AppleScript list output
    const parts = result.split(", ");
    const count = Math.floor(parts.length / 4);
    const apps: RunningApp[] = [];
    for (let i = 0; i < count; i++) {
      apps.push({
        bundleId: parts[i] ?? "unknown",
        name: parts[count + i] ?? "Unknown",
        pid: parseInt(parts[2 * count + i] ?? "0", 10),
        isActive: parts[3 * count + i] === "true",
      });
    }
    return apps;
  }

  async listWindows(_sessionId: string): Promise<WindowInfo[]> {
    // Simplified — AppleScript window listing is limited
    const result = await this.runScript(
      'tell application "System Events" to get {name, position, size} of every window of (first process whose frontmost is true)',
    );
    return [{
      windowId: 0,
      title: result,
      bundleId: "",
      pid: 0,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      isOnScreen: true,
    }];
  }

  async menuClick(sessionId: string, menuPath: string[]): Promise<void> {
    const state = this.requireSession(sessionId);
    if (menuPath.length === 0) throw new Error("menuPath must not be empty");

    let script = `tell application "System Events" to tell process "${state.appName}"\n`;
    if (menuPath.length === 1) {
      script += `  click menu item "${this.escapeAS(menuPath[0]!)}" of menu bar 1\n`;
    } else if (menuPath.length === 2) {
      script += `  click menu item "${this.escapeAS(menuPath[1]!)}" of menu "${this.escapeAS(menuPath[0]!)}" of menu bar 1\n`;
    } else {
      // Deep menu path
      script += `  click menu item "${this.escapeAS(menuPath[menuPath.length - 1]!)}" of menu "${this.escapeAS(menuPath[menuPath.length - 2]!)}"`;
      for (let i = menuPath.length - 3; i >= 0; i--) {
        script += ` of menu item "${this.escapeAS(menuPath[i]!)}" of menu "${this.escapeAS(menuPath[i]!)}"`;
      }
      script += ` of menu bar 1\n`;
    }
    script += `end tell`;

    await this.runScript(script);
  }

  async keyCombo(_sessionId: string, keys: string[]): Promise<void> {
    const modifiers: string[] = [];
    let keyChar = "";

    for (const key of keys) {
      const lower = key.toLowerCase();
      if (lower === "cmd" || lower === "command") modifiers.push("command down");
      else if (lower === "shift") modifiers.push("shift down");
      else if (lower === "alt" || lower === "option") modifiers.push("option down");
      else if (lower === "ctrl" || lower === "control") modifiers.push("control down");
      else keyChar = lower;
    }

    const modStr = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
    await this.runScript(
      `tell application "System Events" to keystroke "${this.escapeAS(keyChar)}"${modStr}`,
    );
  }

  // ── Private helpers ──

  private requireSession(sessionId: string): ASSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    return state;
  }

  private async runScript(script: string): Promise<string> {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 10_000,
    });
    return stdout.trim();
  }

  private buildLocateScript(state: ASSessionState, target: Target): string {
    const proc = state.appName;

    if (target.type === "text" || target.type === "role") {
      const searchText = target.type === "text" ? target.value : target.name;
      return `tell application "System Events" to tell process "${proc}" to get name of first UI element of front window whose name contains "${this.escapeAS(searchText)}"`;
    }

    if (target.type === "selector") {
      return `tell application "System Events" to tell process "${proc}" to get name of first UI element of front window whose description contains "${this.escapeAS(target.value)}"`;
    }

    throw new Error(`AppleScript adapter does not support target type: ${target.type}`);
  }

  private escapeAS(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
