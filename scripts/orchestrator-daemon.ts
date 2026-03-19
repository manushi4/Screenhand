#!/usr/bin/env npx tsx
/**
 * Orchestrator Daemon — multi-agent task router and coordinator.
 *
 * Manages a pool of worker slots that process tasks in parallel:
 *   - Web slots (CDP-only): truly parallel, no mouse/keyboard conflict
 *   - Native slots: serialized per-app via lease locks
 *
 * Each worker slot runs a JobRunner independently. The orchestrator
 * routes tasks to the right slot type and manages coordination.
 *
 * Usage:
 *   npx tsx scripts/orchestrator-daemon.ts
 *   npx tsx scripts/orchestrator-daemon.ts --web-slots 4 --native-slots 1 --poll 1000
 *
 * State files:
 *   ~/.screenhand/orchestrator/state.json         — orchestrator state
 *   ~/.screenhand/orchestrator/orchestrator.pid   — PID of this process
 *   ~/.screenhand/orchestrator/orchestrator.log   — log output
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeClient } from "../src/native/bridge-client.js";
import { SessionSupervisor, LeaseManager } from "../src/supervisor/supervisor.js";
import { JobManager } from "../src/jobs/manager.js";
import { JobRunner } from "../src/jobs/runner.js";
import type { RunResult } from "../src/jobs/runner.js";
import { PlaybookEngine } from "../src/playbook/engine.js";
import { PlaybookStore } from "../src/playbook/store.js";
import { AccessibilityAdapter } from "../src/runtime/accessibility-adapter.js";
import { AutomationRuntimeService } from "../src/runtime/service.js";
import { TimelineLogger } from "../src/logging/timeline-logger.js";
import { MemoryService } from "../src/memory/service.js";
import { writeOrchestratorState, getOrchestratorDaemonPid } from "../src/orchestrator/state.js";
import type { OrchestratorState, OrchestratorTask, WorkerSlot } from "../src/orchestrator/types.js";
import { ORCHESTRATOR_DIR, ORCHESTRATOR_PID_FILE, ORCHESTRATOR_LOG_FILE } from "../src/orchestrator/types.js";

// ── Config from CLI args ──

const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf("--" + name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const WEB_SLOTS = Number(getArg("web-slots", "4"));
const NATIVE_SLOTS = Number(getArg("native-slots", "1"));
const POLL_MS = Number(getArg("poll", "1000"));

// ── Directories ──

const JOB_DIR = path.join(os.homedir(), ".screenhand", "jobs");
const LOCK_DIR = path.join(os.homedir(), ".screenhand", "locks");
const PLAYBOOKS_DIR = path.join(os.homedir(), ".screenhand", "playbooks");
const SUPERVISOR_STATE_DIR = path.join(os.homedir(), ".screenhand", "supervisor");

fs.mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
fs.mkdirSync(JOB_DIR, { recursive: true });

// ── Logging ──

const logStream = fs.createWriteStream(ORCHESTRATOR_LOG_FILE, { flags: "a" });
let daemonized = false;

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
  if (!daemonized) process.stderr.write(line + "\n");
}

// ── Bridge setup ──

const scriptDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const projectRoot = scriptDir.includes("/dist/")
  ? path.resolve(scriptDir, "../..")
  : path.resolve(scriptDir, "..");
const bridgePath = process.platform === "win32"
  ? path.resolve(projectRoot, "native/windows-bridge/bin/Release/net8.0-windows/windows-bridge.exe")
  : path.resolve(projectRoot, "native/macos-bridge/.build/release/macos-bridge");

// Each worker slot gets its own bridge for true parallelism
function createBridge(): BridgeClient {
  return new BridgeClient(bridgePath);
}

// ── Shared services ──

const leaseManager = new LeaseManager(LOCK_DIR);
const supervisor = new SessionSupervisor({
  stateDir: SUPERVISOR_STATE_DIR,
  lockDir: LOCK_DIR,
});
const memory = new MemoryService(os.homedir());
const jobManager = new JobManager({ jobDir: JOB_DIR, memory, supervisor });
jobManager.init();

const playbookStore = new PlaybookStore(PLAYBOOKS_DIR);

// ── State ──

let stopped = false;
const startedAt = new Date().toISOString();
let totalSubmitted = 0;
let totalCompleted = 0;
let totalFailed = 0;

// Task queue — loaded from / persisted to state.json
let taskQueue: OrchestratorTask[] = [];

// Worker slots
const workers: WorkerSlot[] = [];
const workerRunners: Map<number, { runner: JobRunner; bridge: BridgeClient; busy: boolean }> = new Map();

// App locks for native tasks — bundleId → worker slot ID
const nativeLocks: Map<string, number> = new Map();

// ── Worker slot initialization ──

async function initWorkerSlots(): Promise<void> {
  let slotId = 0;

  // Web slots
  for (let i = 0; i < WEB_SLOTS; i++) {
    const slot: WorkerSlot = {
      id: slotId,
      type: "web",
      busy: false,
      tasksCompleted: 0,
      tasksFailed: 0,
    };
    workers.push(slot);

    const bridge = createBridge();
    await bridge.start();
    const adapter = new AccessibilityAdapter(bridge);
    const logger = new TimelineLogger();
    const runtimeService = new AutomationRuntimeService(adapter, logger);
    const playbookEngine = new PlaybookEngine(runtimeService);

    const runner = new JobRunner(bridge, jobManager, leaseManager, supervisor, {
      playbookEngine,
      playbookStore,
      runtimeService,
      onLog: (msg) => log(`[W${slotId}] ${msg}`),
    });

    workerRunners.set(slotId, { runner, bridge, busy: false });
    slotId++;
  }

  // Native slots
  for (let i = 0; i < NATIVE_SLOTS; i++) {
    const slot: WorkerSlot = {
      id: slotId,
      type: "native",
      busy: false,
      tasksCompleted: 0,
      tasksFailed: 0,
    };
    workers.push(slot);

    const bridge = createBridge();
    await bridge.start();
    const adapter = new AccessibilityAdapter(bridge);
    const logger = new TimelineLogger();
    const runtimeService = new AutomationRuntimeService(adapter, logger);
    const playbookEngine = new PlaybookEngine(runtimeService);

    const runner = new JobRunner(bridge, jobManager, leaseManager, supervisor, {
      playbookEngine,
      playbookStore,
      runtimeService,
      onLog: (msg) => log(`[W${slotId}] ${msg}`),
    });

    workerRunners.set(slotId, { runner, bridge, busy: false });
    slotId++;
  }

  log(`Initialized ${WEB_SLOTS} web slots + ${NATIVE_SLOTS} native slots = ${workers.length} total`);
}

// ── Task routing ──

function findAvailableSlot(task: OrchestratorTask): WorkerSlot | null {
  if (task.mode === "web") {
    // Any free web slot
    return workers.find(w => w.type === "web" && !w.busy) ?? null;
  }

  if (task.mode === "native" || task.mode === "mixed") {
    // Native tasks need a free native slot AND the app must not be locked by another slot
    const bundleId = task.bundleId ?? "unknown";
    const lockHolder = nativeLocks.get(bundleId);

    if (lockHolder !== undefined) {
      // App is locked — only the lock holder can work on it
      const slot = workers.find(w => w.id === lockHolder && !w.busy);
      return slot ?? null;
    }

    // No lock — find any free native slot
    return workers.find(w => w.type === "native" && !w.busy) ?? null;
  }

  return null;
}

// ── Task → Job conversion ──

function taskToJobParams(task: OrchestratorTask) {
  return {
    task: task.task,
    ...(task.playbookId !== undefined ? { playbookId: task.playbookId } : {}),
    ...(task.bundleId !== undefined ? { bundleId: task.bundleId } : {}),
    ...(task.windowId !== undefined ? { windowId: task.windowId } : {}),
    ...(task.vars ? { vars: task.vars } : {}),
    priority: task.priority,
    tags: ["orchestrator", `task_${task.id}`],
  };
}

// ── Task dispatch ──

async function dispatchTask(task: OrchestratorTask, slot: WorkerSlot): Promise<void> {
  const worker = workerRunners.get(slot.id);
  if (!worker) return;

  // Mark slot as busy
  slot.busy = true;
  slot.currentTaskId = task.id;
  worker.busy = true;

  // Lock native app
  if ((task.mode === "native" || task.mode === "mixed") && task.bundleId) {
    nativeLocks.set(task.bundleId, slot.id);
  }

  // Update task status
  task.status = "assigned";
  task.assignedWorker = slot.id;
  task.startedAt = new Date().toISOString();

  log(`Dispatching task ${task.id} ("${task.task.slice(0, 50)}") to slot ${slot.id} (${slot.type})`);

  // Create a job for this task
  const jobParams = taskToJobParams(task);
  const job = jobManager.create(jobParams);
  task.jobId = job.id;
  task.status = "running";

  persistState();

  // Run the job asynchronously
  try {
    const result = await worker.runner.run();

    if (result) {
      task.result = `${result.finalState}: ${result.stepsCompleted}/${result.totalSteps} steps in ${result.durationMs}ms`;

      if (result.finalState === "done") {
        task.status = "done";
        slot.tasksCompleted++;
        totalCompleted++;
        log(`Task ${task.id} completed (${result.durationMs}ms)`);
      } else if (result.finalState === "blocked" || result.finalState === "waiting_human") {
        task.status = "blocked";
        task.error = result.error ?? "Blocked";
        log(`Task ${task.id} blocked: ${result.error ?? "unknown"}`);
      } else {
        task.status = "failed";
        task.error = result.error ?? "Failed";
        slot.tasksFailed++;
        totalFailed++;
        log(`Task ${task.id} failed: ${result.error ?? "unknown"}`);
      }
    } else {
      // No job was dequeued — it may have been picked up already
      task.status = "failed";
      task.error = "No job to dequeue";
      slot.tasksFailed++;
      totalFailed++;
    }
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    slot.tasksFailed++;
    totalFailed++;
    log(`Task ${task.id} error: ${task.error}`);
  }

  // Release slot
  task.completedAt = new Date().toISOString();
  slot.busy = false;
  delete slot.currentTaskId;
  worker.busy = false;

  // Release native app lock
  if ((task.mode === "native" || task.mode === "mixed") && task.bundleId) {
    nativeLocks.delete(task.bundleId);
  }

  persistState();
}

// ── State persistence ──

function buildState(): OrchestratorState {
  const nativeLocksObj: Record<string, number> = {};
  for (const [k, v] of nativeLocks) nativeLocksObj[k] = v;

  return {
    pid: process.pid,
    running: !stopped,
    startedAt,
    workers: [...workers],
    webSlots: WEB_SLOTS,
    nativeSlots: NATIVE_SLOTS,
    tasks: taskQueue,
    totalSubmitted,
    totalCompleted,
    totalFailed,
    nativeLocks: nativeLocksObj,
  };
}

function persistState(): void {
  try {
    writeOrchestratorState(buildState());
  } catch {
    // Non-fatal
  }
}

// ── Load tasks from state (resume after restart) ──

function loadState(): void {
  try {
    const state = readExistingState();
    if (state && state.tasks) {
      // Resume queued/running tasks
      for (const task of state.tasks) {
        if (task.status === "queued" || task.status === "assigned" || task.status === "running") {
          task.status = "queued"; // Re-queue interrupted tasks
          delete task.assignedWorker;
          taskQueue.push(task);
        }
      }
      totalSubmitted = state.totalSubmitted ?? 0;
      totalCompleted = state.totalCompleted ?? 0;
      totalFailed = state.totalFailed ?? 0;
      if (taskQueue.length > 0) {
        log(`Resumed ${taskQueue.length} tasks from previous state`);
      }
    }
  } catch {
    // Fresh start
  }
}

function readExistingState(): OrchestratorState | null {
  try {
    const data = fs.readFileSync(
      path.join(ORCHESTRATOR_DIR, "state.json"),
      "utf-8",
    );
    return JSON.parse(data) as OrchestratorState;
  } catch {
    return null;
  }
}

// ── Main poll loop ──

async function poll(): Promise<void> {
  // Also reload playbooks periodically
  playbookStore.load();

  // Sort queue by priority (lower = higher priority)
  const queued = taskQueue
    .filter(t => t.status === "queued")
    .sort((a, b) => a.priority - b.priority);

  // Dispatch tasks to available slots
  const dispatches: Promise<void>[] = [];

  for (const task of queued) {
    const slot = findAvailableSlot(task);
    if (slot) {
      // Dispatch in parallel — don't await here
      dispatches.push(dispatchTask(task, slot));
    }
  }

  // Wait for all dispatched tasks in this cycle
  if (dispatches.length > 0) {
    await Promise.allSettled(dispatches);
  }
}

async function main() {
  // Enforce single daemon
  const existingPid = getOrchestratorDaemonPid();
  if (existingPid !== null && existingPid !== process.pid) {
    log(`Another orchestrator daemon already running (pid=${existingPid}). Aborting.`);
    process.exit(1);
  }

  fs.writeFileSync(ORCHESTRATOR_PID_FILE, String(process.pid));
  daemonized = true;

  log(`Orchestrator daemon started (pid=${process.pid})`);
  log(`Config: web-slots=${WEB_SLOTS} native-slots=${NATIVE_SLOTS} poll=${POLL_MS}ms`);

  // Load previous state
  loadState();

  // Initialize worker slots (each with its own bridge)
  await initWorkerSlots();

  persistState();

  // Poll loop
  while (!stopped) {
    try {
      await poll();
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Graceful shutdown ──

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  if (stopped) return;
  stopped = true;
  log("Shutting down...");

  // Stop all worker bridges
  for (const [, w] of workerRunners) {
    try { await w.bridge.stop(); } catch { /* ignore */ }
  }

  persistState();
  try { fs.unlinkSync(ORCHESTRATOR_PID_FILE); } catch { /* ignore */ }
  logStream.end();

  log(`Orchestrator exiting (${totalCompleted} done, ${totalFailed} failed)`);
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
