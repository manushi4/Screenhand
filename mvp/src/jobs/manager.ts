/**
 * JobManager — orchestrates job lifecycle on top of supervisor + memory.
 *
 * Responsibilities:
 * - Create, transition, and query jobs
 * - Resume from last successful playbook step
 * - Record outcomes to memory for learning
 * - Bind jobs to supervisor sessions
 */

import type { Job, JobState, JobStep, JobSummary } from "./types.js";
import { VALID_TRANSITIONS, JOB_STATES } from "./types.js";
import { JobStore } from "./store.js";
import type { MemoryService } from "../memory/service.js";
import type { SessionSupervisor } from "../supervisor/supervisor.js";

export class JobManager {
  private readonly store: JobStore;
  private readonly memory: MemoryService | null;
  private readonly supervisor: SessionSupervisor | null;

  constructor(opts: {
    jobDir: string;
    memory?: MemoryService;
    supervisor?: SessionSupervisor;
  }) {
    this.store = new JobStore(opts.jobDir);
    this.memory = opts.memory ?? null;
    this.supervisor = opts.supervisor ?? null;
  }

  init(): void {
    this.store.init();
  }

  // ── Create ──────────────────────────────────────

  create(opts: {
    task: string;
    playbookId?: string;
    steps?: Array<{ action: string; target?: string | undefined; description?: string | undefined; text?: string | undefined; keys?: string | undefined; value?: string | undefined }>;
    tags?: string[];
    priority?: number;
    maxRetries?: number;
    sessionId?: string;
    bundleId?: string;
    windowId?: number;
  }): Job {
    const now = new Date().toISOString();
    const id = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

    const steps: JobStep[] = (opts.steps ?? []).map((s, i) => {
      const step: JobStep = { index: i, action: s.action, status: "pending" };
      if (s.target !== undefined) step.target = s.target;
      if (s.description !== undefined) step.description = s.description;
      if (s.text !== undefined) step.text = s.text;
      if (s.keys !== undefined) step.keys = s.keys;
      if (s.value !== undefined) step.value = s.value;
      return step;
    });

    const job: Job = {
      id,
      task: opts.task,
      state: "queued",
      playbookId: opts.playbookId ?? null,
      sessionId: opts.sessionId ?? null,
      bundleId: opts.bundleId ?? null,
      windowId: opts.windowId ?? null,
      lastStep: -1,
      steps,
      blockReason: null,
      retries: 0,
      maxRetries: opts.maxRetries ?? 3,
      lastError: null,
      tags: opts.tags ?? [],
      priority: opts.priority ?? 10,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };

    this.store.add(job);
    return job;
  }

  // ── State transitions ───────────────────────────

  transition(id: string, to: JobState, opts?: {
    blockReason?: string;
    error?: string;
    sessionId?: string;
  }): Job | { error: string } {
    const job = this.store.get(id);
    if (!job) return { error: `Job ${id} not found` };

    const allowed = VALID_TRANSITIONS[job.state];
    if (!allowed.includes(to)) {
      return { error: `Cannot transition from "${job.state}" to "${to}". Allowed: [${allowed.join(", ")}]` };
    }

    const patch: Partial<Job> = { state: to };

    if (to === "running") {
      if (!job.startedAt) patch.startedAt = new Date().toISOString();
      patch.blockReason = null;
      if (opts?.sessionId) patch.sessionId = opts.sessionId;
    }

    if (to === "blocked" || to === "waiting_human") {
      patch.blockReason = opts?.blockReason ?? null;
    }

    if (to === "failed") {
      patch.lastError = opts?.error ?? job.lastError;
      this.recordOutcomeToMemory(job, false);
    }

    if (to === "done") {
      patch.completedAt = new Date().toISOString();
      this.recordOutcomeToMemory(job, true);
    }

    // Re-queue bumps retry count
    if (job.state === "failed" && to === "queued") {
      patch.retries = job.retries + 1;
      if (patch.retries! > job.maxRetries) {
        return { error: `Job ${id} has exceeded max retries (${job.maxRetries})` };
      }
      patch.lastError = null;
      patch.blockReason = null;
    }

    const updated = this.store.update(id, patch);
    return updated ?? { error: `Failed to update job ${id}` };
  }

  // ── Step tracking ───────────────────────────────

  /** Mark a step as completed and advance lastStep. */
  completeStep(jobId: string, stepIndex: number, opts?: { durationMs?: number }): Job | { error: string } {
    const job = this.store.get(jobId);
    if (!job) return { error: `Job ${jobId} not found` };
    if (job.state !== "running") return { error: `Job is not running (state=${job.state})` };

    const step = job.steps[stepIndex];
    if (!step) return { error: `Step ${stepIndex} does not exist (total: ${job.steps.length})` };

    step.status = "done";
    step.completedAt = new Date().toISOString();
    if (opts?.durationMs !== undefined) step.durationMs = opts.durationMs;

    const newLastStep = Math.max(job.lastStep, stepIndex);
    return this.store.update(jobId, { lastStep: newLastStep, steps: job.steps }) ?? { error: "Update failed" };
  }

  /** Mark a step as failed. Does NOT transition the job — caller decides (retry vs block vs fail). */
  failStep(jobId: string, stepIndex: number, error: string): Job | { error: string } {
    const job = this.store.get(jobId);
    if (!job) return { error: `Job ${jobId} not found` };

    const step = job.steps[stepIndex];
    if (!step) return { error: `Step ${stepIndex} does not exist` };

    step.status = "failed";
    step.error = error;
    return this.store.update(jobId, { steps: job.steps, lastError: error }) ?? { error: "Update failed" };
  }

  /** Skip a step (e.g., optional step or already done). */
  skipStep(jobId: string, stepIndex: number): Job | { error: string } {
    const job = this.store.get(jobId);
    if (!job) return { error: `Job ${jobId} not found` };

    const step = job.steps[stepIndex];
    if (!step) return { error: `Step ${stepIndex} does not exist` };

    step.status = "skipped";
    return this.store.update(jobId, { steps: job.steps }) ?? { error: "Update failed" };
  }

  // ── Resume ──────────────────────────────────────

  /** Get the resume point: next pending step after lastStep. */
  getResumePoint(jobId: string): { stepIndex: number; step: JobStep } | null {
    const job = this.store.get(jobId);
    if (!job) return null;

    for (let i = job.lastStep + 1; i < job.steps.length; i++) {
      if (job.steps[i]!.status === "pending") {
        return { stepIndex: i, step: job.steps[i]! };
      }
    }
    return null;
  }

  // ── Queries ─────────────────────────────────────

  get(id: string): Job | undefined {
    return this.store.get(id);
  }

  list(state?: JobState): Job[] {
    return this.store.list(state);
  }

  /** Pop the next queued job and transition it to running. */
  dequeue(sessionId?: string): Job | null {
    const next = this.store.nextQueued();
    if (!next) return null;

    const opts: { sessionId?: string } = {};
    if (sessionId !== undefined) opts.sessionId = sessionId;
    const result = this.transition(next.id, "running", opts);
    if ("error" in result) return null;
    return result;
  }

  summary(): JobSummary {
    const all = this.store.list();
    const byState = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
    for (const j of all) byState[j.state]++;

    const queued = all
      .filter((j) => j.state === "queued")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return {
      total: all.length,
      byState,
      oldestQueued: queued[0]?.createdAt ?? null,
      runningJobIds: all.filter((j) => j.state === "running").map((j) => j.id),
    };
  }

  /** Remove a job entirely. */
  remove(id: string): boolean {
    return this.store.remove(id);
  }

  /** Prune old terminal jobs. */
  prune(): number {
    return this.store.prune();
  }

  // ── Private ─────────────────────────────────────

  private recordOutcomeToMemory(job: Job, success: boolean): void {
    if (!this.memory) return;
    try {
      const completedSteps = job.steps.filter((s) => s.status === "done");
      if (completedSteps.length === 0) return;

      this.memory.appendStrategy({
        id: "strat_" + job.id,
        task: job.task,
        steps: completedSteps.map((s) => ({
          tool: s.action,
          params: s.target ? { target: s.target } : {},
        })),
        totalDurationMs: completedSteps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
        successCount: success ? 1 : 0,
        failCount: success ? 0 : 1,
        lastUsed: new Date().toISOString(),
        tags: job.tags,
        fingerprint: completedSteps.map((s) => s.action).join("→"),
      });
    } catch {
      // Non-critical — don't let memory failures break job flow
    }
  }
}
