/**
 * Session Supervisor types — generic, client-agnostic session management
 */

import os from "node:os";
import path from "node:path";

/** Client identity */
export interface ClientInfo {
  id: string;          // e.g., "claude_sess_abc"
  type: string;        // "claude" | "codex" | "cursor" | "openclaw" | string
  pid?: number;
  startedAt: string;
}

/** Session lease — one client per window */
export interface SessionLease {
  sessionId: string;
  client: ClientInfo;
  app: string;         // bundle ID
  windowId: number;
  claimedAt: string;
  lastHeartbeat: string;
  expiresAt: string;
}

/** Supervisor state written to disk */
export interface SupervisorState {
  pid: number;
  startedAt: string;
  running: boolean;
  sessions: SessionLease[];
  health: SupervisorHealth;
  config: SupervisorConfig;
}

export interface SupervisorHealth {
  uptimeMs: number;
  totalSessions: number;
  activeSessions: number;
  expiredLeases: number;
  stallsDetected: number;
  recoveriesAttempted: number;
}

export interface SupervisorConfig {
  pollMs: number;                // default 5000
  leaseTimeoutMs: number;        // default 300000 (5 min)
  stallThresholdMs: number;      // default 300000 (5 min)
  maxConsecutiveErrors: number;  // default 5
  autoRecover: boolean;          // default true
  stateDir: string;              // default ~/.screenhand/supervisor
  lockDir: string;               // default ~/.screenhand/locks
}

/** Recovery action */
export interface RecoveryAction {
  id: string;
  sessionId: string;
  type: "nudge" | "restart" | "escalate" | "custom";
  instruction: string;
  status: "pending" | "attempted" | "succeeded" | "failed";
  createdAt: string;
  attemptedAt: string | null;
  result: string | null;
}

/** Stall detection result */
export interface StallInfo {
  sessionId: string;
  stalledSince: string;
  durationMs: number;
  lastScreenContent: string | null;
  matchedBlockers: string[];
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  pollMs: 5000,
  leaseTimeoutMs: 300000,
  stallThresholdMs: 300000,
  maxConsecutiveErrors: 5,
  autoRecover: true,
  stateDir: path.join(os.homedir(), ".screenhand", "supervisor"),
  lockDir: path.join(os.homedir(), ".screenhand", "locks"),
};
