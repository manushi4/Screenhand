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
 * SessionSupervisor — generic, client-agnostic session supervisor.
 *
 * Manages session leases, detects stalls, and coordinates recovery actions
 * via the filesystem. Does NOT perform OCR or interact with the native bridge
 * directly — that responsibility belongs to the daemon layer.
 *
 * State directory: ~/.screenhand/supervisor/
 * Files: state.json, recoveries.json, supervisor.pid, supervisor.log
 */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync, readJsonWithRecovery } from "../util/atomic-write.js";
import { LeaseManager } from "./locks.js";
import {
  DEFAULT_SUPERVISOR_CONFIG,
} from "./types.js";
import type {
  ClientInfo,
  RecoveryAction,
  SessionLease,
  StallInfo,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorState,
} from "./types.js";

/** Known blocker patterns for stall detection (matched against screen content) */
const BLOCKER_PATTERNS: string[] = [
  "captcha",
  "2fa",
  "two-factor",
  "rate limit",
  "timed out",
  "login",
  "permission",
  "approve",
  "blocked",
];

export class SessionSupervisor {
  private readonly config: SupervisorConfig;
  private readonly stateDir: string;
  private readonly lockDir: string;
  private readonly leaseManager: LeaseManager;

  private readonly stateFile: string;
  private readonly recoveriesFile: string;
  private readonly pidFile: string;
  private readonly logFile: string;

  private startedAt: string;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Health counters
  private totalSessions = 0;
  private expiredLeases = 0;
  private stallsDetected = 0;
  private recoveriesAttempted = 0;
  private consecutiveErrors = 0;

  // In-memory recovery list (also persisted)
  private recoveries: RecoveryAction[] = [];

  // Last known screen content per session (set externally via stall detection)
  private screenContent = new Map<string, string>();

  private logStream: fs.WriteStream | null = null;

  constructor(config?: Partial<SupervisorConfig>) {
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
    this.startedAt = new Date().toISOString();

    this.stateDir = this.config.stateDir;
    this.lockDir = this.config.lockDir;

    this.stateFile = path.join(this.stateDir, "state.json");
    this.recoveriesFile = path.join(this.stateDir, "recoveries.json");
    this.pidFile = path.join(this.stateDir, "supervisor.pid");
    this.logFile = path.join(this.stateDir, "supervisor.log");

    this.leaseManager = new LeaseManager(this.lockDir, this.config.leaseTimeoutMs);

    // Ensure directories exist
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.lockDir, { recursive: true });

    // Load persisted recoveries if any
    this.loadRecoveries();
  }

  /**
   * Start the supervisor poll loop (meant to be called when running as daemon).
   */
  /**
   * Check if another supervisor daemon is already running via PID file.
   * Returns the existing PID if alive, null otherwise.
   */
  getExistingDaemonPid(): number | null {
    try {
      if (!fs.existsSync(this.pidFile)) return null;
      const pid = Number(fs.readFileSync(this.pidFile, "utf-8").trim());
      if (isNaN(pid) || pid <= 0) return null;
      // Check if process is alive (signal 0 = test existence)
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Enforce single daemon: refuse to start if another is alive
    const existingPid = this.getExistingDaemonPid();
    if (existingPid !== null && existingPid !== process.pid) {
      throw new Error(`Another supervisor daemon is already running (pid=${existingPid}). Stop it first or remove ${this.pidFile}.`);
    }

    this.running = true;
    this.startedAt = new Date().toISOString();

    this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });

    // Write PID file (atomic-ish — we checked above)
    fs.writeFileSync(this.pidFile, String(process.pid));

    this.log(`Supervisor started (pid=${process.pid})`);
    this.writeState();

    // Start poll loop
    this.pollTimer = setInterval(() => {
      this.pollCycle();
    }, this.config.pollMs);
  }

  /**
   * Stop the supervisor.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.log("Supervisor stopped");
    this.writeState();

    // Clean up PID file
    try {
      fs.unlinkSync(this.pidFile);
    } catch {
      // Ignore
    }

    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  /**
   * Get current supervisor state.
   */
  getState(): SupervisorState {
    const activeSessions = this.leaseManager.getActive();

    return {
      pid: process.pid,
      startedAt: this.startedAt,
      running: this.running,
      sessions: activeSessions,
      health: this.getHealth(activeSessions),
      config: { ...this.config },
    };
  }

  /**
   * Register a session for monitoring.
   * Claims a window lease for the given client.
   */
  registerSession(client: ClientInfo, app: string, windowId: number): SessionLease | null {
    const lease = this.leaseManager.claim(client, app, windowId);
    if (lease) {
      this.totalSessions++;
      this.log(`Session registered: ${lease.sessionId} (client=${client.id}, type=${client.type}, app=${app}, window=${windowId})`);
      this.writeState();
    }
    return lease;
  }

  /**
   * Heartbeat from a client.
   */
  heartbeat(sessionId: string): boolean {
    return this.leaseManager.heartbeat(sessionId);
  }

  /**
   * Release a session lease.
   */
  releaseSession(sessionId: string): boolean {
    const released = this.leaseManager.release(sessionId);
    if (released) {
      this.screenContent.delete(sessionId);
      this.log(`Session released: ${sessionId}`);
      this.writeState();
    }
    return released;
  }

  /**
   * Add a recovery action for a session.
   */
  addRecovery(sessionId: string, type: RecoveryAction["type"], instruction: string): RecoveryAction {
    const action: RecoveryAction = {
      id: "recv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      sessionId,
      type,
      instruction,
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptedAt: null,
      result: null,
    };

    this.recoveries.push(action);
    this.saveRecoveries();
    this.log(`Recovery added: ${action.id} (session=${sessionId}, type=${type})`);

    return action;
  }

  /**
   * List recovery actions, optionally filtered by status.
   */
  getRecoveries(status?: RecoveryAction["status"]): RecoveryAction[] {
    if (status) {
      return this.recoveries.filter((r) => r.status === status);
    }
    return [...this.recoveries];
  }

  /**
   * Update a recovery's status and result, then persist to disk.
   */
  updateRecovery(id: string, status: RecoveryAction["status"], result?: string): void {
    const recovery = this.recoveries.find((r) => r.id === id);
    if (recovery) {
      recovery.status = status;
      if (result !== undefined) recovery.result = result;
      this.saveRecoveries();
    }
  }

  /**
   * Detect stalls across all active sessions.
   * A session is stalled if its lastHeartbeat is older than stallThresholdMs.
   */
  detectStalls(): StallInfo[] {
    const now = Date.now();
    const active = this.leaseManager.getActive();
    const stalls: StallInfo[] = [];

    for (const lease of active) {
      const lastHb = new Date(lease.lastHeartbeat).getTime();
      const elapsed = now - lastHb;

      if (elapsed >= this.config.stallThresholdMs) {
        const content = this.screenContent.get(lease.sessionId) ?? null;
        const matchedBlockers = content
          ? BLOCKER_PATTERNS.filter((p) => content.toLowerCase().includes(p))
          : [];

        stalls.push({
          sessionId: lease.sessionId,
          stalledSince: lease.lastHeartbeat,
          durationMs: elapsed,
          lastScreenContent: content,
          matchedBlockers,
        });
      }
    }

    return stalls;
  }

  /**
   * Set screen content for a session (used by external daemons for blocker matching).
   */
  setScreenContent(sessionId: string, content: string): void {
    this.screenContent.set(sessionId, content);
  }

  // ── Private methods ──

  private pollCycle(): void {
    try {
      // 1. Expire stale leases
      const expired = this.leaseManager.expireStale();
      if (expired > 0) {
        this.expiredLeases += expired;
        this.log(`Expired ${expired} stale lease(s)`);
      }

      // 2. Detect stalls
      const stalls = this.detectStalls();
      if (stalls.length > 0) {
        this.stallsDetected += stalls.length;
        for (const stall of stalls) {
          this.log(`Stall detected: session=${stall.sessionId}, duration=${stall.durationMs}ms, blockers=[${stall.matchedBlockers.join(", ")}]`);
        }
      }

      // 3. Auto-recover if enabled
      if (this.config.autoRecover) {
        this.attemptAutoRecovery(stalls);
      }

      // 4. Process pending recovery actions
      this.processPendingRecoveries();

      // 5. Write state
      this.writeState();

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      this.log(`Poll error (${this.consecutiveErrors}/${this.config.maxConsecutiveErrors}): ${err instanceof Error ? err.message : String(err)}`);

      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        this.log("Max consecutive errors reached — stopping supervisor");
        this.stop().catch(() => {});
      }
    }
  }

  private attemptAutoRecovery(stalls: StallInfo[]): void {
    for (const stall of stalls) {
      // Skip if there is already a pending/in-flight recovery, or a recent one (cooldown = stall threshold)
      const cooldownMs = this.config.stallThresholdMs;
      const hasActiveOrRecent = this.recoveries.some((r) => {
        if (r.sessionId !== stall.sessionId) return false;
        if (r.status === "pending" || r.status === "attempted") return true;
        // Skip if a recovery completed recently (cooldown)
        if (r.attemptedAt) {
          const age = Date.now() - new Date(r.attemptedAt).getTime();
          if (age < cooldownMs) return true;
        }
        return false;
      });
      if (hasActiveOrRecent) continue;

      // Determine recovery type based on blockers
      let type: RecoveryAction["type"] = "nudge";
      let instruction = "Session appears stalled — send a heartbeat or check status.";

      if (stall.matchedBlockers.length > 0) {
        type = "escalate";
        instruction = `Session blocked by: ${stall.matchedBlockers.join(", ")}. Requires human intervention.`;
      } else if (stall.durationMs > this.config.stallThresholdMs * 2) {
        type = "restart";
        instruction = "Session stalled for extended period — consider restarting.";
      }

      this.addRecovery(stall.sessionId, type, instruction);
    }
  }

  private processPendingRecoveries(): void {
    // Re-read from disk to pick up recoveries added by MCP tools
    this.loadRecoveries();

    for (const recovery of this.recoveries) {
      if (recovery.status !== "pending") continue;

      // Mark as attempted (actual execution is the daemon's responsibility)
      recovery.status = "attempted";
      recovery.attemptedAt = new Date().toISOString();
      this.recoveriesAttempted++;

      this.log(`Recovery attempted: ${recovery.id} (type=${recovery.type})`);
    }

    this.saveRecoveries();
  }

  private getHealth(activeSessions: SessionLease[]): SupervisorHealth {
    const uptimeMs = this.running
      ? Date.now() - new Date(this.startedAt).getTime()
      : 0;

    // Derive counters from filesystem state so they survive across MCP/daemon restarts
    // and reflect activity from both MCP tools and the daemon
    const recoveries = this.recoveries;
    const recoveriesAttempted = recoveries.filter(
      (r) => r.status === "attempted" || r.status === "succeeded" || r.status === "failed",
    ).length;

    // totalSessions = active + unique sessions that have completed recoveries (proxy for historical)
    const historicalSessionIds = new Set(recoveries.map((r) => r.sessionId));
    const activeSessionIds = new Set(activeSessions.map((s) => s.sessionId));
    // Merge: active sessions + sessions only known from recovery history
    const allKnownSessions = new Set([...historicalSessionIds, ...activeSessionIds]);
    const totalSessions = Math.max(allKnownSessions.size, this.totalSessions);

    return {
      uptimeMs,
      totalSessions,
      activeSessions: activeSessions.length,
      expiredLeases: this.expiredLeases,
      stallsDetected: this.stallsDetected,
      recoveriesAttempted,
    };
  }

  private writeState(): void {
    const state = this.getState();
    try {
      writeFileAtomicSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private loadRecoveries(): void {
    const loaded = readJsonWithRecovery<RecoveryAction[]>(this.recoveriesFile);
    this.recoveries = loaded ?? [];
  }

  private saveRecoveries(): void {
    try {
      writeFileAtomicSync(this.recoveriesFile, JSON.stringify(this.recoveries, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (this.logStream) {
      this.logStream.write(line + "\n");
    }
  }
}

export type {
  ClientInfo,
  SessionLease,
  SupervisorState,
  SupervisorHealth,
  SupervisorConfig,
  RecoveryAction,
  StallInfo,
};
export { DEFAULT_SUPERVISOR_CONFIG } from "./types.js";
export { LeaseManager } from "./locks.js";
