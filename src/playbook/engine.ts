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

/**
 * Playbook Engine — executes playbooks step-by-step
 *
 * Known path → playbook (fast, deterministic, no AI)
 * Unknown state → AI fallback (slow, adaptive, learns)
 *
 * After AI recovers, the recovery steps get saved back into the playbook.
 */

import type { AutomationRuntimeService } from "../runtime/service.js";
import type { Playbook, PlaybookStep, PlaybookRunResult } from "./types.js";
import { readObserverState, getObserverPopup } from "../observer/state.js";
import type { DetectedPopup } from "../observer/types.js";

/** CDP client interface — matches what JobRunner already provides */
export interface CDPConnection {
  Runtime: { evaluate: (params: { expression: string; awaitPromise?: boolean; returnByValue?: boolean }) => Promise<any> };
  Input: {
    dispatchKeyEvent: (params: Record<string, unknown>) => Promise<any>;
    dispatchMouseEvent: (params: Record<string, unknown>) => Promise<any>;
  };
  close: () => Promise<void>;
}

const DEFAULT_VERIFY_TIMEOUT = 5000;
const STEP_DELAY_MS = 300;

/** Callback for reporting step outcomes to external systems (learning, memory, AppMap). */
export type PlaybookOutcomeCallback = (step: PlaybookStep, success: boolean, error: string | null) => void;

export class PlaybookEngine {
  private cdpConnect?: (port?: number) => Promise<CDPConnection>;
  private appleScriptRunner?: (script: string) => Promise<string>;
  /** Enable observer-based popup checks before each step */
  private popupCheckEnabled = false;
  /** Optional callback invoked after each step with outcome — wires into learning/memory. */
  private onOutcome?: PlaybookOutcomeCallback;

  constructor(private readonly runtime: AutomationRuntimeService) {}

  /** Set callback for step outcomes so PlaybookEngine feeds learning. */
  setOutcomeCallback(cb: PlaybookOutcomeCallback): void {
    this.onOutcome = cb;
  }

  /** Enable/disable pre-step popup detection via observer daemon */
  setPopupCheck(enabled: boolean): void {
    this.popupCheckEnabled = enabled;
  }

  /** Set CDP connection factory for browser_js and cdp_key_event actions. Factory accepts optional port override. */
  setCDPConnect(factory: (port?: number) => Promise<CDPConnection>): void {
    this.cdpConnect = factory;
  }

  /** Set AppleScript runner for applescript steps. Runner should execute the script and return stdout. */
  setAppleScriptRunner(runner: (script: string) => Promise<string>): void {
    this.appleScriptRunner = runner;
  }

  /**
   * Execute a playbook against a live session.
   * Returns result with success/failure and which step broke.
   */
  async run(
    sessionId: string,
    playbook: Playbook,
    options: { vars?: Record<string, string>; onStep?: (index: number, step: PlaybookStep, result: string) => void } = {},
  ): Promise<PlaybookRunResult> {
    const start = Date.now();
    let stepsCompleted = 0;

    for (let i = 0; i < playbook.steps.length; i++) {
      let step = options.vars ? this.substituteVars(playbook.steps[i]!, options.vars) : playbook.steps[i]!;

      try {
        // Pre-step: check for popups via observer (if enabled, non-blocking)
        if (this.popupCheckEnabled) {
          await this.dismissPopupIfPresent(sessionId);
        }

        // OCR-based locate: resolve locateByOcr to coordinates before execution
        if (step.locateByOcr) {
          const coords = this.resolveOcrTarget(step.locateByOcr, step.offsetX ?? 0, step.offsetY ?? 0);
          if (coords) {
            step = { ...step, target: { x: coords.x, y: coords.y } };
          }
        }

        const result = await this.executeStep(sessionId, step, playbook.cdpPort);
        stepsCompleted++;

        // Report success to learning pipeline
        if (this.onOutcome) this.onOutcome(step, true, null);

        if (options.onStep) {
          options.onStep(i, step, result);
        }

        // Verify step if needed
        if (step.verify) {
          const verified = await this.verifyStep(sessionId, step);
          if (!verified && !step.optional) {
            if (this.onOutcome) this.onOutcome(step, false, `Verification failed at step ${i}`);
            return {
              playbook: playbook.id,
              success: false,
              stepsCompleted,
              totalSteps: playbook.steps.length,
              failedAtStep: i,
              error: `Verification failed at step ${i}: ${step.description ?? step.action}`,
              durationMs: Date.now() - start,
            };
          }
        }

        // Small delay between steps for UI to settle
        await sleep(STEP_DELAY_MS);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Report failure to learning pipeline
        if (this.onOutcome) this.onOutcome(step, false, errMsg);

        if (step.optional) {
          stepsCompleted++;
          if (options.onStep) {
            options.onStep(i, step, `Skipped (optional): ${errMsg}`);
          }
          continue;
        }

        return {
          playbook: playbook.id,
          success: false,
          stepsCompleted,
          totalSteps: playbook.steps.length,
          failedAtStep: i,
          error: errMsg,
          durationMs: Date.now() - start,
        };
      }
    }

    return {
      playbook: playbook.id,
      success: true,
      stepsCompleted,
      totalSteps: playbook.steps.length,
      failedAtStep: -1,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Execute a single playbook step.
   */
  /** Tools that the PlaybookEngine refuses to execute (defense in depth). */
  private static readonly BLOCKED_ACTIONS = new Set([
    "browser_stealth",
    "memory_save", "memory_clear", "memory_snapshot",
    "supervisor_start", "supervisor_stop", "supervisor_install", "supervisor_uninstall",
    "job_create", "worker_start",
  ]);

  private async executeStep(sessionId: string, step: PlaybookStep, cdpPort?: number): Promise<string> {
    if (PlaybookEngine.BLOCKED_ACTIONS.has(step.action)) {
      throw new Error(`Blocked: playbook step uses restricted action "${step.action}"`);
    }
    const target = this.resolveTarget(step.target);

    switch (step.action) {
      case "navigate": {
        if (!step.url) throw new Error("navigate step missing url");
        const r = await this.runtime.navigate({ sessionId, url: step.url });
        if (!r.ok) throw new Error(r.error.message);
        return `Navigated to ${step.url}`;
      }

      case "press": {
        if (!target) throw new Error("press step missing target");
        const r = await this.runtime.press({ sessionId, target });
        if (!r.ok) throw new Error(r.error.message);
        return `Pressed ${JSON.stringify(step.target)}`;
      }

      case "type_into": {
        if (!step.text) throw new Error("type_into step missing text");
        if (target) {
          const r = await this.runtime.typeInto({ sessionId, target, text: step.text });
          if (!r.ok) throw new Error(r.error.message);
          return `Typed "${step.text}" into ${JSON.stringify(step.target)}`;
        }
        // No target — type into focused element character by character via key events
        for (const char of step.text) {
          const r = await this.runtime.keyCombo({ sessionId, keys: [char] });
          if (!r.ok) throw new Error(r.error?.message ?? "key event failed");
        }
        return `Typed "${step.text}" into focused element`;
      }

      case "extract": {
        if (!target) throw new Error("extract step missing target");
        const r = await this.runtime.extract({
          sessionId,
          target,
          format: step.format ?? "text",
        });
        if (!r.ok) throw new Error(r.error.message);
        return `Extracted: ${JSON.stringify(r.data).slice(0, 200)}`;
      }

      case "key":
      case "key_combo": {
        if (!step.keys || step.keys.length === 0) throw new Error(`${step.action} step missing keys`);
        const r = await this.runtime.keyCombo({ sessionId, keys: step.keys });
        if (!r.ok) throw new Error(r.error.message);
        return `${step.action === "key" ? "Key" : "Key combo"}: ${step.keys.join("+")}`;
      }

      case "menu_click": {
        if (!step.menuPath || step.menuPath.length === 0) throw new Error("menu_click step missing menuPath");
        const r = await this.runtime.menuClick({ sessionId, menuPath: step.menuPath });
        if (!r.ok) throw new Error(r.error.message);
        return `Menu click: ${step.menuPath.join(" > ")}`;
      }

      case "scroll": {
        const input: import("../types.js").ScrollInput = {
          sessionId,
          direction: step.direction ?? "down",
        };
        if (step.amount != null) input.amount = step.amount;
        const r = await this.runtime.scroll(input);
        if (!r.ok) throw new Error(r.error.message);
        return `Scrolled ${step.direction ?? "down"}`;
      }

      case "wait": {
        await sleep(step.ms ?? 1000);
        return `Waited ${step.ms ?? 1000}ms`;
      }

      case "screenshot": {
        const r = await this.runtime.screenshot({ sessionId });
        if (!r.ok) throw new Error(r.error.message);
        return `Screenshot taken`;
      }

      case "browser_js": {
        if (!step.code) throw new Error("browser_js step missing code");
        if (!this.cdpConnect) throw new Error("browser_js requires CDP — call setCDPConnect() first");
        const client = await this.cdpConnect(cdpPort);
        try {
          const result = await client.Runtime.evaluate({
            expression: step.code,
            awaitPromise: true,
            returnByValue: true,
          });
          if (result.exceptionDetails) {
            throw new Error(`JS Error: ${result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? "unknown"}`);
          }
          const val = result.result?.value;
          return `browser_js: ${typeof val === "object" ? JSON.stringify(val) : String(val ?? "undefined")}`;
        } finally {
          await client.close();
        }
      }

      case "browser_click":
      case "browser_human_click": {
        const selector = this.getBrowserSelector(step);
        if (!this.cdpConnect) throw new Error(`${step.action} requires CDP — call setCDPConnect() first`);
        const client = await this.cdpConnect(cdpPort);
        try {
          const point = await this.resolveBrowserClickPoint(client, selector);
          await this.dispatchMouseClick(client, point.x, point.y);
          return `${step.action}: clicked ${selector}`;
        } finally {
          await client.close();
        }
      }

      case "browser_type": {
        const selector = this.getBrowserSelector(step);
        if (!step.text) throw new Error("browser_type step missing text");
        if (!this.cdpConnect) throw new Error("browser_type requires CDP — call setCDPConnect() first");
        const client = await this.cdpConnect(cdpPort);
        try {
          await this.focusBrowserElement(client, selector);
          const shouldClear = step.text !== undefined;
          if (shouldClear) {
            await this.dispatchSelectAll(client);
            await this.dispatchKey(client, "Backspace", "Backspace");
            await sleep(50);
          }
          for (const char of step.text) {
            await this.dispatchTextChar(client, char);
            await sleep(50);
          }
          return `browser_type: typed ${step.text.length} chars into ${selector}`;
        } finally {
          await client.close();
        }
      }

      case "cdp_key_event": {
        if (!step.keyEvent) throw new Error("cdp_key_event step missing keyEvent");
        if (!this.cdpConnect) throw new Error("cdp_key_event requires CDP — call setCDPConnect() first");
        const client = await this.cdpConnect(cdpPort);
        try {
          const { key, code, modifiers, windowsVirtualKeyCode } = step.keyEvent;
          const baseParams = { key, code, modifiers: modifiers ?? 0, windowsVirtualKeyCode: windowsVirtualKeyCode ?? 0, nativeVirtualKeyCode: windowsVirtualKeyCode ?? 0 };
          await client.Input.dispatchKeyEvent({ type: "keyDown", ...baseParams });
          await client.Input.dispatchKeyEvent({ type: "keyUp", ...baseParams });
          return `cdp_key_event: ${modifiers ? `mod${modifiers}+` : ""}${key}`;
        } finally {
          await client.close();
        }
      }

      case "applescript": {
        if (!step.script) throw new Error("applescript step missing script");
        if (!this.appleScriptRunner) throw new Error("applescript requires runner — call setAppleScriptRunner() first");
        const result = await this.appleScriptRunner(step.script);
        return `applescript: ${result.substring(0, 200)}`;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /**
   * Substitute {VAR_NAME} placeholders in step string fields with actual values.
   */
  private substituteVars(step: PlaybookStep, vars: Record<string, string>): PlaybookStep {
    const sub = (s: string): string => {
      let result = s;
      for (const [key, val] of Object.entries(vars)) {
        result = result.replaceAll(`{${key}}`, val);
      }
      return result;
    };
    const result = { ...step };
    if (result.code) result.code = sub(result.code);
    if (result.text) result.text = sub(result.text);
    if (result.url) result.url = sub(result.url);
    if (result.description) result.description = sub(result.description);
    if (result.verify) result.verify = sub(result.verify);
    if (result.menuPath) result.menuPath = result.menuPath.map(sub);
    if (result.script) result.script = sub(result.script);
    return result;
  }

  /**
   * Verify a step's postcondition via CSS selector check.
   */
  private async verifyStep(sessionId: string, step: PlaybookStep): Promise<boolean> {
    if (!step.verify) return true;
    const timeout = step.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT;

    const r = await this.runtime.waitFor({
      sessionId,
      condition: { type: "selector_visible", selector: step.verify },
      timeoutMs: timeout,
    });

    return r.ok && r.data.matched;
  }

  /**
   * Dismiss a popup detected by the observer daemon.
   * Reads observer state, if popup found, sends the appropriate dismiss action.
   * Non-fatal — if observer isn't running or no popup, silently returns.
   */
  private async dismissPopupIfPresent(sessionId: string): Promise<void> {
    let popup: DetectedPopup | null;
    try {
      popup = getObserverPopup();
    } catch {
      return; // Observer not running or state unreadable
    }
    if (!popup) return;

    try {
      switch (popup.dismissAction) {
        case "press_escape":
          await this.runtime.keyCombo({ sessionId, keys: ["escape"] });
          break;
        case "click_ok":
        case "click_cancel":
        case "click_close":
        case "click_allow":
        case "click_deny": {
          // Map action to button text
          const buttonMap: Record<string, string> = {
            click_ok: "OK",
            click_cancel: "Cancel",
            click_close: "Close",
            click_allow: "Allow",
            click_deny: "Don't Allow",
          };
          const buttonText = buttonMap[popup.dismissAction] ?? "OK";
          // Try to click the button by text
          await this.runtime.press({ sessionId, target: { type: "text", value: buttonText } });
          break;
        }
        case "unknown":
          break; // Don't auto-dismiss unknown popups
      }
      // Wait briefly for popup to close
      await sleep(500);
    } catch {
      // Popup dismiss failed — non-fatal, continue with step
    }
  }

  /**
   * Resolve an OCR text target to screen coordinates using observer state.
   * Returns center coordinates of the matched text + offsets, or null if not found.
   */
  private resolveOcrTarget(
    searchText: string,
    offsetX: number,
    offsetY: number,
  ): { x: number; y: number } | null {
    let state;
    try {
      state = readObserverState();
    } catch {
      return null;
    }
    if (!state?.running || !state.lastFrame?.ocrText) return null;

    // Simple text search in OCR output
    // The native OCR (vision.ocr) returns bounding boxes when available.
    // For now we use a fallback: if the observer has the text, we know
    // the element is visible. The caller should provide approximate
    // coordinates via offsetX/offsetY relative to a known anchor.
    const ocrText = state.lastFrame.ocrText;
    if (!ocrText.toLowerCase().includes(searchText.toLowerCase())) {
      return null; // Text not found on screen
    }

    // Text found — return offset coordinates (caller provides absolute offsets
    // or relative to screen center as a basic heuristic)
    if (offsetX !== 0 || offsetY !== 0) {
      return { x: offsetX, y: offsetY };
    }

    // No explicit coordinates — can't determine position from plain OCR text alone
    return null;
  }

  /**
   * Convert playbook target format to runtime Target format.
   */
  private resolveTarget(target: PlaybookStep["target"]): import("../types.js").Target | undefined {
    if (!target) return undefined;

    if (typeof target === "string") {
      // CSS selector if starts with common patterns, else treat as text
      if (target.startsWith("[") || target.startsWith("#") || target.startsWith(".") || target.startsWith("css=")) {
        return { type: "selector", value: target.replace(/^css=/, "") };
      }
      return { type: "text", value: target };
    }

    if ("selector" in target) {
      return { type: "selector", value: target.selector };
    }

    if ("x" in target && "y" in target) {
      return { type: "coordinates", x: target.x, y: target.y };
    }

    return undefined;
  }

  private getBrowserSelector(step: PlaybookStep): string {
    if (typeof step.target === "string") return step.target;
    if (step.target && "selector" in step.target) return step.target.selector;
    if (step.verify) return step.verify;
    throw new Error(`${step.action} step missing selector target`);
  }

  private async focusBrowserElement(client: CDPConnection, selector: string): Promise<void> {
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!(el instanceof HTMLElement)) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
        el.scrollIntoView({ block: "center" });
        el.focus();
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (!value?.ok) {
      throw new Error(value?.reason || `Element not found: ${selector}`);
    }
  }

  private async resolveBrowserClickPoint(client: CDPConnection, selector: string): Promise<{ x: number; y: number }> {
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!(el instanceof HTMLElement)) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (!value?.ok) {
      throw new Error(value?.reason || `Element not found: ${selector}`);
    }
    return { x: value.x, y: value.y };
  }

  private async dispatchMouseClick(client: CDPConnection, x: number, y: number): Promise<void> {
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await sleep(40);
    await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(40);
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  private async dispatchSelectAll(client: CDPConnection): Promise<void> {
    const metaModifier = process.platform === "darwin" ? 4 : 2;
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: metaModifier });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: metaModifier });
  }

  private async dispatchKey(client: CDPConnection, key: string, code: string): Promise<void> {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key, code });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key, code });
  }

  private async dispatchTextChar(client: CDPConnection, char: string): Promise<void> {
    await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
    await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
