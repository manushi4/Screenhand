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

const DEFAULT_VERIFY_TIMEOUT = 5000;
const STEP_DELAY_MS = 300;

export class PlaybookEngine {
  constructor(private readonly runtime: AutomationRuntimeService) {}

  /**
   * Execute a playbook against a live session.
   * Returns result with success/failure and which step broke.
   */
  async run(
    sessionId: string,
    playbook: Playbook,
    options: { onStep?: (index: number, step: PlaybookStep, result: string) => void } = {},
  ): Promise<PlaybookRunResult> {
    const start = Date.now();
    let stepsCompleted = 0;

    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i]!;

      try {
        const result = await this.executeStep(sessionId, step);
        stepsCompleted++;

        if (options.onStep) {
          options.onStep(i, step, result);
        }

        // Verify step if needed
        if (step.verify) {
          const verified = await this.verifyStep(sessionId, step);
          if (!verified && !step.optional) {
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
        if (step.optional) {
          stepsCompleted++;
          if (options.onStep) {
            options.onStep(i, step, `Skipped (optional): ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }

        return {
          playbook: playbook.id,
          success: false,
          stepsCompleted,
          totalSteps: playbook.steps.length,
          failedAtStep: i,
          error: err instanceof Error ? err.message : String(err),
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
  private async executeStep(sessionId: string, step: PlaybookStep): Promise<string> {
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
        if (!target) throw new Error("type_into step missing target");
        if (!step.text) throw new Error("type_into step missing text");
        const r = await this.runtime.typeInto({ sessionId, target, text: step.text });
        if (!r.ok) throw new Error(r.error.message);
        return `Typed "${step.text}" into ${JSON.stringify(step.target)}`;
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

      case "key_combo": {
        if (!step.keys || step.keys.length === 0) throw new Error("key_combo step missing keys");
        const r = await this.runtime.keyCombo({ sessionId, keys: step.keys });
        if (!r.ok) throw new Error(r.error.message);
        return `Key combo: ${step.keys.join("+")}`;
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

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
