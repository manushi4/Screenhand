#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const workdir = process.env.CODEX_TMUX_WORKDIR ?? "/Users/khushi/Documents/Automator/mvp";
const sessionName = process.env.CODEX_TMUX_SESSION ?? "codex-night";
const pollMs = readInt("CODEX_TMUX_WATCH_POLL_MS", 30_000);
const stallMs = readInt("CODEX_TMUX_WATCH_STALL_MS", 15 * 60_000);
const lines = readInt("CODEX_TMUX_WATCH_LINES", 220);
const notifyEnabled = process.env.CODEX_TMUX_WATCH_NOTIFY !== "0";
const notifyCooldownMs = readInt("CODEX_TMUX_WATCH_NOTIFY_COOLDOWN_MS", 5 * 60_000);
const autoNudge = process.env.CODEX_TMUX_WATCH_AUTO_NUDGE === "1";
const nudgeCooldownMs = readInt("CODEX_TMUX_WATCH_NUDGE_COOLDOWN_MS", 10 * 60_000);
const nudgeOnAttention = process.env.CODEX_TMUX_WATCH_NUDGE_ON_ATTENTION !== "0";
const nudgeOnIdle = process.env.CODEX_TMUX_WATCH_NUDGE_ON_IDLE === "1";
const nudgeText =
  process.env.CODEX_TMUX_WATCH_NUDGE_TEXT ??
  "Continue from the last completed step. Do not repeat finished work. If blocked, state the blocker clearly, choose the next safest useful action, and keep going without asking for confirmation unless credentials or irreversible actions are required.";
const stateFile = process.env.CODEX_TMUX_WATCH_STATE_FILE ?? path.join(workdir, ".logs", `${sessionName}.watch.json`);
const logFile = process.env.CODEX_TMUX_WATCH_LOG_FILE ?? path.join(workdir, ".logs", `${sessionName}.watch.log`);

fs.mkdirSync(path.dirname(stateFile), { recursive: true });

let lastFingerprint = "";
let lastChangedAt = Date.now();
let lastNotifyAt = 0;
let lastNudgeAt = 0;
let stopped = false;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();

async function main() {
  log(`watching tmux session ${sessionName}`);
  while (!stopped) {
    try {
      const pane = capturePane();
      const fingerprint = sha1(pane);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChangedAt = Date.now();
      }

      const snapshot = analyzePane(pane);
      snapshot.lastChangedAt = new Date(lastChangedAt).toISOString();
      snapshot.idleForMs = Date.now() - lastChangedAt;
      snapshot.sessionName = sessionName;
      snapshot.updatedAt = new Date().toISOString();
      snapshot.lastNudgeAt = lastNudgeAt ? new Date(lastNudgeAt).toISOString() : null;
      snapshot.lastNudgeReason = null;

      writeState(snapshot);

      const shouldAlert =
        snapshot.status === "attention" ||
        (snapshot.status === "idle" && snapshot.idleForMs >= stallMs);

      if (shouldAlert && Date.now() - lastNotifyAt >= notifyCooldownMs) {
        lastNotifyAt = Date.now();
        const reason =
          snapshot.status === "attention"
            ? snapshot.reason
            : `idle for ${Math.round(snapshot.idleForMs / 60_000)}m`;
        log(`attention: ${reason}`);
        if (notifyEnabled) {
          notify(`Codex watcher: ${reason}`, sessionName);
        }
      }

      const shouldNudge =
        autoNudge &&
        Date.now() - lastNudgeAt >= nudgeCooldownMs &&
        (
          (snapshot.status === "attention" && nudgeOnAttention) ||
          (snapshot.status === "idle" && snapshot.idleForMs >= stallMs && nudgeOnIdle)
        );

      if (shouldNudge) {
        const reason =
          snapshot.status === "attention"
            ? snapshot.reason
            : `idle for ${Math.round(snapshot.idleForMs / 60_000)}m`;
        sendNudge(reason);
        lastNudgeAt = Date.now();
        snapshot.lastNudgeAt = new Date(lastNudgeAt).toISOString();
        snapshot.lastNudgeReason = reason;
        writeState(snapshot);
      }
    } catch (error) {
      const message = formatError(error);
      log(`watch error: ${message}`);
      writeState({
        sessionName,
        status: "error",
        reason: message,
        lastChangedAt: new Date(lastChangedAt).toISOString(),
        idleForMs: Date.now() - lastChangedAt,
        updatedAt: new Date().toISOString(),
        lastLines: [],
        lastNudgeAt: lastNudgeAt ? new Date(lastNudgeAt).toISOString() : null,
        lastNudgeReason: null,
      });
      if (notifyEnabled && Date.now() - lastNotifyAt >= notifyCooldownMs) {
        lastNotifyAt = Date.now();
        notify(`Codex watcher error: ${message}`, sessionName);
      }
    }

    await sleep(pollMs);
  }
}

function capturePane() {
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", `${sessionName}:0.0`, "-S", `-${lines}`],
    { encoding: "utf8" },
  );
}

function analyzePane(pane) {
  const allLines = pane.split("\n");
  const lastLines = allLines.slice(-25);
  const lower = pane.toLowerCase();
  const recent = lastLines.join("\n").toLowerCase();

  let status = "unknown";
  let reason = "no signal";

  if (recent.includes("working (") || recent.includes("thinking")) {
    status = "running";
    reason = "Codex is actively working";
  } else if (
    recent.includes("conversation interrupted") ||
    recent.includes("failed") ||
    recent.includes("fatal") ||
    recent.includes("error:") ||
    recent.includes("mcp startup incomplete") ||
    recent.includes("need input") ||
    recent.includes("waiting for input")
  ) {
    status = "attention";
    reason = detectAttentionReason(recent);
  } else if (lastLines.some((line) => line.trimStart().startsWith("›"))) {
    status = "idle";
    reason = "Codex is at a prompt";
  } else if (lower.trim().length > 0) {
    status = "unknown";
    reason = "Pane has output but no clear active state";
  }

  return {
    status,
    reason,
    lastLines,
  };
}

function detectAttentionReason(recent) {
  if (recent.includes("conversation interrupted")) return "conversation interrupted";
  if (recent.includes("need input") || recent.includes("waiting for input")) return "waiting for input";
  if (recent.includes("mcp startup incomplete")) return "MCP startup incomplete";
  if (recent.includes("fatal")) return "fatal error";
  if (recent.includes("error:")) return "error reported";
  if (recent.includes("failed")) return "failure reported";
  return "attention needed";
}

function writeState(snapshot) {
  fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2));
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, line);
}

function notify(message, subtitle) {
  if (process.platform !== "darwin") return;
  execFileSync("osascript", [
    "-e",
    `display notification ${asAppleString(message)} with title ${asAppleString("Codex Watcher")} subtitle ${asAppleString(subtitle)}`,
  ]);
}

function sendNudge(reason) {
  const prompt = `${nudgeText}\n\nWatcher reason: ${reason}`;
  execFileSync("tmux", ["load-buffer", "-"], { input: prompt, encoding: "utf8" });
  execFileSync("tmux", ["paste-buffer", "-t", `${sessionName}:0.0`]);
  execFileSync("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "Enter"]);
  log(`nudge sent: ${reason}`);
  if (notifyEnabled) {
    notify(`Codex watcher nudged session: ${reason}`, sessionName);
  }
}

function asAppleString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function shutdown() {
  stopped = true;
  process.exit(0);
}
