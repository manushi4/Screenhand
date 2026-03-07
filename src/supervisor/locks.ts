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
 * LeaseManager — filesystem-based session lease management.
 *
 * Each lease is a JSON lock file: {app}__{windowId}.lock
 * Provides mutual exclusion so only one client controls a window at a time.
 */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "../util/atomic-write.js";
import type { ClientInfo, SessionLease } from "./types.js";

const DEFAULT_LEASE_TIMEOUT_MS = 300000; // 5 min

export class LeaseManager {
  private readonly lockDir: string;
  private leaseTimeoutMs: number;

  constructor(lockDir: string, leaseTimeoutMs: number = DEFAULT_LEASE_TIMEOUT_MS) {
    this.lockDir = lockDir;
    this.leaseTimeoutMs = leaseTimeoutMs;
    fs.mkdirSync(this.lockDir, { recursive: true });
  }

  /**
   * Claim a window for a client. Fails if another active lease exists.
   * Returns the new SessionLease, or null if the window is already claimed.
   */
  claim(client: ClientInfo, app: string, windowId: number): SessionLease | null {
    const existing = this.isLocked(app, windowId);
    if (existing) {
      return null;
    }

    const now = new Date();
    const sessionId = "lease_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

    const lease: SessionLease = {
      sessionId,
      client,
      app,
      windowId,
      claimedAt: now.toISOString(),
      lastHeartbeat: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseTimeoutMs).toISOString(),
    };

    const lockFile = this.lockFilePath(app, windowId);

    try {
      fs.writeFileSync(lockFile, JSON.stringify(lease, null, 2), { flag: "wx" });
    } catch {
      // File already exists (race condition) — another client claimed it
      return null;
    }

    return lease;
  }

  /**
   * Refresh heartbeat for an existing lease.
   * Returns true if the lease was found and updated, false otherwise.
   */
  heartbeat(sessionId: string): boolean {
    const leases = this.readAllLeases();

    for (const { lease, filePath } of leases) {
      if (lease.sessionId === sessionId) {
        const now = new Date();
        lease.lastHeartbeat = now.toISOString();
        lease.expiresAt = new Date(now.getTime() + this.leaseTimeoutMs).toISOString();
        writeFileAtomicSync(filePath, JSON.stringify(lease, null, 2));
        return true;
      }
    }

    return false;
  }

  /**
   * Release a lease by session ID.
   * Returns true if the lease was found and removed, false otherwise.
   */
  release(sessionId: string): boolean {
    const leases = this.readAllLeases();

    for (const { lease, filePath } of leases) {
      if (lease.sessionId === sessionId) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Already removed
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Get all active (non-expired) leases.
   */
  getActive(): SessionLease[] {
    const now = Date.now();
    return this.readAllLeases()
      .filter(({ lease }) => new Date(lease.expiresAt).getTime() > now)
      .map(({ lease }) => lease);
  }

  /**
   * Clean up expired leases by deleting their lock files.
   * Returns the number of leases expired.
   */
  expireStale(): number {
    const now = Date.now();
    let count = 0;

    for (const { lease, filePath } of this.readAllLeases()) {
      if (new Date(lease.expiresAt).getTime() <= now) {
        try {
          fs.unlinkSync(filePath);
          count++;
        } catch {
          // Already removed
        }
      }
    }

    return count;
  }

  /**
   * Check if a window is claimed by an active (non-expired) lease.
   * Returns the lease if found, null otherwise.
   */
  isLocked(app: string, windowId: number): SessionLease | null {
    const lockFile = this.lockFilePath(app, windowId);

    try {
      const data = fs.readFileSync(lockFile, "utf-8");
      const lease: SessionLease = JSON.parse(data);

      // Check if expired
      if (new Date(lease.expiresAt).getTime() <= Date.now()) {
        // Expired — clean up and report as unlocked
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Ignore
        }
        return null;
      }

      return lease;
    } catch {
      return null;
    }
  }

  // ── Private helpers ──

  private lockFilePath(app: string, windowId: number): string {
    // Sanitize app name for filesystem safety
    const safeApp = app.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.lockDir, `${safeApp}__${windowId}.lock`);
  }

  private readAllLeases(): Array<{ lease: SessionLease; filePath: string }> {
    const results: Array<{ lease: SessionLease; filePath: string }> = [];

    let files: string[];
    try {
      files = fs.readdirSync(this.lockDir);
    } catch {
      return results;
    }

    for (const file of files) {
      if (!file.endsWith(".lock")) continue;
      const filePath = path.join(this.lockDir, file);
      try {
        const data = fs.readFileSync(filePath, "utf-8");
        const lease: SessionLease = JSON.parse(data);
        results.push({ lease, filePath });
      } catch {
        // Corrupt lock file — skip
      }
    }

    return results;
  }
}
