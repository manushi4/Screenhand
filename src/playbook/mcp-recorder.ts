// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * McpPlaybookRecorder — captures MCP tool calls as PlaybookSteps.
 *
 * Start recording → agent does the flow → stop → saves as executable playbook.
 * Like a macro recorder, but for AI tool calls.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import { redactPII } from "../util/sanitize.js";
import type { Playbook, PlaybookStep } from "./types.js";

/** Tools that are observation-only — not recorded as steps */
const SKIP_TOOLS = new Set([
  "screenshot", "screenshot_file",
  "ui_tree", "ui_find", "browser_dom", "browser_page_info", "browser_tabs",
  "ocr", "apps", "windows", "memory_recall", "memory_save", "memory_snapshot",
  "memory_stats", "memory_errors", "memory_query_patterns", "memory_record_error",
  "memory_record_learning", "memory_clear", "platform_guide", "playbook_preflight",
  "export_playbook", "playbook_record", "job_create", "job_status", "job_list",
  "job_run", "job_run_all", "job_create_chain", "job_remove", "job_transition",
  "job_step_done", "job_step_fail", "job_resume", "job_dequeue",
  "worker_start", "worker_stop", "worker_status",
  "supervisor_status", "supervisor_start", "supervisor_stop",
  "supervisor_pause", "supervisor_resume", "supervisor_install", "supervisor_uninstall",
  "session_claim", "session_heartbeat", "session_release",
  "recovery_queue_add", "recovery_queue_list",
  "codex_monitor_start", "codex_monitor_status", "codex_monitor_add_task",
  "codex_monitor_tasks", "codex_monitor_assign_now", "codex_monitor_stop",
  "platform_learn", "platform_explore",
  // Observation tools — not steps
  "read_with_fallback", "locate_with_fallback", "execution_plan",
  "browser_stealth",
  // Observer/orchestrator lifecycle — not steps
  "observer_start", "observer_stop", "observer_status", "observer_ocr_roi",
  "orchestrator_start", "orchestrator_stop", "orchestrator_submit", "orchestrator_status",
  // Ingestion/discovery — learning, not steps
  "scan_menu_bar", "ingest_documentation", "ingest_tutorial",
  "discover_features", "coverage_report",
]);

/** Map MCP tool names to PlaybookStep actions */
function mapToolToAction(toolName: string): PlaybookStep["action"] | null {
  switch (toolName) {
    case "browser_navigate": case "browser_open": return "navigate";
    case "click": case "click_text": case "browser_click":
    case "browser_human_click":
    case "click_with_fallback": case "ui_press": return "press";
    case "type_text": case "browser_type": case "browser_fill_form":
    case "type_with_fallback": return "type_into";
    case "key": return "key";
    case "menu_click": return "menu_click";
    case "scroll": case "scroll_with_fallback": return "scroll";
    case "browser_js": return "browser_js";
    case "screenshot": case "screenshot_file": return "screenshot";
    case "browser_wait": case "wait_for_state": return "wait";
    case "applescript": return "applescript";
    case "ui_set_value": return "type_into";
    case "select_with_fallback": return "press";
    case "focus": case "launch": return null; // useful context but not a step
    case "drag": return null; // drag is complex, skip for now
    default: return null;
  }
}

/** Build a PlaybookStep from an MCP tool call */
function buildStep(
  toolName: string,
  params: Record<string, unknown>,
  success: boolean,
): PlaybookStep | null {
  const action = mapToolToAction(toolName);
  if (!action) return null;

  const step: PlaybookStep = { action };

  switch (action) {
    case "navigate":
      step.url = String(params.url ?? "");
      step.description = `Navigate to ${step.url}`;
      break;

    case "press":
      step.target = String(params.selector ?? params.text ?? params.title ?? params.target ?? "");
      step.description = `Click ${step.target}`;
      break;

    case "type_into":
      step.target = String(params.selector ?? params.target ?? params.field ?? "");
      step.text = String(params.text ?? params.value ?? "");
      step.description = `Type "${step.text.substring(0, 50)}" into ${step.target}`;
      break;

    case "key":
    case "key_combo": {
      const combo = String(params.combo ?? params.key ?? "");
      step.keys = combo.split("+").map(k => k.trim());
      step.description = `${action === "key" ? "Key" : "Key combo"}: ${combo}`;
      break;
    }

    case "menu_click": {
      const menuPath = Array.isArray(params.menuPath)
        ? params.menuPath.map((part) => String(part).trim()).filter(Boolean)
        : String(params.menuPath ?? "").split("/").map((part) => part.trim()).filter(Boolean);
      step.menuPath = menuPath;
      step.description = `Menu click: ${menuPath.join(" > ")}`;
      break;
    }

    case "scroll":
      step.direction = (params.direction as "up" | "down") ?? "down";
      if (params.amount != null) step.amount = Number(params.amount);
      step.description = `Scroll ${step.direction}`;
      break;

    case "browser_js":
      step.code = String(params.code ?? "");
      step.description = `Execute JS: ${step.code.substring(0, 60)}...`;
      break;

    case "screenshot":
      step.description = "Take screenshot";
      break;

    case "wait":
      step.ms = Number(params.timeout ?? params.ms ?? params.timeoutMs ?? 1000);
      step.description = `Wait ${step.ms}ms`;
      break;

    case "applescript":
      step.script = String(params.script ?? "");
      step.description = `AppleScript: ${step.script.substring(0, 80)}${step.script.length > 80 ? "..." : ""}`;
      break;
  }

  if (!success) {
    step.optional = true;
  }

  return step;
}

export class McpPlaybookRecorder {
  private recording = false;
  private platform = "";
  private steps: PlaybookStep[] = [];
  private startTime = "";
  private cdpPort?: number;

  constructor(private readonly playbooksDir: string) {}

  get isRecording(): boolean { return this.recording; }
  get stepCount(): number { return this.steps.length; }

  getSteps(): PlaybookStep[] { return [...this.steps]; }

  start(platform: string, cdpPort?: number): void {
    this.recording = true;
    this.platform = platform;
    this.steps = [];
    this.startTime = new Date().toISOString();
    if (cdpPort !== undefined) this.cdpPort = cdpPort;
  }

  captureToolCall(
    toolName: string,
    params: Record<string, unknown>,
    success: boolean,
    _result: string,
    _durationMs: number,
  ): void {
    if (!this.recording) return;
    if (SKIP_TOOLS.has(toolName)) return;

    const step = buildStep(toolName, params, success);
    if (!step) return;

    // Deduplicate consecutive identical steps
    const last = this.steps[this.steps.length - 1];
    if (
      last &&
      last.action === step.action &&
      last.target === step.target &&
      last.text === step.text &&
      last.code === step.code &&
      JSON.stringify(last.keys ?? []) === JSON.stringify(step.keys ?? []) &&
      JSON.stringify(last.menuPath ?? []) === JSON.stringify(step.menuPath ?? [])
    ) {
      return; // skip duplicate
    }

    this.steps.push(step);
  }

  stop(name: string, description: string): Playbook {
    this.recording = false;

    // Sanitize platform to prevent path traversal in filename
    const safePlatform = this.platform.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 100);
    const id = safePlatform + "-" + Date.now().toString(36);
    // S75 Option C: Redact PII in persisted playbook steps and metadata
    const redactedSteps = this.steps.map(s => ({
      ...s,
      ...(s.text ? { text: redactPII(s.text) } : {}),
      ...(typeof s.target === "string" ? { target: redactPII(s.target) } : {}),
      ...(s.url ? { url: redactPII(s.url) } : {}),
      ...(s.code ? { code: redactPII(s.code) } : {}),
      ...(s.script ? { script: redactPII(s.script) } : {}),
      ...(s.description ? { description: redactPII(s.description) } : {}),
    }));
    const playbook: Playbook = {
      id,
      name: redactPII(name),
      description: redactPII(description),
      platform: this.platform,
      version: "1.0.0",
      tags: [this.platform, "recorded"],
      successCount: 0,
      failCount: 0,
      steps: redactedSteps,
    };

    if (this.cdpPort) {
      playbook.cdpPort = this.cdpPort;
    }

    // Save to playbooks dir
    if (!fs.existsSync(this.playbooksDir)) {
      fs.mkdirSync(this.playbooksDir, { recursive: true });
    }
    const safeFilename = `${id}.json`;
    const resolved = path.resolve(path.join(this.playbooksDir, safeFilename));
    if (!resolved.startsWith(path.resolve(this.playbooksDir))) {
      throw new Error("Invalid playbook path — refusing to write outside playbooks directory");
    }
    writeFileAtomicSync(
      resolved,
      JSON.stringify(playbook, null, 2),
    );

    this.steps = [];
    return playbook;
  }

  cancel(): void {
    this.recording = false;
    this.steps = [];
  }

  /**
   * Remove steps by index (0-based). Accepts individual indices or ranges.
   * Returns the number of steps removed.
   */
  removeSteps(indices: number[]): number {
    if (!this.recording || indices.length === 0) return 0;
    const toRemove = new Set(indices.filter((i) => i >= 0 && i < this.steps.length));
    const before = this.steps.length;
    this.steps = this.steps.filter((_, i) => !toRemove.has(i));
    return before - this.steps.length;
  }

  /**
   * Remove all failed/optional steps (recorded when tool calls failed).
   * Returns the number of steps removed.
   */
  removeFailedSteps(): number {
    if (!this.recording) return 0;
    const before = this.steps.length;
    this.steps = this.steps.filter((s) => !s.optional);
    return before - this.steps.length;
  }

  /**
   * Remove consecutive duplicate steps that look like retries.
   * A "retry" = same action + same target within 3 consecutive steps.
   * Keeps the last occurrence (the one that presumably worked).
   * Returns the number of steps removed.
   */
  removeRetries(): number {
    if (!this.recording || this.steps.length < 2) return 0;
    const before = this.steps.length;
    const cleaned: PlaybookStep[] = [];

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const next = this.steps[i + 1];
      // If the next step is the same action+target, skip this one (keep the later one)
      if (
        next &&
        next.action === step.action &&
        next.target === step.target &&
        JSON.stringify(next.keys ?? []) === JSON.stringify(step.keys ?? []) &&
        JSON.stringify(next.menuPath ?? []) === JSON.stringify(step.menuPath ?? [])
      ) {
        continue; // skip this duplicate, keep the next one
      }
      cleaned.push(step);
    }

    this.steps = cleaned;
    return before - this.steps.length;
  }
}
