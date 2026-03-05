import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AutomationRuntimeService } from "../runtime/service.js";
import type { Target, WaitCondition, ExtractFormat } from "../types.js";

// ── Schema building blocks ──

const TargetSchema = z.union([
  z.string().describe("Shorthand: text to find, or 'css=...' / 'text=...' / 'ax_id=...' prefix"),
  z.object({
    text: z.string(),
    exact: z.boolean().optional(),
  }).describe("Find by visible text"),
  z.object({
    role: z.string(),
    name: z.string(),
    exact: z.boolean().optional(),
  }).describe("Find by ARIA/AX role and accessible name"),
  z.object({
    selector: z.string(),
  }).describe("Find by CSS selector (browser) or AX identifier (desktop)"),
  z.object({
    x: z.number(),
    y: z.number(),
  }).describe("Click at screen coordinates"),
  z.object({
    attribute: z.string(),
    value: z.string(),
  }).describe("Find by accessibility attribute"),
]);

const WaitConditionSchema = z.object({
  type: z.enum([
    "selector_visible",
    "selector_hidden",
    "url_matches",
    "text_appears",
    "spinner_disappears",
    "element_exists",
    "element_gone",
    "window_title_matches",
    "app_idle",
  ]),
  selector: z.string().optional(),
  regex: z.string().optional(),
  text: z.string().optional(),
  target: TargetSchema.optional(),
  bundleId: z.string().optional(),
  timeoutMs: z.number().optional(),
}).describe("Condition to wait for");

const RegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

// ── Target parser ──

function parseTarget(input: unknown): Target {
  if (typeof input === "string") {
    if (input.startsWith("css=")) return { type: "selector", value: input.slice(4) };
    if (input.startsWith("text=")) return { type: "text", value: input.slice(5), exact: true };
    if (input.startsWith("ax_id=")) return { type: "ax_attribute", attribute: "identifier", value: input.slice(6) };
    return { type: "text", value: input };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.selector === "string") return { type: "selector", value: obj.selector };
  if (typeof obj.text === "string") return { type: "text", value: obj.text, exact: obj.exact === true };
  if (typeof obj.role === "string" && typeof obj.name === "string") return { type: "role", role: obj.role, name: obj.name, exact: obj.exact === true };
  if (typeof obj.x === "number" && typeof obj.y === "number") return { type: "coordinates", x: obj.x, y: obj.y };
  if (typeof obj.attribute === "string" && typeof obj.value === "string") return { type: "ax_attribute", attribute: obj.attribute, value: obj.value };
  throw new Error("Invalid target");
}

function parseWaitCondition(input: unknown): WaitCondition {
  const obj = input as Record<string, unknown>;
  const type = obj.type as string;
  switch (type) {
    case "selector_visible": return { type: "selector_visible", selector: obj.selector as string };
    case "selector_hidden": return { type: "selector_hidden", selector: obj.selector as string };
    case "url_matches": return { type: "url_matches", regex: obj.regex as string };
    case "text_appears": return { type: "text_appears", text: obj.text as string };
    case "spinner_disappears": return { type: "spinner_disappears", selector: obj.selector as string };
    case "element_exists": return { type: "element_exists", target: parseTarget(obj.target) };
    case "element_gone": return { type: "element_gone", target: parseTarget(obj.target) };
    case "window_title_matches": return { type: "window_title_matches", regex: obj.regex as string };
    case "app_idle": {
      const cond: WaitCondition = { type: "app_idle", bundleId: obj.bundleId as string };
      if (typeof obj.timeoutMs === "number") (cond as { type: "app_idle"; bundleId: string; timeoutMs: number }).timeoutMs = obj.timeoutMs;
      return cond;
    }
    default: throw new Error(`Unknown wait condition type: ${type}`);
  }
}

// ── Helpers ──

function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ── Server builder ──

export function createMcpStdioServer(runtime: AutomationRuntimeService): McpServer {
  const mcp = new McpServer(
    { name: "screenhand", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "ScreenHand gives AI agents eyes and hands on the desktop. Use session_start to begin, then call tools to control apps.",
    },
  );

  // ── session_start ──
  mcp.tool(
    "session_start",
    "Start a new automation session. Returns a sessionId needed by all other tools. Automatically attaches to the frontmost app.",
    { profile: z.string().optional().describe("Session profile name (default: 'automation')") },
    async ({ profile }) => {
      try {
        const session = await runtime.sessionStart(profile);
        return ok(session);
      } catch (e) {
        return err(`Failed to start session: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── press ──
  mcp.tool(
    "press",
    "Click/press a UI element. Finds the element by text, role, selector, or coordinates, then clicks it.",
    {
      sessionId: z.string().describe("Session ID from session_start"),
      target: TargetSchema.describe("What to click — text string, {role, name}, {selector}, or {x, y}"),
      verify: WaitConditionSchema.optional().describe("Optional condition to verify after clicking"),
    },
    async ({ sessionId, target, verify }) => {
      const input: import("../types.js").PressInput = { sessionId, target: parseTarget(target) };
      if (verify) input.verify = parseWaitCondition(verify);
      const result = await runtime.press(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── type_into ──
  mcp.tool(
    "type_into",
    "Type text into a UI element (text field, search box, etc). Locates the field, optionally clears it, then types.",
    {
      sessionId: z.string(),
      target: TargetSchema.describe("The input field to type into"),
      text: z.string().describe("Text to type"),
      clear: z.boolean().optional().describe("Clear the field first (default: true)"),
      verify: WaitConditionSchema.optional(),
    },
    async ({ sessionId, target, text, clear, verify }) => {
      const input: import("../types.js").TypeIntoInput = { sessionId, target: parseTarget(target), text };
      if (typeof clear === "boolean") input.clear = clear;
      if (verify) input.verify = parseWaitCondition(verify);
      const result = await runtime.typeInto(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── navigate ──
  mcp.tool(
    "navigate",
    "Navigate a browser to a URL, or open an app via 'app://com.bundle.id'.",
    {
      sessionId: z.string(),
      url: z.string().describe("URL to navigate to, or 'app://bundleId' to launch an app"),
      timeoutMs: z.number().optional().describe("Navigation timeout in ms (default: 10000)"),
    },
    async ({ sessionId, url, timeoutMs }) => {
      const input: import("../types.js").NavigateInput = { sessionId, url };
      if (typeof timeoutMs === "number") input.timeoutMs = timeoutMs;
      const result = await runtime.navigate(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── wait_for ──
  mcp.tool(
    "wait_for",
    "Wait for a condition: element appears/disappears, text appears, URL changes, window title matches, etc.",
    {
      sessionId: z.string(),
      condition: WaitConditionSchema,
      timeoutMs: z.number().optional().describe("Timeout in ms (default: 2000)"),
    },
    async ({ sessionId, condition, timeoutMs }) => {
      const input: import("../types.js").WaitForInput = { sessionId, condition: parseWaitCondition(condition) };
      if (typeof timeoutMs === "number") input.timeoutMs = timeoutMs;
      const result = await runtime.waitFor(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── extract ──
  mcp.tool(
    "extract",
    "Extract data from a UI element. Returns text content, table data, or structured JSON from the element.",
    {
      sessionId: z.string(),
      target: TargetSchema,
      format: z.enum(["text", "table", "json"]).describe("Output format"),
    },
    async ({ sessionId, target, format }) => {
      const result = await runtime.extract({
        sessionId,
        target: parseTarget(target),
        format: format as ExtractFormat,
      });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── screenshot ──
  mcp.tool(
    "screenshot",
    "Capture a screenshot of the current app window or a specific screen region. Returns the file path.",
    {
      sessionId: z.string(),
      region: RegionSchema.optional().describe("Optional screen region to capture"),
    },
    async ({ sessionId, region }) => {
      const input: import("../types.js").ScreenshotInput = { sessionId };
      if (region) input.region = region;
      const result = await runtime.screenshot(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── app_launch ──
  mcp.tool(
    "app_launch",
    "Launch a macOS/Windows application by bundle ID (e.g., 'com.apple.Safari', 'com.google.Chrome').",
    {
      sessionId: z.string(),
      bundleId: z.string().describe("macOS bundle ID or Windows process name"),
    },
    async ({ sessionId, bundleId }) => {
      const result = await runtime.appLaunch({ sessionId, bundleId });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── app_focus ──
  mcp.tool(
    "app_focus",
    "Bring a running application to the foreground.",
    {
      sessionId: z.string(),
      bundleId: z.string(),
    },
    async ({ sessionId, bundleId }) => {
      const result = await runtime.appFocus({ sessionId, bundleId });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── app_list ──
  mcp.tool(
    "app_list",
    "List all running applications with their bundle IDs, names, and PIDs.",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const result = await runtime.appList(sessionId);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── window_list ──
  mcp.tool(
    "window_list",
    "List all visible windows with their titles, positions, and sizes.",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const result = await runtime.windowList(sessionId);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── menu_click ──
  mcp.tool(
    "menu_click",
    "Click a menu item by path. For example ['File', 'Save As...'] clicks File → Save As.",
    {
      sessionId: z.string(),
      menuPath: z.array(z.string()).describe("Menu path, e.g. ['File', 'New Window']"),
    },
    async ({ sessionId, menuPath }) => {
      const result = await runtime.menuClick({ sessionId, menuPath });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── key_combo ──
  mcp.tool(
    "key_combo",
    "Send a keyboard shortcut. Keys: 'cmd', 'ctrl', 'alt', 'shift', plus any character. E.g. ['cmd', 'c'] for copy.",
    {
      sessionId: z.string(),
      keys: z.array(z.string()).describe("Key combination, e.g. ['cmd', 's']"),
    },
    async ({ sessionId, keys }) => {
      const result = await runtime.keyCombo({ sessionId, keys });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── element_tree ──
  mcp.tool(
    "element_tree",
    "Get the accessibility element tree of the current app. Useful for understanding the UI structure and finding elements to interact with.",
    {
      sessionId: z.string(),
      maxDepth: z.number().optional().describe("Max tree depth (default: 5)"),
    },
    async ({ sessionId, maxDepth }) => {
      const input: import("../types.js").ElementTreeInput = { sessionId };
      if (typeof maxDepth === "number") input.maxDepth = maxDepth;
      const result = await runtime.elementTree(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── drag ──
  mcp.tool(
    "drag",
    "Drag from one UI element to another.",
    {
      sessionId: z.string(),
      from: TargetSchema.describe("Element to drag from"),
      to: TargetSchema.describe("Element to drag to"),
    },
    async ({ sessionId, from, to }) => {
      const result = await runtime.drag({
        sessionId,
        from: parseTarget(from),
        to: parseTarget(to),
      });
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── scroll ──
  mcp.tool(
    "scroll",
    "Scroll in a direction, optionally targeting a specific element.",
    {
      sessionId: z.string(),
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Scroll amount (default: 3)"),
      target: TargetSchema.optional().describe("Element to scroll within"),
    },
    async ({ sessionId, direction, amount, target }) => {
      const input: import("../types.js").ScrollInput = { sessionId, direction };
      if (typeof amount === "number") input.amount = amount;
      if (target) input.target = parseTarget(target);
      const result = await runtime.scroll(input);
      return result.ok ? ok(result) : err(result.error.message);
    },
  );

  // ── task_run ──
  mcp.tool(
    "task_run",
    "Run a complete task autonomously. Starts an observe→decide→act loop that uses the accessibility tree (not screenshots) to see the UI and Claude to decide each action. The loop continues until the task is fully done or max steps reached. Returns a summary of all actions taken.",
    {
      task: z.string().describe("Natural language description of the task to complete"),
      sessionId: z.string().optional().describe("Existing session ID (auto-creates if not provided)"),
      maxSteps: z.number().optional().describe("Max actions before stopping (default: 50)"),
      model: z.string().optional().describe("Claude model for decisions (default: claude-sonnet-4-20250514)"),
    },
    async ({ task, sessionId, maxSteps, model }) => {
      try {
        const { runAgentLoop } = await import("../agent/loop.js");

        // Auto-create session if not provided
        let sid = sessionId;
        if (!sid) {
          const session = await runtime.sessionStart();
          sid = session.sessionId;
        }

        const result = await runAgentLoop(runtime, sid, task, {
          maxSteps: maxSteps ?? 50,
          ...(model ? { model } : {}),
          onStep: (step) => {
            process.stderr.write(`[step ${step.index}] ${step.reasoning.slice(0, 80)} → ${step.action?.tool ?? "none"} (${step.durationMs}ms)\n`);
          },
        });

        return ok({
          success: result.success,
          summary: result.summary,
          totalSteps: result.steps.length,
          totalMs: result.totalMs,
          steps: result.steps.map(s => ({
            reasoning: s.reasoning,
            action: s.action,
            result: s.result,
            durationMs: s.durationMs,
          })),
        });
      } catch (e) {
        return err(`Agent loop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return mcp;
}

export async function startMcpStdioServer(runtime: AutomationRuntimeService): Promise<void> {
  const mcp = createMcpStdioServer(runtime);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
