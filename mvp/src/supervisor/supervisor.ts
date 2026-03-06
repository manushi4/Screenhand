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
import os from "node:os";

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

    this.stateDir = path.join(os.homedir(), ".screenhand", "supervisor");
    this.lockDir = path.join(os.homedir(), ".screenhand", "locks");

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
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.startedAt = new Date().toISOString();

    this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });

    // Write PID file
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
      // Check if there is already a pending recovery for this session
      const hasPending = this.recoveries.some(
        (r) => r.sessionId === stall.sessionId && r.status === "pending",
      );
      if (hasPending) continue;

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

    return {
      uptimeMs,
      totalSessions: this.totalSessions,
      activeSessions: activeSessions.length,
      expiredLeases: this.expiredLeases,
      stallsDetected: this.stallsDetected,
      recoveriesAttempted: this.recoveriesAttempted,
    };
  }

  private writeState(): void {
    const state = this.getState();
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private loadRecoveries(): void {
    try {
      if (fs.existsSync(this.recoveriesFile)) {
        const data = fs.readFileSync(this.recoveriesFile, "utf-8");
        this.recoveries = JSON.parse(data);
      }
    } catch {
      this.recoveries = [];
    }
  }

  private saveRecoveries(): void {
    try {
      fs.writeFileSync(this.recoveriesFile, JSON.stringify(this.recoveries, null, 2));
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
