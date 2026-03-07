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
 * Playbook Runner — the brain
 *
 * 1. Match task → playbook
 * 2. Execute playbook steps (fast, no AI)
 * 3. If step fails → ask AI to recover
 * 4. Save AI's recovery steps back into playbook
 * 5. Loop forever in monitor mode
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AutomationRuntimeService } from "../runtime/service.js";
import { PlaybookEngine } from "./engine.js";
import { PlaybookStore } from "./store.js";
import type { Playbook, PlaybookStep, PlaybookRunResult } from "./types.js";

export interface RunnerOptions {
  /** Anthropic model for AI fallback (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Max AI recovery attempts per failure (default: 3) */
  maxRecoveryAttempts?: number;
  /** Callback for logging */
  onLog?: (msg: string) => void;
}

export class PlaybookRunner {
  private readonly engine: PlaybookEngine;
  private readonly store: PlaybookStore;
  private readonly ai: Anthropic;
  private readonly model: string;
  private readonly maxRecovery: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly runtime: AutomationRuntimeService,
    playbookDir: string,
    options: RunnerOptions = {},
  ) {
    this.engine = new PlaybookEngine(runtime);
    this.store = new PlaybookStore(playbookDir);
    this.store.load();
    this.ai = new Anthropic();
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.maxRecovery = options.maxRecoveryAttempts ?? 3;
    this.log = options.onLog ?? ((msg) => console.error(`[PlaybookRunner] ${msg}`));
  }

  /**
   * Execute a task. Tries playbook first, falls back to AI.
   */
  async execute(sessionId: string, task: string): Promise<PlaybookRunResult> {
    // 1. Find matching playbook
    const playbook = this.store.matchByTask(task);

    if (playbook && playbook.steps.length > 0) {
      this.log(`Found playbook: ${playbook.name} (${playbook.successCount} successes)`);

      // 2. Run playbook
      const result = await this.engine.run(sessionId, playbook, {
        onStep: (i, step, res) => {
          this.log(`  Step ${i + 1}/${playbook.steps.length}: ${step.description ?? step.action} → ${res}`);
        },
      });

      if (result.success) {
        this.store.recordOutcome(playbook.id, true);
        this.log(`Playbook completed successfully in ${result.durationMs}ms`);
        return result;
      }

      // 3. Playbook failed at a step — try AI recovery
      this.log(`Playbook failed at step ${result.failedAtStep}: ${result.error}`);
      const recovery = await this.aiRecover(sessionId, playbook, result);

      if (recovery) {
        this.store.recordOutcome(playbook.id, true);
        return { ...result, success: true, aiRecovery: recovery };
      }

      this.store.recordOutcome(playbook.id, false);
      return result;
    }

    // Playbook found but has no executable steps (legacy format with flows/selectors)
    // → Use AI mode but feed it the playbook's rich metadata as context
    if (playbook) {
      this.log(`Found reference playbook: ${playbook.name} (flows/selectors, no executable steps)`);
      return this.aiExecute(sessionId, task, playbook);
    }

    // No playbook found — pure AI mode
    this.log(`No playbook found for: "${task}". Using AI.`);
    return this.aiExecute(sessionId, task);
  }

  /**
   * AI recovery — when a playbook step fails, ask AI to fix it.
   */
  private async aiRecover(
    sessionId: string,
    playbook: Playbook,
    failResult: PlaybookRunResult,
  ): Promise<string | null> {
    const failedStep = playbook.steps[failResult.failedAtStep];
    if (!failedStep) return null;

    // Take screenshot for context
    let screenshotInfo = "";
    try {
      const shot = await this.runtime.screenshot({ sessionId });
      if (shot.ok) screenshotInfo = `Screenshot saved to: ${shot.data.path}`;
    } catch { /* ignore */ }

    // Get current page state
    let pageState = "";
    try {
      const tree = await this.runtime.elementTree({ sessionId, maxDepth: 4 });
      if (tree.ok) {
        pageState = JSON.stringify(tree.data).slice(0, 3000);
      }
    } catch { /* ignore */ }

    // Build rich context from playbook metadata
    const playbookContext = buildPlaybookContext(playbook);

    const prompt = `A playbook automation failed. Help me recover.

Playbook: ${playbook.name}
Platform: ${playbook.platform}
Failed at step ${failResult.failedAtStep + 1}/${playbook.steps.length}:
  Action: ${failedStep.action}
  Target: ${JSON.stringify(failedStep.target)}
  Error: ${failResult.error}

Steps completed before failure:
${playbook.steps.slice(0, failResult.failedAtStep).map((s, i) => `  ${i + 1}. ${s.description ?? s.action}`).join("\n")}

Remaining steps after failure:
${playbook.steps.slice(failResult.failedAtStep).map((s, i) => `  ${failResult.failedAtStep + i + 1}. ${s.description ?? s.action}`).join("\n")}

${playbookContext}

Current UI state (accessibility tree):
${pageState}

${screenshotInfo}

What should I do to recover? Respond with a JSON array of recovery steps:
[
  { "action": "press", "target": "...", "description": "..." },
  { "action": "wait", "ms": 1000 }
]

Or if unrecoverable, respond with: { "unrecoverable": true, "reason": "..." }`;

    for (let attempt = 0; attempt < this.maxRecovery; attempt++) {
      try {
        const resp = await this.ai.messages.create({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        });

        const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
        const jsonMatch = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const parsed = JSON.parse(jsonMatch[0]);

        // Check if unrecoverable
        if (parsed.unrecoverable) {
          this.log(`AI says unrecoverable: ${parsed.reason}`);
          return null;
        }

        // Execute recovery steps
        const recoverySteps: PlaybookStep[] = Array.isArray(parsed) ? parsed : [parsed];
        this.log(`AI suggests ${recoverySteps.length} recovery steps`);

        for (const step of recoverySteps) {
          const stepResult = await this.engine.run(sessionId, {
            id: "recovery",
            name: "AI Recovery",
            description: "",
            platform: playbook.platform,
            steps: [step],
            version: "0",
            tags: [],
            successCount: 0,
            failCount: 0,
          });

          if (!stepResult.success) {
            this.log(`Recovery step failed: ${stepResult.error}`);
            continue;
          }
        }

        // Now try remaining playbook steps
        const remaining: Playbook = {
          ...playbook,
          id: `${playbook.id}_remaining`,
          steps: playbook.steps.slice(failResult.failedAtStep + 1),
        };

        if (remaining.steps.length > 0) {
          const remainingResult = await this.engine.run(sessionId, remaining, {
            onStep: (i, step, res) => {
              const globalIdx = failResult.failedAtStep + 1 + i;
              this.log(`  Step ${globalIdx + 1}/${playbook.steps.length}: ${step.description ?? step.action} → ${res}`);
            },
          });

          if (!remainingResult.success) {
            this.log(`Remaining steps failed at ${remainingResult.failedAtStep}`);
            return null;
          }
        }

        // Save recovery steps back into playbook for next time
        this.patchPlaybook(playbook, failResult.failedAtStep, recoverySteps);

        return `AI recovered with ${recoverySteps.length} steps, then completed remaining ${remaining.steps.length} steps`;
      } catch (err) {
        this.log(`AI recovery attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return null;
  }

  /**
   * AI execution — optionally guided by a reference playbook's metadata.
   * When a playbook has selectors/flows/errors but no executable steps,
   * AI uses that knowledge to make smarter decisions.
   * After success, saves the steps as a new playbook.
   */
  private async aiExecute(sessionId: string, task: string, refPlaybook?: Playbook): Promise<PlaybookRunResult> {
    const start = Date.now();
    const executedSteps: PlaybookStep[] = [];
    const playbookContext = refPlaybook ? buildPlaybookContext(refPlaybook) : "";

    // Simple AI loop — observe, decide, act
    for (let i = 0; i < 20; i++) {
      let pageState = "";
      try {
        const tree = await this.runtime.elementTree({ sessionId, maxDepth: 4 });
        if (tree.ok) pageState = JSON.stringify(tree.data).slice(0, 4000);
      } catch { /* ignore */ }

      const prompt = `Task: ${task}

Steps taken so far:
${executedSteps.map((s, idx) => `${idx + 1}. ${s.description ?? s.action}`).join("\n") || "(none)"}

Current UI state:
${pageState}
${playbookContext ? `\n--- PLAYBOOK REFERENCE ---\n${playbookContext}\nUse the selectors, flows, and error solutions above to guide your actions. Prefer data-testid selectors over text matching.\n---\n` : ""}
What's the next step? Respond with ONE step as JSON:
{ "action": "press|type_into|navigate|key_combo|scroll|wait", "target": "...", "text": "...", "url": "...", "keys": [...], "ms": 1000, "description": "..." }

Or if done: { "action": "done", "description": "Task complete" }`;

      try {
        const resp = await this.ai.messages.create({
          model: this.model,
          max_tokens: 512,
          messages: [{ role: "user", content: prompt }],
        });

        const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const step = JSON.parse(jsonMatch[0]) as PlaybookStep & { action: string };

        if ((step.action as string) === "done") {
          // Save as new playbook for next time
          if (executedSteps.length > 0) {
            this.saveNewPlaybook(task, executedSteps);
          }

          return {
            playbook: "ai_generated",
            success: true,
            stepsCompleted: executedSteps.length,
            totalSteps: executedSteps.length,
            failedAtStep: -1,
            durationMs: Date.now() - start,
          };
        }

        // Execute the step
        const stepResult = await this.engine.run(sessionId, {
          id: "ai_step",
          name: "AI Step",
          description: "",
          platform: "unknown",
          steps: [step],
          version: "0",
          tags: [],
          successCount: 0,
          failCount: 0,
        });

        if (stepResult.success) {
          executedSteps.push(step);
          this.log(`AI step ${executedSteps.length}: ${step.description ?? step.action}`);
        } else {
          this.log(`AI step failed: ${stepResult.error}`);
        }

        await sleep(300);
      } catch (err) {
        this.log(`AI step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      playbook: "ai_generated",
      success: false,
      stepsCompleted: executedSteps.length,
      totalSteps: -1,
      failedAtStep: executedSteps.length,
      error: "Max AI steps reached",
      durationMs: Date.now() - start,
    };
  }

  /**
   * Patch a playbook — insert recovery steps at the failure point.
   */
  private patchPlaybook(playbook: Playbook, failedAt: number, recoverySteps: PlaybookStep[]): void {
    const patched: Playbook = {
      ...playbook,
      steps: [
        ...playbook.steps.slice(0, failedAt),
        ...recoverySteps,
        ...playbook.steps.slice(failedAt),
      ],
      version: bumpVersion(playbook.version),
    };
    this.store.save(patched);
    this.log(`Patched playbook ${playbook.id}: inserted ${recoverySteps.length} recovery steps at position ${failedAt}`);
  }

  /**
   * Save AI-generated steps as a new playbook.
   */
  private saveNewPlaybook(task: string, steps: PlaybookStep[]): void {
    const id = `auto_${Date.now()}`;
    const playbook: Playbook = {
      id,
      name: task.slice(0, 80),
      description: `Auto-generated from AI execution: ${task}`,
      platform: "unknown",
      steps,
      version: "1.0.0",
      tags: task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3),
      successCount: 1,
      failCount: 0,
      lastRun: new Date().toISOString(),
    };
    this.store.save(playbook);
    this.log(`Saved new playbook: ${id} (${steps.length} steps)`);
  }

  /** Get all loaded playbooks. */
  listPlaybooks(): Playbook[] {
    return this.store.getAll();
  }

  /** Reload playbooks from disk. */
  reload(): void {
    this.store.load();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map(Number);
  if (parts.length === 3) {
    parts[2]!++;
    return parts.join(".");
  }
  return version + ".1";
}

/**
 * Build a context string from playbook metadata for AI consumption.
 * Includes selectors, flows, known errors, detection expressions.
 */
function buildPlaybookContext(playbook: Playbook): string {
  const parts: string[] = [];

  if (playbook.urls && Object.keys(playbook.urls).length > 0) {
    parts.push("URLS:\n" + Object.entries(playbook.urls).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  }

  if (playbook.selectors && Object.keys(playbook.selectors).length > 0) {
    parts.push("SELECTORS:");
    for (const [group, sels] of Object.entries(playbook.selectors)) {
      parts.push(`  [${group}]`);
      for (const [name, sel] of Object.entries(sels)) {
        parts.push(`    ${name}: ${sel}`);
      }
    }
  }

  if (playbook.flows && Object.keys(playbook.flows).length > 0) {
    parts.push("FLOWS:");
    for (const [name, flow] of Object.entries(playbook.flows)) {
      parts.push(`  [${name}]`);
      for (const step of flow.steps) {
        parts.push(`    - ${step}`);
      }
      if (flow.guards) {
        parts.push(`    Guards:`);
        for (const g of flow.guards) parts.push(`      ! ${g}`);
      }
    }
  }

  if (playbook.detection && Object.keys(playbook.detection).length > 0) {
    parts.push("DETECTION (JS expressions):");
    for (const [name, expr] of Object.entries(playbook.detection)) {
      parts.push(`  ${name}: ${expr}`);
    }
  }

  if (playbook.errors && playbook.errors.length > 0) {
    parts.push("KNOWN ERRORS & SOLUTIONS:");
    for (const e of playbook.errors) {
      parts.push(`  [${e.severity}] ${e.error}`);
      parts.push(`    Context: ${e.context}`);
      parts.push(`    Solution: ${e.solution}`);
    }
  }

  if (playbook.policyNotes && Object.keys(playbook.policyNotes).length > 0) {
    parts.push("POLICY NOTES:");
    for (const [cat, notes] of Object.entries(playbook.policyNotes)) {
      parts.push(`  [${cat}]`);
      for (const n of notes) parts.push(`    - ${n}`);
    }
  }

  return parts.join("\n");
}
