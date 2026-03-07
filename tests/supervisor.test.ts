import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LeaseManager } from "../src/supervisor/locks.js";
import { SessionSupervisor } from "../src/supervisor/supervisor.js";
import type { ClientInfo } from "../src/supervisor/types.js";

let tmpDir: string;

const testClient: ClientInfo = {
  id: "test-client-1",
  type: "claude",
  pid: process.pid,
};

describe("LeaseManager", () => {
  let lockDir: string;
  let manager: LeaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screenhand-test-"));
    lockDir = path.join(tmpDir, "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    manager = new LeaseManager(lockDir, 5000);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("claims a lease for a window", () => {
    const lease = manager.claim(testClient, "com.apple.Safari", 12345);
    expect(lease).not.toBeNull();
    expect(lease!.sessionId).toBeDefined();
    expect(lease!.app).toBe("com.apple.Safari");
    expect(lease!.windowId).toBe(12345);
    expect(lease!.client).toEqual(testClient);
  });

  it("rejects duplicate lease for same window", () => {
    manager.claim(testClient, "com.apple.Safari", 12345);
    const second = manager.claim(
      { id: "other-client", type: "codex", pid: 9999 },
      "com.apple.Safari",
      12345,
    );
    expect(second).toBeNull();
  });

  it("heartbeat updates timestamp", () => {
    const lease = manager.claim(testClient, "com.apple.Safari", 12345)!;
    const updated = manager.heartbeat(lease.sessionId);
    expect(updated).toBe(true);

    const active = manager.getActive();
    expect(active.length).toBe(1);
  });

  it("release removes the lease", () => {
    const lease = manager.claim(testClient, "com.apple.Safari", 12345)!;
    const released = manager.release(lease.sessionId);
    expect(released).toBe(true);
    expect(manager.getActive()).toHaveLength(0);
  });

  it("getActive returns all active leases", () => {
    manager.claim(testClient, "com.apple.Safari", 111);
    manager.claim(testClient, "com.google.Chrome", 222);
    expect(manager.getActive()).toHaveLength(2);
  });

  it("isLocked returns lease when locked, null when not", () => {
    expect(manager.isLocked("com.apple.Safari", 111)).toBeNull();
    manager.claim(testClient, "com.apple.Safari", 111);
    const locked = manager.isLocked("com.apple.Safari", 111);
    expect(locked).not.toBeNull();
    expect(locked!.app).toBe("com.apple.Safari");
  });

  it("allows claim after release", () => {
    const first = manager.claim(testClient, "com.apple.Safari", 12345)!;
    manager.release(first.sessionId);
    const second = manager.claim(testClient, "com.apple.Safari", 12345);
    expect(second).not.toBeNull();
  });

  it("expireStale removes expired leases", () => {
    // Create lease with very short timeout
    const shortManager = new LeaseManager(lockDir, 1);
    shortManager.claim(testClient, "com.apple.Safari", 111);

    // Wait for it to expire
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    const expired = shortManager.expireStale();
    expect(expired).toBe(1);
    expect(shortManager.getActive()).toHaveLength(0);
  });

  it("heartbeat returns false for unknown session", () => {
    expect(manager.heartbeat("nonexistent")).toBe(false);
  });

  it("release returns false for unknown session", () => {
    expect(manager.release("nonexistent")).toBe(false);
  });
});

describe("SessionSupervisor health counters", () => {
  let stateDir: string;
  let lockDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sup-health-test-"));
    stateDir = path.join(tmpDir, "supervisor");
    lockDir = path.join(tmpDir, "locks");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("totalSessions reflects registered sessions", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stallThresholdMs: 60000, stateDir, lockDir });
    const lease = sup.registerSession(testClient, "com.test.Health1", 11111);
    expect(lease).not.toBeNull();
    const state = sup.getState();
    expect(state.health.totalSessions).toBe(1);
    expect(state.health.activeSessions).toBe(1);
    sup.releaseSession(lease!.sessionId);
  });

  it("recoveriesAttempted counts processed recoveries", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stallThresholdMs: 60000, stateDir, lockDir });
    const lease = sup.registerSession(testClient, "com.test.Health2", 22222)!;
    const recovery = sup.addRecovery(lease.sessionId, "nudge", "test");
    sup.updateRecovery(recovery.id, "attempted");
    const state = sup.getState();
    expect(state.health.recoveriesAttempted).toBe(1);
    sup.releaseSession(lease.sessionId);
  });

  it("recoveriesAttempted counts succeeded and failed too", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stallThresholdMs: 60000, stateDir, lockDir });
    const lease = sup.registerSession(testClient, "com.test.Health3", 33333)!;
    const r1 = sup.addRecovery(lease.sessionId, "nudge", "test1");
    const r2 = sup.addRecovery(lease.sessionId, "nudge", "test2");
    sup.updateRecovery(r1.id, "succeeded", "ok");
    sup.updateRecovery(r2.id, "failed", "nope");
    const state = sup.getState();
    expect(state.health.recoveriesAttempted).toBe(2);
    sup.releaseSession(lease.sessionId);
  });
});

describe("SessionSupervisor PID lock", () => {
  let stateDir: string;
  let lockDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sup-pid-test-"));
    stateDir = path.join(tmpDir, "supervisor");
    lockDir = path.join(tmpDir, "locks");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getExistingDaemonPid returns null when no PID file", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stateDir, lockDir });
    expect(sup.getExistingDaemonPid()).toBeNull();
  });

  it("getExistingDaemonPid returns PID of a live process", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stateDir, lockDir });
    const pidPath = path.join(stateDir, "supervisor.pid");
    fs.writeFileSync(pidPath, String(process.pid));
    expect(sup.getExistingDaemonPid()).toBe(process.pid);
  });

  it("getExistingDaemonPid returns null for dead PID", () => {
    const sup = new SessionSupervisor({ pollMs: 60000, stateDir, lockDir });
    const pidPath = path.join(stateDir, "supervisor.pid");
    fs.writeFileSync(pidPath, "999999999");
    expect(sup.getExistingDaemonPid()).toBeNull();
  });
});
