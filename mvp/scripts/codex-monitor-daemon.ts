#!/usr/bin/env npx tsx
/**
 * Codex Monitor Daemon — runs as a standalone background process.
 *
 * Survives Claude Code restarts. Writes state to ~/.screenhand/monitor/
 * so MCP tools can read status and enqueue tasks via the filesystem.
 *
 * Usage:
 *   npx tsx scripts/codex-monitor-daemon.ts --pid 56966
 *   npx tsx scripts/codex-monitor-daemon.ts --pid 56966 --window 5015 --poll 5000
 *
 * State files:
 *   ~/.screenhand/monitor/state.json    — terminal states + status
 *   ~/.screenhand/monitor/tasks.json    — task queue
 *   ~/.screenhand/monitor/daemon.pid    — PID of this process
 *   ~/.screenhand/monitor/daemon.log    — log output
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeClient } from "../src/native/bridge-client.js";

// ── Config from CLI args ──

const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf("--" + name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const VSCODE_PID = Number(getArg("pid", "0"));
const WINDOW_ID = getArg("window") ? Number(getArg("window")) : undefined;
const POLL_MS = Number(getArg("poll", "3000"));
const LABEL = getArg("label", "Terminal") ?? "Terminal";
const AUTO_ASSIGN = getArg("no-auto-assign") === undefined;

if (!VSCODE_PID) {
  console.error("Usage: codex-monitor-daemon.ts --pid <vscode_pid> [--window <id>] [--poll <ms>]");
  process.exit(1);
}

// ── State directory ──

const STATE_DIR = path.join(os.homedir(), ".screenhand", "monitor");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const TASKS_FILE = path.join(STATE_DIR, "tasks.json");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");

fs.mkdirSync(STATE_DIR, { recursive: true });

// ── Logging ──

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
  // Also write to stderr for initial debugging
  if (!daemonized) process.stderr.write(line + "\n");
}

let daemonized = false;

// ── Types ──

interface TerminalState {
  id: string;
  vscodePid: number;
  windowId?: number;
  label: string;
  status: "running" | "idle" | "error" | "unknown";
  lastOutput: string;
  lastTask: string | null;
  lastPollAt: string;
  tasksCompleted: number;
  taskHistory: { task: string; completedAt: string }[];
}

interface Task {
  id: string;
  prompt: string;
  priority: number;
  terminalId: string | null;
  status: "queued" | "assigned" | "running" | "completed" | "failed";
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
  result: string | null;
}

interface DaemonState {
  pid: number;
  startedAt: string;
  terminals: TerminalState[];
  running: boolean;
}

// ── Status detection patterns ──

const RUNNING_PATTERNS = [
  "thinking", "working", "generating", "analyzing", "reading",
  "writing", "searching", "running", "executing", "...",
  "in progress",
];

const IDLE_PATTERNS = [
  "codex>", "> ", "$ ", "done", "complete", "finished",
  "task completed", "all done", "ready", "waiting for input",
  "what would you like", "how can i help",
];

const ERROR_PATTERNS = [
  "error:", "failed", "exception", "traceback", "panic:",
  "fatal", "cannot", "could not",
];

// ── Bridge setup ──

const scriptDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(scriptDir, "..");
const bridgePath = process.platform === "win32"
  ? path.resolve(projectRoot, "native/windows-bridge/bin/Release/net8.0-windows/windows-bridge.exe")
  : path.resolve(projectRoot, "native/macos-bridge/.build/release/macos-bridge");

const bridge = new BridgeClient(bridgePath);

// ── State ──

let resolvedWindowId = WINDOW_ID;

const terminal: TerminalState = {
  id: `term_${VSCODE_PID}_${Date.now().toString(36)}`,
  vscodePid: VSCODE_PID,
  ...(WINDOW_ID != null ? { windowId: WINDOW_ID } : {}),
  label: LABEL,
  status: "unknown",
  lastOutput: "",
  lastTask: null,
  lastPollAt: new Date().toISOString(),
  tasksCompleted: 0,
  taskHistory: [],
};

let stopped = false;

// ── Filesystem I/O ──

function writeState() {
  const state: DaemonState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    terminals: [terminal],
    running: !stopped,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readTasks(): Task[] {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeTasks(tasks: Task[]) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── Detection logic ──

function detectStatus(text: string): "running" | "idle" | "error" | "unknown" {
  const lower = text.toLowerCase();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = (lines[lines.length - 1] ?? "").trim().toLowerCase();

  // Check errors in last 5 lines
  const lastFew = lines.slice(-5).join("\n").toLowerCase();
  for (const p of ERROR_PATTERNS) {
    if (lastFew.includes(p)) return "error";
  }

  // Check idle (prompt on last line)
  for (const p of IDLE_PATTERNS) {
    if (lastLine.includes(p) || lastLine.endsWith(p.trim())) return "idle";
  }

  // Check running
  for (const p of RUNNING_PATTERNS) {
    if (lower.includes(p)) return "running";
  }

  return "unknown";
}

// ── Terminal reading ──

async function readTerminalContent(): Promise<string | null> {
  try {
    // Find window if not set
    if (!resolvedWindowId) {
      const wins = await bridge.call<any[]>("app.windows");
      // Find VS Code windows, pick the largest one (skip title bar / small panels)
      const vscodeWins = wins.filter(
        (w: any) => w.pid === VSCODE_PID || w.bundleId === "com.microsoft.VSCode",
      );
      if (vscodeWins.length === 0) {
        log("VS Code window not found");
        return null;
      }
      const largest = vscodeWins.reduce((a: any, b: any) => {
        const areaA = (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0);
        const areaB = (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0);
        return areaA >= areaB ? a : b;
      });
      resolvedWindowId = largest.windowId;
      terminal.windowId = resolvedWindowId;
      log(`Auto-detected window ${resolvedWindowId} (${largest.bounds?.width}x${largest.bounds?.height})`);
    }

    // Screenshot + OCR
    const shot = await bridge.call<{ path: string }>("cg.captureWindow", {
      windowId: resolvedWindowId,
    });
    const ocr = await bridge.call<{ text: string }>("vision.ocr", {
      imagePath: shot.path,
    });
    return ocr.text;
  } catch (err) {
    log(`OCR failed: ${err instanceof Error ? err.message : String(err)}`);

    // Fallback: AX tree
    try {
      const tree = await bridge.call<any>("ax.getElementTree", {
        pid: VSCODE_PID,
        maxDepth: 6,
      });
      return extractTerminalText(tree);
    } catch {
      return null;
    }
  }
}

function extractTerminalText(node: any, depth = 0): string | null {
  if (depth > 8) return null;
  const role = (node.role || "").toLowerCase();
  const title = (node.title || "").toLowerCase();
  if (
    (role.includes("terminal") || title.includes("terminal")) &&
    node.value
  ) {
    return node.value;
  }
  if (node.children) {
    for (const child of node.children) {
      const found = extractTerminalText(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Task assignment ──

async function typeIntoTerminal(text: string): Promise<boolean> {
  try {
    await bridge.call("app.focus", { bundleId: "com.microsoft.VSCode" });
    await sleep(300);
    await bridge.call("cg.typeText", { text });
    await sleep(100);
    await bridge.call("cg.keyCombo", { keys: ["enter"] });
    return true;
  } catch (err) {
    log(`Failed to type: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function tryAssignTask() {
  if (!AUTO_ASSIGN || terminal.status !== "idle") return;

  const tasks = readTasks();
  const next = tasks.find(
    (t) => t.status === "queued" && (t.terminalId === null || t.terminalId === terminal.id),
  );
  if (!next) return;

  log(`Assigning task: "${next.prompt.slice(0, 60)}"`);
  next.status = "assigned";
  next.terminalId = terminal.id;
  next.assignedAt = new Date().toISOString();
  writeTasks(tasks);

  terminal.lastTask = next.prompt;

  const success = await typeIntoTerminal(next.prompt);
  if (success) {
    next.status = "running";
    terminal.status = "running";
    log(`Task running: ${next.id}`);
  } else {
    next.status = "failed";
    next.result = "Failed to type into terminal";
    log(`Task failed to assign: ${next.id}`);
  }
  writeTasks(tasks);
}

function handleIdleTransition() {
  // Complete current task
  if (terminal.lastTask) {
    terminal.taskHistory.push({
      task: terminal.lastTask,
      completedAt: new Date().toISOString(),
    });
    terminal.tasksCompleted++;

    // Update task in queue
    const tasks = readTasks();
    const running = tasks.find(
      (t) => t.status === "running" && t.terminalId === terminal.id,
    );
    if (running) {
      running.status = "completed";
      running.completedAt = new Date().toISOString();
      running.result = terminal.lastOutput.split("\n").slice(-20).join("\n");
      writeTasks(tasks);
    }

    terminal.lastTask = null;
    log(`Task completed (${terminal.tasksCompleted} total)`);
  }

  // Delay then try assign
  setTimeout(() => tryAssignTask(), 2000);
}

// ── Main loop ──

async function poll() {
  const output = await readTerminalContent();
  if (output === null) return;

  const oldStatus = terminal.status;
  terminal.lastOutput = output;
  terminal.lastPollAt = new Date().toISOString();

  const lastLines = output.split("\n").slice(-15).join("\n");
  terminal.status = detectStatus(lastLines);

  if (oldStatus !== terminal.status) {
    log(`Status: ${oldStatus} -> ${terminal.status}`);

    if (terminal.status === "idle" && (oldStatus === "running" || oldStatus === "unknown")) {
      handleIdleTransition();
    }
  }

  writeState();
}

async function main() {
  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Initialize tasks file if missing
  if (!fs.existsSync(TASKS_FILE)) {
    writeTasks([]);
  }

  log(`Daemon started (pid=${process.pid})`);
  log(`Watching VS Code pid=${VSCODE_PID} window=${WINDOW_ID ?? "auto"} poll=${POLL_MS}ms`);

  await bridge.start();
  log("Bridge started");

  writeState();

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
  writeState();
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
