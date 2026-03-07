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
 * JobRunner — dequeue + execute jobs through the fallback chain or playbook engine.
 *
 * Lifecycle per job:
 *   1. Dequeue highest-priority queued job
 *   2. Claim/bind a supervisor session
 *   3. Start heartbeat interval
 *   4. Focus/validate target app before each step
 *   5. If job has playbookId → delegate to PlaybookEngine
 *      Otherwise → execute steps via bridge (AX → CDP → coordinates)
 *   6. On blocker/error → auto-transition to blocked/waiting_human/failed
 *   7. On all steps done → transition to done
 *   8. Release session, stop heartbeat
 *
 * The runner is single-threaded: it processes one job at a time.
 * Call run() in a loop, or use runLoop() for continuous processing.
 */

import type { BridgeClient } from "../native/bridge-client.js";
import type { JobManager } from "./manager.js";
import type { Job, JobStep } from "./types.js";
import type { LeaseManager } from "../supervisor/locks.js";
import type { SessionSupervisor } from "../supervisor/supervisor.js";
import type { PlaybookEngine } from "../playbook/engine.js";
import type { PlaybookStore } from "../playbook/store.js";
import type { Playbook, PlaybookStep } from "../playbook/types.js";
import type { AutomationRuntimeService } from "../runtime/service.js";
import {
  planExecution,
  executeWithFallback,
  DEFAULT_RETRY_POLICY,
} from "../runtime/execution-contract.js";
import type { ExecutionMethod, ActionResult, ActionType } from "../runtime/execution-contract.js";

/** Patterns that indicate a blocker requiring human intervention. */
const HUMAN_BLOCKER_PATTERNS = [
  "captcha", "recaptcha", "hcaptcha",
  "2fa", "two-factor", "verification code",
  "sign in", "log in", "login required",
  "permission denied", "access denied",
  "approve this", "confirm your identity",
];

/** Patterns that indicate a transient blocker (auto-recoverable). */
const TRANSIENT_BLOCKER_PATTERNS = [
  "rate limit", "too many requests", "try again later",
  "loading", "please wait",
  "timed out", "timeout",
  "network error", "connection refused",
];

export interface JobRunnerConfig {
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatMs: number;
  /** Delay between steps in ms (default: 500) */
  stepDelayMs: number;
  /** Max consecutive step failures before failing the job (default: 3) */
  maxConsecutiveFailures: number;
  /** Whether CDP is available (default: false, set at runtime) */
  hasCDP: boolean;
  /** CDP connection factory (optional) */
  cdpConnect?: () => Promise<{ Runtime: any; Input: any; close: () => Promise<void> }>;
  /** PlaybookEngine for executing jobs with playbookId */
  playbookEngine?: PlaybookEngine;
  /** PlaybookStore to look up playbooks by ID */
  playbookStore?: PlaybookStore;
  /** AutomationRuntimeService for creating playbook sessions */
  runtimeService?: AutomationRuntimeService;
  /** Logger callback */
  onLog?: (msg: string) => void;
}

const DEFAULT_CONFIG: JobRunnerConfig = {
  heartbeatMs: 30_000,
  stepDelayMs: 500,
  maxConsecutiveFailures: 3,
  hasCDP: false,
  onLog: (msg) => console.error(`[JobRunner] ${msg}`),
};

export interface RunResult {
  jobId: string;
  finalState: Job["state"];
  stepsCompleted: number;
  totalSteps: number;
  durationMs: number;
  error: string | null;
}

export class JobRunner {
  private readonly config: JobRunnerConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly bridge: BridgeClient,
    private readonly jobs: JobManager,
    private readonly leaseManager: LeaseManager,
    private readonly supervisor: SessionSupervisor | null,
    config?: Partial<JobRunnerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private log(msg: string): void {
    this.config.onLog?.(msg);
  }

  /**
   * Run a single job cycle: dequeue → execute → finalize.
   * Returns null if no jobs are queued.
   */
  async run(): Promise<RunResult | null> {
    // 1. Dequeue
    const job = this.jobs.dequeue();
    if (!job) return null;

    const start = Date.now();
    this.log(`Dequeued job ${job.id}: "${job.task}" (${job.steps.length} steps, resume from ${job.lastStep + 1})`);

    // 2. Claim session
    const sessionId = await this.claimSession(job);
    if (!sessionId) {
      this.jobs.transition(job.id, "failed", { error: "Failed to claim supervisor session" });
      return { jobId: job.id, finalState: "failed", stepsCompleted: 0, totalSteps: job.steps.length, durationMs: Date.now() - start, error: "Failed to claim session" };
    }

    // 3. Start heartbeat
    this.startHeartbeat(sessionId);

    try {
      // 4. Route: playbook engine or free-form steps
      if (job.playbookId) {
        if (!this.config.playbookEngine || !this.config.playbookStore) {
          const err = `Job requires playbook "${job.playbookId}" but no playbook engine is configured`;
          this.jobs.transition(job.id, "failed", { error: err });
          return this.finalize(job, start, 0, err);
        }
        return await this.runViaPlaybookEngine(job, sessionId, start);
      }
      return await this.runFreeFormSteps(job, start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.jobs.transition(job.id, "failed", { error: msg });
      this.log(`Job ${job.id} → failed (unhandled): ${msg}`);
      return this.finalize(job, start, 0, msg);
    } finally {
      this.stopHeartbeat();
      this.releaseSession(sessionId);
    }
  }

  // ── Playbook engine path ──────────────────────

  private async runViaPlaybookEngine(job: Job, sessionId: string, start: number): Promise<RunResult> {
    const engine = this.config.playbookEngine!;
    const store = this.config.playbookStore!;

    const playbook = store.get(job.playbookId!);
    if (!playbook) {
      this.jobs.transition(job.id, "failed", { error: `Playbook "${job.playbookId}" not found` });
      return this.finalize(job, start, 0, `Playbook "${job.playbookId}" not found`);
    }

    this.log(`  Using playbook engine: "${playbook.name}" (${playbook.steps.length} steps)`);

    // If job has no steps yet, populate from playbook so step tracking works
    if (job.steps.length === 0 && playbook.steps.length > 0) {
      for (let i = 0; i < playbook.steps.length; i++) {
        const ps = playbook.steps[i]!;
        const step: JobStep = { index: i, action: ps.action, status: "pending" };
        const target = typeof ps.target === "string" ? ps.target : ps.target ? JSON.stringify(ps.target) : undefined;
        if (target !== undefined) step.target = target;
        if (ps.description !== undefined) step.description = ps.description;
        if (ps.text !== undefined) step.text = ps.text;
        if (ps.keys) step.keys = ps.keys.join("+");
        job.steps.push(step);
      }
    }

    // Build remaining-steps playbook (resume from lastStep+1)
    const resumeIdx = job.lastStep + 1;
    const remainingSteps = playbook.steps.slice(resumeIdx);
    if (remainingSteps.length === 0) {
      this.jobs.transition(job.id, "done");
      return this.finalize(job, start, playbook.steps.length, null);
    }

    const remainingPlaybook: Playbook = {
      ...playbook,
      id: `${playbook.id}_job_${job.id}`,
      steps: remainingSteps,
    };

    // Create a runtime session if available, focus target app
    let runtimeSessionId: string | null = null;
    if (this.config.runtimeService) {
      try {
        const session = await this.config.runtimeService.sessionStart("jobrunner");
        runtimeSessionId = session.sessionId;
        // Focus target app if specified
        if (job.bundleId) {
          await this.config.runtimeService.appFocus({ sessionId: session.sessionId, bundleId: job.bundleId });
        }
      } catch (err) {
        this.log(`  Warning: failed to create runtime session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const engineSessionId = runtimeSessionId ?? sessionId;
    let stepsCompleted = 0;

    const result = await engine.run(engineSessionId, remainingPlaybook, {
      onStep: (i, step, res) => {
        const globalIdx = resumeIdx + i;
        this.jobs.completeStep(job.id, globalIdx, { durationMs: 0 });
        stepsCompleted++;
        this.log(`  Step ${globalIdx}/${playbook.steps.length - 1}: ${step.description ?? step.action} → ${res}`);
      },
    });

    if (result.success) {
      store.recordOutcome(playbook.id, true);
      this.jobs.transition(job.id, "done");
      this.log(`Job ${job.id} → done via playbook engine (${stepsCompleted} steps in ${result.durationMs}ms)`);
    } else {
      store.recordOutcome(playbook.id, false);
      const error = result.error ?? `Playbook failed at step ${result.failedAtStep}`;

      // Mark the failed step
      if (result.failedAtStep >= 0) {
        const globalFailIdx = resumeIdx + result.failedAtStep;
        this.jobs.failStep(job.id, globalFailIdx, error);
      }

      // Classify blocker from the error
      const blocker = this.classifyBlocker(error);
      if (blocker === "human") {
        this.jobs.transition(job.id, "waiting_human", { blockReason: error });
      } else if (blocker === "transient") {
        this.jobs.transition(job.id, "blocked", { blockReason: error });
      } else {
        this.jobs.transition(job.id, "failed", { error });
      }

      this.log(`Job ${job.id} → ${blocker === "human" ? "waiting_human" : blocker === "transient" ? "blocked" : "failed"}: ${error}`);
    }

    return this.finalize(job, start, stepsCompleted, result.success ? null : (result.error ?? null));
  }

  // ── Free-form step execution path ─────────────

  private async runFreeFormSteps(job: Job, start: number): Promise<RunResult> {
    let consecutiveFailures = 0;
    let stepsCompleted = 0;
    let lastError: string | null = null;

    const resumeIdx = job.lastStep + 1;
    for (let i = resumeIdx; i < job.steps.length; i++) {
      if (this.stopped) {
        this.log(`Runner stopped — pausing job ${job.id} at step ${i}`);
        break;
      }

      const step = job.steps[i]!;
      if (step.status === "done" || step.status === "skipped") {
        stepsCompleted++;
        continue;
      }

      // Focus/validate target app before each step
      await this.focusTargetApp(job);

      this.log(`  Step ${i}/${job.steps.length - 1}: ${step.description ?? step.action}${step.target ? ` → "${step.target}"` : ""}`);

      const stepStart = Date.now();
      const result = await this.executeStep(step);

      if (result.ok) {
        this.jobs.completeStep(job.id, i, { durationMs: Date.now() - stepStart });
        stepsCompleted++;
        consecutiveFailures = 0;
        this.log(`    ✓ ${result.method} in ${result.durationMs}ms${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ""}`);
      } else {
        consecutiveFailures++;
        lastError = result.error ?? "Unknown error";
        this.jobs.failStep(job.id, i, lastError);
        this.log(`    ✗ ${lastError}`);

        // Check for blocker patterns across all errors from the fallback chain
        const { type: blocker, matchedError: blockerError } = this.classifyBlockerFromErrors(this.lastStepErrors);
        if (blocker === "human") {
          const reason = blockerError ?? lastError;
          this.jobs.transition(job.id, "waiting_human", { blockReason: reason });
          this.log(`  → waiting_human: ${reason}`);
          return this.finalize(job, start, stepsCompleted, reason);
        }
        if (blocker === "transient") {
          const reason = blockerError ?? lastError;
          this.jobs.transition(job.id, "blocked", { blockReason: reason });
          this.log(`  → blocked (transient): ${reason}`);
          return this.finalize(job, start, stepsCompleted, reason);
        }

        if (consecutiveFailures >= this.config.maxConsecutiveFailures) {
          this.jobs.transition(job.id, "failed", { error: `${consecutiveFailures} consecutive step failures. Last: ${lastError}` });
          this.log(`  → failed: ${consecutiveFailures} consecutive failures`);
          return this.finalize(job, start, stepsCompleted, lastError);
        }
      }

      // Delay between steps
      if (i < job.steps.length - 1) {
        await delay(this.config.stepDelayMs);
      }
    }

    // Check if all steps complete
    const updated = this.jobs.get(job.id);
    if (!updated) {
      return this.finalize(job, start, stepsCompleted, "Job disappeared");
    }

    const allDone = updated.steps.every((s) => s.status === "done" || s.status === "skipped");
    if (allDone && !this.stopped) {
      this.jobs.transition(job.id, "done");
      this.log(`Job ${job.id} → done (${stepsCompleted} steps in ${Date.now() - start}ms)`);
    } else if (this.stopped) {
      this.log(`Job ${job.id} paused at step ${updated.lastStep + 1}`);
    }

    return this.finalize(job, start, stepsCompleted, lastError);
  }

  // ── Target app focus ──────────────────────────

  /**
   * Focus the job's target bundleId/windowId before acting.
   * Validates the app is still running. Skips if no bundleId set.
   */
  private async focusTargetApp(job: Job): Promise<void> {
    if (!job.bundleId) return;

    try {
      // Verify the app is running
      const apps = await this.bridge.call<Array<{ bundleId: string; pid: number }>>("app.list");
      const target = apps.find((a) => a.bundleId === job.bundleId);
      if (!target) {
        throw new Error(`Target app ${job.bundleId} is not running`);
      }

      // Focus the app
      await this.bridge.call("app.focus", { bundleId: job.bundleId });

      // If windowId specified, validate it exists
      if (job.windowId != null) {
        const wins = await this.bridge.call<Array<{ windowId: number; pid: number }>>("app.windows");
        const targetWin = wins.find((w) => w.windowId === job.windowId && w.pid === target.pid);
        if (!targetWin) {
          this.log(`  Warning: window ${job.windowId} not found for ${job.bundleId}, using frontmost`);
        }
      }
    } catch (err) {
      // Log but don't fail — the step itself will fail if the target isn't right
      this.log(`  Warning: focus target app failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Continuous loop: process jobs until stop() is called or queue is empty.
   * Returns when stopped or no more queued jobs.
   */
  async runLoop(): Promise<RunResult[]> {
    const results: RunResult[] = [];
    this.stopped = false;

    while (!this.stopped) {
      const result = await this.run();
      if (!result) break; // Queue empty
      results.push(result);
    }

    return results;
  }

  /** Signal the runner to stop after the current step. */
  stop(): void {
    this.stopped = true;
  }

  // ── Session management ──────────────────────────

  private async claimSession(job: Job): Promise<string | null> {
    // If job already has a session, verify it's still valid
    if (job.sessionId) {
      const ok = this.supervisor
        ? this.supervisor.heartbeat(job.sessionId)
        : this.leaseManager.heartbeat(job.sessionId);
      if (ok) return job.sessionId;
      // Session expired — claim a new one
    }

    const client = { id: `jobrunner_${job.id}`, type: "jobrunner", startedAt: new Date().toISOString() };
    const app = job.bundleId ?? "com.screenhand.jobrunner";
    const windowId = job.windowId ?? 0;

    try {
      let sessionId: string | null = null;

      if (this.supervisor) {
        // Use supervisor path — inherits stall detection + recovery
        const lease = this.supervisor.registerSession(client, app, windowId);
        sessionId = lease?.sessionId ?? null;
      } else {
        // Fallback to raw lease manager
        const lease = this.leaseManager.claim(client, app, windowId);
        sessionId = lease?.sessionId ?? null;
      }

      if (!sessionId) return null;

      // Bind session to job
      this.jobs.transition(job.id, "running" as any, { sessionId });
      return sessionId;
    } catch {
      return null;
    }
  }

  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.supervisor) {
        this.supervisor.heartbeat(sessionId);
      } else {
        this.leaseManager.heartbeat(sessionId);
      }
    }, this.config.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private releaseSession(sessionId: string): void {
    try {
      if (this.supervisor) {
        this.supervisor.releaseSession(sessionId);
      } else {
        this.leaseManager.release(sessionId);
      }
    } catch {
      // Best-effort
    }
  }

  // ── Step execution ──────────────────────────────

  /** All errors collected during the last executeStep call (across fallback methods). */
  private lastStepErrors: string[] = [];

  private async executeStep(step: JobStep): Promise<ActionResult> {
    const actionType = this.mapActionType(step.action);
    const infra = { hasBridge: true, hasCDP: this.config.hasCDP };
    const plan = planExecution(actionType, infra);
    this.lastStepErrors = [];

    if (plan.length === 0) {
      return { ok: false, method: "ax", durationMs: 0, fallbackFrom: null, retries: 0, error: `No execution method available for "${step.action}"`, target: step.target ?? null };
    }

    return executeWithFallback(step.action, plan, DEFAULT_RETRY_POLICY, async (method, attempt) => {
      const result = await this.executeViaMethod(method, step, attempt);
      if (!result.ok && result.error) this.lastStepErrors.push(result.error);
      return result;
    });
  }

  private async executeViaMethod(method: ExecutionMethod, step: JobStep, attempt: number): Promise<ActionResult> {
    const start = Date.now();
    const target = step.target ?? null;

    try {
      switch (step.action) {
        case "click":
        case "press":
          return await this.execClick(method, target, start, attempt);
        case "type_text":
        case "type_into":
        case "type":
          return await this.execType(method, target, step.text ?? step.description ?? "", start, attempt);
        case "navigate":
          return await this.execNavigate(target, start, attempt);
        case "screenshot":
          return await this.execScreenshot(start, attempt);
        case "scroll":
          return await this.execScroll(method, step.description ?? "down", start, attempt);
        case "wait":
          await delay(1000);
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: "wait" };
        case "key_combo":
        case "key":
          return await this.execKey(step.keys ?? target ?? "", start, attempt);
        case "read":
        case "extract":
          return await this.execRead(method, target, start, attempt);
        default:
          // Try as a generic click on the target text
          if (target) return await this.execClick(method, target, start, attempt);
          return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: `Unknown action: ${step.action}`, target };
      }
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target };
    }
  }

  // ── Bridge execution methods ────────────────────

  private async execClick(method: ExecutionMethod, target: string | null, start: number, attempt: number): Promise<ActionResult> {
    if (!target) return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: "Click requires a target", target };

    switch (method) {
      case "ax": {
        const found = await this.bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", { pid: 0, title: target, exact: false });
        await this.bridge.call("ax.performAction", { pid: 0, elementPath: found.elementPath, action: "AXPress" });
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
      }
      case "cdp": {
        if (!this.config.cdpConnect) throw new Error("CDP not available");
        const client = await this.config.cdpConnect();
        try {
          const evalResult = await client.Runtime.evaluate({
            expression: `(() => { const el = Array.from(document.querySelectorAll('*')).find(e => e.textContent?.trim() === ${JSON.stringify(target)} || e.getAttribute('aria-label') === ${JSON.stringify(target)}); if (el) { el.click(); return 'clicked'; } return null; })()`,
            returnByValue: true,
          });
          if (evalResult.result?.value !== "clicked") throw new Error("Element not found via CDP");
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        } finally {
          await client.close();
        }
      }
      case "ocr": {
        const shot = await this.bridge.call<{ path: string }>("cg.captureScreen", {});
        const matches = await this.bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", { imagePath: shot.path, searchText: target });
        const match = Array.isArray(matches) ? matches[0] : null;
        if (!match?.bounds) throw new Error("Target not found via OCR");
        const x = match.bounds.x + match.bounds.width / 2;
        const y = match.bounds.y + match.bounds.height / 2;
        await this.bridge.call("cg.mouseClick", { x, y });
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
      }
      case "coordinates": {
        // Can't click by text with coordinates alone — need a prior locate
        throw new Error("Coordinate click requires explicit x,y — not available for text target");
      }
    }
    throw new Error(`Unknown method: ${method}`);
  }

  private async execType(method: ExecutionMethod, target: string | null, text: string, start: number, attempt: number): Promise<ActionResult> {
    switch (method) {
      case "ax": {
        if (target) {
          const found = await this.bridge.call<{ elementPath: number[] }>("ax.findElement", { pid: 0, title: target, exact: false });
          await this.bridge.call("ax.setElementValue", { pid: 0, elementPath: found.elementPath, value: text });
        } else {
          // Type into focused element via key events
          await this.bridge.call("cg.typeText", { text });
        }
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
      }
      case "cdp": {
        if (!this.config.cdpConnect) throw new Error("CDP not available");
        const client = await this.config.cdpConnect();
        try {
          if (target) {
            const evalResult = await client.Runtime.evaluate({
              expression: `(() => { const el = Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).find(e => e.getAttribute('placeholder') === ${JSON.stringify(target)} || e.getAttribute('aria-label') === ${JSON.stringify(target)} || e.getAttribute('name') === ${JSON.stringify(target)}); if (el) { el.focus(); return true; } return false; })()`,
              returnByValue: true,
            });
            if (!evalResult.result?.value) throw new Error("Field not found via CDP");
          }
          for (const char of text) {
            await client.Input.dispatchKeyEvent({ type: "keyDown", key: char, text: char });
            await client.Input.dispatchKeyEvent({ type: "keyUp", key: char });
          }
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        } finally {
          await client.close();
        }
      }
    }
    throw new Error(`Method ${method} does not support type`);
  }

  private async execNavigate(url: string | null, start: number, attempt: number): Promise<ActionResult> {
    if (!url) return { ok: false, method: "ax", durationMs: 0, fallbackFrom: null, retries: attempt, error: "Navigate requires a URL target", target: null };

    if (this.config.cdpConnect) {
      const client = await this.config.cdpConnect();
      try {
        await client.Runtime.evaluate({ expression: `window.location.href = ${JSON.stringify(url)}` });
        return { ok: true, method: "cdp", durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: url };
      } finally {
        await client.close();
      }
    }

    // Fallback: use AppleScript / open command
    await this.bridge.call("app.openURL", { url });
    return { ok: true, method: "ax", durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: url };
  }

  private async execScreenshot(start: number, attempt: number): Promise<ActionResult> {
    const shot = await this.bridge.call<{ path: string }>("cg.captureScreen", {});
    return { ok: true, method: "ax", durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: shot.path };
  }

  private async execScroll(method: ExecutionMethod, direction: string, start: number, attempt: number): Promise<ActionResult> {
    const amount = 300;
    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;

    switch (method) {
      case "ax":
      case "coordinates":
        await this.bridge.call("cg.scroll", { deltaX, deltaY });
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${amount}px` };
      case "cdp": {
        if (!this.config.cdpConnect) throw new Error("CDP not available");
        const client = await this.config.cdpConnect();
        try {
          await client.Runtime.evaluate({ expression: `window.scrollBy(${deltaX}, ${deltaY})` });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${amount}px` };
        } finally {
          await client.close();
        }
      }
    }
    throw new Error(`Method ${method} does not support scroll`);
  }

  private async execKey(keys: string, start: number, attempt: number): Promise<ActionResult> {
    // keys is a "+" separated combo like "cmd+a"
    const parts = keys.split("+").map((k) => k.trim());
    await this.bridge.call("cg.keyCombo", { keys: parts });
    return { ok: true, method: "ax", durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: keys };
  }

  private async execRead(method: ExecutionMethod, target: string | null, start: number, attempt: number): Promise<ActionResult> {
    switch (method) {
      case "ax": {
        if (target) {
          const found = await this.bridge.call<{ elementPath: number[] }>("ax.findElement", { pid: 0, title: target, exact: false });
          const val = await this.bridge.call<{ value: string }>("ax.getElementValue", { pid: 0, elementPath: found.elementPath });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: val.value ?? "" };
        }
        const tree = await this.bridge.call<{ description: string }>("ax.getElementTree", { pid: 0, maxDepth: 4 });
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: tree.description ?? "" };
      }
      case "cdp": {
        if (!this.config.cdpConnect) throw new Error("CDP not available");
        const client = await this.config.cdpConnect();
        try {
          if (target) {
            const evalResult = await client.Runtime.evaluate({
              expression: `(() => { const el = Array.from(document.querySelectorAll('*')).find(e => e.getAttribute('aria-label') === ${JSON.stringify(target)} || e.textContent?.trim() === ${JSON.stringify(target)}); return el ? (el.value ?? el.textContent ?? '').trim() : null; })()`,
              returnByValue: true,
            });
            if (evalResult.result?.value == null) throw new Error("Element not found via CDP");
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result.value) };
          }
          const evalResult = await client.Runtime.evaluate({
            expression: "document.body?.innerText?.slice(0, 4000) ?? ''",
            returnByValue: true,
          });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result?.value ?? "") };
        } finally {
          await client.close();
        }
      }
      case "ocr": {
        const shot = await this.bridge.call<{ path: string }>("cg.captureScreen", {});
        if (target) {
          const matches = await this.bridge.call<Array<{ text: string }>>("vision.findText", { imagePath: shot.path, searchText: target });
          const match = Array.isArray(matches) ? matches[0] : null;
          if (!match) throw new Error("Text not found via OCR");
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: match.text };
        }
        const ocr = await this.bridge.call<{ text: string }>("vision.ocr", { imagePath: shot.path });
        return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: ocr.text?.slice(0, 4000) ?? "" };
      }
    }
    throw new Error(`Method ${method} does not support read`);
  }

  // ── Blocker classification ──────────────────────

  /** Check a single error string for blocker patterns. */
  private classifyBlocker(error: string): "human" | "transient" | null {
    const lower = error.toLowerCase();
    for (const pattern of HUMAN_BLOCKER_PATTERNS) {
      if (lower.includes(pattern)) return "human";
    }
    for (const pattern of TRANSIENT_BLOCKER_PATTERNS) {
      if (lower.includes(pattern)) return "transient";
    }
    return null;
  }

  /** Check all errors from a fallback chain — return the highest-priority blocker found with the matched error. */
  private classifyBlockerFromErrors(errors: string[]): { type: "human" | "transient" | null; matchedError: string | null } {
    let transientError: string | null = null;
    for (const err of errors) {
      const result = this.classifyBlocker(err);
      if (result === "human") return { type: "human", matchedError: err };
      if (result === "transient" && !transientError) transientError = err;
    }
    if (transientError) return { type: "transient", matchedError: transientError };
    return { type: null, matchedError: null };
  }

  // ── Helpers ─────────────────────────────────────

  private mapActionType(action: string): ActionType {
    switch (action) {
      case "click": case "press": return "click";
      case "type_text": case "type_into": case "type": return "type";
      case "read": case "extract": return "read";
      case "scroll": return "scroll";
      case "navigate": case "screenshot": case "wait": case "key_combo": case "key":
        return "click"; // These don't go through the fallback chain — handled specially
      default: return "click";
    }
  }

  private finalize(job: Job, start: number, stepsCompleted: number, lastError: string | null): RunResult {
    const updated = this.jobs.get(job.id);
    return {
      jobId: job.id,
      finalState: updated?.state ?? "failed",
      stepsCompleted,
      totalSteps: job.steps.length,
      durationMs: Date.now() - start,
      error: lastError,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
