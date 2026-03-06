/**
 * JobWorker — persistent state for the worker daemon.
 *
 * The actual daemon runs as a separate process (scripts/worker-daemon.ts).
 * This module provides the state types and filesystem persistence
 * shared between the daemon and the MCP tools that query/control it.
 *
 * State directory: ~/.screenhand/worker/
 * Files: state.json, worker.pid, worker.log
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFileAtomicSync, readJsonWithRecovery } from "../util/atomic-write.js";
import type { RunResult } from "./runner.js";

/** Default worker directory — used by MCP tools and the daemon. */
export const WORKER_DIR = path.join(os.homedir(), ".screenhand", "worker");
export const WORKER_PID_FILE = path.join(WORKER_DIR, "worker.pid");
export const WORKER_LOG_FILE = path.join(WORKER_DIR, "worker.log");

export interface WorkerStatus {
  pid: number | null;
  running: boolean;
  startedAt: string | null;
  pollMs: number;
  maxJobs: number;
  jobsProcessed: number;
  jobsDone: number;
  jobsFailed: number;
  jobsBlocked: number;
  lastJobId: string | null;
  lastJobState: string | null;
  uptimeMs: number;
  recentResults: RunResult[];
}

function stateFile(dir: string): string {
  return path.join(dir, "state.json");
}

function pidFile(dir: string): string {
  return path.join(dir, "worker.pid");
}

/** Read the persisted worker state from disk. */
export function readWorkerStatus(dir: string = WORKER_DIR): WorkerStatus | null {
  return readJsonWithRecovery<WorkerStatus>(stateFile(dir));
}

/** Write worker state to disk atomically. */
export function writeWorkerStatus(status: WorkerStatus, dir: string = WORKER_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(stateFile(dir), JSON.stringify(status, null, 2));
}

/** Check if the worker daemon is alive by reading its PID file. */
export function getWorkerDaemonPid(dir: string = WORKER_DIR): number | null {
  try {
    const pf = pidFile(dir);
    if (!fs.existsSync(pf)) return null;
    const pid = Number(fs.readFileSync(pf, "utf-8").trim());
    if (isNaN(pid) || pid <= 0) return null;
    // Check if process is alive (signal 0 = test existence)
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Get a live status: reads persisted state + validates PID is alive. */
export function getWorkerLiveStatus(dir: string = WORKER_DIR): WorkerStatus {
  const persisted = readWorkerStatus(dir);
  const pid = getWorkerDaemonPid(dir);

  if (!persisted) {
    return {
      pid: null,
      running: false,
      startedAt: null,
      pollMs: 3000,
      maxJobs: 0,
      jobsProcessed: 0,
      jobsDone: 0,
      jobsFailed: 0,
      jobsBlocked: 0,
      lastJobId: null,
      lastJobState: null,
      uptimeMs: 0,
      recentResults: [],
    };
  }

  // If PID file says alive but process is dead, mark as not running
  if (persisted.running && pid === null) {
    return { ...persisted, running: false, pid: null };
  }

  // Update uptime from startedAt
  if (persisted.running && persisted.startedAt) {
    persisted.uptimeMs = Date.now() - new Date(persisted.startedAt).getTime();
  }

  return { ...persisted, pid };
}
