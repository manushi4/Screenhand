#!/usr/bin/env npx tsx
/**
 * Desktop Automation MCP Server
 * Controls any macOS app + Chrome browser via CDP.
 *
 * For app debugging, design inspection, UI testing.
 *
 * Setup — add to ~/.claude/settings.json or project .mcp.json:
 * {
 *   "mcpServers": {
 *     "desktop": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/desktop-automation/mcp-desktop.ts"]
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
import { MacOSBridgeClient } from "./src/native/macos-bridge-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(__dirname, "native/macos-bridge/.build/release/macos-bridge");
const bridge = new MacOSBridgeClient(bridgePath);
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

const server = new McpServer({ name: "desktop-automation", version: "2.0.0" });

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

server.tool("screenshot", "Take a screenshot and OCR it. Returns all visible text.", {
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

server.tool("ocr", "OCR a window with element positions (for finding clickable targets)", {
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

server.tool("ui_tree", "Get the full UI element tree of an app via Accessibility. FAST — no OCR needed. Use this for debugging app structure.", {
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

server.tool("ui_press", "Find and press/click a UI element by its title via Accessibility", {
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

server.tool("click_text", "Find text on screen via OCR and click it (shadow-corrected for Retina)", {
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

// ═══════════════════════════════════════════════
// BROWSER — control Chrome pages via CDP (10ms, not OCR)
// ═══════════════════════════════════════════════

server.tool("browser_tabs", "List all open Chrome tabs", {}, async () => {
  const { CDP: cdp, port } = await ensureCDP();
  const targets = await cdp.List({ port });
  const pages = targets.filter((t: any) => t.type === "page");
  const lines = pages.map((t: any) => `[${t.id.slice(0, 8)}] ${t.title} — ${t.url}`);
  return { content: [{ type: "text", text: lines.join("\n") || "No tabs open" }] };
});

server.tool("browser_open", "Open a URL in Chrome (creates new tab)", {
  url: z.string().describe("URL to open"),
}, async ({ url }) => {
  const { CDP: cdp, port } = await ensureCDP();
  const target = await cdp.New({ port, url });
  return { content: [{ type: "text", text: `Opened: ${target.id.slice(0, 8)} — ${url}` }] };
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

server.tool("browser_js", "Execute JavaScript in a Chrome tab. Returns the result. Use this for ANY dynamic web page interaction.", {
  code: z.string().describe("JavaScript to execute. Must be an expression that returns a value. Use (() => { ... })() for multi-line."),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ code, tabId }) => {
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

server.tool("browser_click", "Click an element in Chrome by CSS selector", {
  selector: z.string().describe("CSS selector of element to click"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
}, async ({ selector, tabId }) => {
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
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector}" };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, text: el.textContent?.trim()?.slice(0, 100) };
    })()`,
    returnByValue: true,
  });
  await client.close();

  const val = result.result.value;
  if (!val.ok) return { content: [{ type: "text", text: val.reason }] };
  return { content: [{ type: "text", text: `Clicked: "${val.text}"` }] };
});

server.tool("browser_type", "Type into an input field in Chrome", {
  selector: z.string().describe("CSS selector of the input"),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear field first (default true)"),
  tabId: z.string().optional().describe("Tab ID"),
}, async ({ selector, text, clear, tabId }) => {
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
  const shouldClear = clear !== false;
  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Input not found" };
      el.focus();
      ${shouldClear ? 'el.value = "";' : ''}
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`,
    returnByValue: true,
  });
  await client.close();
  return { content: [{ type: "text", text: result.result.value.ok ? `Typed "${text}"` : result.result.value.reason }] };
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
// APPLESCRIPT — control scriptable apps directly
// ═══════════════════════════════════════════════

server.tool("applescript", "Run an AppleScript command. For controlling Finder, Safari, Mail, Notes, etc.", {
  script: z.string().describe("AppleScript code to execute"),
}, async ({ script }) => {
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
