#!/usr/bin/env npx tsx
/**
 * MCP Server — exposes the macOS native bridge as MCP tools.
 * Claude Code can call these directly as tool calls — no API key needed.
 *
 * Add to .claude/settings.json:
 * {
 *   "mcpServers": {
 *     "desktop": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/desktop-automation/mcp-bridge.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { MacOSBridgeClient } from "./src/native/macos-bridge-client.js";

const bridgePath = path.resolve(
  import.meta.dirname ?? process.cwd(),
  "native/macos-bridge/.build/release/macos-bridge"
);

const bridge = new MacOSBridgeClient(bridgePath);
let bridgeReady = false;

async function ensureBridge() {
  if (!bridgeReady) {
    await bridge.start();
    bridgeReady = true;
  }
}

const server = new McpServer({
  name: "desktop-automation",
  version: "1.0.0",
});

// ── Apps ──

server.tool("apps", "List all running applications", {}, async () => {
  await ensureBridge();
  const apps = await bridge.call<any[]>("app.list");
  return { content: [{ type: "text", text: JSON.stringify(apps, null, 2) }] };
});

server.tool("windows", "List all visible windows with IDs and positions", {}, async () => {
  await ensureBridge();
  const wins = await bridge.call<any[]>("app.windows");
  return { content: [{ type: "text", text: JSON.stringify(wins, null, 2) }] };
});

server.tool("focus", "Focus/activate an application by bundle ID", {
  bundleId: z.string().describe("App bundle ID, e.g. com.apple.Safari"),
}, async ({ bundleId }) => {
  await ensureBridge();
  await bridge.call("app.focus", { bundleId });
  return { content: [{ type: "text", text: "Focused " + bundleId }] };
});

server.tool("launch", "Launch an application by bundle ID", {
  bundleId: z.string().describe("App bundle ID"),
}, async ({ bundleId }) => {
  await ensureBridge();
  const r = await bridge.call<any>("app.launch", { bundleId });
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
});

// ── Screenshot + OCR ──

server.tool("screenshot", "Screenshot a window (or full screen) and OCR it. Returns visible text.", {
  windowId: z.number().optional().describe("Window ID to capture. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shotPath: string;
  if (windowId) {
    const s = await bridge.call<any>("cg.captureWindow", { windowId });
    shotPath = s.path;
  } else {
    const s = await bridge.call<any>("cg.captureScreen");
    shotPath = s.path;
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shotPath });
  return { content: [{ type: "text", text: ocr.text }] };
});

server.tool("ocr_regions", "Screenshot + OCR with detailed region positions (bounds, confidence)", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shotPath: string;
  let imgW: number, imgH: number;
  if (windowId) {
    const s = await bridge.call<any>("cg.captureWindow", { windowId });
    shotPath = s.path; imgW = s.width; imgH = s.height;
  } else {
    const s = await bridge.call<any>("cg.captureScreen");
    shotPath = s.path; imgW = s.width; imgH = s.height;
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shotPath });

  // Also get window bounds if windowId provided (for coordinate mapping)
  let winInfo: any = null;
  if (windowId) {
    const wins = await bridge.call<any[]>("app.windows");
    winInfo = wins.find((w: any) => w.windowId === windowId);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        text: ocr.text,
        regions: ocr.regions,
        image: { width: imgW, height: imgH },
        window: winInfo?.bounds || null,
      }, null, 2),
    }],
  };
});

// ── Input ──

server.tool("click", "Click at screen coordinates", {
  x: z.number().describe("Screen X coordinate"),
  y: z.number().describe("Screen Y coordinate"),
}, async ({ x, y }) => {
  await ensureBridge();
  await bridge.call("cg.mouseClick", { x, y });
  return { content: [{ type: "text", text: "Clicked (" + x + ", " + y + ")" }] };
});

server.tool("click_text", "Find text on a window via OCR and click it. Handles Retina + shadow coordinate mapping.", {
  windowId: z.number().describe("Window ID to search in"),
  text: z.string().describe("Text to find and click"),
  offset_y: z.number().optional().describe("Y offset in screen points from text center. Use -25 to click icon above a label."),
}, async ({ windowId, text, offset_y }) => {
  await ensureBridge();

  const wins = await bridge.call<any[]>("app.windows");
  const win = wins.find((w: any) => w.windowId === windowId);
  if (!win) return { content: [{ type: "text", text: "Window " + windowId + " not found" }] };
  const wb = win.bounds;

  const shot = await bridge.call<any>("cg.captureWindow", { windowId });
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });

  const match = ocr.regions.find((r: any) =>
    r.text.toLowerCase().includes(text.toLowerCase())
  );
  if (!match) {
    const available = ocr.regions.map((r: any) => r.text).join(", ");
    return { content: [{ type: "text", text: "'" + text + "' not found. Available: " + available }] };
  }

  // Shadow-corrected Retina coordinate mapping
  const contentW = wb.width * 2;
  const contentH = wb.height * 2;
  const shadowL = (shot.width - contentW) / 2;
  const shadowT = (shot.height - contentH) / 3;
  const imgCx = match.bounds.x + match.bounds.width / 2;
  const imgCy = match.bounds.y + match.bounds.height / 2;
  const sx = wb.x + (imgCx - shadowL) / 2;
  const sy = wb.y + (imgCy - shadowT) / 2 + (offset_y || 0);

  await bridge.call("cg.mouseMove", { x: sx, y: sy });
  await new Promise(r => setTimeout(r, 100));
  await bridge.call("cg.mouseClick", { x: sx, y: sy });

  return { content: [{ type: "text", text: "Clicked '" + match.text + "' at (" + Math.round(sx) + ", " + Math.round(sy) + ")" }] };
});

server.tool("type_text", "Type text using keyboard", {
  text: z.string().describe("Text to type"),
}, async ({ text }) => {
  await ensureBridge();
  await bridge.call("cg.typeText", { text });
  return { content: [{ type: "text", text: "Typed: " + text }] };
});

server.tool("key", "Press a key combination", {
  keys: z.string().describe("Key combo like 'cmd+c', 'enter', 'cmd+shift+n'. Use + to separate."),
}, async ({ keys }) => {
  await ensureBridge();
  await bridge.call("cg.keyCombo", { keys: keys.split("+") });
  return { content: [{ type: "text", text: "Key: " + keys }] };
});

// ── Gestures ──

server.tool("drag", "Drag from one point to another (slow, smooth)", {
  fromX: z.number(), fromY: z.number(),
  toX: z.number(), toY: z.number(),
}, async ({ fromX, fromY, toX, toY }) => {
  await ensureBridge();
  await bridge.call("cg.mouseDrag", { fromX, fromY, toX, toY });
  return { content: [{ type: "text", text: "Dragged (" + fromX + "," + fromY + ") → (" + toX + "," + toY + ")" }] };
});

server.tool("flick", "Fast swipe/flick gesture (for iOS home gesture etc)", {
  fromX: z.number(), fromY: z.number(),
  toX: z.number(), toY: z.number(),
}, async ({ fromX, fromY, toX, toY }) => {
  await ensureBridge();
  await bridge.call("cg.mouseFlick", { fromX, fromY, toX, toY });
  return { content: [{ type: "text", text: "Flicked (" + fromX + "," + fromY + ") → (" + toX + "," + toY + ")" }] };
});

server.tool("scroll", "Scroll at a position", {
  x: z.number(), y: z.number(),
  deltaX: z.number().describe("Horizontal scroll amount"),
  deltaY: z.number().describe("Vertical scroll amount (negative = scroll down)"),
}, async ({ x, y, deltaX, deltaY }) => {
  await ensureBridge();
  await bridge.call("cg.scroll", { x, y, deltaX, deltaY });
  return { content: [{ type: "text", text: "Scrolled" }] };
});

// ── Accessibility ──

server.tool("ax_tree", "Get the accessibility UI tree of an app", {
  pid: z.number().describe("Process ID of the app"),
  maxDepth: z.number().optional().describe("Max tree depth (default 3)"),
}, async ({ pid, maxDepth }) => {
  await ensureBridge();
  const tree = await bridge.call<any>("ax.getElementTree", { pid, maxDepth: maxDepth || 3 });
  return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
});

server.tool("ax_find", "Find a UI element by text/title in an app", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Text to search for"),
}, async ({ pid, title }) => {
  await ensureBridge();
  const r = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("ax_press", "Find a UI element by title and press/click it via accessibility", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Element title to find and press"),
}, async ({ pid, title }) => {
  await ensureBridge();
  const el = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  await bridge.call("ax.performAction", { pid, elementPath: el.elementPath, action: "AXPress" });
  return { content: [{ type: "text", text: "Pressed '" + el.title + "' (" + el.role + ")" }] };
});

server.tool("menu_click", "Click a menu item in an app's menu bar", {
  pid: z.number().describe("Process ID"),
  menuPath: z.string().describe("Menu path like 'File/New' or 'View/Home Screen'"),
}, async ({ pid, menuPath }) => {
  await ensureBridge();
  await bridge.call("ax.menuClick", { pid, menuPath: menuPath.split("/") });
  return { content: [{ type: "text", text: "Menu: " + menuPath }] };
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
