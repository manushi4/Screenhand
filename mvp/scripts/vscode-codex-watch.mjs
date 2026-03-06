#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { BridgeClient } from "../dist/native/bridge-client.js";
import { TimelineLogger } from "../dist/logging/timeline-logger.js";
import { AutomationRuntimeService } from "../dist/runtime/service.js";
import { AccessibilityAdapter } from "../dist/runtime/accessibility-adapter.js";

const config = {
  bundleId: process.env.WATCH_BUNDLE_ID ?? "com.microsoft.VSCode",
  pollMs: readInt("WATCH_POLL_MS", 30_000),
  stallMs: readInt("WATCH_STALL_MS", 10 * 60_000),
  maxDepth: readInt("WATCH_MAX_DEPTH", 7),
  maxLines: readInt("WATCH_MAX_LINES", 220),
  windowMatch: (process.env.WATCH_WINDOW_MATCH ?? "").trim(),
  notify: process.env.WATCH_NOTIFY === "1",
  autoNudge: process.env.WATCH_AUTO_NUDGE === "1",
  nudgeText: process.env.WATCH_NUDGE_TEXT ?? "",
  nudgeCooldownMs: readInt("WATCH_NUDGE_COOLDOWN_MS", 5 * 60_000),
  focusBeforeNudge: process.env.WATCH_FOCUS_BEFORE_NUDGE !== "0",
  sendEnter: process.env.WATCH_SEND_ENTER !== "0",
  stopPatterns: splitPatterns(
    process.env.WATCH_STOP_PATTERNS ??
      "waiting for input|need input|approval|approve|permission|rate limit|timed out|failed|error|blocked|login|captcha|stopped",
  ),
};

const bridge = new BridgeClient();
const adapter = new AccessibilityAdapter(bridge);
const runtime = new AutomationRuntimeService(adapter, new TimelineLogger());

let sessionId = "";
let lastFingerprint = "";
let lastChangedAt = Date.now();
let lastAlertAt = 0;
let stopped = false;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();

async function main() {
  await ensureCodeSession();

  console.log(`[watcher] Monitoring ${config.bundleId}`);
  console.log(`[watcher] poll=${config.pollMs}ms stall=${config.stallMs}ms depth=${config.maxDepth}`);
  if (config.windowMatch) {
    console.log(`[watcher] window match="${config.windowMatch}"`);
  }
  if (config.autoNudge) {
    console.log("[watcher] auto-nudge enabled");
  }

  while (!stopped) {
    try {
      const snapshot = await observe();
      if (!snapshot) {
        await sleep(config.pollMs);
        continue;
      }

      const fingerprint = fingerprintSnapshot(snapshot.normalizedText);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChangedAt = Date.now();
        console.log(`[watcher] change detected | title="${snapshot.windowTitle}" | tabs=${snapshot.tabs.join(", ") || "-"}`);
      }

      const idleMs = Date.now() - lastChangedAt;
      const matchedPatterns = config.stopPatterns.filter((pattern) => snapshot.normalizedText.includes(pattern));
      const isStalled = idleMs >= config.stallMs;
      const shouldAlert = isStalled || matchedPatterns.length > 0;

      if (shouldAlert && Date.now() - lastAlertAt >= config.nudgeCooldownMs) {
        lastAlertAt = Date.now();

        const reasons = [];
        if (isStalled) reasons.push(`stalled for ${Math.round(idleMs / 60_000)}m`);
        if (matchedPatterns.length > 0) reasons.push(`matched: ${matchedPatterns.join(", ")}`);

        const message = `Codex may need help in VS Code (${reasons.join(" | ")})`;
        console.log(`[watcher] ${message}`);

        if (config.notify) {
          notify(message, snapshot.windowTitle);
        }

        if (config.autoNudge) {
          await nudge(snapshot);
        }
      }
    } catch (error) {
      console.error(`[watcher] ${formatError(error)}`);
      await ensureCodeSession();
    }

    await sleep(config.pollMs);
  }
}

async function ensureCodeSession() {
  const session = await runtime.sessionStart("watcher");
  sessionId = session.sessionId;

  const apps = await adapter.listApps?.(sessionId);
  const codeApp = apps?.find((app) => app.bundleId === config.bundleId);
  if (!codeApp) {
    throw new Error(`VS Code app not found for bundle id ${config.bundleId}`);
  }

  const focused = await runtime.appFocus({ sessionId, bundleId: config.bundleId });
  if (!focused.ok) {
    throw new Error(focused.error.message);
  }
}

async function observe() {
  const context = await adapter.getAppContext(sessionId);
  const windowTitle = context.windowTitle || "VS Code";
  if (config.windowMatch && !windowTitle.toLowerCase().includes(config.windowMatch.toLowerCase())) {
    console.log(`[watcher] skipped window "${windowTitle}"`);
    return null;
  }

  const tree = await adapter.elementTree?.(sessionId, config.maxDepth);
  if (!tree) {
    throw new Error("Could not read accessibility tree");
  }

  const lines = [];
  flattenTree(tree, lines);
  const cappedLines = lines.slice(0, config.maxLines);
  const normalizedText = cappedLines.join("\n").toLowerCase();
  const tabs = collectTabLabels(tree);

  return {
    windowTitle,
    tabs,
    normalizedText,
  };
}

async function nudge(snapshot) {
  if (!config.nudgeText.trim()) {
    console.log("[watcher] auto-nudge enabled but WATCH_NUDGE_TEXT is empty");
    return;
  }

  console.log(`[watcher] nudging Codex in "${snapshot.windowTitle}"`);

  if (config.focusBeforeNudge) {
    const focused = await runtime.appFocus({ sessionId, bundleId: config.bundleId });
    if (!focused.ok) {
      throw new Error(`Could not refocus VS Code: ${focused.error.message}`);
    }
    await sleep(400);
  }

  await bridge.call("cg.typeText", { text: config.nudgeText });
  if (config.sendEnter) {
    await bridge.call("cg.keyCombo", { keys: ["enter"] });
  }
}

function flattenTree(node, lines) {
  if (lines.length >= config.maxLines) return;

  const role = String(node.role ?? "").replace(/^AX/, "").toLowerCase();
  const title = normalize(node.title);
  const value = normalize(node.value);
  const identifier = normalize(node.identifier);

  if (role || title || value || identifier) {
    lines.push([role, title, value, identifier].filter(Boolean).join(" | "));
  }

  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (lines.length >= config.maxLines) break;
    flattenTree(child, lines);
  }
}

function collectTabLabels(node, labels = new Set()) {
  const role = String(node.role ?? "").toLowerCase();
  const title = normalize(node.title);

  if ((role.includes("tab") || role.includes("radio")) && title) {
    labels.add(title);
  }

  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    collectTabLabels(child, labels);
  }

  return [...labels].slice(0, 12);
}

function fingerprintSnapshot(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function normalize(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function splitPatterns(raw) {
  return raw
    .split("|")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function notify(message, title) {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("osascript", [
      "-e",
      `display notification ${toAppleScript(message)} with title ${toAppleScript("ScreenHand Watcher")} subtitle ${toAppleScript(title)}`,
    ]);
  } catch (error) {
    console.error(`[watcher] notification failed: ${formatError(error)}`);
  }
}

function toAppleScript(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  try {
    await bridge.stop();
  } catch {
    // ignore cleanup failures
  }
  process.exit(0);
}
