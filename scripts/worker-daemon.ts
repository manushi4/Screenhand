#!/usr/bin/env npx tsx
/**
 * Worker Daemon — runs as a standalone background process.
 *
 * Survives MCP/client restarts. Continuously processes the job queue
 * via JobRunner with playbook engine support.
 *
 * Usage:
 *   npx tsx scripts/worker-daemon.ts
 *   npx tsx scripts/worker-daemon.ts --poll 3000 --max-jobs 0
 *
 * State files:
 *   ~/.screenhand/worker/state.json   — worker status + recent results
 *   ~/.screenhand/worker/worker.pid   — PID of this process
 *   ~/.screenhand/worker/worker.log   — log output
 *   ~/.screenhand/jobs/               — job persistence
 *   ~/.screenhand/locks/              — session leases
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
import {
  WORKER_DIR,
  WORKER_PID_FILE,
  WORKER_LOG_FILE,
  getWorkerDaemonPid,
  writeWorkerStatus,
} from "../src/jobs/worker.js";
import type { WorkerStatus } from "../src/jobs/worker.js";

// ── Config from CLI args ──

const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf("--" + name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const POLL_MS = Number(getArg("poll", "3000"));
const MAX_JOBS = Number(getArg("max-jobs", "0")); // 0 = unlimited

// ── Directories ──

const JOB_DIR = path.join(os.homedir(), ".screenhand", "jobs");
const LOCK_DIR = path.join(os.homedir(), ".screenhand", "locks");
const PLAYBOOKS_DIR = path.join(os.homedir(), ".screenhand", "playbooks");
const SUPERVISOR_STATE_DIR = path.join(os.homedir(), ".screenhand", "supervisor");

fs.mkdirSync(WORKER_DIR, { recursive: true });
fs.mkdirSync(JOB_DIR, { recursive: true });

// ── Logging ──

const logStream = fs.createWriteStream(WORKER_LOG_FILE, { flags: "a" });
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

const bridge = new BridgeClient(bridgePath);
let bridgeReady = false;

async function ensureBridge(): Promise<void> {
  if (!bridgeReady) {
    await bridge.start();
    bridgeReady = true;
  }
}

// ── Services ──

const leaseManager = new LeaseManager(LOCK_DIR);
const supervisor = new SessionSupervisor({
  stateDir: SUPERVISOR_STATE_DIR,
  lockDir: LOCK_DIR,
});

const memory = new MemoryService(os.homedir());
const jobManager = new JobManager({ jobDir: JOB_DIR, memory, supervisor });
jobManager.init();

// ── State ──

let stopped = false;
let processing = false;
const recentResults: RunResult[] = [];
const MAX_RECENT = 50;

let jobsProcessed = 0;
let jobsDone = 0;
let jobsFailed = 0;
let jobsBlocked = 0;
let lastJobId: string | null = null;
let lastJobState: string | null = null;
let startedAt: string | null = null;

function buildStatus(): WorkerStatus {
  return {
    pid: process.pid,
    running: !stopped,
    startedAt,
    pollMs: POLL_MS,
    maxJobs: MAX_JOBS,
    jobsProcessed,
    jobsDone,
    jobsFailed,
    jobsBlocked,
    lastJobId,
    lastJobState,
    uptimeMs: startedAt ? Date.now() - new Date(startedAt).getTime() : 0,
    recentResults: recentResults.slice(-MAX_RECENT),
  };
}

function persistState(): void {
  try {
    writeWorkerStatus(buildStatus());
  } catch {
    // Non-fatal
  }
}

function recordResult(result: RunResult): void {
  jobsProcessed++;
  lastJobId = result.jobId;
  lastJobState = result.finalState;

  switch (result.finalState) {
    case "done": jobsDone++; break;
    case "failed": jobsFailed++; break;
    case "blocked":
    case "waiting_human": jobsBlocked++; break;
  }

  recentResults.push(result);
  if (recentResults.length > MAX_RECENT) recentResults.shift();

  log(`Completed: ${result.jobId} → ${result.finalState} (${result.stepsCompleted}/${result.totalSteps} steps, ${result.durationMs}ms)`);
  persistState();
}

// ── Main loop ──

async function main() {
  // Enforce single daemon
  const existingPid = getWorkerDaemonPid();
  if (existingPid !== null && existingPid !== process.pid) {
    const msg = `Another worker daemon is already running (pid=${existingPid}). Aborting.`;
    log(msg);
    process.stderr.write(msg + "\n");
    process.exit(1);
  }

  fs.writeFileSync(WORKER_PID_FILE, String(process.pid));
  daemonized = true;
  startedAt = new Date().toISOString();

  log(`Worker daemon started (pid=${process.pid})`);
  log(`Config: poll=${POLL_MS}ms max-jobs=${MAX_JOBS || "unlimited"}`);

  // Ensure bridge is ready
  await ensureBridge();

  // Build playbook engine stack
  const adapter = new AccessibilityAdapter(bridge);
  const logger = new TimelineLogger();
  const runtimeService = new AutomationRuntimeService(adapter, logger);
  const playbookEngine = new PlaybookEngine(runtimeService);
  const playbookStore = new PlaybookStore(PLAYBOOKS_DIR);
  playbookStore.load();

  const runner = new JobRunner(bridge, jobManager, leaseManager, supervisor, {
    playbookEngine,
    playbookStore,
    runtimeService,
    onLog: log,
  });

  persistState();

  // Poll loop
  while (!stopped) {
    if (!processing) {
      processing = true;
      try {
        const result = await runner.run();

        if (result) {
          recordResult(result);

          // Check maxJobs limit
          if (MAX_JOBS > 0 && jobsProcessed >= MAX_JOBS) {
            log(`Reached max-jobs limit (${MAX_JOBS})`);
            break;
          }

          // Job found — poll again immediately
          continue;
        }
      } catch (err) {
        log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        processing = false;
      }
    }

    // Queue empty or error — wait before next poll
    await sleep(POLL_MS);
  }

  log(`Worker daemon exiting (${jobsProcessed} jobs: ${jobsDone} done, ${jobsFailed} failed, ${jobsBlocked} blocked)`);
  await shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Graceful shutdown ──

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

async function shutdown() {
  stopped = true;
  persistState();
  try { fs.unlinkSync(WORKER_PID_FILE); } catch { /* ignore */ }
  try { await bridge.stop(); } catch { /* ignore */ }
  logStream.end();
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  persistState();
  process.exit(1);
});
