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
import { MemoryStore } from "./src/memory/store.js";
import { SessionTracker } from "./src/memory/session.js";
import { RecallEngine } from "./src/memory/recall.js";
import type { ActionEntry, ErrorPattern } from "./src/memory/types.js";
import { backgroundResearch } from "./src/memory/research.js";
import { CodexMonitor } from "./src/monitor/codex-monitor.js";

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

const memoryStore = new MemoryStore(__dirname);
memoryStore.init(); // One-time disk read at startup
const sessionTracker = new SessionTracker(memoryStore);
const recallEngine = new RecallEngine(memoryStore);

// Skip logging for memory tools themselves
const MEMORY_TOOLS = new Set(["memory_recall", "memory_save", "memory_errors", "memory_stats", "memory_clear"]);

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

    const sessionId = sessionTracker.getSessionId();
    const safeParams = typeof params === "object" && params !== null ? params : {};
    const start = Date.now();

    // ── PRE-CALL: check for known error warnings (~0ms, in-memory) ──
    const knownError = recallEngine.quickErrorCheck(toolName);

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
      memoryStore.appendAction(entry);   // non-blocking
      sessionTracker.recordAction(entry); // in-memory only

      // ── POST-CALL: auto-recall hints (~0ms, in-memory) ──
      const hints: string[] = [];

      // Warn about known errors for this tool
      if (knownError) {
        hints.push(`⚡ Memory: "${toolName}" has failed before: "${knownError.error}" (${knownError.occurrences}x). Fix: ${knownError.resolution}`);
      }

      // Suggest next step if we're mid-strategy
      const recentTools = sessionTracker.getRecentToolNames();
      const strategyHint = recallEngine.quickStrategyHint(recentTools);
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
        memoryStore.recordStrategyOutcome(activeStrategyFingerprint, true);
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
      memoryStore.appendAction(entry);    // non-blocking
      sessionTracker.recordAction(entry);  // in-memory only

      // Record strategy failure if we were following one
      if (activeStrategyFingerprint) {
        memoryStore.recordStrategyOutcome(activeStrategyFingerprint, false);
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
      memoryStore.appendError(errorPattern);

      // Background research: search for a fix if no resolution exists
      const existingErrors = memoryStore.readErrors();
      const hasResolution = existingErrors.some(
        (e) => e.tool === toolName && e.error === errorMsg && e.resolution
      );
      if (!hasResolution) {
        backgroundResearch(memoryStore, toolName, safeParams, errorMsg);
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
  const actions = memoryStore.readActions();
  const errors = memoryStore.readErrors();
  const strategies = memoryStore.readStrategies();

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

originalTool("memory_recall", "Have I done something like this before? Searches past successful strategies by keyword similarity.", {
  task: z.string().describe("Describe the task you want to accomplish"),
  limit: z.number().optional().describe("Max results (default 5)"),
}, async ({ task, limit }) => {
  const matches = recallEngine.recallStrategies(task, limit ?? 5);
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
  const strategy = sessionTracker.endSession(true, task);
  if (!strategy) {
    return { content: [{ type: "text" as const, text: "No actions recorded in the current session. Perform some tool calls first, then save." }] };
  }
  if (tags && tags.length > 0) {
    strategy.tags = [...new Set([...strategy.tags, ...tags])];
    // Re-save with updated tags
    memoryStore.appendStrategy(strategy);
  }
  return { content: [{ type: "text" as const, text: `Saved strategy "${task}" with ${strategy.steps.length} steps. Tags: ${strategy.tags.join(", ")}` }] };
});

originalTool("memory_errors", "What goes wrong with this tool? Shows known error patterns and resolutions.", {
  tool: z.string().optional().describe("Tool name to filter by (omit for all errors)"),
}, async ({ tool }) => {
  const errors = recallEngine.recallErrors(tool);
  if (errors.length === 0) {
    return { content: [{ type: "text" as const, text: tool ? `No known error patterns for "${tool}".` : "No error patterns recorded yet." }] };
  }
  const text = errors.map((e, i) =>
    `${i + 1}. ${e.tool}: "${e.error}" (${e.occurrences}x)${e.resolution ? `\n   Fix: ${e.resolution}` : ""}`
  ).join("\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_stats", "How much have I learned? Shows total actions, strategies, error patterns, and success rates.", {}, async () => {
  const stats = memoryStore.getStats();
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
  what: z.enum(["all", "actions", "strategies", "errors"]).describe("What to clear"),
}, async ({ what }) => {
  memoryStore.clear(what);
  return { content: [{ type: "text" as const, text: `Cleared ${what === "all" ? "all memory data" : what}.` }] };
});

// ═══════════════════════════════════════════════
// CODEX MONITOR — watch VS Code terminals, auto-assign tasks
// ═══════════════════════════════════════════════

let codexMonitor: CodexMonitor | null = null;

function getMonitor(): CodexMonitor {
  if (!codexMonitor) {
    codexMonitor = new CodexMonitor(bridge, {});
    codexMonitor.onLog = (msg) => process.stderr.write(`[CodexMonitor] ${msg}\n`);
    codexMonitor.onStatusChange = (terminal, oldStatus) => {
      process.stderr.write(`[CodexMonitor] ${terminal.id}: ${oldStatus} -> ${terminal.status}\n`);
    };
    codexMonitor.onTaskAssigned = (terminalId, task) => {
      process.stderr.write(`[CodexMonitor] Assigned "${task.prompt.slice(0, 60)}" to ${terminalId}\n`);
    };
  }
  return codexMonitor;
}

server.tool("codex_monitor_start", "Start monitoring VS Code terminals for Codex/AI agent activity. Finds VS Code by PID, watches terminal output via OCR, detects when agent is running/idle/done.", {
  vscodePid: z.number().describe("Process ID of VS Code (get from 'apps' tool)"),
  windowId: z.number().optional().describe("Window ID of the VS Code window (get from 'windows' tool). Auto-detected if omitted."),
  label: z.string().optional().describe("Label for this terminal (default: 'Terminal')"),
  pollIntervalMs: z.number().optional().describe("How often to poll in ms (default: 3000)"),
  autoAssign: z.boolean().optional().describe("Auto-assign queued tasks when terminal goes idle (default: true)"),
}, async ({ vscodePid, windowId, label, pollIntervalMs, autoAssign }) => {
  await ensureBridge();
  const monitor = getMonitor();

  if (pollIntervalMs || autoAssign !== undefined) {
    const cfg: Record<string, unknown> = {};
    if (pollIntervalMs) cfg.pollIntervalMs = pollIntervalMs;
    if (autoAssign !== undefined) cfg.autoAssign = autoAssign;
    monitor.updateConfig(cfg);
  }

  const terminal = await monitor.addTerminal({ vscodePid, windowId, label });

  if (!monitor.isRunning) {
    monitor.start();
  }

  return {
    content: [{
      type: "text",
      text: `Monitoring started!\n` +
        `Terminal ID: ${terminal.id}\n` +
        `VS Code PID: ${terminal.vscodePid}\n` +
        `Window ID: ${terminal.windowId ?? "auto-detecting"}\n` +
        `Initial status: ${terminal.status}\n` +
        `Poll interval: ${pollIntervalMs ?? 3000}ms\n` +
        `Auto-assign: ${autoAssign !== false}`,
    }],
  };
});

server.tool("codex_monitor_status", "Get status of all monitored VS Code terminals. Shows whether each agent is running, idle, or errored, plus task queue info.", {
  terminalId: z.string().optional().describe("Specific terminal ID to check (omit for all)"),
}, async ({ terminalId }) => {
  const monitor = getMonitor();
  const terminals = terminalId
    ? [monitor.getTerminal(terminalId)].filter(Boolean)
    : monitor.getTerminals();

  if (terminals.length === 0) {
    return { content: [{ type: "text", text: "No terminals being monitored. Use codex_monitor_start first." }] };
  }

  const queuedTasks = monitor.queue.queuedCount();

  const lines = terminals.map((t: any) => {
    const lastOutput = t.lastOutput.split("\n").slice(-5).join("\n").trim();
    return [
      `--- ${t.id} ---`,
      `  Status: ${t.status.toUpperCase()}`,
      `  VS Code PID: ${t.vscodePid}`,
      `  Window ID: ${t.windowId ?? "unknown"}`,
      `  Current task: ${t.lastTask ?? "none"}`,
      `  Tasks completed: ${t.tasksCompleted}`,
      `  Last poll: ${t.lastPollAt}`,
      `  Last output (tail):`,
      `    ${lastOutput.split("\n").join("\n    ")}`,
    ].join("\n");
  });

  lines.push("", `Queued tasks: ${queuedTasks}`);
  lines.push(`Monitor running: ${monitor.isRunning}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("codex_monitor_add_task", "Add a task to the queue. When a monitored terminal goes idle, the next task is automatically typed in and executed.", {
  prompt: z.string().describe("The prompt/command to send to Codex when a terminal is available"),
  priority: z.number().optional().describe("Priority (lower = higher priority, default: 10)"),
  terminalId: z.string().optional().describe("Assign to a specific terminal (omit for any available)"),
}, async ({ prompt, priority, terminalId }) => {
  const monitor = getMonitor();
  const task = monitor.queue.enqueue(prompt, { priority, terminalId });

  return {
    content: [{
      type: "text",
      text: `Task queued!\n` +
        `ID: ${task.id}\n` +
        `Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"\n` +
        `Priority: ${task.priority}\n` +
        `Target terminal: ${task.terminalId ?? "any available"}\n` +
        `Queue position: ${monitor.queue.queuedCount()}`,
    }],
  };
});

server.tool("codex_monitor_tasks", "List all tasks in the queue with their status (queued, running, completed, failed).", {
  status: z.enum(["all", "queued", "running", "completed", "failed"]).optional().describe("Filter by status (default: all)"),
}, async ({ status }) => {
  const monitor = getMonitor();
  let tasks = monitor.queue.all();

  if (status && status !== "all") {
    tasks = tasks.filter((t) => t.status === status);
  }

  if (tasks.length === 0) {
    return { content: [{ type: "text", text: `No ${status ?? ""} tasks.` }] };
  }

  const lines = tasks.map((t, i) => {
    const parts = [
      `${i + 1}. [${t.status.toUpperCase()}] "${t.prompt.slice(0, 80)}"`,
      `   ID: ${t.id} | Priority: ${t.priority}`,
      `   Terminal: ${t.terminalId ?? "any"}`,
      `   Created: ${t.createdAt}`,
    ];
    if (t.assignedAt) parts.push(`   Assigned: ${t.assignedAt}`);
    if (t.completedAt) parts.push(`   Completed: ${t.completedAt}`);
    if (t.result) parts.push(`   Result: ${t.result.slice(0, 100)}`);
    return parts.join("\n");
  });

  return { content: [{ type: "text", text: lines.join("\n\n") }] };
});

server.tool("codex_monitor_assign_now", "Immediately assign a prompt to a specific terminal (bypasses queue). Types the command and presses Enter.", {
  terminalId: z.string().describe("Terminal ID to send the command to"),
  prompt: z.string().describe("The prompt/command to type into the terminal"),
}, async ({ terminalId, prompt }) => {
  await ensureBridge();
  const monitor = getMonitor();

  const success = await monitor.assignDirect(terminalId, prompt);
  if (success) {
    return { content: [{ type: "text", text: `Sent to ${terminalId}: "${prompt.slice(0, 100)}"` }] };
  }
  return { content: [{ type: "text", text: `Failed — terminal ${terminalId} not found or couldn't type.` }] };
});

server.tool("codex_monitor_stop", "Stop monitoring terminals. Optionally remove specific terminal or stop everything.", {
  terminalId: z.string().optional().describe("Specific terminal to stop monitoring (omit to stop all)"),
}, async ({ terminalId }) => {
  const monitor = getMonitor();

  if (terminalId) {
    const removed = monitor.removeTerminal(terminalId);
    return { content: [{ type: "text", text: removed ? `Stopped monitoring ${terminalId}` : `Terminal ${terminalId} not found` }] };
  }

  monitor.stop();
  return { content: [{ type: "text", text: "All monitoring stopped." }] };
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
