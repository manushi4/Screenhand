import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { JobManager } from "../src/jobs/manager.js";
import { JobRunner } from "../src/jobs/runner.js";
import { writeWorkerStatus, readWorkerStatus } from "../src/jobs/worker.js";
import type { WorkerStatus } from "../src/jobs/worker.js";
import { LeaseManager } from "../src/supervisor/locks.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobrunner-test-"));
}

/** Minimal mock bridge that records calls and returns canned responses. */
function mockBridge(responses?: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const defaults: Record<string, unknown> = {
    "ax.findElement": { elementPath: [0, 1], bounds: { x: 100, y: 200, width: 50, height: 20 } },
    "ax.performAction": {},
    "ax.setElementValue": {},
    "ax.getElementValue": { value: "hello" },
    "ax.getElementTree": { description: "root > button" },
    "cg.captureScreen": { path: "/tmp/screenshot.png" },
    "cg.scroll": {},
    "cg.typeText": {},
    "cg.mouseClick": {},
    "cg.keyCombo": {},
    "vision.findText": [{ text: "found", bounds: { x: 10, y: 20, width: 30, height: 10 } }],
    "vision.ocr": { text: "screen text" },
    "app.openURL": {},
    ...responses,
  };

  return {
    calls,
    bridge: {
      start: async () => {},
      stop: async () => {},
      call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ method, params });
        if (method in defaults) return defaults[method] as T;
        throw new Error(`Mock: no response for ${method}`);
      },
    } as any,
  };
}

describe("JobRunner", () => {
  let jobDir: string;
  let lockDir: string;
  let jobs: JobManager;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    jobDir = tmpDir();
    lockDir = tmpDir();
    jobs = new JobManager({ jobDir });
    jobs.init();
    leaseManager = new LeaseManager(lockDir);
  });

  it("returns null when queue is empty", async () => {
    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();
    expect(result).toBeNull();
  });

  it("executes a click step via AX fallback", async () => {
    jobs.create({
      task: "Click the button",
      steps: [{ action: "click", target: "Submit", description: "Click Submit" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result).not.toBeNull();
    expect(result!.finalState).toBe("done");
    expect(result!.stepsCompleted).toBe(1);
    expect(calls.some((c) => c.method === "ax.findElement")).toBe(true);
    expect(calls.some((c) => c.method === "ax.performAction")).toBe(true);
  });

  it("executes a type step", async () => {
    jobs.create({
      task: "Type hello",
      steps: [{ action: "type_text", target: "Name field", description: "hello" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(calls.some((c) => c.method === "ax.setElementValue")).toBe(true);
  });

  it("executes multiple steps in sequence", async () => {
    jobs.create({
      task: "Multi-step job",
      steps: [
        { action: "click", target: "Open", description: "Click open" },
        { action: "type_text", target: "Input", description: "Type text" },
        { action: "click", target: "Save", description: "Click save" },
      ],
    });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(result!.stepsCompleted).toBe(3);

    // Job should be persisted as done
    const job = jobs.get(result!.jobId)!;
    expect(job.state).toBe("done");
    expect(job.completedAt).toBeTruthy();
    expect(job.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("resumes from last successful step", async () => {
    const job = jobs.create({
      task: "Resume test",
      steps: [
        { action: "click", target: "A" },
        { action: "click", target: "B" },
        { action: "click", target: "C" },
      ],
    });

    // Simulate: step 0 already done from previous run
    jobs.transition(job.id, "running");
    jobs.completeStep(job.id, 0);
    // Now fail the job so it can be re-queued
    jobs.transition(job.id, "failed", { error: "crash" });
    jobs.transition(job.id, "queued");

    const calls: string[] = [];
    const { bridge } = mockBridge();
    // Wrap bridge to track findElement calls
    const origCall = bridge.call.bind(bridge);
    bridge.call = async (method: string, params: any) => {
      if (method === "ax.findElement") calls.push(params.title);
      return origCall(method, params);
    };

    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    // Should only execute steps B and C (A was already done)
    expect(calls).toEqual(["B", "C"]);
  });

  it("transitions to failed after consecutive failures", async () => {
    jobs.create({
      task: "Failing job",
      steps: [
        { action: "click", target: "Missing1" },
        { action: "click", target: "Missing2" },
        { action: "click", target: "Missing3" },
      ],
    });

    const { bridge } = mockBridge();
    // Override to always throw (not a blocker pattern — just a generic error)
    bridge.call = async (method: string) => {
      if (method === "ax.findElement" || method === "ax.performAction" || method === "cg.captureScreen" || method === "vision.findText" || method === "cg.mouseClick") {
        throw new Error("Element not found");
      }
      // Lease methods still work
      return {};
    };

    const runner = new JobRunner(bridge, jobs, leaseManager, null, {
      heartbeatMs: 60000,
      stepDelayMs: 0,
      maxConsecutiveFailures: 2,
    });
    const result = await runner.run();

    expect(result!.finalState).toBe("failed");
    expect(result!.stepsCompleted).toBe(0);
  });

  it("transitions to waiting_human on human blocker", async () => {
    jobs.create({
      task: "Blocked by captcha",
      steps: [{ action: "click", target: "Submit" }],
    });

    const { bridge } = mockBridge();
    // All bridge methods throw with the blocker keyword so the last error in the fallback chain still matches
    bridge.call = async () => { throw new Error("CAPTCHA detected — please solve manually"); };

    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("waiting_human");
    const job = jobs.get(result!.jobId)!;
    expect(job.blockReason).toContain("CAPTCHA");
  });

  it("transitions to blocked on transient blocker", async () => {
    jobs.create({
      task: "Rate limited",
      steps: [{ action: "click", target: "Submit" }],
    });

    const { bridge } = mockBridge();
    bridge.call = async () => { throw new Error("rate limit exceeded, try again later"); };

    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("blocked");
  });

  it("claims and releases supervisor session", async () => {
    jobs.create({
      task: "Session test",
      steps: [{ action: "wait", description: "wait" }],
    });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    // Session should be released — no active leases
    expect(leaseManager.getActive()).toHaveLength(0);
  });

  it("processes multiple jobs with runLoop-style sequential calls", async () => {
    jobs.create({ task: "Job A", steps: [{ action: "wait" }], priority: 1 });
    jobs.create({ task: "Job B", steps: [{ action: "wait" }], priority: 2 });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });

    const r1 = await runner.run();
    const r2 = await runner.run();
    const r3 = await runner.run();

    expect(r1!.finalState).toBe("done");
    expect(r2!.finalState).toBe("done");
    expect(r3).toBeNull(); // Queue empty
  });

  it("stop() halts after current step", async () => {
    jobs.create({
      task: "Stoppable",
      steps: [
        { action: "click", target: "A", description: "step 0" },
        { action: "click", target: "B", description: "step 1" },
        { action: "click", target: "C", description: "step 2" },
      ],
    });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });

    // Stop after first AXPress completes
    const origCall = bridge.call.bind(bridge);
    let pressCount = 0;
    bridge.call = async (method: string, params: any) => {
      const result = await origCall(method, params);
      if (method === "ax.performAction") {
        pressCount++;
        if (pressCount >= 1) runner.stop();
      }
      return result;
    };

    const result = await runner.run();
    const job = jobs.get(result!.jobId)!;
    // Completed at least 1 step but not all 3
    expect(job.lastStep).toBeGreaterThanOrEqual(0);
    expect(job.steps.filter((s) => s.status === "done").length).toBeLessThanOrEqual(2);
  });

  it("navigate step works", async () => {
    jobs.create({
      task: "Navigate test",
      steps: [{ action: "navigate", target: "https://example.com" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(calls.some((c) => c.method === "app.openURL")).toBe(true);
  });

  it("screenshot step works", async () => {
    jobs.create({
      task: "Screenshot test",
      steps: [{ action: "screenshot" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(calls.some((c) => c.method === "cg.captureScreen")).toBe(true);
  });

  it("scroll step works", async () => {
    jobs.create({
      task: "Scroll test",
      steps: [{ action: "scroll", description: "down" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(calls.some((c) => c.method === "cg.scroll")).toBe(true);
  });

  it("uses step.text for type actions instead of description", async () => {
    jobs.create({
      task: "Type with explicit text",
      steps: [{ action: "type_text", target: "Name field", text: "explicit text", description: "should not use this" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    const setValueCall = calls.find((c) => c.method === "ax.setElementValue");
    expect(setValueCall).toBeDefined();
    expect(setValueCall!.params.value).toBe("explicit text");
  });

  it("uses step.keys for key_combo actions", async () => {
    jobs.create({
      task: "Key combo test",
      steps: [{ action: "key_combo", keys: "cmd+a" }],
    });

    const { bridge, calls } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    const keyCall = calls.find((c) => c.method === "cg.keyCombo");
    expect(keyCall).toBeDefined();
    expect(keyCall!.params.keys).toEqual(["cmd", "a"]);
  });

  it("claims session with real bundleId/windowId", async () => {
    jobs.create({
      task: "Safari job",
      bundleId: "com.apple.Safari",
      windowId: 42,
      steps: [{ action: "wait", description: "wait" }],
    });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    // Verify the lease was created for the right app/window
    const job = jobs.get(result!.jobId)!;
    expect(job.bundleId).toBe("com.apple.Safari");
    expect(job.windowId).toBe(42);
  });

  it("uses supervisor.registerSession when supervisor is provided", async () => {
    jobs.create({
      task: "Supervisor session test",
      bundleId: "com.google.Chrome",
      windowId: 7,
      steps: [{ action: "wait", description: "wait" }],
    });

    const registerCalls: Array<{ app: string; windowId: number }> = [];
    const releaseCalls: string[] = [];
    const heartbeatCalls: string[] = [];

    const mockSupervisor = {
      registerSession: (client: any, app: string, windowId: number) => {
        registerCalls.push({ app, windowId });
        // Delegate to lease manager so the lease actually exists
        return leaseManager.claim(client, app, windowId);
      },
      heartbeat: (sessionId: string) => {
        heartbeatCalls.push(sessionId);
        return leaseManager.heartbeat(sessionId);
      },
      releaseSession: (sessionId: string) => {
        releaseCalls.push(sessionId);
        return leaseManager.release(sessionId);
      },
    } as any;

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, mockSupervisor, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    // Verify supervisor was used, not raw leaseManager
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]!.app).toBe("com.google.Chrome");
    expect(registerCalls[0]!.windowId).toBe(7);
    expect(releaseCalls).toHaveLength(1);
  });

  it("focuses target bundleId before each step", async () => {
    jobs.create({
      task: "Focus test",
      bundleId: "com.apple.Safari",
      steps: [
        { action: "click", target: "Submit" },
        { action: "click", target: "Confirm" },
      ],
    });

    const focusCalls: string[] = [];
    const { bridge, calls } = mockBridge({
      "app.list": [{ bundleId: "com.apple.Safari", pid: 123 }],
    });
    const origCall = bridge.call.bind(bridge);
    bridge.call = async (method: string, params: any) => {
      if (method === "app.focus") focusCalls.push(params.bundleId);
      return origCall(method, params);
    };

    const runner = new JobRunner(bridge, jobs, leaseManager, null, { heartbeatMs: 60000, stepDelayMs: 0 });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    // Should focus before each step
    expect(focusCalls).toEqual(["com.apple.Safari", "com.apple.Safari"]);
  });

  it("executes playbookId through playbook engine", async () => {
    jobs.create({
      task: "Playbook test",
      playbookId: "test_playbook",
      steps: [],
    });

    const engineSteps: string[] = [];
    const mockEngine = {
      run: async (_sessionId: string, playbook: any, opts: any) => {
        for (let i = 0; i < playbook.steps.length; i++) {
          engineSteps.push(playbook.steps[i].action);
          if (opts?.onStep) opts.onStep(i, playbook.steps[i], "ok");
        }
        return {
          playbook: playbook.id,
          success: true,
          stepsCompleted: playbook.steps.length,
          totalSteps: playbook.steps.length,
          failedAtStep: -1,
          durationMs: 10,
        };
      },
    } as any;

    const mockStore = {
      get: (id: string) => {
        if (id !== "test_playbook") return undefined;
        return {
          id: "test_playbook",
          name: "Test Playbook",
          description: "test",
          platform: "test",
          steps: [
            { action: "navigate" as const, url: "https://example.com", description: "Go to example" },
            { action: "press" as const, target: "Submit", description: "Click Submit" },
          ],
          version: "1.0.0",
          tags: [],
          successCount: 0,
          failCount: 0,
        };
      },
      recordOutcome: vi.fn(),
    } as any;

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, {
      heartbeatMs: 60000,
      stepDelayMs: 0,
      playbookEngine: mockEngine,
      playbookStore: mockStore,
    });
    const result = await runner.run();

    expect(result!.finalState).toBe("done");
    expect(engineSteps).toEqual(["navigate", "press"]);
    expect(mockStore.recordOutcome).toHaveBeenCalledWith("test_playbook", true);

    // Job steps should have been populated from the playbook
    const job = jobs.get(result!.jobId)!;
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0]!.status).toBe("done");
    expect(job.steps[1]!.status).toBe("done");
  });

  it("fails fast when playbookId not found in store", async () => {
    jobs.create({
      task: "Missing playbook",
      playbookId: "nonexistent",
      steps: [{ action: "wait", description: "wait" }],
    });

    const mockStore = { get: () => undefined, recordOutcome: vi.fn() } as any;
    const mockEngine = { run: vi.fn() } as any;

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, {
      heartbeatMs: 60000,
      stepDelayMs: 0,
      playbookEngine: mockEngine,
      playbookStore: mockStore,
    });
    const result = await runner.run();

    expect(result!.finalState).toBe("failed");
    expect(result!.error).toContain("not found");
    expect(mockEngine.run).not.toHaveBeenCalled();
  });

  it("fails fast when playbookId set but no engine configured", async () => {
    jobs.create({
      task: "No engine",
      playbookId: "some_playbook",
      steps: [{ action: "wait", description: "wait" }],
    });

    const { bridge } = mockBridge();
    const runner = new JobRunner(bridge, jobs, leaseManager, null, {
      heartbeatMs: 60000,
      stepDelayMs: 0,
      // no playbookEngine or playbookStore
    });
    const result = await runner.run();

    expect(result!.finalState).toBe("failed");
    expect(result!.error).toContain("no playbook engine is configured");
  });
});

describe("WorkerStatus persistence", () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
  });

  it("writes and reads worker status from disk", () => {
    const status: WorkerStatus = {
      pid: 12345,
      running: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      pollMs: 3000,
      maxJobs: 0,
      jobsProcessed: 5,
      jobsDone: 3,
      jobsFailed: 1,
      jobsBlocked: 1,
      lastJobId: "job_test_123",
      lastJobState: "done",
      uptimeMs: 60000,
      recentResults: [
        { jobId: "job_test_123", finalState: "done", stepsCompleted: 2, totalSteps: 2, durationMs: 500, error: null },
      ],
    };

    writeWorkerStatus(status, workerDir);
    const loaded = readWorkerStatus(workerDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.pid).toBe(12345);
    expect(loaded!.running).toBe(true);
    expect(loaded!.jobsProcessed).toBe(5);
    expect(loaded!.jobsDone).toBe(3);
    expect(loaded!.recentResults).toHaveLength(1);
    expect(loaded!.recentResults[0]!.jobId).toBe("job_test_123");
  });

  it("returns null when no state file exists", () => {
    const emptyDir = tmpDir();
    const result = readWorkerStatus(emptyDir);
    expect(result).toBeNull();
  });
});
