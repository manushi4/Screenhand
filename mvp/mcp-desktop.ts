#!/usr/bin/env npx tsx
/**
 * ScreenHand — MCP Server for Desktop Automation
 * Controls any macOS/Windows app + Chrome browser via CDP.
 *
 * Setup — add to ~/.claude/settings.json or project .mcp.json:
 * {
 *   "mcpServers": {
 *     "screenhand": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { BridgeClient } from "./src/native/bridge-client.js";
import { writeFileAtomicSync, readJsonWithRecovery } from "./src/util/atomic-write.js";
import { MemoryService } from "./src/memory/service.js";
import type { ActionEntry, ErrorPattern } from "./src/memory/types.js";
import { backgroundResearch } from "./src/memory/research.js";
import { SessionSupervisor, LeaseManager } from "./src/supervisor/supervisor.js";
import type { RecoveryAction } from "./src/supervisor/types.js";
import { JobManager } from "./src/jobs/manager.js";
import { JobRunner } from "./src/jobs/runner.js";
import { getWorkerLiveStatus, getWorkerDaemonPid, WORKER_PID_FILE, WORKER_LOG_FILE } from "./src/jobs/worker.js";
import type { JobState } from "./src/jobs/types.js";
import { JOB_STATES } from "./src/jobs/types.js";
import { PlaybookEngine } from "./src/playbook/engine.js";
import { PlaybookStore } from "./src/playbook/store.js";
import { AccessibilityAdapter } from "./src/runtime/accessibility-adapter.js";
import { AutomationRuntimeService } from "./src/runtime/service.js";
import { TimelineLogger } from "./src/logging/timeline-logger.js";
import { spawn } from "node:child_process";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Audit logging for dangerous tools ──
const AUDIT_LOG_PATH = path.resolve(__dirname, ".audit-log.jsonl");

function auditLog(tool: string, params: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool,
    params,
    pid: process.pid,
  };
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Non-critical — don't crash if log write fails
  }
}
const bridgePath = process.platform === "win32"
  ? path.resolve(__dirname, "native/windows-bridge/bin/Release/net8.0-windows/windows-bridge.exe")
  : path.resolve(__dirname, "native/macos-bridge/.build/release/macos-bridge");
const bridge = new BridgeClient(bridgePath);
let bridgeReady = false;

async function ensureBridge() {
  if (!bridgeReady) { await bridge.start(); bridgeReady = true; }
}

// CDP connection cache
let cdpPort: number | null = null;
let CDP: any = null;

async function ensureCDP(): Promise<{ CDP: any; port: number }> {
  if (!CDP) CDP = (await import("chrome-remote-interface")).default;
  if (cdpPort) {
    try { await CDP.Version({ port: cdpPort }); return { CDP, port: cdpPort }; } catch {}
  }
  // Try common ports
  for (const p of [9222, 9223, 9224]) {
    try { await CDP.Version({ port: p }); cdpPort = p; return { CDP, port: p }; } catch {}
  }
  throw new Error("Chrome not running with --remote-debugging-port. Launch with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug");
}

const server = new McpServer({ name: "screenhand", version: "2.0.0" });

// ═══════════════════════════════════════════════
// LEARNING MEMORY — cached, auto-recall, non-blocking
// ═══════════════════════════════════════════════

const memory = new MemoryService(__dirname);
memory.init(); // One-time disk read at startup

// Supervisor — manages session leases and stall detection
const supervisor = new SessionSupervisor();

// Job manager — persistent multi-step automation jobs
const JOB_DIR = path.join(os.homedir(), ".screenhand", "jobs");
const jobManager = new JobManager({ jobDir: JOB_DIR, memory, supervisor });
jobManager.init();

// Direct lease manager that shares the filesystem lock dir with the daemon
const LOCK_DIR = path.join(os.homedir(), ".screenhand", "locks");
const leaseManager = new LeaseManager(LOCK_DIR);

// Skip logging for memory tools themselves
const MEMORY_TOOLS = new Set([
  "memory_snapshot", "memory_recall", "memory_save", "memory_record_error",
  "memory_record_learning", "memory_query_patterns", "memory_errors",
  "memory_stats", "memory_clear",
  "session_claim", "session_heartbeat", "session_release",
  "supervisor_status", "supervisor_start", "supervisor_stop", "supervisor_pause", "supervisor_resume",
  "supervisor_install", "supervisor_uninstall",
  "recovery_queue_add", "recovery_queue_list",
  "job_create", "job_status", "job_list", "job_transition",
  "job_step_done", "job_step_fail", "job_resume", "job_dequeue", "job_remove",
  "job_run", "job_run_all",
  "worker_start", "worker_stop", "worker_status",
]);

// Track the strategy we're currently following (for feedback loop)
let activeStrategyFingerprint: string | null = null;

// Intercept all tool registrations to auto-log + auto-recall
const originalTool = server.tool.bind(server);
type ToolArgs = Parameters<typeof server.tool>;

function extractText(result: any): string {
  if (!result?.content) return "";
  return result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .slice(0, 500);
}

(server as any).tool = (...args: ToolArgs) => {
  const handlerIdx = args.findIndex((a) => typeof a === "function");
  if (handlerIdx === -1) return (originalTool as any)(...args);

  const originalHandler = args[handlerIdx] as Function;
  const toolName = args[0] as string;

  const wrappedHandler = async (params: any, extra: any) => {
    // Skip intercepting memory tools to avoid recursion
    if (MEMORY_TOOLS.has(toolName)) {
      return originalHandler(params, extra);
    }

    const sessionId = memory.getSessionId();
    const safeParams = typeof params === "object" && params !== null ? params : {};
    const start = Date.now();

    // ── PRE-CALL: check for known error warnings (~0ms, in-memory) ──
    const knownError = memory.quickErrorCheck(toolName);

    try {
      const result = await originalHandler(params, extra);
      const durationMs = Date.now() - start;

      // ── POST-CALL: log action (async, non-blocking) ──
      const entry: ActionEntry = {
        id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        sessionId,
        tool: toolName,
        params: safeParams,
        durationMs,
        success: true,
        result: extractText(result),
        error: null,
      };
      memory.recordEvent(entry);  // non-blocking write + session tracking

      // ── POST-CALL: auto-recall hints (~0ms, in-memory) ──
      const hints: string[] = [];

      // Warn about known errors for this tool
      if (knownError) {
        hints.push(`⚡ Memory: "${toolName}" has failed before: "${knownError.error}" (${knownError.occurrences}x). Fix: ${knownError.resolution}`);
      }

      // Suggest next step if we're mid-strategy
      const recentTools = memory.getRecentToolNames();
      const strategyHint = memory.quickStrategyHint(recentTools);
      if (strategyHint) {
        activeStrategyFingerprint = strategyHint.fingerprint;
        const nextParams = Object.keys(strategyHint.nextStep.params).length > 0
          ? `(${JSON.stringify(strategyHint.nextStep.params)})`
          : "";
        hints.push(`💡 Memory: This matches strategy "${strategyHint.strategy.task}" (${strategyHint.strategy.successCount} wins, ${strategyHint.strategy.failCount ?? 0} fails). Next step: ${strategyHint.nextStep.tool}${nextParams}`);

        // If this was the last step of the strategy, record success
        if (recentTools.length === strategyHint.strategy.steps.length - 1) {
          // Next call will be the final step — but this call completing means we're on track
        }
      } else if (activeStrategyFingerprint && recentTools.length > 0) {
        // We were following a strategy but the sequence diverged — record success
        // (the agent completed the strategy or went its own way after it)
        memory.recordStrategyOutcome(activeStrategyFingerprint, true);
        activeStrategyFingerprint = null;
      }

      // Attach hints as _meta (doesn't pollute tool output for MCP clients)
      if (hints.length > 0) {
        return {
          ...result,
          _meta: { ...(result?._meta ?? {}), memoryHints: hints },
        };
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorMsg = err?.message ?? String(err);

      // Log failed action (non-blocking)
      const entry: ActionEntry = {
        id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        sessionId,
        tool: toolName,
        params: safeParams,
        durationMs,
        success: false,
        result: null,
        error: errorMsg,
      };
      memory.recordEvent(entry);  // non-blocking write + session tracking

      // Record strategy failure if we were following one
      if (activeStrategyFingerprint) {
        memory.recordStrategyOutcome(activeStrategyFingerprint, false);
        activeStrategyFingerprint = null;
      }

      // Record error pattern (updates cache + async write)
      const errorPattern: ErrorPattern = {
        id: "err_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        tool: toolName,
        params: safeParams,
        error: errorMsg,
        resolution: null,
        occurrences: 1,
        lastSeen: new Date().toISOString(),
      };
      memory.appendError(errorPattern);

      // Background research: search for a fix if no resolution exists
      const existingErrors = memory.readErrors();
      const hasResolution = existingErrors.some(
        (e) => e.tool === toolName && e.error === errorMsg && e.resolution
      );
      if (!hasResolution) {
        backgroundResearch(memory as any, toolName, safeParams, errorMsg);
      }

      throw err;
    }
  };

  const newArgs = [...args];
  newArgs[handlerIdx] = wrappedHandler;
  return (originalTool as any)(...newArgs);
};

// ═══════════════════════════════════════════════
// APPS — discover and manage running applications
// ═══════════════════════════════════════════════

server.tool("apps", "List all running applications with bundle IDs and PIDs", {}, async () => {
  await ensureBridge();
  const apps = await bridge.call<any[]>("app.list");
  const lines = apps.map((a: any) =>
    `${a.name} (${a.bundleId}) pid=${a.pid}${a.isActive ? " ← active" : ""}`
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("windows", "List all visible windows with IDs, positions, and sizes", {}, async () => {
  await ensureBridge();
  const wins = await bridge.call<any[]>("app.windows");
  const lines = wins.map((w: any) => {
    const b = w.bounds || {};
    return `[${w.windowId}] ${w.appName} "${w.title}" (${Math.round(b.x||0)},${Math.round(b.y||0)}) ${Math.round(b.width||0)}x${Math.round(b.height||0)}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("focus", "Focus/activate an application", {
  bundleId: z.string().describe("App bundle ID, e.g. com.apple.Safari"),
}, async ({ bundleId }) => {
  await ensureBridge();
  await bridge.call("app.focus", { bundleId });
  return { content: [{ type: "text", text: "Focused " + bundleId }] };
});

server.tool("launch", "Launch an application", {
  bundleId: z.string().describe("App bundle ID"),
}, async ({ bundleId }) => {
  await ensureBridge();
  const r = await bridge.call<any>("app.launch", { bundleId });
  return { content: [{ type: "text", text: `Launched ${r.appName} pid=${r.pid}` }] };
});

// ═══════════════════════════════════════════════
// INSPECT — see what's on screen (debugging/design)
// ═══════════════════════════════════════════════

server.tool("screenshot", "Take a screenshot and OCR it. Returns all visible text. NOTE: For finding/clicking UI elements, ui_tree + ui_press is 10x faster.", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });
  return { content: [{ type: "text", text: `Screenshot: ${shot.width}x${shot.height} (${shot.path})\n\n${ocr.text}` }] };
});

server.tool("screenshot_file", "Take a screenshot and return the file path (for viewing the actual image)", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  return { content: [{ type: "text", text: shot.path }] };
});

server.tool("ocr", "OCR a window with element positions. SLOW — prefer ui_tree for structured element discovery. Use OCR only for reading visual/canvas content.", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });

  let winBounds: any = null;
  if (windowId) {
    const wins = await bridge.call<any[]>("app.windows");
    const win = wins.find((w: any) => w.windowId === windowId);
    winBounds = win?.bounds;
  }

  const regions = ocr.regions.map((r: any) => `"${r.text}" (${Math.round(r.bounds.x)},${Math.round(r.bounds.y)}) ${Math.round(r.bounds.width)}x${Math.round(r.bounds.height)}`);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        image: { width: shot.width, height: shot.height, path: shot.path },
        window: winBounds,
        elementCount: regions.length,
        elements: regions,
      }, null, 2),
    }],
  };
});

// ═══════════════════════════════════════════════
// ACCESSIBILITY — structured UI inspection (instant, no OCR)
// ═══════════════════════════════════════════════

server.tool("ui_tree", "PREFERRED: Get the full UI element tree of an app via Accessibility. ~50ms, no screenshot/OCR. Use this FIRST to find elements — returns titles, roles, and bounds. Then use ui_press/ui_find to interact.", {
  pid: z.number().describe("Process ID of the app"),
  maxDepth: z.number().optional().describe("Max depth (default 4). Use 2 for overview, 6+ for deep inspection."),
}, async ({ pid, maxDepth }) => {
  await ensureBridge();
  const tree = await bridge.call<any>("ax.getElementTree", { pid, maxDepth: maxDepth || 4 });

  function format(node: any, depth: number): string {
    let line = "  ".repeat(depth) + (node.role || "?");
    if (node.title) line += ` "${node.title}"`;
    if (node.value) line += ` =${String(node.value).slice(0, 60)}`;
    if (node.bounds) line += ` (${Math.round(node.bounds.x)},${Math.round(node.bounds.y)} ${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)})`;
    let result = line;
    if (node.children) {
      for (const c of node.children) result += "\n" + format(c, depth + 1);
    }
    return result;
  }

  return { content: [{ type: "text", text: format(tree, 0) }] };
});

server.tool("ui_find", "Find a specific UI element by text/title. Returns its role, bounds, and path.", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Text to search for (partial match)"),
}, async ({ pid, title }) => {
  await ensureBridge();
  const r = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("ui_press", "PREFERRED: Find and press/click a UI element by its title via Accessibility. Faster and more reliable than click_text — no screenshot needed.", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Element title to find and press"),
}, async ({ pid, title }) => {
  await ensureBridge();
  const el = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  await bridge.call("ax.performAction", { pid, elementPath: el.elementPath, action: "AXPress" });
  return { content: [{ type: "text", text: `Pressed "${el.title}" (${el.role})` }] };
});

server.tool("ui_set_value", "Set the value of a UI element (text field, slider, etc.)", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Element title to find"),
  value: z.string().describe("Value to set"),
}, async ({ pid, title, value }) => {
  await ensureBridge();
  const el = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  await bridge.call("ax.setElementValue", { pid, elementPath: el.elementPath, value });
  return { content: [{ type: "text", text: `Set "${el.title}" = "${value}"` }] };
});

server.tool("menu_click", "Click a menu item in an app's menu bar", {
  pid: z.number().describe("Process ID"),
  menuPath: z.string().describe("Menu path separated by /. e.g. 'File/New', 'View/Show Sidebar'"),
}, async ({ pid, menuPath }) => {
  await ensureBridge();
  await bridge.call("ax.menuClick", { pid, menuPath: menuPath.split("/") });
  return { content: [{ type: "text", text: "Menu: " + menuPath }] };
});

// ═══════════════════════════════════════════════
// INPUT — interact with the screen
// ═══════════════════════════════════════════════

server.tool("click", "Click at screen coordinates", {
  x: z.number().describe("Screen X"),
  y: z.number().describe("Screen Y"),
}, async ({ x, y }) => {
  await ensureBridge();
  await bridge.call("cg.mouseMove", { x, y });
  await new Promise(r => setTimeout(r, 50));
  await bridge.call("cg.mouseClick", { x, y });
  return { content: [{ type: "text", text: `Clicked (${x}, ${y})` }] };
});

server.tool("click_text", "SLOW fallback: Find text on screen via OCR and click it. Use ui_press instead when possible — it's 10x faster. Only use this for canvas/image content where Accessibility doesn't work.", {
  windowId: z.number().describe("Window ID"),
  text: z.string().describe("Text to find and click"),
  offset_y: z.number().optional().describe("Y offset from text center (e.g. -25 for icon above label)"),
}, async ({ windowId, text, offset_y }) => {
  await ensureBridge();
  const wins = await bridge.call<any[]>("app.windows");
  const win = wins.find((w: any) => w.windowId === windowId);
  if (!win) return { content: [{ type: "text", text: "Window not found" }] };
  const wb = win.bounds;

  const shot = await bridge.call<any>("cg.captureWindow", { windowId });
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });
  const match = ocr.regions.find((r: any) => r.text.toLowerCase().includes(text.toLowerCase()));
  if (!match) {
    return { content: [{ type: "text", text: `"${text}" not found. Available: ${ocr.regions.map((r:any) => r.text).slice(0, 20).join(", ")}` }] };
  }

  const shadowL = (shot.width - wb.width * 2) / 2;
  const shadowT = (shot.height - wb.height * 2) / 3;
  const sx = wb.x + (match.bounds.x + match.bounds.width / 2 - shadowL) / 2;
  const sy = wb.y + (match.bounds.y + match.bounds.height / 2 - shadowT) / 2 + (offset_y || 0);

  await bridge.call("cg.mouseMove", { x: sx, y: sy });
  await new Promise(r => setTimeout(r, 50));
  await bridge.call("cg.mouseClick", { x: sx, y: sy });

  return { content: [{ type: "text", text: `Clicked "${match.text}" at (${Math.round(sx)}, ${Math.round(sy)})` }] };
});

server.tool("type_text", "Type text using the keyboard", {
  text: z.string().describe("Text to type"),
}, async ({ text }) => {
  await ensureBridge();
  await bridge.call("cg.typeText", { text });
  return { content: [{ type: "text", text: "Typed: " + text }] };
});

server.tool("key", "Press a key combination", {
  combo: z.string().describe("Key combo: 'cmd+c', 'enter', 'cmd+shift+n', 'space'. Use + to separate."),
}, async ({ combo }) => {
  await ensureBridge();
  await bridge.call("cg.keyCombo", { keys: combo.split("+") });
  return { content: [{ type: "text", text: "Key: " + combo }] };
});

server.tool("drag", "Drag from one point to another", {
  fromX: z.number(), fromY: z.number(),
  toX: z.number(), toY: z.number(),
}, async ({ fromX, fromY, toX, toY }) => {
  await ensureBridge();
  await bridge.call("cg.mouseDrag", { fromX, fromY, toX, toY });
  return { content: [{ type: "text", text: `Dragged (${fromX},${fromY}) → (${toX},${toY})` }] };
});

server.tool("scroll", "Scroll at a position", {
  x: z.number(), y: z.number(),
  deltaX: z.number().optional().describe("Horizontal scroll (default 0)"),
  deltaY: z.number().describe("Vertical scroll (negative = down)"),
}, async ({ x, y, deltaX, deltaY }) => {
  await ensureBridge();
  await bridge.call("cg.scroll", { x, y, deltaX: deltaX || 0, deltaY });
  return { content: [{ type: "text", text: "Scrolled" }] };
});

// ── CDP helper: get client for a tab ──
async function getCDPClient(tabId?: string): Promise<{ client: any; targetId: string; CDP: any; port: number }> {
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  return { client, targetId: targetId!, CDP: cdp, port };
}

// ── Random delay helper ──
function randomDelay(min: number, max: number): Promise<void> {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// ═══════════════════════════════════════════════
// BROWSER — control Chrome pages via CDP (10ms, not OCR)
// ═══════════════════════════════════════════════

server.tool("browser_tabs", "List all open Chrome tabs", {}, async () => {
  const { CDP: cdp, port } = await ensureCDP();
  const targets = await cdp.List({ port });
  const pages = targets.filter((t: any) => t.type === "page");
  const lines = pages.map((t: any) => `[${t.id}] ${t.title} — ${t.url}`);
  return { content: [{ type: "text", text: lines.join("\n") || "No tabs open" }] };
});

server.tool("browser_open", "Open a URL in Chrome (creates new tab)", {
  url: z.string().describe("URL to open"),
}, async ({ url }) => {
  const { CDP: cdp, port } = await ensureCDP();
  const target = await cdp.New({ port, url });
  return { content: [{ type: "text", text: `Opened: ${target.id} — ${url}` }] };
});

server.tool("browser_navigate", "Navigate the active Chrome tab to a URL", {
  url: z.string().describe("URL to navigate to"),
  tabId: z.string().optional().describe("Tab ID (from browser_tabs). Omit for most recent tab."),
}, async ({ url, tabId }) => {
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Page.enable();
  await client.Page.navigate({ url });
  // Wait for load
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await client.Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
    if (r.result.value === "complete" || r.result.value === "interactive") break;
    await new Promise(r => setTimeout(r, 200));
  }
  const title = await client.Runtime.evaluate({ expression: "document.title", returnByValue: true });
  await client.close();
  return { content: [{ type: "text", text: `Navigated to: ${title.result.value}` }] };
});

server.tool("browser_js", "Execute JavaScript in a Chrome tab. Returns the result. WARNING: This runs arbitrary JS in the browser context — avoid on sensitive pages (banking, email). All executions are audit-logged.", {
  code: z.string().describe("JavaScript to execute. Must be an expression that returns a value. Use (() => { ... })() for multi-line."),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ code, tabId }) => {
  auditLog("browser_js", { code: code.slice(0, 500), tabId });
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: code,
    awaitPromise: true,
    returnByValue: true,
  });
  await client.close();

  if (result.exceptionDetails) {
    return { content: [{ type: "text", text: `JS Error: ${result.exceptionDetails.text}\n${result.exceptionDetails.exception?.description || ""}` }] };
  }

  const val = result.result.value;
  const text = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "undefined");
  return { content: [{ type: "text", text }] };
});

server.tool("browser_dom", "Query the DOM of a Chrome page. Returns matching elements' text, attributes, and structure.", {
  selector: z.string().describe("CSS selector, e.g. 'button', '.nav a', '#main h2'"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ selector, tabId, limit }) => {
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const maxResults = limit || 20;
  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, ${maxResults});
      return els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        class: el.className?.toString()?.slice(0, 100) || undefined,
        text: el.textContent?.trim()?.slice(0, 200),
        href: el.href || undefined,
        src: el.src || undefined,
        value: el.value || undefined,
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
    })()`,
    returnByValue: true,
  });
  await client.close();

  return { content: [{ type: "text", text: JSON.stringify(result.result.value, null, 2) }] };
});

server.tool("browser_click", "Click an element in Chrome by CSS selector. Uses CDP Input.dispatchMouseEvent for realistic mouse events.", {
  selector: z.string().describe("CSS selector of element to click"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ selector, tabId }) => {
  const { client } = await getCDPClient(tabId);
  await client.Runtime.enable();

  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent?.trim()?.slice(0, 100) };
    })()`,
    returnByValue: true,
  });

  const val = result.result.value;
  if (!val?.ok) {
    await client.close();
    return { content: [{ type: "text", text: val?.reason || "Element not found" }] };
  }

  const { x, y } = val;
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await randomDelay(30, 60);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await randomDelay(30, 80);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  await client.close();
  return { content: [{ type: "text", text: `Clicked: "${val.text}" at (${Math.round(x)}, ${Math.round(y)})` }] };
});

server.tool("browser_type", "Type into an input field in Chrome. Uses CDP Input.dispatchKeyEvent for real keyboard events (works with React/Angular).", {
  selector: z.string().describe("CSS selector of the input"),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear field first (default true)"),
  tabId: z.string().optional().describe("Tab ID"),
}, async ({ selector, text, clear, tabId }) => {
  const { client } = await getCDPClient(tabId);
  await client.Runtime.enable();

  // Focus the element
  const focusResult = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Input not found" };
      el.scrollIntoView({ block: "center" });
      el.focus();
      return { ok: true };
    })()`,
    returnByValue: true,
  });

  if (!focusResult.result.value?.ok) {
    await client.close();
    return { content: [{ type: "text", text: focusResult.result.value?.reason || "Input not found" }] };
  }

  // Clear if needed: select all + delete
  const shouldClear = clear !== false;
  if (shouldClear) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace" });
    await randomDelay(30, 80);
  }

  // Type character by character with random delays
  for (const char of text) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
    await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
    await randomDelay(30, 80);
  }

  await client.close();
  return { content: [{ type: "text", text: `Typed "${text}"` }] };
});

server.tool("browser_wait", "Wait for a condition on a Chrome page", {
  condition: z.string().describe("JS expression that returns truthy when ready. e.g. 'document.querySelector(\".loaded\")'"),
  timeoutMs: z.number().optional().describe("Timeout in ms (default 10000)"),
  tabId: z.string().optional().describe("Tab ID"),
}, async ({ condition, timeoutMs, tabId }) => {
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const deadline = Date.now() + (timeoutMs || 10000);
  let met = false;
  while (Date.now() < deadline) {
    const r = await client.Runtime.evaluate({ expression: `!!(${condition})`, returnByValue: true });
    if (r.result.value) { met = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  await client.close();
  return { content: [{ type: "text", text: met ? "Condition met" : "Timeout — condition not met" }] };
});

server.tool("browser_page_info", "Get current page title, URL, and text content summary", {
  tabId: z.string().optional().describe("Tab ID"),
}, async ({ tabId }) => {
  const { CDP: cdp, port } = await ensureCDP();
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: `(() => ({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 2000) || "",
    }))()`,
    returnByValue: true,
  });
  await client.close();
  return { content: [{ type: "text", text: JSON.stringify(result.result.value, null, 2) }] };
});

// ═══════════════════════════════════════════════
// BROWSER STEALTH — anti-detection patches
// ═══════════════════════════════════════════════

const STEALTH_SCRIPT = `
// Hide navigator.webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Delete ChromeDriver leak variables
for (const key of Object.keys(window)) {
  if (key.match(/^cdc_/)) delete (window)[key];
}

// Realistic plugins array
Object.defineProperty(navigator, 'plugins', {
  get: () => [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ],
});

// Realistic languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// Patch chrome.runtime to look realistic (not headless)
if (!window.chrome) (window as any).chrome = {};
if (!window.chrome.runtime) (window as any).chrome.runtime = { connect: () => {}, sendMessage: () => {} };

// Patch Permissions.query for notifications
const origQuery = window.Permissions?.prototype?.query;
if (origQuery) {
  window.Permissions.prototype.query = function(params: any) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
    }
    return origQuery.call(this, params);
  };
}
`;

server.tool("browser_stealth", "Inject anti-detection patches into Chrome page. Call once after navigating to a protected site. Hides webdriver flag, patches plugins/languages/permissions.", {
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ tabId }) => {
  const { client } = await getCDPClient(tabId);
  await client.Page.enable();
  await client.Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
  // Also evaluate immediately on current page
  await client.Runtime.enable();
  await client.Runtime.evaluate({ expression: STEALTH_SCRIPT, returnByValue: true });
  await client.close();
  return { content: [{ type: "text", text: "Stealth patches injected: webdriver hidden, plugins/languages/permissions patched." }] };
});

// ═══════════════════════════════════════════════
// BROWSER HUMAN-LIKE INPUT — anti-detection tools
// ═══════════════════════════════════════════════

server.tool("browser_fill_form", "Fill a form field with human-like typing (anti-detection). Uses real keyboard events via CDP Input domain.", {
  selector: z.string().describe("CSS selector of the input"),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear field first (default true)"),
  delayMs: z.number().optional().describe("Avg delay between keystrokes in ms (default 50)"),
  tabId: z.string().optional().describe("Tab ID"),
}, async ({ selector, text, clear, delayMs, tabId }) => {
  const { client } = await getCDPClient(tabId);
  await client.Runtime.enable();

  // Focus the element
  const focusResult = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      el.focus();
      return { ok: true };
    })()`,
    returnByValue: true,
  });
  if (!focusResult.result.value?.ok) {
    await client.close();
    return { content: [{ type: "text", text: focusResult.result.value?.reason || "Element not found" }] };
  }

  // Clear if needed
  const shouldClear = clear !== false;
  if (shouldClear) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace" });
    await randomDelay(30, 80);
  }

  // Type character by character with random delays
  const avgDelay = delayMs ?? 50;
  const minDelay = Math.max(10, avgDelay - 20);
  const maxDelay = avgDelay + 30;

  for (const char of text) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
    await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
    await randomDelay(minDelay, maxDelay);
  }

  await client.close();
  return { content: [{ type: "text", text: `Typed "${text}" (${text.length} chars, human-like)` }] };
});

server.tool("browser_human_click", "Click an element with realistic mouse events (anti-detection). Dispatches mouseMoved → mousePressed → mouseReleased at element coordinates.", {
  selector: z.string().describe("CSS selector of element to click"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ selector, tabId }) => {
  const { client } = await getCDPClient(tabId);
  await client.Runtime.enable();

  // Get element center coordinates
  const rectResult = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent?.trim()?.slice(0, 100) };
    })()`,
    returnByValue: true,
  });

  const val = rectResult.result.value;
  if (!val?.ok) {
    await client.close();
    return { content: [{ type: "text", text: val?.reason || "Element not found" }] };
  }

  const { x, y } = val;

  // Simulate realistic mouse event sequence
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await randomDelay(30, 60);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await randomDelay(30, 80);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  await client.close();
  return { content: [{ type: "text", text: `Clicked: "${val.text}" at (${Math.round(x)}, ${Math.round(y)})` }] };
});

// ═══════════════════════════════════════════════
// PLATFORM PLAYBOOKS — lazy-loaded site knowledge
// ═══════════════════════════════════════════════

const playbooksDir = path.resolve(__dirname, "playbooks");

server.tool("platform_guide", "Get automation guide for a platform (selectors, URLs, flows, error solutions). Available: devpost. Zero cost — only loads when called.", {
  platform: z.string().describe("Platform name, e.g. 'devpost'"),
  section: z.enum(["all", "urls", "flows", "selectors", "errors", "detection"]).optional().describe("Section to return (default: all). Use 'errors' for just error+solution pairs."),
}, async ({ platform, section }) => {
  const filePath = path.resolve(playbooksDir, `${platform.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) {
    const available = fs.existsSync(playbooksDir)
      ? fs.readdirSync(playbooksDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""))
      : [];
    return { content: [{ type: "text", text: `No playbook for "${platform}". Available: ${available.join(", ") || "none"}` }] };
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const s = section || "all";

  if (s === "errors") {
    const errors = data.errors || [];
    const text = errors.map((e: any, i: number) =>
      `${i + 1}. [${e.severity}] ${e.error}\n   Context: ${e.context}\n   Solution: ${e.solution}`
    ).join("\n\n");
    return { content: [{ type: "text", text: text || "No errors documented." }] };
  }

  if (s === "urls") {
    return { content: [{ type: "text", text: JSON.stringify(data.urls, null, 2) }] };
  }

  if (s === "detection") {
    return { content: [{ type: "text", text: JSON.stringify(data.detection, null, 2) }] };
  }

  if (s === "flows") {
    const flows = data.flows || {};
    const text = Object.entries(flows).map(([name, flow]: [string, any]) => {
      const steps = (flow.steps || []).map((s: string, i: number) => `  ${i + 1}. ${s}`).join("\n");
      const tips = (flow.tips || []).map((t: string) => `  TIP: ${t}`).join("\n");
      return `### ${name}\n${steps}${tips ? "\n" + tips : ""}`;
    }).join("\n\n");
    return { content: [{ type: "text", text }] };
  }

  if (s === "selectors") {
    const flows = data.flows || {};
    const text = Object.entries(flows).map(([name, flow]: [string, any]) => {
      const sels = flow.selectors || {};
      const lines = Object.entries(sels).map(([k, v]) => `  ${k}: ${v}`).join("\n");
      return `### ${name}\n${lines}`;
    }).join("\n\n");
    return { content: [{ type: "text", text }] };
  }

  // "all" — return full playbook
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool("export_playbook", "Generate a playbook JSON from your session. Extracts URLs, selectors, errors+solutions from memory. Share the output with ScreenHand to help others automate this platform.", {
  platform: z.string().describe("Platform name, e.g. 'linkedin', 'twitter'"),
  domain: z.string().describe("Domain to filter actions by, e.g. 'linkedin.com'"),
  description: z.string().optional().describe("Short description of the platform"),
  tabId: z.string().optional().describe("Tab ID to scan current page for selectors"),
}, async ({ platform, domain, description, tabId }) => {
  // 1. Pull URLs and errors from memory store
  const actions = memory.readActions();
  const errors = memory.readErrors();
  const strategies = memory.readStrategies();

  const domainLower = domain.toLowerCase();

  // Extract unique URLs from actions that touched this domain
  const urlSet = new Set<string>();
  for (const a of actions) {
    const params = a.params as Record<string, any> || {};
    const url = params.url || "";
    if (typeof url === "string" && url.toLowerCase().includes(domainLower)) {
      urlSet.add(url);
    }
    const result = a.result || "";
    const urlMatch = result.match(/https?:\/\/[^\s"]+/g);
    if (urlMatch) {
      for (const u of urlMatch) {
        if (u.toLowerCase().includes(domainLower)) urlSet.add(u);
      }
    }
  }

  // Extract errors related to this domain's tools
  const domainErrors: Array<{ error: string; tool: string; resolution: string | null; occurrences: number }> = [];
  for (const e of errors) {
    const params = e.params as Record<string, any> || {};
    const url = params.url || params.selector || "";
    const isRelevant = (typeof url === "string" && url.toLowerCase().includes(domainLower)) ||
      actions.some(a => {
        const ap = a.params as Record<string, any> || {};
        return a.tool === e.tool && typeof ap.url === "string" && ap.url.toLowerCase().includes(domainLower);
      });
    if (isRelevant) {
      domainErrors.push({
        error: e.error,
        tool: e.tool,
        resolution: e.resolution,
        occurrences: e.occurrences,
      });
    }
  }

  // Extract relevant strategies
  const domainStrategies = strategies.filter(s =>
    s.task.toLowerCase().includes(domainLower) ||
    s.task.toLowerCase().includes(platform.toLowerCase()) ||
    s.tags.some(t => t.toLowerCase().includes(platform.toLowerCase()))
  );

  // 2. Scan current page for selectors if tab is available
  let pageSelectors: Record<string, string> = {};
  if (tabId || true) {
    try {
      const { client } = await getCDPClient(tabId);
      await client.Runtime.enable();
      const scanResult = await client.Runtime.evaluate({
        expression: `(() => {
          const url = location.href;
          if (!url.toLowerCase().includes(${JSON.stringify(domainLower)})) return { match: false, url };
          const inputs = Array.from(document.querySelectorAll('input,select,textarea,button[type="submit"]'));
          const selectors = {};
          for (const el of inputs) {
            const id = el.id;
            const name = el.name || el.getAttribute('aria-label') || el.placeholder || el.type || el.tagName.toLowerCase();
            const key = (id || name || '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
            if (!key) continue;
            if (id) selectors[key] = '#' + id;
            else if (el.name) selectors[key] = '[name="' + el.name + '"]';
            else if (el.getAttribute('aria-label')) selectors[key] = '[aria-label="' + el.getAttribute('aria-label') + '"]';
          }
          return { match: true, url, selectors };
        })()`,
        returnByValue: true,
      });
      await client.close();
      if (scanResult.result.value?.match) {
        pageSelectors = scanResult.result.value.selectors || {};
      }
    } catch {
      // No browser or wrong page — skip selector scan
    }
  }

  // 3. Build playbook JSON
  const playbook = {
    platform: platform.toLowerCase(),
    version: "1.0.0",
    updated: new Date().toISOString().slice(0, 10),
    description: description || `Automation playbook for ${platform}`,
    urls: Object.fromEntries(
      Array.from(urlSet).sort().map((u, i) => {
        const urlObj = new URL(u);
        const pathKey = urlObj.pathname.replace(/^\//, "").replace(/\//g, "_").replace(/[^a-zA-Z0-9_]/g, "") || "home";
        return [pathKey, u];
      })
    ),
    flows: {
      discovered: {
        steps: domainStrategies.length > 0
          ? domainStrategies[0]!.steps.map((s: any) => `${s.tool}(${JSON.stringify(s.params)})`)
          : ["No strategies recorded yet. Use the platform, then call export_playbook again."],
        selectors: pageSelectors,
      },
    },
    detection: {
      is_logged_in: "// Add detection JS for logged-in state",
    },
    errors: domainErrors.map(e => ({
      error: e.error,
      context: `Tool: ${e.tool} (${e.occurrences}x)`,
      solution: e.resolution || "No resolution recorded yet. Fix it and call memory_save.",
      severity: e.occurrences >= 3 ? "high" : "medium",
    })),
    _meta: {
      exported_from: "screenhand",
      actions_count: actions.filter(a => {
        const p = a.params as Record<string, any> || {};
        return typeof p.url === "string" && p.url.toLowerCase().includes(domainLower);
      }).length,
      strategies_count: domainStrategies.length,
    },
  };

  // 4. Save to playbooks dir
  const outPath = path.resolve(playbooksDir, `${platform.toLowerCase()}.json`);
  const exists = fs.existsSync(outPath);

  if (!fs.existsSync(playbooksDir)) fs.mkdirSync(playbooksDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(playbook, null, 2));

  return {
    content: [{
      type: "text",
      text: `${exists ? "Updated" : "Created"} playbook: playbooks/${platform.toLowerCase()}.json\n\n` +
        `URLs found: ${urlSet.size}\n` +
        `Selectors found: ${Object.keys(pageSelectors).length}\n` +
        `Errors documented: ${domainErrors.length}\n` +
        `Strategies: ${domainStrategies.length}\n\n` +
        `Share this file to help others automate ${platform}.\n\n` +
        JSON.stringify(playbook, null, 2),
    }],
  };
});

// ═══════════════════════════════════════════════
// APPLESCRIPT — control scriptable apps directly
// ═══════════════════════════════════════════════

server.tool("applescript", "Run an AppleScript command. For controlling Finder, Safari, Mail, Notes, etc. (macOS only). WARNING: Executes arbitrary AppleScript — can perform destructive actions (delete files, send emails). All executions are audit-logged.", {
  script: z.string().describe("AppleScript code to execute"),
}, async ({ script }) => {
  auditLog("applescript", { script: script.slice(0, 500) });
  if (process.platform === "win32") {
    return { content: [{ type: "text", text: "AppleScript is not supported on Windows. Use ui_tree, ui_press, and other accessibility tools instead." }] };
  }
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    return { content: [{ type: "text", text: result || "(no output)" }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: "Error: " + (e.stderr || e.message) }] };
  }
});

// ═══════════════════════════════════════════════
// MEMORY — recall past strategies and error patterns
// ═══════════════════════════════════════════════

originalTool("memory_snapshot", "Get current memory state snapshot — session info, mission, health metrics, known patterns, and policy.", {}, async () => {
  const snap = memory.getSnapshot();
  return { content: [{ type: "text" as const, text: JSON.stringify(snap, null, 2) }] };
});

originalTool("memory_recall", "Have I done something like this before? Searches past successful strategies by keyword similarity.", {
  task: z.string().describe("Describe the task you want to accomplish"),
  limit: z.number().optional().describe("Max results (default 5)"),
}, async ({ task, limit }) => {
  const matches = memory.recallStrategies(task, limit ?? 5);
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching strategies found. Try memory_save after completing a task to build up knowledge." }] };
  }
  const text = matches.map((m, i) => {
    const steps = m.steps.map((s, j) => `  ${j + 1}. ${s.tool}(${JSON.stringify(s.params)})`).join("\n");
    return `${i + 1}. "${m.task}" (used ${m.successCount}x, score: ${m.score.toFixed(2)})\n${steps}`;
  }).join("\n\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_save", "This approach worked — remember it. Saves the current session's action sequence as a reusable strategy.", {
  task: z.string().describe("Short description of the task that was accomplished"),
  tags: z.array(z.string()).optional().describe("Optional tags for easier recall"),
}, async ({ task, tags }) => {
  const strategy = memory.saveStrategy(task, tags);
  if (!strategy) {
    return { content: [{ type: "text" as const, text: "No actions recorded in the current session. Perform some tool calls first, then save." }] };
  }
  return { content: [{ type: "text" as const, text: `Saved strategy "${task}" with ${strategy.steps.length} steps. Tags: ${strategy.tags.join(", ")}` }] };
});

originalTool("memory_record_error", "Record a known error pattern with an optional fix. Helps future sessions avoid the same problem.", {
  tool: z.string().describe("Tool that failed"),
  error: z.string().describe("Error message or description"),
  fix: z.string().optional().describe("How to fix or work around this error"),
  scope: z.string().optional().describe("Scope of the error (e.g., 'chrome/github.com', 'vscode/terminal')"),
}, async ({ tool, error, fix, scope }) => {
  memory.recordError(tool, error, fix ?? null, scope);
  return { content: [{ type: "text" as const, text: `Error pattern recorded for "${tool}": "${error}"${fix ? `\nFix: ${fix}` : ""}` }] };
});

originalTool("memory_record_learning", "Record a verified pattern — what works, what fails, and how to fix it. Builds the knowledge base for future sessions.", {
  scope: z.string().describe("Scope (e.g., 'chrome/github.com', 'slack/desktop', 'vscode/terminal')"),
  pattern: z.string().describe("What worked or failed"),
  method: z.enum(["ax", "cdp", "ocr", "coordinates"]).describe("Which execution method was used"),
  confidence: z.number().min(0).max(1).describe("Confidence level 0-1"),
  success: z.boolean().describe("Was this a success or failure?"),
  fix: z.string().optional().describe("Fix or workaround if it was a failure"),
}, async ({ scope, pattern, method, confidence, success, fix }) => {
  memory.recordLearning({
    scope,
    pattern,
    method,
    confidence,
    successCount: success ? 1 : 0,
    failCount: success ? 0 : 1,
    lastSeen: new Date().toISOString(),
    fix: fix ?? null,
  });
  return { content: [{ type: "text" as const, text: `Learning recorded: ${scope} — "${pattern}" (${method}, confidence=${confidence})` }] };
});

originalTool("memory_query_patterns", "Search verified learnings by scope and/or execution method.", {
  scope: z.string().optional().describe("Filter by scope (e.g., 'chrome', 'vscode')"),
  method: z.enum(["ax", "cdp", "ocr", "coordinates"]).optional().describe("Filter by execution method"),
}, async ({ scope, method }) => {
  const patterns = memory.queryPatterns(scope, method);
  if (patterns.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching patterns found." }] };
  }
  const text = patterns.map((p, i) =>
    `${i + 1}. [${p.method}] ${p.scope}: "${p.pattern}" (confidence=${p.confidence.toFixed(2)}, ${p.successCount}✓ ${p.failCount}✗)${p.fix ? `\n   Fix: ${p.fix}` : ""}`
  ).join("\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_errors", "What goes wrong with this tool? Shows known error patterns and resolutions.", {
  tool: z.string().optional().describe("Tool name to filter by (omit for all errors)"),
}, async ({ tool }) => {
  const errors = memory.queryErrors(tool);
  if (errors.length === 0) {
    return { content: [{ type: "text" as const, text: tool ? `No known error patterns for "${tool}".` : "No error patterns recorded yet." }] };
  }
  const text = errors.map((e, i) =>
    `${i + 1}. ${e.tool}: "${e.error}" (${e.occurrences}x)${e.resolution ? `\n   Fix: ${e.resolution}` : ""}`
  ).join("\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_stats", "How much have I learned? Shows total actions, strategies, error patterns, and success rates.", {}, async () => {
  const stats = memory.getStats();
  const lines = [
    `Actions logged: ${stats.totalActions}`,
    `Strategies saved: ${stats.totalStrategies}`,
    `Error patterns: ${stats.totalErrors}`,
    `Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
    `Disk usage: ${(stats.diskUsageBytes / 1024).toFixed(1)} KB`,
  ];
  if (stats.topTools.length > 0) {
    lines.push("", "Top tools:");
    for (const t of stats.topTools) {
      lines.push(`  ${t.tool}: ${t.count} calls`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("memory_clear", "Forget everything or just a specific category. Clears stored memory data.", {
  what: z.enum(["all", "actions", "strategies", "errors", "learnings"]).describe("What to clear"),
}, async ({ what }) => {
  memory.clear(what);
  return { content: [{ type: "text" as const, text: `Cleared ${what === "all" ? "all memory data" : what}.` }] };
});

// ═══════════════════════════════════════════════
// SESSION SUPERVISOR — lease management, stall detection, recovery
// ═══════════════════════════════════════════════

originalTool("session_claim", "Claim exclusive control of an app window. Prevents other clients from acting on the same window.", {
  clientId: z.string().describe("Your client identifier (e.g., 'claude_abc123')"),
  clientType: z.enum(["claude", "codex", "cursor", "openclaw"]).describe("Client type"),
  app: z.string().describe("Bundle ID of the app (e.g., 'com.google.Chrome')"),
  windowId: z.number().describe("Window ID to claim (get from 'windows' tool)"),
}, async ({ clientId, clientType, app, windowId }) => {
  // Use filesystem-backed lease manager directly (shared with daemon)
  const lease = leaseManager.claim(
    { id: clientId, type: clientType, startedAt: new Date().toISOString() },
    app, windowId,
  );
  if (!lease) {
    const existing = leaseManager.isLocked(app, windowId);
    return { content: [{ type: "text" as const, text: `Window already claimed by ${existing?.client.type ?? "unknown"} (session=${existing?.sessionId}). Release it first or wait for expiry.` }] };
  }
  return { content: [{ type: "text" as const, text: `Session claimed!\nSession ID: ${lease.sessionId}\nApp: ${app}\nWindow: ${windowId}\nExpires: ${lease.expiresAt}\n\nCall session_heartbeat every 60s to keep the lease alive.` }] };
});

originalTool("session_heartbeat", "Keep your session lease alive. Call every 60 seconds. Lease expires after 5 minutes without heartbeat.", {
  sessionId: z.string().describe("Session ID from session_claim"),
}, async ({ sessionId }) => {
  // Use filesystem-backed lease manager directly (shared with daemon)
  const ok = leaseManager.heartbeat(sessionId);
  if (!ok) {
    return { content: [{ type: "text" as const, text: `Session ${sessionId} not found or expired. Re-claim with session_claim.` }] };
  }
  return { content: [{ type: "text" as const, text: `Heartbeat OK for ${sessionId}.` }] };
});

originalTool("session_release", "Release your session lease so other clients can use the window.", {
  sessionId: z.string().describe("Session ID to release"),
}, async ({ sessionId }) => {
  // Use filesystem-backed lease manager directly (shared with daemon)
  const released = leaseManager.release(sessionId);
  return { content: [{ type: "text" as const, text: released ? `Session ${sessionId} released.` : `Session ${sessionId} not found.` }] };
});

originalTool("supervisor_status", "Get supervisor state — active sessions, health metrics, stall detection.", {
  tail_log: z.number().optional().describe("Show last N lines of supervisor log (default: 0, max: 50)"),
}, async ({ tail_log }) => {
  const { running: daemonRunning, pid: daemonPid } = isSupervisorDaemonRunning();

  // Always read active sessions from the shared filesystem lock dir (source of truth)
  const activeSessions = leaseManager.getActive();

  // Read daemon health counters if available, otherwise show minimal info
  let health = { uptimeMs: 0, totalSessions: 0, expiredLeases: 0, stallsDetected: 0, recoveriesAttempted: 0 };
  if (daemonRunning && fs.existsSync(SUPERVISOR_STATE_FILE)) {
    try {
      const daemonState = JSON.parse(fs.readFileSync(SUPERVISOR_STATE_FILE, "utf-8"));
      health = daemonState.health ?? health;
    } catch { /* use defaults */ }
  }

  const lines = [
    `Supervisor: ${daemonRunning ? "DAEMON RUNNING" : "STOPPED"} (pid=${daemonPid ?? "n/a"})`,
    `Active sessions: ${activeSessions.length} (from lock files)`,
  ];
  if (daemonRunning) {
    lines.push(
      `Uptime: ${Math.round(health.uptimeMs / 60000)}m`,
      `Expired leases: ${health.expiredLeases}`,
      `Stalls detected: ${health.stallsDetected}`,
      `Recoveries attempted: ${health.recoveriesAttempted}`,
    );
  }
  if (activeSessions.length > 0) {
    lines.push("", "Active sessions:");
    for (const s of activeSessions) {
      lines.push(`  ${s.sessionId}: ${s.client.type} → ${s.app} (window=${s.windowId}, heartbeat=${s.lastHeartbeat})`);
    }
  }

  if (tail_log && tail_log > 0) {
    try {
      const logContent = fs.readFileSync(SUPERVISOR_LOG_FILE, "utf-8");
      const logLines = logContent.trim().split("\n").slice(-Math.min(tail_log, 50));
      lines.push("", "--- Supervisor Log ---");
      lines.push(logLines.join("\n"));
    } catch {
      lines.push("\n(no log file found)");
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

const SUPERVISOR_DIR = path.join(os.homedir(), ".screenhand", "supervisor");
const SUPERVISOR_PID_FILE = path.join(SUPERVISOR_DIR, "supervisor.pid");
const SUPERVISOR_STATE_FILE = path.join(SUPERVISOR_DIR, "state.json");
const SUPERVISOR_LOG_FILE = path.join(SUPERVISOR_DIR, "supervisor.log");
const SUPERVISOR_RECOVERIES_FILE = path.join(SUPERVISOR_DIR, "recoveries.json");
const SUPERVISOR_DAEMON_SCRIPT = path.resolve(__dirname, "scripts", "supervisor-daemon.ts");

/** Read recoveries from daemon's filesystem state (with corrupt-file recovery). */
function readDaemonRecoveries(): RecoveryAction[] {
  return readJsonWithRecovery<RecoveryAction[]>(SUPERVISOR_RECOVERIES_FILE) ?? [];
}

/** Write recoveries atomically to daemon's filesystem state. */
function writeDaemonRecoveries(recoveries: RecoveryAction[]): void {
  fs.mkdirSync(SUPERVISOR_DIR, { recursive: true });
  writeFileAtomicSync(SUPERVISOR_RECOVERIES_FILE, JSON.stringify(recoveries, null, 2));
}

function isSupervisorDaemonRunning(): { running: boolean; pid: number | null } {
  try {
    if (!fs.existsSync(SUPERVISOR_PID_FILE)) return { running: false, pid: null };
    const pid = Number(fs.readFileSync(SUPERVISOR_PID_FILE, "utf-8").trim());
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

originalTool("supervisor_start", "Start the supervisor as a background daemon. Survives Claude Code restarts. Monitors sessions, detects stalls, executes recovery actions via native bridge.", {
  pollMs: z.number().optional().describe("Poll interval in ms (default: 5000)"),
  stallMs: z.number().optional().describe("Stall threshold in ms (default: 300000 = 5 min)"),
  dryRun: z.boolean().optional().describe("Log recovery actions without executing them (default: false)"),
}, async ({ pollMs, stallMs, dryRun }) => {
  const { running, pid } = isSupervisorDaemonRunning();
  if (running) {
    return { content: [{ type: "text" as const, text: `Supervisor daemon already running (pid=${pid}). Use supervisor_stop first.` }] };
  }

  // Try compiled JS first (reliable), fall back to tsx (dev mode)
  // When running from dist/, the script is a sibling: dist/scripts/supervisor-daemon.js
  // When running from source via tsx, it's at dist/scripts/supervisor-daemon.js relative to project root
  const compiledPath = fs.existsSync(path.resolve(__dirname, "scripts", "supervisor-daemon.js"))
    ? path.resolve(__dirname, "scripts", "supervisor-daemon.js")               // running from dist/
    : path.resolve(__dirname, "dist", "scripts", "supervisor-daemon.js");      // running from source

  let child;
  let usedCompiled = false;
  if (fs.existsSync(compiledPath)) {
    const nodeArgs = [compiledPath];
    if (pollMs) nodeArgs.push("--poll", String(pollMs));
    if (stallMs) nodeArgs.push("--stall", String(stallMs));
    if (dryRun) nodeArgs.push("--dry-run");

    child = spawn("node", nodeArgs, {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
    });
    usedCompiled = true;
  } else {
    const daemonArgs = ["tsx", SUPERVISOR_DAEMON_SCRIPT];
    if (pollMs) daemonArgs.push("--poll", String(pollMs));
    if (stallMs) daemonArgs.push("--stall", String(stallMs));
    if (dryRun) daemonArgs.push("--dry-run");

    child = spawn("npx", daemonArgs, {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
    });
  }
  child.unref();

  const daemonPid = child.pid;

  // Wait briefly, then verify the daemon actually started by checking PID file
  await new Promise((r) => setTimeout(r, 2000));

  const verify = isSupervisorDaemonRunning();
  if (!verify.running) {
    return { content: [{ type: "text" as const, text: `Supervisor daemon failed to start (spawned pid=${daemonPid}, mode=${usedCompiled ? "compiled" : "tsx"}).\nCheck log: ${SUPERVISOR_LOG_FILE}\n\nIf running in a restricted environment, ensure 'npx tsx' or 'node' can spawn processes.\nYou can also run the daemon manually: npx tsx scripts/supervisor-daemon.ts` }] };
  }

  const dryNote = dryRun ? "\n⚠️  DRY RUN mode — recovery actions are logged but not executed." : "";
  return { content: [{ type: "text" as const, text: `Supervisor daemon started (pid=${verify.pid}, mode=${usedCompiled ? "compiled" : "tsx"}).\nPoll: ${pollMs ?? 5000}ms | Stall threshold: ${stallMs ?? 300000}ms\nLog: ${SUPERVISOR_LOG_FILE}${dryNote}\n\nThe daemon runs independently — survives Claude Code restarts.\nUse supervisor_status to check health.` }] };
});

originalTool("supervisor_stop", "Stop the supervisor background daemon.", {}, async () => {
  const { running, pid } = isSupervisorDaemonRunning();
  if (!running) {
    // Also stop in-process supervisor if it was started
    await supervisor.stop();
    return { content: [{ type: "text" as const, text: "No supervisor daemon running." }] };
  }
  try {
    process.kill(pid!, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    return { content: [{ type: "text" as const, text: `Supervisor daemon stopped (pid=${pid}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Failed to stop: ${err.message}` }] };
  }
});

originalTool("supervisor_pause", "Pause all automation — keeps leases but signals clients to stop acting.", {
  reason: z.string().optional().describe("Why automation is being paused"),
}, async ({ reason }) => {
  // Read active sessions from shared filesystem lock dir (source of truth)
  const sessions = leaseManager.getActive();

  // Add escalation recovery to daemon's filesystem state
  const recoveries = readDaemonRecoveries();
  for (const s of sessions) {
    recoveries.push({
      id: "recv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      sessionId: s.sessionId,
      type: "escalate",
      instruction: reason ?? "Automation paused by operator.",
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptedAt: null,
      result: null,
    });
  }
  writeDaemonRecoveries(recoveries);

  return { content: [{ type: "text" as const, text: `Paused. ${sessions.length} session(s) notified. Leases held — call supervisor_resume to continue.` }] };
});

originalTool("supervisor_resume", "Resume automation after a pause.", {}, async () => {
  // Clear pending escalation recoveries from daemon's filesystem state
  const recoveries = readDaemonRecoveries();
  let cleared = 0;
  for (const r of recoveries) {
    if (r.type === "escalate" && r.status === "pending") {
      r.status = "succeeded";
      r.result = "Resumed by operator.";
      cleared++;
    }
  }
  writeDaemonRecoveries(recoveries);
  return { content: [{ type: "text" as const, text: `Resumed. ${cleared} pause escalation(s) cleared. Clients can continue.` }] };
});

originalTool("recovery_queue_add", "Add a manual recovery instruction for a stalled session.", {
  sessionId: z.string().describe("Session ID that needs recovery"),
  type: z.enum(["nudge", "restart", "escalate", "custom"]).describe("Recovery type"),
  instruction: z.string().describe("What to do (e.g., 'Click the login button', 'Restart Chrome')"),
}, async ({ sessionId, type, instruction }) => {
  const recovery: RecoveryAction = {
    id: "recv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    sessionId,
    type,
    instruction,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptedAt: null,
    result: null,
  };

  // Write to daemon's filesystem state so the daemon picks it up
  const recoveries = readDaemonRecoveries();
  recoveries.push(recovery);
  writeDaemonRecoveries(recoveries);

  return { content: [{ type: "text" as const, text: `Recovery queued: ${recovery.id} (type=${type})` }] };
});

originalTool("recovery_queue_list", "List recovery actions, optionally filtered by status.", {
  status: z.enum(["pending", "attempted", "succeeded", "failed"]).optional().describe("Filter by status"),
}, async ({ status }) => {
  // Read from daemon's filesystem state
  let recoveries = readDaemonRecoveries();
  if (status) {
    recoveries = recoveries.filter((r) => r.status === status);
  }
  if (recoveries.length === 0) {
    return { content: [{ type: "text" as const, text: `No ${status ?? ""} recovery actions.` }] };
  }
  const text = recoveries.map((r, i) =>
    `${i + 1}. [${r.status.toUpperCase()}] ${r.type}: "${r.instruction.slice(0, 80)}"\n   Session: ${r.sessionId} | Created: ${r.createdAt}${r.result ? `\n   Result: ${r.result}` : ""}`
  ).join("\n\n");
  return { content: [{ type: "text" as const, text }] };
});

// ── Service install / auto-start (launchd on macOS) ──

const LAUNCHD_LABEL = "com.screenhand.supervisor";
const LAUNCHD_PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function findNodeBinary(): string {
  // Prefer the node that's running us — guaranteed to exist
  return process.execPath;
}

function findDaemonScript(): string | null {
  // compiled JS in dist/
  const fromDist = path.resolve(__dirname, "scripts", "supervisor-daemon.js");
  if (fs.existsSync(fromDist)) return fromDist;
  // running from source root
  const fromRoot = path.resolve(__dirname, "dist", "scripts", "supervisor-daemon.js");
  if (fs.existsSync(fromRoot)) return fromRoot;
  return null;
}

function generatePlist(nodeBin: string, daemonScript: string, opts: { pollMs?: number | undefined; stallMs?: number | undefined }): string {
  const args = [nodeBin, daemonScript];
  if (opts.pollMs) args.push("--poll", String(opts.pollMs));
  if (opts.stallMs) args.push("--stall", String(opts.stallMs));

  const programArgs = args.map((a) => `      <string>${a}</string>`).join("\n");

  // Inherit PATH so native bridge binary and node can be found
  const envPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>WorkingDirectory</key>
    <string>${path.dirname(daemonScript).replace(/\/dist\/scripts$/, "").replace(/\/dist$/, "")}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${SUPERVISOR_DIR}/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${SUPERVISOR_DIR}/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
    </dict>
</dict>
</plist>
`;
}

function isServiceInstalled(): boolean {
  return fs.existsSync(LAUNCHD_PLIST_PATH);
}

originalTool("supervisor_install", "Install the supervisor as a system service (launchd on macOS). Starts automatically on login and restarts on crash.", {
  pollMs: z.number().optional().describe("Poll interval in ms (default: 5000)"),
  stallMs: z.number().optional().describe("Stall threshold in ms (default: 300000 = 5 min)"),
}, async ({ pollMs, stallMs }) => {
  if (process.platform !== "darwin") {
    return { content: [{ type: "text" as const, text: "Service install is currently macOS-only (launchd). Windows Task Scheduler support coming soon." }] };
  }

  const daemonScript = findDaemonScript();
  if (!daemonScript) {
    return { content: [{ type: "text" as const, text: "Cannot find compiled daemon script. Run `npx tsc` first to build dist/scripts/supervisor-daemon.js." }] };
  }

  const nodeBin = findNodeBinary();

  // Stop existing daemon if running (will be managed by launchd now)
  const { running, pid } = isSupervisorDaemonRunning();
  if (running && pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Unload existing plist if present
  if (isServiceInstalled()) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("launchctl", ["unload", LAUNCHD_PLIST_PATH], { stdio: "ignore" });
    } catch { /* ignore */ }
  }

  // Write plist
  const plist = generatePlist(nodeBin, daemonScript, { pollMs, stallMs });
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plist);

  // Load the service
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("launchctl", ["load", LAUNCHD_PLIST_PATH]);
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Plist written to ${LAUNCHD_PLIST_PATH} but launchctl load failed: ${err.message}\nTry manually: launchctl load "${LAUNCHD_PLIST_PATH}"` }] };
  }

  // Verify it started
  await new Promise((r) => setTimeout(r, 2000));
  const verify = isSupervisorDaemonRunning();

  const lines = [
    `Service installed and loaded.`,
    `  Plist: ${LAUNCHD_PLIST_PATH}`,
    `  Node: ${nodeBin}`,
    `  Script: ${daemonScript}`,
    `  Poll: ${pollMs ?? 5000}ms | Stall: ${stallMs ?? 300000}ms`,
    `  Status: ${verify.running ? `running (pid=${verify.pid})` : "starting..."}`,
    ``,
    `The supervisor will:`,
    `  - Start automatically on login`,
    `  - Restart automatically if it crashes`,
    `  - Survive reboots`,
    ``,
    `Use supervisor_uninstall to remove.`,
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("supervisor_uninstall", "Uninstall the supervisor system service. Stops the daemon and removes the launchd plist.", {}, async () => {
  if (process.platform !== "darwin") {
    return { content: [{ type: "text" as const, text: "Service uninstall is currently macOS-only." }] };
  }

  if (!isServiceInstalled()) {
    return { content: [{ type: "text" as const, text: "No service installed (no plist at " + LAUNCHD_PLIST_PATH + ")." }] };
  }

  // Unload the service (stops the daemon)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
  } catch { /* ignore — may already be unloaded */ }

  // Remove plist
  try {
    fs.unlinkSync(LAUNCHD_PLIST_PATH);
  } catch { /* ignore */ }

  // Clean up PID file
  try {
    fs.unlinkSync(SUPERVISOR_PID_FILE);
  } catch { /* ignore */ }

  return { content: [{ type: "text" as const, text: `Service uninstalled.\n  Removed: ${LAUNCHD_PLIST_PATH}\n  Daemon stopped.\n\nState files in ~/.screenhand/ are preserved (logs, leases, recoveries).` }] };
});

// ═══════════════════════════════════════════════
// EXECUTION CONTRACT — canonical fallback chain
// ═══════════════════════════════════════════════

import {
  EXECUTION_METHODS,
  METHOD_CAPABILITIES,
  DEFAULT_RETRY_POLICY,
  planExecution,
  executeWithFallback,
} from "./src/runtime/execution-contract.js";
import type { ExecutionMethod, ActionResult } from "./src/runtime/execution-contract.js";

originalTool("execution_plan", "Show the execution plan for an action type. Returns the ordered fallback chain based on available infrastructure.", {
  action: z.enum(["click", "type", "read", "locate", "select", "scroll"]).describe("Action type"),
}, async ({ action }) => {
  const plan = planExecution(action, { hasBridge: true, hasCDP: cdpPort !== null });
  const lines = plan.map((method, i) => {
    const cap = METHOD_CAPABILITIES[method];
    return `${i + 1}. ${method} (~${cap.avgLatencyMs}ms)${i === 0 ? " ← primary" : ""}`;
  });
  lines.push("", `Retry policy: ${DEFAULT_RETRY_POLICY.maxRetriesPerMethod}/method, ${DEFAULT_RETRY_POLICY.maxTotalRetries} total, escalate after ${DEFAULT_RETRY_POLICY.escalateAfter}`);
  return { content: [{ type: "text" as const, text: `Execution plan for "${action}":\n${lines.join("\n")}` }] };
});

// ── Shared helpers for resilient action tools ──

async function resolvePid(bundleId?: string | undefined): Promise<number> {
  let pid = 0;
  if (bundleId) {
    try {
      const appInfo = await bridge.call<{ pid: number }>("app.focus", { bundleId });
      pid = appInfo.pid ?? 0;
    } catch { /* fall through */ }
  }
  if (pid === 0) {
    try {
      const front = await bridge.call<{ pid: number }>("app.frontmost", {});
      pid = front.pid;
    } catch { /* caller will handle pid=0 */ }
  }
  return pid;
}

function infra() {
  return { hasBridge: true, hasCDP: cdpPort !== null };
}

function formatResult(action: string, target: string, result: ActionResult): { content: Array<{ type: "text"; text: string }> } {
  if (result.ok) {
    const fallbackNote = result.fallbackFrom ? ` (fell back from ${result.fallbackFrom})` : "";
    return { content: [{ type: "text" as const, text: `${action} "${result.target ?? target}" via ${result.method}${fallbackNote} in ${result.durationMs}ms` }] };
  }
  return { content: [{ type: "text" as const, text: `Failed to ${action} "${target}" — all methods exhausted. Last error: ${result.error}` }] };
}

// ── click_with_fallback ──

originalTool("click_with_fallback", "Click a target by text using the canonical fallback chain: AX → CDP → OCR. Automatically retries and falls through methods.", {
  target: z.string().describe("Text, title, or identifier of the element to click"),
  bundleId: z.string().optional().describe("App bundle ID (for AX path)"),
}, async ({ target, bundleId }) => {
  await ensureBridge();

  const plan = planExecution("click", infra())
    .filter((m) => m !== "coordinates");

  const targetPid = await resolvePid(bundleId);

  const result = await executeWithFallback("click", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // Find element by title, then perform AXPress action
          const found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
            pid: targetPid,
            title: target,
            exact: false,
          });
          await bridge.call("ax.performAction", {
            pid: targetPid,
            elementPath: found.elementPath,
            action: "AXPress",
          });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            const evalResult = await Runtime.evaluate({
              expression: `(() => {
                const el = Array.from(document.querySelectorAll('*')).find(e =>
                  e.textContent?.trim() === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)}
                );
                if (el) { el.click(); return 'clicked'; }
                return null;
              })()`,
              returnByValue: true,
            });
            if (evalResult.result?.value === "clicked") {
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
            }
            throw new Error("Element not found via CDP");
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          // Capture screen, find text via vision.findText, click at center of bounds
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
            imagePath: shot.path,
            searchText: target,
          });
          const match = Array.isArray(matches) ? matches[0] : null;
          if (match && match.bounds) {
            const x = match.bounds.x + match.bounds.width / 2;
            const y = match.bounds.y + match.bounds.height / 2;
            await bridge.call("cg.mouseClick", { x, y });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${Math.round(x)},${Math.round(y)})` };
          }
          throw new Error("Target not found via OCR");
        }
      }
      throw new Error(`Unknown method: ${method}`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target };
    }
  });

  return formatResult("Clicked", target, result);
});

// ── type_with_fallback ──

originalTool("type_with_fallback", "Type text into a target field using the canonical fallback chain: AX → CDP → coordinates. Finds the field by label/placeholder, focuses it, then types.", {
  target: z.string().describe("Label, placeholder, or title of the field to type into"),
  text: z.string().describe("Text to type"),
  bundleId: z.string().optional().describe("App bundle ID"),
  clearFirst: z.boolean().optional().describe("Select-all and clear the field before typing (default: false)"),
}, async ({ target, text, bundleId, clearFirst }) => {
  await ensureBridge();

  const plan = planExecution("type", infra());
  const targetPid = await resolvePid(bundleId);

  const result = await executeWithFallback("type", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          const found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
            pid: targetPid,
            title: target,
            exact: false,
          });
          if (clearFirst) {
            await bridge.call("ax.setElementValue", { pid: targetPid, elementPath: found.elementPath, value: "" });
          }
          await bridge.call("ax.setElementValue", { pid: targetPid, elementPath: found.elementPath, value: text });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime, DOM, Input } = client;
            const evalResult = await Runtime.evaluate({
              expression: `(() => {
                const el = Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).find(e =>
                  e.getAttribute('placeholder') === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                  e.getAttribute('name') === ${JSON.stringify(target)} ||
                  (e.labels && Array.from(e.labels).some(l => l.textContent?.trim() === ${JSON.stringify(target)}))
                );
                if (el) { el.focus(); return true; }
                return false;
              })()`,
              returnByValue: true,
            });
            if (!evalResult.result?.value) throw new Error("Field not found via CDP");
            if (clearFirst) {
              await Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
              await Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
            }
            for (const char of text) {
              await Input.dispatchKeyEvent({ type: "keyDown", key: char, text: char });
              await Input.dispatchKeyEvent({ type: "keyUp", key: char });
            }
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
          } finally {
            await client.close();
          }
        }
      }
      throw new Error(`Method ${method} does not support type`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target };
    }
  });

  return formatResult("Typed into", target, result);
});

// ── read_with_fallback ──

originalTool("read_with_fallback", "Read text content from the screen or a specific element using the canonical fallback chain: AX → CDP → OCR. Returns the text found.", {
  target: z.string().optional().describe("Element label/title to read from (omit for full-screen OCR)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, bundleId }) => {
  await ensureBridge();

  const plan = planExecution("read", infra());
  const targetPid = await resolvePid(bundleId);

  const result = await executeWithFallback("read", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          if (target) {
            const found = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: false,
            });
            const val = await bridge.call<{ value: string }>("ax.getElementValue", {
              pid: targetPid,
              elementPath: found.elementPath,
            });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: val.value ?? "" };
          }
          // No specific target — get the full element tree text
          const tree = await bridge.call<{ description: string }>("ax.getElementTree", {
            pid: targetPid,
            maxDepth: 4,
          });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: tree.description ?? JSON.stringify(tree).slice(0, 2000) };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            if (target) {
              const evalResult = await Runtime.evaluate({
                expression: `(() => {
                  const el = Array.from(document.querySelectorAll('*')).find(e =>
                    e.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                    e.textContent?.trim() === ${JSON.stringify(target)}
                  );
                  return el ? (el.value ?? el.textContent ?? '').trim() : null;
                })()`,
                returnByValue: true,
              });
              if (evalResult.result?.value == null) throw new Error("Element not found via CDP");
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result.value) };
            }
            // Full page text
            const evalResult = await Runtime.evaluate({
              expression: "document.body?.innerText?.slice(0, 4000) ?? ''",
              returnByValue: true,
            });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result?.value ?? "") };
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          if (target) {
            const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
              imagePath: shot.path,
              searchText: target,
            });
            const match = Array.isArray(matches) ? matches[0] : null;
            if (!match) throw new Error("Text not found via OCR");
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: match.text };
          }
          const ocr = await bridge.call<{ text: string }>("vision.ocr", { imagePath: shot.path });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: ocr.text?.slice(0, 4000) ?? "" };
        }
      }
      throw new Error(`Method ${method} does not support read`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  if (result.ok) {
    const fallbackNote = result.fallbackFrom ? ` (fell back from ${result.fallbackFrom})` : "";
    return { content: [{ type: "text" as const, text: `Read via ${result.method}${fallbackNote} in ${result.durationMs}ms:\n\n${result.target}` }] };
  }
  return { content: [{ type: "text" as const, text: `Failed to read${target ? ` "${target}"` : ""} — all methods exhausted. Last error: ${result.error}` }] };
});

// ── locate_with_fallback ──

originalTool("locate_with_fallback", "Find an element's position on screen using the canonical fallback chain: AX → CDP → OCR. Returns bounds (x, y, width, height).", {
  target: z.string().describe("Text, title, or identifier of the element to locate"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, bundleId }) => {
  await ensureBridge();

  const plan = planExecution("locate", infra());
  const targetPid = await resolvePid(bundleId);

  const result = await executeWithFallback("locate", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          const found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
            pid: targetPid,
            title: target,
            exact: false,
          });
          if (!found.bounds) throw new Error("Element found but has no bounds");
          const b = found.bounds;
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${b.x},${b.y} ${b.width}x${b.height})` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            const evalResult = await Runtime.evaluate({
              expression: `(() => {
                const el = Array.from(document.querySelectorAll('*')).find(e =>
                  e.textContent?.trim() === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)}
                );
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
              })()`,
              returnByValue: true,
            });
            const bounds = evalResult.result?.value;
            if (!bounds) throw new Error("Element not found via CDP");
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})` };
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
            imagePath: shot.path,
            searchText: target,
          });
          const match = Array.isArray(matches) ? matches[0] : null;
          if (!match?.bounds) throw new Error("Target not found via OCR");
          const b = match.bounds;
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${b.x},${b.y} ${b.width}x${b.height})` };
        }
      }
      throw new Error(`Method ${method} does not support locate`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Located", target, result);
});

// ── select_with_fallback ──

originalTool("select_with_fallback", "Select an option from a dropdown/menu using the canonical fallback chain: AX → CDP. Finds the control, opens it, and picks the specified option.", {
  target: z.string().describe("Label or title of the dropdown/menu control"),
  option: z.string().describe("Text of the option to select"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, option, bundleId }) => {
  await ensureBridge();

  const plan = planExecution("select", infra());
  const targetPid = await resolvePid(bundleId);

  const result = await executeWithFallback("select", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // Find the popup button / combo box by title
          const found = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
            pid: targetPid,
            title: target,
            exact: false,
          });
          // Press to open the menu
          await bridge.call("ax.performAction", { pid: targetPid, elementPath: found.elementPath, action: "AXPress" });
          await new Promise((r) => setTimeout(r, 300));
          // Now find the menu item by title
          const menuItem = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
            pid: targetPid,
            title: option,
            exact: false,
          });
          await bridge.call("ax.performAction", { pid: targetPid, elementPath: menuItem.elementPath, action: "AXPress" });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} → ${option}` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            const evalResult = await Runtime.evaluate({
              expression: `(() => {
                const sel = Array.from(document.querySelectorAll('select')).find(s =>
                  s.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                  s.getAttribute('name') === ${JSON.stringify(target)} ||
                  (s.labels && Array.from(s.labels).some(l => l.textContent?.trim() === ${JSON.stringify(target)}))
                );
                if (!sel) return null;
                const opt = Array.from(sel.options).find(o => o.text.trim() === ${JSON.stringify(option)} || o.value === ${JSON.stringify(option)});
                if (!opt) return 'no_option';
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return 'selected';
              })()`,
              returnByValue: true,
            });
            if (evalResult.result?.value === "selected") {
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} → ${option}` };
            }
            if (evalResult.result?.value === "no_option") throw new Error(`Option "${option}" not found in select`);
            throw new Error("Select element not found via CDP");
          } finally {
            await client.close();
          }
        }
      }
      throw new Error(`Method ${method} does not support select`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Selected", `${target} → ${option}`, result);
});

// ── scroll_with_fallback ──

originalTool("scroll_with_fallback", "Scroll within an element or the active window using the canonical fallback chain: AX → CDP → coordinates. Scrolls until target text is visible, or by a fixed amount.", {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.number().optional().describe("Scroll amount in pixels (default: 300)"),
  target: z.string().optional().describe("Scroll until this text is visible (overrides amount)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ direction, amount, target, bundleId }) => {
  await ensureBridge();

  const plan = planExecution("scroll", infra());
  const targetPid = await resolvePid(bundleId);
  const scrollAmount = amount ?? 300;

  // If target is specified, scroll in a loop until text is visible (max 10 scrolls)
  if (target) {
    for (let i = 0; i < 10; i++) {
      // Check if target is already visible
      try {
        const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
        const matches = await bridge.call<Array<{ text: string }>>("vision.findText", {
          imagePath: shot.path,
          searchText: target,
        });
        if (Array.isArray(matches) && matches.length > 0) {
          return { content: [{ type: "text" as const, text: `"${target}" is visible after ${i} scroll(s).` }] };
        }
      } catch { /* OCR failed, keep scrolling */ }

      // Scroll once
      const deltaX = direction === "left" ? -scrollAmount : direction === "right" ? scrollAmount : 0;
      const deltaY = direction === "up" ? -scrollAmount : direction === "down" ? scrollAmount : 0;
      await bridge.call("cg.scroll", { deltaX, deltaY });
      await new Promise((r) => setTimeout(r, 400));
    }
    return { content: [{ type: "text" as const, text: `Scrolled ${direction} 10 times but "${target}" not found.` }] };
  }

  // Fixed-amount scroll via fallback chain
  const result = await executeWithFallback("scroll", plan, DEFAULT_RETRY_POLICY, async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      const deltaX = direction === "left" ? -scrollAmount : direction === "right" ? scrollAmount : 0;
      const deltaY = direction === "up" ? -scrollAmount : direction === "down" ? scrollAmount : 0;

      switch (method) {
        case "ax": {
          // Use AX scroll action on the focused element
          const tree = await bridge.call<{ elementPath: number[] }>("ax.getElementTree", {
            pid: targetPid,
            maxDepth: 1,
          });
          // Fall through to cg.scroll since AX scroll is less reliable
          await bridge.call("cg.scroll", { deltaX, deltaY });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            await Runtime.evaluate({
              expression: `window.scrollBy(${deltaX}, ${deltaY})`,
            });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
          } finally {
            await client.close();
          }
        }
        case "coordinates": {
          await bridge.call("cg.scroll", { deltaX, deltaY });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
        }
      }
      throw new Error(`Method ${method} does not support scroll`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Scrolled", `${direction} ${scrollAmount}px`, result);
});

// ── wait_for_state ──

originalTool("wait_for_state", "Wait until a condition is met on screen: text appears, text disappears, or element becomes available. Polls at intervals using the fallback chain.", {
  condition: z.enum(["text_appears", "text_disappears", "element_exists"]).describe("What to wait for"),
  target: z.string().describe("Text or element to watch for"),
  timeoutMs: z.number().optional().describe("Maximum wait time in ms (default: 10000)"),
  pollMs: z.number().optional().describe("Poll interval in ms (default: 1000)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ condition, target, timeoutMs, pollMs, bundleId }) => {
  await ensureBridge();

  const timeout = timeoutMs ?? 10000;
  const poll = pollMs ?? 1000;
  const deadline = Date.now() + timeout;
  const targetPid = await resolvePid(bundleId);
  let lastCheck = "";

  while (Date.now() < deadline) {
    let found = false;

    // Try AX first (fastest), then OCR as fallback
    try {
      if (condition === "element_exists") {
        await bridge.call("ax.findElement", { pid: targetPid, title: target, exact: false });
        found = true;
      } else {
        // Text-based: try OCR
        const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
        const matches = await bridge.call<Array<{ text: string }>>("vision.findText", {
          imagePath: shot.path,
          searchText: target,
        });
        found = Array.isArray(matches) && matches.length > 0;
      }
    } catch {
      found = false;
    }

    // Also try CDP if available and text-based
    if (!found && cdpPort && condition !== "element_exists") {
      try {
        const { CDP: CDPClient, port } = await ensureCDP();
        const client = await CDPClient({ port });
        try {
          const { Runtime } = client;
          const evalResult = await Runtime.evaluate({
            expression: `document.body?.innerText?.includes(${JSON.stringify(target)}) ?? false`,
            returnByValue: true,
          });
          found = !!evalResult.result?.value;
        } finally {
          await client.close();
        }
      } catch { /* CDP unavailable */ }
    }

    const elapsed = Date.now() - (deadline - timeout);
    lastCheck = `${elapsed}ms`;

    if (condition === "text_appears" && found) {
      return { content: [{ type: "text" as const, text: `"${target}" appeared after ${lastCheck}.` }] };
    }
    if (condition === "text_disappears" && !found) {
      return { content: [{ type: "text" as const, text: `"${target}" disappeared after ${lastCheck}.` }] };
    }
    if (condition === "element_exists" && found) {
      return { content: [{ type: "text" as const, text: `Element "${target}" found after ${lastCheck}.` }] };
    }

    await new Promise((r) => setTimeout(r, poll));
  }

  return { content: [{ type: "text" as const, text: `Timeout: "${target}" — condition "${condition}" not met after ${timeout}ms.` }] };
});

// ═══════════════════════════════════════════════
// JOBS — persistent multi-step automation with resume
// ═══════════════════════════════════════════════

originalTool("job_create", "Create a new automation job. Jobs persist across restarts and can be resumed from the last successful step.", {
  task: z.string().describe("Human-readable description of what this job should do"),
  playbookId: z.string().optional().describe("Playbook ID to drive this job (optional — AI-only if omitted)"),
  bundleId: z.string().optional().describe("Target application bundle ID (e.g., 'com.apple.Safari'). Omit for app-agnostic jobs."),
  windowId: z.number().optional().describe("Target window ID within the application. Omit for app-agnostic jobs."),
  steps: z.array(z.object({
    action: z.string().describe("Action name (e.g., navigate, click, type_text, screenshot, key)"),
    target: z.string().optional().describe("Target element or URL"),
    description: z.string().optional().describe("Human-readable description"),
    text: z.string().optional().describe("Text payload for type_text/type_into actions"),
    keys: z.string().optional().describe("Key combo string for key/key_combo actions (e.g., 'cmd+a')"),
    value: z.string().optional().describe("Value payload for set_value actions"),
  })).optional().describe("Ordered steps for this job (can be populated from a playbook)"),
  tags: z.array(z.string()).optional().describe("Tags for filtering/grouping"),
  priority: z.number().optional().describe("Priority (lower = higher priority, default: 10)"),
  maxRetries: z.number().optional().describe("Max retry attempts on failure (default: 3)"),
  sessionId: z.string().optional().describe("Bind to an existing supervisor session"),
}, async ({ task, playbookId, bundleId, windowId, steps, tags, priority, maxRetries, sessionId }) => {
  const createOpts: Parameters<typeof jobManager.create>[0] = { task };
  if (playbookId !== undefined) createOpts.playbookId = playbookId;
  if (bundleId !== undefined) createOpts.bundleId = bundleId;
  if (windowId !== undefined) createOpts.windowId = windowId;
  if (steps !== undefined) createOpts.steps = steps;
  if (tags !== undefined) createOpts.tags = tags;
  if (priority !== undefined) createOpts.priority = priority;
  if (maxRetries !== undefined) createOpts.maxRetries = maxRetries;
  if (sessionId !== undefined) createOpts.sessionId = sessionId;
  const job = jobManager.create(createOpts);
  return { content: [{ type: "text" as const, text: `Job created: ${job.id}\nTask: ${job.task}\nState: ${job.state}\nSteps: ${job.steps.length}\nPriority: ${job.priority}\nTarget: ${job.bundleId ?? "(any app)"}${job.windowId != null ? ` window ${job.windowId}` : ""}` }] };
});

originalTool("job_status", "Get detailed status of a job including step progress and resume point.", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const job = jobManager.get(jobId);
  if (!job) return { content: [{ type: "text" as const, text: `Job ${jobId} not found.` }] };

  const completed = job.steps.filter((s) => s.status === "done").length;
  const failed = job.steps.filter((s) => s.status === "failed").length;
  const pending = job.steps.filter((s) => s.status === "pending").length;
  const resume = jobManager.getResumePoint(jobId);

  const lines = [
    `Job: ${job.id}`,
    `Task: ${job.task}`,
    `State: ${job.state}`,
    `Playbook: ${job.playbookId ?? "(none)"}`,
    `Target: ${job.bundleId ?? "(any app)"}${job.windowId != null ? ` window ${job.windowId}` : ""}`,
    `Session: ${job.sessionId ?? "(unbound)"}`,
    `Steps: ${completed} done, ${failed} failed, ${pending} pending (${job.steps.length} total)`,
    `Last completed step: ${job.lastStep}`,
    `Resume point: ${resume ? `step ${resume.stepIndex} — ${resume.step.description ?? resume.step.action}` : "(none — all done or no pending steps)"}`,
    `Retries: ${job.retries}/${job.maxRetries}`,
  ];
  if (job.blockReason) lines.push(`Block reason: ${job.blockReason}`);
  if (job.lastError) lines.push(`Last error: ${job.lastError}`);
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);

  if (job.steps.length > 0) {
    lines.push("", "Steps:");
    for (const s of job.steps) {
      const icon = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "skipped" ? "–" : "○";
      lines.push(`  ${icon} [${s.index}] ${s.description ?? s.action}${s.error ? ` (${s.error})` : ""}${s.durationMs != null ? ` ${s.durationMs}ms` : ""}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_list", "List all jobs, optionally filtered by state. Shows summary counts and job details.", {
  state: z.enum(["queued", "running", "blocked", "waiting_human", "done", "failed"]).optional().describe("Filter by state"),
}, async ({ state }) => {
  const jobs = jobManager.list(state as JobState | undefined);
  const sum = jobManager.summary();

  const lines = [
    `Jobs: ${sum.total} total — queued:${sum.byState.queued} running:${sum.byState.running} blocked:${sum.byState.blocked} waiting_human:${sum.byState.waiting_human} done:${sum.byState.done} failed:${sum.byState.failed}`,
  ];
  if (sum.oldestQueued) lines.push(`Oldest queued: ${sum.oldestQueued}`);
  if (sum.runningJobIds.length > 0) lines.push(`Running: ${sum.runningJobIds.join(", ")}`);

  if (jobs.length > 0) {
    lines.push("");
    for (const j of jobs.slice(0, 50)) {
      const completed = j.steps.filter((s) => s.status === "done").length;
      lines.push(`[${j.state}] ${j.id} — ${j.task.slice(0, 60)} (${completed}/${j.steps.length} steps, pri=${j.priority})`);
    }
    if (jobs.length > 50) lines.push(`  ... and ${jobs.length - 50} more`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_transition", "Move a job to a new state. Validates the transition is allowed by the state machine.", {
  jobId: z.string().describe("Job ID"),
  to: z.enum(["queued", "running", "blocked", "waiting_human", "done", "failed"]).describe("Target state"),
  reason: z.string().optional().describe("Block/failure reason"),
  sessionId: z.string().optional().describe("Session ID (when transitioning to running)"),
}, async ({ jobId, to, reason, sessionId }) => {
  const transOpts: { blockReason?: string; error?: string; sessionId?: string } = {};
  if ((to === "blocked" || to === "waiting_human") && reason) transOpts.blockReason = reason;
  if (to === "failed" && reason) transOpts.error = reason;
  if (sessionId !== undefined) transOpts.sessionId = sessionId;
  const result = jobManager.transition(jobId, to as JobState, transOpts);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  return { content: [{ type: "text" as const, text: `Job ${jobId} → ${to}${reason ? ` (${reason})` : ""}` }] };
});

originalTool("job_step_done", "Mark a step as completed and advance the job's resume point.", {
  jobId: z.string().describe("Job ID"),
  stepIndex: z.number().describe("Step index to mark done"),
  durationMs: z.number().optional().describe("How long the step took"),
}, async ({ jobId, stepIndex, durationMs }) => {
  const stepOpts: { durationMs?: number } = {};
  if (durationMs !== undefined) stepOpts.durationMs = durationMs;
  const result = jobManager.completeStep(jobId, stepIndex, stepOpts);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  const resume = jobManager.getResumePoint(jobId);
  return { content: [{ type: "text" as const, text: `Step ${stepIndex} done.${resume ? ` Next: step ${resume.stepIndex} — ${resume.step.description ?? resume.step.action}` : " All steps complete."}` }] };
});

originalTool("job_step_fail", "Mark a step as failed. The job stays running — caller decides whether to retry, block, or fail the job.", {
  jobId: z.string().describe("Job ID"),
  stepIndex: z.number().describe("Step index that failed"),
  error: z.string().describe("Error message"),
}, async ({ jobId, stepIndex, error }) => {
  const result = jobManager.failStep(jobId, stepIndex, error);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  return { content: [{ type: "text" as const, text: `Step ${stepIndex} failed: ${error}` }] };
});

originalTool("job_resume", "Get the resume point for a job — the next pending step after the last successful one.", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const job = jobManager.get(jobId);
  if (!job) return { content: [{ type: "text" as const, text: `Job ${jobId} not found.` }] };
  const resume = jobManager.getResumePoint(jobId);
  if (!resume) {
    return { content: [{ type: "text" as const, text: `No pending steps. Last completed: ${job.lastStep}. State: ${job.state}.` }] };
  }
  return { content: [{ type: "text" as const, text: `Resume at step ${resume.stepIndex}: ${resume.step.description ?? resume.step.action}\nAction: ${resume.step.action}${resume.step.target ? `\nTarget: ${resume.step.target}` : ""}` }] };
});

originalTool("job_dequeue", "Pop the highest-priority queued job and transition it to running.", {
  sessionId: z.string().optional().describe("Session ID to bind the job to"),
}, async ({ sessionId }) => {
  const job = jobManager.dequeue(sessionId);
  if (!job) return { content: [{ type: "text" as const, text: "No queued jobs." }] };
  const resume = jobManager.getResumePoint(job.id);
  return { content: [{ type: "text" as const, text: `Dequeued: ${job.id}\nTask: ${job.task}\nSteps: ${job.steps.length}\nResume: ${resume ? `step ${resume.stepIndex}` : "start"}` }] };
});

originalTool("job_remove", "Remove a job entirely (any state).", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const ok = jobManager.remove(jobId);
  return { content: [{ type: "text" as const, text: ok ? `Job ${jobId} removed.` : `Job ${jobId} not found.` }] };
});

// ── Job Runner + Worker ─────────────────────────

const PLAYBOOKS_DIR = path.join(os.homedir(), ".screenhand", "playbooks");

let activeJobRunner: JobRunner | null = null;


function getJobRunner(): JobRunner {
  if (!activeJobRunner) {
    // Build playbook engine stack: adapter → runtime → engine
    const adapter = new AccessibilityAdapter(bridge);
    const logger = new TimelineLogger();
    const runtimeService = new AutomationRuntimeService(adapter, logger);
    const playbookEngine = new PlaybookEngine(runtimeService);
    const playbookStore = new PlaybookStore(PLAYBOOKS_DIR);
    playbookStore.load();

    activeJobRunner = new JobRunner(
      bridge,
      jobManager,
      leaseManager,
      supervisor,
      (() => {
        const cfg: Partial<import("./src/jobs/runner.js").JobRunnerConfig> = {
          hasCDP: cdpPort !== null,
          playbookEngine,
          playbookStore,
          runtimeService,
        };
        if (cdpPort) {
          cfg.cdpConnect = async () => {
            const { CDP: CDPClient, port } = await ensureCDP();
            const client = await CDPClient({ port });
            return { Runtime: client.Runtime, Input: client.Input, close: () => client.close() };
          };
        }
        return cfg;
      })(),
    );
  }
  return activeJobRunner;
}



originalTool("job_run", "Execute the next queued job: dequeue → claim session → run steps through fallback chain → auto-transition. Returns when the job completes, blocks, or fails.", {
}, async () => {
  await ensureBridge();
  const runner = getJobRunner();
  const result = await runner.run();
  if (!result) return { content: [{ type: "text" as const, text: "No queued jobs." }] };

  const lines = [
    `Job: ${result.jobId}`,
    `Final state: ${result.finalState}`,
    `Steps: ${result.stepsCompleted}/${result.totalSteps}`,
    `Duration: ${result.durationMs}ms`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_run_all", "Process all queued jobs sequentially until the queue is empty or a job blocks/fails. Each job gets its own session.", {
  maxJobs: z.number().optional().describe("Max jobs to process (default: unlimited)"),
}, async ({ maxJobs }) => {
  await ensureBridge();
  const runner = getJobRunner();
  const results: Array<{ jobId: string; finalState: string; stepsCompleted: number; totalSteps: number; durationMs: number; error: string | null }> = [];

  const limit = maxJobs ?? Infinity;
  for (let i = 0; i < limit; i++) {
    const result = await runner.run();
    if (!result) break;
    results.push(result);
  }

  if (results.length === 0) return { content: [{ type: "text" as const, text: "No queued jobs." }] };

  const lines = [`Processed ${results.length} job(s):`];
  for (const r of results) {
    lines.push(`  ${r.jobId}: ${r.finalState} (${r.stepsCompleted}/${r.totalSteps} steps, ${r.durationMs}ms)${r.error ? ` — ${r.error}` : ""}`);
  }

  const done = results.filter((r) => r.finalState === "done").length;
  const failed = results.filter((r) => r.finalState === "failed").length;
  const blocked = results.filter((r) => r.finalState === "blocked" || r.finalState === "waiting_human").length;
  lines.push(`\nSummary: ${done} done, ${failed} failed, ${blocked} blocked`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ── Job Worker Daemon (separate process, survives restarts) ───

const WORKER_DAEMON_PATH = path.resolve(__dirname, "scripts/worker-daemon.ts");

originalTool("worker_start", "Start the job worker daemon as a detached background process. Survives MCP/client restarts. Continuously processes the job queue.", {
  pollMs: z.number().optional().describe("Poll interval when queue is empty (default: 3000ms)"),
  maxJobs: z.number().optional().describe("Max jobs to process before auto-stopping (0 = unlimited, default: 0)"),
}, async ({ pollMs, maxJobs }) => {
  const existingPid = getWorkerDaemonPid();
  if (existingPid !== null) {
    return { content: [{ type: "text" as const, text: `Worker daemon is already running (pid=${existingPid}).` }] };
  }

  const daemonArgs = ["tsx", WORKER_DAEMON_PATH];
  if (pollMs !== undefined) daemonArgs.push("--poll", String(pollMs));
  if (maxJobs !== undefined) daemonArgs.push("--max-jobs", String(maxJobs));

  const child = spawn("npx", daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait briefly for PID file to appear
  await new Promise((r) => setTimeout(r, 1500));
  const pid = getWorkerDaemonPid();

  return { content: [{ type: "text" as const, text: pid
    ? `Worker daemon started (pid=${pid}).\nPoll: ${pollMs ?? 3000}ms | Max jobs: ${maxJobs ?? "unlimited"}\nLog: ${WORKER_LOG_FILE}`
    : `Worker daemon spawn attempted but PID not yet confirmed. Check log: ${WORKER_LOG_FILE}` }] };
});

originalTool("worker_stop", "Stop the worker daemon. Sends SIGTERM for graceful shutdown — current job finishes before exit.", {
}, async () => {
  const pid = getWorkerDaemonPid();
  if (pid === null) {
    return { content: [{ type: "text" as const, text: "Worker daemon is not running." }] };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { content: [{ type: "text" as const, text: `Failed to send SIGTERM to pid=${pid}. Process may have already exited.` }] };
  }

  // Wait for it to exit
  await new Promise((r) => setTimeout(r, 2000));
  const stillAlive = getWorkerDaemonPid();

  const s = getWorkerLiveStatus();
  const summary = `Jobs processed: ${s.jobsProcessed} (${s.jobsDone} done, ${s.jobsFailed} failed, ${s.jobsBlocked} blocked)`;

  return { content: [{ type: "text" as const, text: stillAlive
    ? `SIGTERM sent to pid=${pid} but process is still running. It may be finishing a job.\n${summary}`
    : `Worker daemon stopped (was pid=${pid}).\n${summary}` }] };
});

originalTool("worker_status", "Get the current status of the worker daemon (reads persisted state from disk).", {
}, async () => {
  const s = getWorkerLiveStatus();
  const lines = [
    `Running: ${s.running}${s.pid ? ` (pid=${s.pid})` : ""}`,
    `Started: ${s.startedAt ?? "(not started)"}`,
    `Uptime: ${Math.round(s.uptimeMs / 1000)}s`,
    `Poll: ${s.pollMs}ms | Max jobs: ${s.maxJobs || "unlimited"}`,
    `Jobs processed: ${s.jobsProcessed}`,
    `  Done: ${s.jobsDone}`,
    `  Failed: ${s.jobsFailed}`,
    `  Blocked: ${s.jobsBlocked}`,
  ];
  if (s.lastJobId) lines.push(`Last job: ${s.lastJobId} → ${s.lastJobState}`);

  if (s.recentResults.length > 0) {
    lines.push("", `Recent (last ${Math.min(s.recentResults.length, 10)}):`);
    for (const r of s.recentResults.slice(-10)) {
      lines.push(`  ${r.jobId}: ${r.finalState} (${r.stepsCompleted}/${r.totalSteps}, ${r.durationMs}ms)`);
    }
  }

  lines.push("", `Log: ${WORKER_LOG_FILE}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ═══════════════════════════════════════════════
// CODEX MONITOR — watch VS Code terminals, auto-assign tasks
// ═══════════════════════════════════════════════

// Daemon state directory
const MONITOR_DIR = path.join(os.homedir(), ".screenhand", "monitor");
const MONITOR_STATE = path.join(MONITOR_DIR, "state.json");
const MONITOR_TASKS = path.join(MONITOR_DIR, "tasks.json");
const MONITOR_PID = path.join(MONITOR_DIR, "daemon.pid");
const MONITOR_LOG = path.join(MONITOR_DIR, "daemon.log");
const DAEMON_SCRIPT = path.resolve(__dirname, "scripts", "codex-monitor-daemon.ts");

function isDaemonRunning(): { running: boolean; pid: number | null } {
  try {
    if (!fs.existsSync(MONITOR_PID)) return { running: false, pid: null };
    const pid = Number(fs.readFileSync(MONITOR_PID, "utf-8").trim());
    // Check if process is alive
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

function readDaemonState(): any {
  try {
    if (!fs.existsSync(MONITOR_STATE)) return null;
    return JSON.parse(fs.readFileSync(MONITOR_STATE, "utf-8"));
  } catch {
    return null;
  }
}

function readDaemonTasks(): any[] {
  try {
    if (!fs.existsSync(MONITOR_TASKS)) return [];
    return JSON.parse(fs.readFileSync(MONITOR_TASKS, "utf-8"));
  } catch {
    return [];
  }
}

function writeDaemonTasks(tasks: any[]) {
  fs.mkdirSync(MONITOR_DIR, { recursive: true });
  fs.writeFileSync(MONITOR_TASKS, JSON.stringify(tasks, null, 2));
}

server.tool("codex_monitor_start", "Start a background daemon that monitors VS Code terminals for Codex/AI agent activity. Runs independently — survives Claude Code restarts. Watches terminal output via OCR, detects running/idle/done.", {
  vscodePid: z.number().describe("Process ID of VS Code (get from 'apps' tool)"),
  windowId: z.number().optional().describe("Window ID of the VS Code window (get from 'windows' tool). Auto-detected if omitted."),
  label: z.string().optional().describe("Label for this terminal (default: 'Terminal')"),
  pollIntervalMs: z.number().optional().describe("How often to poll in ms (default: 3000)"),
  autoAssign: z.boolean().optional().describe("Auto-assign queued tasks when terminal goes idle (default: true)"),
}, async ({ vscodePid, windowId, label, pollIntervalMs, autoAssign }) => {
  const { running, pid } = isDaemonRunning();
  if (running) {
    return { content: [{ type: "text", text: `Daemon already running (pid=${pid}). Use codex_monitor_stop first to restart.` }] };
  }

  // Build daemon args
  const daemonArgs = ["tsx", DAEMON_SCRIPT, "--pid", String(vscodePid)];
  if (windowId) daemonArgs.push("--window", String(windowId));
  if (pollIntervalMs) daemonArgs.push("--poll", String(pollIntervalMs));
  if (label) daemonArgs.push("--label", label);
  if (autoAssign === false) daemonArgs.push("--no-auto-assign");

  // Spawn detached daemon
  const child = spawn("npx", daemonArgs, {
    detached: true,
    stdio: "ignore",
    cwd: __dirname,
  });
  child.unref();

  const daemonPid = child.pid;

  // Wait a moment for daemon to start and write state
  await new Promise((r) => setTimeout(r, 3000));

  const state = readDaemonState();
  const terminalId = state?.terminals?.[0]?.id ?? "pending";

  return {
    content: [{
      type: "text",
      text: `Background daemon started!\n` +
        `Daemon PID: ${daemonPid}\n` +
        `Terminal ID: ${terminalId}\n` +
        `VS Code PID: ${vscodePid}\n` +
        `Window ID: ${windowId ?? "auto-detecting"}\n` +
        `Poll interval: ${pollIntervalMs ?? 3000}ms\n` +
        `Auto-assign: ${autoAssign !== false}\n` +
        `Log: ${MONITOR_LOG}\n` +
        `State: ${MONITOR_STATE}\n\n` +
        `The daemon runs independently — survives Claude Code restarts.\n` +
        `Use codex_monitor_status to check on it anytime.`,
    }],
  };
});

server.tool("codex_monitor_status", "Get status of the background monitor daemon. Shows terminal status, agent activity, task queue, and daemon health.", {
  tail_log: z.number().optional().describe("Show last N lines of daemon log (default: 0, max: 50)"),
}, async ({ tail_log }) => {
  const { running, pid } = isDaemonRunning();
  const state = readDaemonState();
  const tasks = readDaemonTasks();

  const lines: string[] = [];
  lines.push(`Daemon: ${running ? "RUNNING" : "STOPPED"} (pid=${pid ?? "none"})`);

  if (state?.terminals) {
    for (const t of state.terminals) {
      const lastOutput = (t.lastOutput || "").split("\n").slice(-5).join("\n").trim();
      lines.push("");
      lines.push(`--- ${t.id} ---`);
      lines.push(`  Status: ${(t.status || "unknown").toUpperCase()}`);
      lines.push(`  VS Code PID: ${t.vscodePid}`);
      lines.push(`  Window ID: ${t.windowId ?? "unknown"}`);
      lines.push(`  Current task: ${t.lastTask ?? "none"}`);
      lines.push(`  Tasks completed: ${t.tasksCompleted}`);
      lines.push(`  Last poll: ${t.lastPollAt}`);
      lines.push(`  Last output (tail):`);
      lines.push(`    ${lastOutput.split("\n").join("\n    ")}`);
    }
  } else if (!running) {
    lines.push("\nNo monitor running. Use codex_monitor_start first.");
  }

  const queued = tasks.filter((t: any) => t.status === "queued").length;
  const runningTasks = tasks.filter((t: any) => t.status === "running").length;
  const completed = tasks.filter((t: any) => t.status === "completed").length;
  lines.push("");
  lines.push(`Tasks: ${queued} queued, ${runningTasks} running, ${completed} completed`);

  // Optionally show daemon log tail
  if (tail_log && tail_log > 0) {
    try {
      const logContent = fs.readFileSync(MONITOR_LOG, "utf-8");
      const logLines = logContent.trim().split("\n").slice(-(Math.min(tail_log, 50)));
      lines.push("");
      lines.push("--- Daemon Log ---");
      lines.push(logLines.join("\n"));
    } catch {
      lines.push("\n(no log file found)");
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("codex_monitor_add_task", "Add a task to the daemon's queue. When a monitored terminal goes idle, the next task is automatically typed in and executed.", {
  prompt: z.string().describe("The prompt/command to send to Codex when a terminal is available"),
  priority: z.number().optional().describe("Priority (lower = higher priority, default: 10)"),
  terminalId: z.string().optional().describe("Assign to a specific terminal (omit for any available)"),
}, async ({ prompt, priority, terminalId }) => {
  const tasks = readDaemonTasks();
  const task = {
    id: "task_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    prompt,
    priority: priority ?? 10,
    terminalId: terminalId ?? null,
    status: "queued",
    createdAt: new Date().toISOString(),
    assignedAt: null,
    completedAt: null,
    result: null,
  };
  tasks.push(task);
  tasks.sort((a: any, b: any) => a.priority - b.priority);
  writeDaemonTasks(tasks);

  const queued = tasks.filter((t: any) => t.status === "queued").length;

  return {
    content: [{
      type: "text",
      text: `Task queued!\n` +
        `ID: ${task.id}\n` +
        `Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"\n` +
        `Priority: ${task.priority}\n` +
        `Target terminal: ${task.terminalId ?? "any available"}\n` +
        `Queue size: ${queued}`,
    }],
  };
});

server.tool("codex_monitor_tasks", "List all tasks in the daemon's queue with their status.", {
  status: z.enum(["all", "queued", "running", "completed", "failed"]).optional().describe("Filter by status (default: all)"),
}, async ({ status }) => {
  let tasks = readDaemonTasks();

  if (status && status !== "all") {
    tasks = tasks.filter((t: any) => t.status === status);
  }

  if (tasks.length === 0) {
    return { content: [{ type: "text", text: `No ${status ?? ""} tasks.` }] };
  }

  const lines = tasks.map((t: any, i: number) => {
    const parts = [
      `${i + 1}. [${t.status.toUpperCase()}] "${(t.prompt || "").slice(0, 80)}"`,
      `   ID: ${t.id} | Priority: ${t.priority}`,
      `   Terminal: ${t.terminalId ?? "any"}`,
      `   Created: ${t.createdAt}`,
    ];
    if (t.assignedAt) parts.push(`   Assigned: ${t.assignedAt}`);
    if (t.completedAt) parts.push(`   Completed: ${t.completedAt}`);
    if (t.result) parts.push(`   Result: ${(t.result || "").slice(0, 100)}`);
    return parts.join("\n");
  });

  return { content: [{ type: "text", text: lines.join("\n\n") }] };
});

server.tool("codex_monitor_assign_now", "Immediately type a prompt into the VS Code terminal (bypasses queue). Focuses VS Code, types, presses Enter.", {
  prompt: z.string().describe("The prompt/command to type into the terminal"),
}, async ({ prompt }) => {
  await ensureBridge();
  try {
    await bridge.call("app.focus", { bundleId: "com.microsoft.VSCode" });
    await new Promise((r) => setTimeout(r, 300));
    await bridge.call("cg.typeText", { text: prompt });
    await new Promise((r) => setTimeout(r, 100));
    await bridge.call("cg.keyCombo", { keys: ["enter"] });
    return { content: [{ type: "text", text: `Typed and sent: "${prompt.slice(0, 100)}"` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
  }
});

server.tool("codex_monitor_stop", "Stop the background monitor daemon.", {}, async () => {
  const { running, pid } = isDaemonRunning();
  if (!running) {
    return { content: [{ type: "text", text: "No daemon running." }] };
  }
  try {
    process.kill(pid!, "SIGTERM");
    // Wait for it to clean up
    await new Promise((r) => setTimeout(r, 1000));
    return { content: [{ type: "text", text: `Daemon stopped (pid=${pid}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Failed to stop daemon: ${err.message}` }] };
  }
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write("MCP server error: " + err.message + "\n");
  process.exit(1);
});
