import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { JobManager } from "../src/jobs/manager.js";
import type { Job, JobState } from "../src/jobs/types.js";
import { VALID_TRANSITIONS } from "../src/jobs/types.js";
import { JobStore } from "../src/jobs/store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
}

describe("JobStore", () => {
  let store: JobStore;
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    store = new JobStore(dir);
    store.init();
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("persists across instances", () => {
    const job: Job = {
      id: "job_1", task: "test", state: "queued", playbookId: null,
      sessionId: null, lastStep: -1, steps: [], blockReason: null,
      retries: 0, maxRetries: 3, lastError: null, tags: [], priority: 10,
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      startedAt: null, completedAt: null,
    };
    store.add(job);

    const store2 = new JobStore(dir);
    store2.init();
    expect(store2.get("job_1")).toBeDefined();
    expect(store2.get("job_1")!.task).toBe("test");
  });

  it("update patches and persists", () => {
    const job: Job = {
      id: "job_2", task: "test", state: "queued", playbookId: null,
      sessionId: null, lastStep: -1, steps: [], blockReason: null,
      retries: 0, maxRetries: 3, lastError: null, tags: [], priority: 10,
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      startedAt: null, completedAt: null,
    };
    store.add(job);
    store.update("job_2", { state: "running" });

    const reloaded = new JobStore(dir);
    reloaded.init();
    expect(reloaded.get("job_2")!.state).toBe("running");
  });

  it("removes a job", () => {
    const job: Job = {
      id: "job_rm", task: "test", state: "queued", playbookId: null,
      sessionId: null, lastStep: -1, steps: [], blockReason: null,
      retries: 0, maxRetries: 3, lastError: null, tags: [], priority: 10,
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      startedAt: null, completedAt: null,
    };
    store.add(job);
    expect(store.remove("job_rm")).toBe(true);
    expect(store.get("job_rm")).toBeUndefined();
  });

  it("nextQueued returns highest priority", () => {
    const base = {
      state: "queued" as const, playbookId: null, sessionId: null, lastStep: -1,
      steps: [], blockReason: null, retries: 0, maxRetries: 3, lastError: null,
      tags: [], startedAt: null, completedAt: null,
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    store.add({ ...base, id: "low", task: "low", priority: 20 });
    store.add({ ...base, id: "high", task: "high", priority: 1 });
    store.add({ ...base, id: "med", task: "med", priority: 10 });

    expect(store.nextQueued()!.id).toBe("high");
  });

  it("filters by state", () => {
    const base = {
      playbookId: null, sessionId: null, lastStep: -1,
      steps: [], blockReason: null, retries: 0, maxRetries: 3, lastError: null,
      tags: [], priority: 10, startedAt: null, completedAt: null,
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    store.add({ ...base, id: "q1", task: "q1", state: "queued" });
    store.add({ ...base, id: "r1", task: "r1", state: "running" });
    store.add({ ...base, id: "d1", task: "d1", state: "done" });

    expect(store.list("queued")).toHaveLength(1);
    expect(store.list("running")).toHaveLength(1);
    expect(store.list("done")).toHaveLength(1);
    expect(store.list()).toHaveLength(3);
  });
});

describe("JobManager", () => {
  let mgr: JobManager;
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    mgr = new JobManager({ jobDir: dir });
    mgr.init();
  });

  describe("create", () => {
    it("creates a queued job with steps", () => {
      const job = mgr.create({
        task: "Post to Twitter",
        steps: [
          { action: "navigate", target: "https://x.com", description: "Open Twitter" },
          { action: "click", target: "New post", description: "Click new post" },
          { action: "type_text", target: "Post input", description: "Type message" },
        ],
        tags: ["social"],
      });

      expect(job.state).toBe("queued");
      expect(job.steps).toHaveLength(3);
      expect(job.steps[0]!.status).toBe("pending");
      expect(job.lastStep).toBe(-1);
      expect(job.id).toMatch(/^job_/);
    });
  });

  describe("state transitions", () => {
    it("queued → running", () => {
      const job = mgr.create({ task: "test" });
      const result = mgr.transition(job.id, "running");
      expect("state" in result && result.state).toBe("running");
    });

    it("running → blocked with reason", () => {
      const job = mgr.create({ task: "test" });
      mgr.transition(job.id, "running");
      const result = mgr.transition(job.id, "blocked", { blockReason: "CAPTCHA detected" });
      expect("state" in result && result.state).toBe("blocked");
      expect("blockReason" in result && result.blockReason).toBe("CAPTCHA detected");
    });

    it("running → waiting_human", () => {
      const job = mgr.create({ task: "test" });
      mgr.transition(job.id, "running");
      const result = mgr.transition(job.id, "waiting_human", { blockReason: "2FA required" });
      expect("state" in result && result.state).toBe("waiting_human");
    });

    it("running → done records completedAt", () => {
      const job = mgr.create({ task: "test" });
      mgr.transition(job.id, "running");
      const result = mgr.transition(job.id, "done");
      expect("completedAt" in result && result.completedAt).toBeTruthy();
    });

    it("running → failed records error", () => {
      const job = mgr.create({ task: "test" });
      mgr.transition(job.id, "running");
      const result = mgr.transition(job.id, "failed", { error: "Element not found" });
      expect("lastError" in result && result.lastError).toBe("Element not found");
    });

    it("failed → queued (retry) bumps retry count", () => {
      const job = mgr.create({ task: "test", maxRetries: 3 });
      mgr.transition(job.id, "running");
      mgr.transition(job.id, "failed", { error: "crash" });
      const result = mgr.transition(job.id, "queued");
      expect("retries" in result && result.retries).toBe(1);
    });

    it("rejects exceeding max retries", () => {
      const job = mgr.create({ task: "test", maxRetries: 1 });
      mgr.transition(job.id, "running");
      mgr.transition(job.id, "failed");
      mgr.transition(job.id, "queued"); // retry 1
      mgr.transition(job.id, "running");
      mgr.transition(job.id, "failed");
      const result = mgr.transition(job.id, "queued"); // retry 2 > max
      expect("error" in result).toBe(true);
    });

    it("rejects invalid transitions", () => {
      const job = mgr.create({ task: "test" });
      const result = mgr.transition(job.id, "done"); // queued → done not allowed
      expect("error" in result).toBe(true);
    });

    it("done is terminal", () => {
      const job = mgr.create({ task: "test" });
      mgr.transition(job.id, "running");
      mgr.transition(job.id, "done");
      const result = mgr.transition(job.id, "running");
      expect("error" in result).toBe(true);
    });
  });

  describe("step tracking", () => {
    it("completeStep advances lastStep", () => {
      const job = mgr.create({
        task: "test",
        steps: [
          { action: "click", description: "step 0" },
          { action: "type", description: "step 1" },
          { action: "click", description: "step 2" },
        ],
      });
      mgr.transition(job.id, "running");

      mgr.completeStep(job.id, 0, { durationMs: 50 });
      const after = mgr.get(job.id)!;
      expect(after.lastStep).toBe(0);
      expect(after.steps[0]!.status).toBe("done");
      expect(after.steps[0]!.durationMs).toBe(50);
    });

    it("failStep marks step but keeps job running", () => {
      const job = mgr.create({
        task: "test",
        steps: [{ action: "click", description: "step 0" }],
      });
      mgr.transition(job.id, "running");
      mgr.failStep(job.id, 0, "timeout");

      const after = mgr.get(job.id)!;
      expect(after.state).toBe("running");
      expect(after.steps[0]!.status).toBe("failed");
      expect(after.steps[0]!.error).toBe("timeout");
    });

    it("skipStep marks step as skipped", () => {
      const job = mgr.create({
        task: "test",
        steps: [{ action: "click", description: "optional step" }],
      });
      mgr.transition(job.id, "running");
      mgr.skipStep(job.id, 0);
      expect(mgr.get(job.id)!.steps[0]!.status).toBe("skipped");
    });
  });

  describe("resume", () => {
    it("returns next pending step after lastStep", () => {
      const job = mgr.create({
        task: "test",
        steps: [
          { action: "a", description: "step 0" },
          { action: "b", description: "step 1" },
          { action: "c", description: "step 2" },
        ],
      });
      mgr.transition(job.id, "running");
      mgr.completeStep(job.id, 0);
      mgr.completeStep(job.id, 1);

      const resume = mgr.getResumePoint(job.id);
      expect(resume).not.toBeNull();
      expect(resume!.stepIndex).toBe(2);
      expect(resume!.step.action).toBe("c");
    });

    it("returns null when all steps are done", () => {
      const job = mgr.create({
        task: "test",
        steps: [{ action: "a", description: "step 0" }],
      });
      mgr.transition(job.id, "running");
      mgr.completeStep(job.id, 0);

      expect(mgr.getResumePoint(job.id)).toBeNull();
    });

    it("skips over done/skipped steps to find next pending", () => {
      const job = mgr.create({
        task: "test",
        steps: [
          { action: "a" },
          { action: "b" },
          { action: "c" },
        ],
      });
      mgr.transition(job.id, "running");
      mgr.completeStep(job.id, 0);
      mgr.skipStep(job.id, 1);

      const resume = mgr.getResumePoint(job.id);
      expect(resume!.stepIndex).toBe(2);
    });
  });

  describe("dequeue", () => {
    it("pops highest-priority queued job", () => {
      mgr.create({ task: "low", priority: 20 });
      mgr.create({ task: "high", priority: 1 });

      const job = mgr.dequeue("sess_1");
      expect(job).not.toBeNull();
      expect(job!.task).toBe("high");
      expect(job!.state).toBe("running");
      expect(job!.sessionId).toBe("sess_1");
    });

    it("returns null when queue is empty", () => {
      expect(mgr.dequeue()).toBeNull();
    });
  });

  describe("summary", () => {
    it("counts jobs by state", () => {
      mgr.create({ task: "q1" });
      mgr.create({ task: "q2" });
      const j3 = mgr.create({ task: "r1" });
      mgr.transition(j3.id, "running");

      const sum = mgr.summary();
      expect(sum.total).toBe(3);
      expect(sum.byState.queued).toBe(2);
      expect(sum.byState.running).toBe(1);
      expect(sum.runningJobIds).toContain(j3.id);
    });
  });

  describe("persistence", () => {
    it("survives manager restart with step progress intact", () => {
      const job = mgr.create({
        task: "test",
        steps: [
          { action: "a", description: "step 0" },
          { action: "b", description: "step 1" },
        ],
      });
      mgr.transition(job.id, "running");
      mgr.completeStep(job.id, 0, { durationMs: 100 });

      // Simulate restart
      const mgr2 = new JobManager({ jobDir: dir });
      mgr2.init();

      const restored = mgr2.get(job.id)!;
      expect(restored.state).toBe("running");
      expect(restored.lastStep).toBe(0);
      expect(restored.steps[0]!.status).toBe("done");

      const resume = mgr2.getResumePoint(job.id);
      expect(resume!.stepIndex).toBe(1);
    });
  });

  describe("VALID_TRANSITIONS", () => {
    it("done is terminal", () => {
      expect(VALID_TRANSITIONS.done).toEqual([]);
    });

    it("failed can re-queue", () => {
      expect(VALID_TRANSITIONS.failed).toContain("queued");
    });

    it("blocked can resume", () => {
      expect(VALID_TRANSITIONS.blocked).toContain("running");
    });

    it("waiting_human can resume", () => {
      expect(VALID_TRANSITIONS.waiting_human).toContain("running");
    });
  });
});
