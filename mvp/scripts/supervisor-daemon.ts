#!/usr/bin/env npx tsx
/**
 * Supervisor Daemon — runs as a standalone background process.
 *
 * Survives Claude Code restarts. Manages session leases,
 * detects stalls via OCR, and executes recovery actions.
 *
 * Usage:
 *   npx tsx scripts/supervisor-daemon.ts
 *   npx tsx scripts/supervisor-daemon.ts --poll 5000 --stall 300000
 *
 * State files:
 *   ~/.screenhand/supervisor/state.json      — supervisor state
 *   ~/.screenhand/supervisor/recoveries.json  — recovery queue
 *   ~/.screenhand/supervisor/supervisor.pid   — PID of this process
 *   ~/.screenhand/supervisor/supervisor.log   — log output
 *   ~/.screenhand/locks/                      — session leases
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeClient } from "../src/native/bridge-client.js";
import { SessionSupervisor } from "../src/supervisor/supervisor.js";
import type { RecoveryAction, SessionLease } from "../src/supervisor/types.js";

// ── Config from CLI args ──

const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf("--" + name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const POLL_MS = Number(getArg("poll", "5000"));
const STALL_MS = Number(getArg("stall", "300000"));
const LEASE_TIMEOUT_MS = Number(getArg("lease-timeout", "300000"));
const AUTO_RECOVER = getArg("no-auto-recover") === undefined;
const DRY_RUN = args.includes("--dry-run");

// ── Logging ──

const STATE_DIR = path.join(os.homedir(), ".screenhand", "supervisor");
fs.mkdirSync(STATE_DIR, { recursive: true });

const LOG_FILE = path.join(STATE_DIR, "supervisor.log");
const PID_FILE = path.join(STATE_DIR, "supervisor.pid");
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

let daemonized = false;
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
  if (!daemonized) process.stderr.write(line + "\n");
}

// ── Bridge setup ──

const scriptDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
// When running from dist/scripts/, go up two levels to reach the real project root
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

// ── Supervisor ──

const supervisor = new SessionSupervisor({
  pollMs: POLL_MS,
  stallThresholdMs: STALL_MS,
  leaseTimeoutMs: LEASE_TIMEOUT_MS,
  autoRecover: AUTO_RECOVER,
});

let stopped = false;

// ── Recovery execution (the real control) ──

async function executeRecovery(recovery: RecoveryAction, lease: SessionLease): Promise<string> {
  await ensureBridge();

  switch (recovery.type) {
    case "nudge": {
      // Focus the app and press Enter to nudge a stalled agent
      log(`Nudging session ${recovery.sessionId}: focusing ${lease.app}`);
      try {
        await bridge.call("app.focus", { bundleId: lease.app });
        await sleep(300);
        await bridge.call("cg.keyCombo", { keys: ["enter"] });
        return "Focused app and pressed Enter";
      } catch (err) {
        return `Nudge failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "restart": {
      // Close and relaunch the app
      log(`Restarting session ${recovery.sessionId}: relaunching ${lease.app}`);
      try {
        await bridge.call("app.focus", { bundleId: lease.app });
        await sleep(200);
        // Cmd+Q to quit, then relaunch
        await bridge.call("cg.keyCombo", { keys: ["cmd", "q"] });
        await sleep(2000);
        await bridge.call("app.launch", { bundleId: lease.app });
        return "App relaunched";
      } catch (err) {
        return `Restart failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "custom": {
      // Type the custom instruction into the focused window
      log(`Custom recovery for ${recovery.sessionId}: "${recovery.instruction.slice(0, 60)}"`);
      try {
        await bridge.call("app.focus", { bundleId: lease.app });
        await sleep(300);
        await bridge.call("cg.typeText", { text: recovery.instruction });
        await sleep(100);
        await bridge.call("cg.keyCombo", { keys: ["enter"] });
        return `Typed: "${recovery.instruction.slice(0, 80)}"`;
      } catch (err) {
        return `Custom recovery failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "escalate": {
      // Notify via macOS notification
      if (process.platform === "darwin") {
        try {
          const { execFileSync } = await import("node:child_process");
          const msg = recovery.instruction.replace(/"/g, '\\"');
          execFileSync("osascript", [
            "-e",
            `display notification "${msg}" with title "ScreenHand Supervisor" subtitle "Session needs help"`,
          ]);
          return "Notification sent";
        } catch {
          return "Escalation: notification failed, check supervisor log";
        }
      }
      return "Escalation logged — requires human intervention";
    }

    default:
      return `Unknown recovery type: ${recovery.type}`;
  }
}

// ── OCR-based stall content capture ──

async function captureWindowContent(lease: SessionLease): Promise<string | null> {
  try {
    await ensureBridge();
    const shot = await bridge.call<{ path: string }>("cg.captureWindow", {
      windowId: lease.windowId,
    });
    const ocr = await bridge.call<{ text: string }>("vision.ocr", {
      imagePath: shot.path,
    });
    return ocr.text;
  } catch {
    // OCR failed — try AX tree as fallback
    try {
      const tree = await bridge.call<any>("ax.getElementTree", {
        pid: lease.client.pid ?? 0,
        maxDepth: 4,
      });
      return extractText(tree);
    } catch {
      return null;
    }
  }
}

function extractText(node: any, depth = 0): string | null {
  if (depth > 6) return null;
  if (node.value && typeof node.value === "string" && node.value.length > 20) {
    return node.value;
  }
  if (node.children) {
    for (const child of node.children) {
      const found = extractText(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Main poll loop ──

async function poll() {
  // 1. Update screen content for all active sessions (for blocker matching)
  const state = supervisor.getState();
  for (const lease of state.sessions) {
    const content = await captureWindowContent(lease);
    if (content) {
      supervisor.setScreenContent(lease.sessionId, content);
    }
  }

  // 2. Let the supervisor run its poll cycle (detect stalls, create recoveries)
  // The supervisor's internal pollCycle is on a timer, but we also call detectStalls
  // to feed screen content into it

  // 3. Execute pending recoveries with actual bridge actions
  const pending = supervisor.getRecoveries("attempted");
  for (const recovery of pending) {
    const lease = state.sessions.find((s) => s.sessionId === recovery.sessionId);
    if (!lease) {
      supervisor.updateRecovery(recovery.id, "failed", "Session no longer active");
      continue;
    }

    log(`Executing recovery ${recovery.id} (type=${recovery.type})`);
    let resultText: string;
    if (DRY_RUN) {
      resultText = `[DRY RUN] Would execute ${recovery.type}: ${recovery.instruction.slice(0, 80)}`;
    } else {
      resultText = await executeRecovery(recovery, lease);
    }
    const status = resultText.toLowerCase().includes("failed") ? "failed" as const : "succeeded" as const;
    supervisor.updateRecovery(recovery.id, status, resultText);
    log(`Recovery ${recovery.id}: ${status} — ${resultText}`);
  }
}

async function main() {
  // Enforce single daemon — abort if another is already running
  const existingPid = supervisor.getExistingDaemonPid();
  if (existingPid !== null && existingPid !== process.pid) {
    const msg = `Another supervisor daemon is already running (pid=${existingPid}). Aborting.`;
    log(msg);
    process.stderr.write(msg + "\n");
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));
  daemonized = true;

  log(`Supervisor daemon started (pid=${process.pid})`);
  log(`Config: poll=${POLL_MS}ms stall=${STALL_MS}ms lease-timeout=${LEASE_TIMEOUT_MS}ms auto-recover=${AUTO_RECOVER} dry-run=${DRY_RUN}`);

  await supervisor.start();
  log("Supervisor poll loop started");

  // Additional poll for OCR + recovery execution
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
  await supervisor.stop();
  try {
    fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
  try {
    await bridge.stop();
  } catch { /* ignore */ }
  logStream.end();
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
