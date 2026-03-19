// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { SharedPlaybook, ValidationResult } from "./types.js";
import type { ToolExecutor } from "../planner/executor.js";

/**
 * Tools that community playbooks are allowed to call.
 * Excludes: applescript (arbitrary code exec), browser_js (XSS),
 * browser_stealth (anti-detection), memory_* (data exfil),
 * supervisor_* (system control), job_* (persistence).
 */
const SAFE_TOOLS = new Set([
  "click", "click_text", "click_with_fallback", "type_text", "type_with_fallback",
  "key", "drag", "scroll", "scroll_with_fallback", "focus", "launch",
  "screenshot", "screenshot_file", "ocr", "ui_tree", "ui_find", "ui_press",
  "ui_set_value", "menu_click", "wait_for_state", "read_with_fallback",
  "locate_with_fallback", "select_with_fallback",
  "browser_open", "browser_navigate", "browser_click", "browser_type",
  "browser_dom", "browser_wait", "browser_page_info", "browser_tabs",
  "browser_fill_form", "browser_human_click",
  "windows", "apps",
]);

/**
 * PlaybookValidator — tests a community playbook against the live app
 * before accepting it into the local collection.
 */
export class PlaybookValidator {
  constructor(private readonly executeTool: ToolExecutor) {}

  /**
   * Validate a community playbook by executing its steps.
   * Runs all steps and reports success/failure.
   */
  async validate(playbook: SharedPlaybook): Promise<ValidationResult> {
    if (playbook.steps.length === 0) {
      return {
        playbook,
        success: false,
        stepsCompleted: 0,
        totalSteps: 0,
        errors: ["Playbook has no steps"],
        validatedAt: new Date().toISOString(),
      };
    }

    const errors: string[] = [];
    let stepsCompleted = 0;

    // Pre-validate: reject playbooks that use unsafe tools
    for (const step of playbook.steps) {
      if (!SAFE_TOOLS.has(step.tool)) {
        return {
          playbook,
          success: false,
          stepsCompleted: 0,
          totalSteps: playbook.steps.length,
          errors: [`Step "${step.description}" uses blocked tool "${step.tool}". Community playbooks cannot use this tool.`],
          validatedAt: new Date().toISOString(),
        };
      }
    }

    for (const step of playbook.steps) {
      try {
        const result = await this.executeTool(step.tool, step.params);
        if (result.ok) {
          stepsCompleted++;
        } else {
          errors.push(
            `Step ${stepsCompleted + 1} ("${step.description}") failed: ${result.error ?? "unknown error"}`,
          );
          break; // Stop on first failure
        }
      } catch (err) {
        errors.push(
          `Step ${stepsCompleted + 1} ("${step.description}") threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    }

    return {
      playbook,
      success: stepsCompleted === playbook.steps.length,
      stepsCompleted,
      totalSteps: playbook.steps.length,
      errors,
      validatedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate multiple playbooks and return the best one.
   */
  async findBest(playbooks: SharedPlaybook[]): Promise<ValidationResult | null> {
    for (const pb of playbooks) {
      const result = await this.validate(pb);
      if (result.success) return result;
    }
    return null;
  }
}
