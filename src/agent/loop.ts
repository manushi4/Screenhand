/**
 * ScreenHand Agent Loop
 *
 * Continuous observe → decide → act loop powered by Claude.
 * Uses element_tree (accessibility tree) as the primary observation — not screenshots.
 * ~50ms per observe, ~50ms per action. Only the LLM call adds latency.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AutomationRuntimeService } from "../runtime/service.js";
import type { AXNode } from "../types.js";

export interface AgentLoopOptions {
  /** Max iterations before stopping (default: 50) */
  maxSteps?: number;
  /** Claude model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Max tokens per LLM response (default: 1024) */
  maxTokens?: number;
  /** Callback for each step — for logging/streaming */
  onStep?: (step: AgentStep) => void;
  /** Whether to include a screenshot on the first observe (default: false) */
  screenshotOnStart?: boolean;
}

export interface AgentStep {
  index: number;
  observation: string;
  reasoning: string;
  action: AgentAction | null;
  result: string;
  done: boolean;
  durationMs: number;
}

export type AgentAction =
  | { tool: "press"; target: string }
  | { tool: "type_into"; target: string; text: string }
  | { tool: "navigate"; url: string }
  | { tool: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { tool: "key_combo"; keys: string[] }
  | { tool: "menu_click"; menuPath: string[] }
  | { tool: "app_launch"; bundleId: string }
  | { tool: "app_focus"; bundleId: string }
  | { tool: "extract"; target: string; format: "text" | "table" | "json" }
  | { tool: "wait"; ms: number }
  | { tool: "done"; summary: string };

export interface AgentResult {
  success: boolean;
  summary: string;
  steps: AgentStep[];
  totalMs: number;
}

/**
 * Compact AX tree representation for LLM consumption.
 * Converts the full AXNode tree into a concise text format:
 *   [button] "Send" (350,200)
 *   [textField] "Search" value="hello" (100,50)
 */
function compactTree(node: AXNode, depth = 0, maxDepth = 5): string {
  if (depth > maxDepth) return "";

  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  // Role
  const role = node.role.replace("AX", "").toLowerCase();

  // Label — prefer title, then description, then identifier
  const label = node.title || node.description || node.identifier || "";

  // Value
  const val = node.value ? ` value="${node.value.slice(0, 50)}"` : "";

  // Position
  const pos = node.position ? ` (${Math.round(node.position.x)},${Math.round(node.position.y)})` : "";

  // Focused/enabled markers
  const markers: string[] = [];
  if (node.focused) markers.push("focused");
  if (node.enabled === false) markers.push("disabled");
  const markerStr = markers.length ? ` [${markers.join(",")}]` : "";

  // Skip noise nodes with no useful info
  const isNoise = !label && !val && !node.focused && (role === "group" || role === "splitgroup" || role === "scrollarea");

  if (!isNoise) {
    parts.push(`${indent}[${role}] "${label}"${val}${pos}${markerStr}`);
  }

  if (node.children) {
    for (const child of node.children) {
      const childStr = compactTree(child, isNoise ? depth : depth + 1, maxDepth);
      if (childStr) parts.push(childStr);
    }
  }

  return parts.join("\n");
}

const SYSTEM_PROMPT = `You are a desktop automation agent. You control a computer through ScreenHand tools.

On each turn you receive the current UI state as an accessibility tree. You must decide the SINGLE next action to take.

Respond in this exact JSON format (no markdown, no explanation outside the JSON):
{
  "reasoning": "Brief explanation of what you see and why you're taking this action",
  "action": { "tool": "...", ... },
  "done": false
}

When the task is fully complete, respond with:
{
  "reasoning": "Task is complete because ...",
  "action": { "tool": "done", "summary": "What was accomplished" },
  "done": true
}

Available actions:
- {"tool": "press", "target": "Button text or element name"}
- {"tool": "type_into", "target": "Field name", "text": "text to type"}
- {"tool": "navigate", "url": "https://..."}
- {"tool": "scroll", "direction": "up|down|left|right", "amount": 3}
- {"tool": "key_combo", "keys": ["cmd", "c"]}
- {"tool": "menu_click", "menuPath": ["File", "Save"]}
- {"tool": "app_launch", "bundleId": "com.apple.Safari"}
- {"tool": "app_focus", "bundleId": "com.apple.Safari"}
- {"tool": "extract", "target": "element name", "format": "text"}
- {"tool": "wait", "ms": 1000}
- {"tool": "done", "summary": "what was accomplished"}

Rules:
- Take ONE action per turn. After each action you'll see the updated UI.
- Use the accessibility tree to find elements — look for roles and labels.
- Target elements by their visible text/label, not coordinates (unless no label exists).
- If an action fails, try an alternative approach — don't repeat the same failed action.
- If you're stuck after 3 attempts, explain what's blocking you and mark done.
- Be efficient. Don't take unnecessary actions.`;

export async function runAgentLoop(
  runtime: AutomationRuntimeService,
  sessionId: string,
  task: string,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  const {
    maxSteps = 50,
    model = "claude-sonnet-4-20250514",
    maxTokens = 1024,
    onStep,
    screenshotOnStart = false,
  } = options;

  const client = new Anthropic();
  const steps: AgentStep[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const startTime = Date.now();

  // Optional initial screenshot for context
  if (screenshotOnStart) {
    await runtime.screenshot({ sessionId });
  }

  for (let i = 0; i < maxSteps; i++) {
    const stepStart = Date.now();

    // 1. OBSERVE — get accessibility tree (~50ms)
    const treeResult = await runtime.elementTree({ sessionId, maxDepth: 5 });
    let observation: string;

    if (treeResult.ok) {
      observation = compactTree(treeResult.data);
      // Truncate if too large to keep tokens manageable
      if (observation.length > 8000) {
        observation = observation.slice(0, 8000) + "\n... (truncated)";
      }
    } else {
      observation = `[Error getting UI tree: ${treeResult.error.message}]`;
    }

    // Also get app context
    let contextLine = "";
    try {
      const apps = await runtime.appList(sessionId);
      if (apps.ok) {
        const active = apps.data.find(a => a.isActive);
        if (active) contextLine = `Active app: ${active.name} (${active.bundleId})`;
      }
    } catch { /* ignore */ }

    // 2. BUILD prompt
    const userMsg = i === 0
      ? `Task: ${task}\n\nCurrent UI state:\n${contextLine}\n${observation}`
      : `Action result: ${steps[i - 1]!.result}\n\nUpdated UI state:\n${contextLine}\n${observation}`;

    messages.push({ role: "user", content: userMsg });

    // 3. DECIDE — ask Claude what to do next
    let reasoning = "";
    let action: AgentAction | null = null;
    let done = false;

    try {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages,
      });

      const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
      messages.push({ role: "assistant", content: text });

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        reasoning = parsed.reasoning ?? "";
        action = parsed.action ?? null;
        done = parsed.done === true;
      } else {
        reasoning = text;
      }
    } catch (e) {
      reasoning = `LLM error: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 4. ACT — execute the action (~50ms)
    let result = "";

    if (action) {
      try {
        result = await executeAction(runtime, sessionId, action);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      result = "No action taken";
    }

    // Record step
    const step: AgentStep = {
      index: i,
      observation: observation.slice(0, 500),
      reasoning,
      action,
      result,
      done,
      durationMs: Date.now() - stepStart,
    };
    steps.push(step);

    if (onStep) onStep(step);

    if (done) break;
  }

  const lastStep = steps[steps.length - 1];
  const summary = lastStep?.action?.tool === "done"
    ? (lastStep.action as { tool: "done"; summary: string }).summary
    : `Stopped after ${steps.length} steps`;

  return {
    success: lastStep?.done ?? false,
    summary,
    steps,
    totalMs: Date.now() - startTime,
  };
}

async function executeAction(
  runtime: AutomationRuntimeService,
  sessionId: string,
  action: AgentAction,
): Promise<string> {
  switch (action.tool) {
    case "press": {
      const r = await runtime.press({
        sessionId,
        target: { type: "text", value: action.target },
      });
      return r.ok ? `Pressed "${action.target}"` : `Failed: ${r.error.message}`;
    }
    case "type_into": {
      const r = await runtime.typeInto({
        sessionId,
        target: { type: "text", value: action.target },
        text: action.text,
      });
      return r.ok ? `Typed "${action.text}" into "${action.target}"` : `Failed: ${r.error.message}`;
    }
    case "navigate": {
      const r = await runtime.navigate({ sessionId, url: action.url });
      return r.ok ? `Navigated to ${action.url}` : `Failed: ${r.error.message}`;
    }
    case "scroll": {
      const input: import("../types.js").ScrollInput = { sessionId, direction: action.direction };
      if (typeof action.amount === "number") input.amount = action.amount;
      const r = await runtime.scroll(input);
      return r.ok ? `Scrolled ${action.direction}` : `Failed: ${r.error.message}`;
    }
    case "key_combo": {
      const r = await runtime.keyCombo({ sessionId, keys: action.keys });
      return r.ok ? `Key combo: ${action.keys.join("+")}` : `Failed: ${r.error.message}`;
    }
    case "menu_click": {
      const r = await runtime.menuClick({ sessionId, menuPath: action.menuPath });
      return r.ok ? `Menu: ${action.menuPath.join(" → ")}` : `Failed: ${r.error.message}`;
    }
    case "app_launch": {
      const r = await runtime.appLaunch({ sessionId, bundleId: action.bundleId });
      return r.ok ? `Launched ${action.bundleId}` : `Failed: ${r.error.message}`;
    }
    case "app_focus": {
      const r = await runtime.appFocus({ sessionId, bundleId: action.bundleId });
      return r.ok ? `Focused ${action.bundleId}` : `Failed: ${r.error.message}`;
    }
    case "extract": {
      const r = await runtime.extract({
        sessionId,
        target: { type: "text", value: action.target },
        format: action.format,
      });
      return r.ok ? `Extracted: ${JSON.stringify(r.data).slice(0, 500)}` : `Failed: ${r.error.message}`;
    }
    case "wait": {
      await new Promise(resolve => setTimeout(resolve, action.ms));
      return `Waited ${action.ms}ms`;
    }
    case "done": {
      return `Task complete: ${action.summary}`;
    }
    default:
      return `Unknown action: ${(action as { tool: string }).tool}`;
  }
}
