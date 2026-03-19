// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

import type { Playbook, PlaybookStep, PlaybookFlow } from "../playbook/types.js";
import type { Strategy, StrategyStep } from "../memory/types.js";
import type { ActionPlan, PlanStep, PlannerConfig } from "./types.js";
import { DEFAULT_PLANNER_CONFIG } from "./types.js";
import type { LearningEngine } from "../learning/engine.js";

/** Minimum score threshold for a learned locator to override a playbook/strategy locator */
const LEARNED_LOCATOR_MIN_SCORE = 0.7;

/**
 * Safe MCP tool names for flow step parsing — excludes dangerous tools
 * that allow arbitrary code execution (browser_js, applescript).
 * These tools should only come from trusted playbooks, not parsed flow descriptions.
 */
const KNOWN_TOOLS = new Set([
  "browser_navigate", "browser_click", "browser_type", "browser_wait",
  "browser_dom", "browser_open", "browser_tabs",
  "browser_page_info", "browser_fill_form", "browser_human_click", "browser_stealth",
  "screenshot", "screenshot_file", "ocr", "ui_tree", "ui_find", "ui_press",
  "ui_set_value", "click_text", "click", "click_with_fallback", "type_text",
  "type_with_fallback", "key", "drag", "scroll", "scroll_with_fallback",
  "launch", "focus", "menu_click", "wait_for_state",
  "select_with_fallback", "read_with_fallback", "locate_with_fallback",
  // Excluded: "browser_js", "applescript" — arbitrary code execution risk
]);

/**
 * Maps PlaybookStep action types to MCP tool names.
 */
const ACTION_TO_TOOL: Record<string, string> = {
  navigate: "browser_navigate",
  press: "click_with_fallback",
  type_into: "type_with_fallback",
  key: "key",
  scroll: "scroll_with_fallback",
  wait: "wait_for_state",
  screenshot: "screenshot",
  extract: "browser_js",
  menu_click: "menu_click",
  browser_js: "browser_js",
  browser_click: "browser_click",
  browser_type: "browser_type",
  cdp_key_event: "browser_js",
  key_combo: "key",
};

/**
 * Converts a Playbook into an ActionPlan for deterministic execution.
 * No LLM calls needed — all steps come from the playbook.
 */
export function playbookToPlan(
  playbook: Playbook,
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
  learningEngine?: LearningEngine | null,
  bundleId?: string,
): ActionPlan {
  const steps: PlanStep[] = playbook.steps.map((step, i) =>
    playbookStepToPlanStep(step, i, config, learningEngine, bundleId),
  );

  const reliability =
    playbook.successCount + playbook.failCount > 0
      ? playbook.successCount / (playbook.successCount + playbook.failCount)
      : 0.5;

  return {
    steps,
    currentStepIndex: 0,
    confidence: reliability,
    source: "playbook",
    sourceId: playbook.id,
  };
}

/**
 * Converts a Strategy (from memory recall) into an ActionPlan.
 */
export function strategyToPlan(
  strategy: Strategy,
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
  learningEngine?: LearningEngine | null,
  bundleId?: string,
): ActionPlan {
  const steps: PlanStep[] = strategy.steps.map((step, i) =>
    strategyStepToPlanStep(step, i, config, learningEngine, bundleId),
  );

  const reliability =
    strategy.successCount + strategy.failCount > 0
      ? strategy.successCount / (strategy.successCount + strategy.failCount)
      : 0.5;

  return {
    steps,
    currentStepIndex: 0,
    confidence: reliability,
    source: "strategy",
    sourceId: strategy.id,
  };
}

/**
 * Runtime context injected into flow plans so steps have concrete params.
 */
export interface FlowRuntimeContext {
  pid?: number | undefined;
  windowId?: number | undefined;
  bundleId?: string | undefined;
}

/**
 * Try to parse a flow step description into a concrete tool + params.
 * Many flow steps embed tool names (e.g. "browser_navigate to canva.com").
 * Returns null if the step is too vague to parse.
 */
function parseFlowStep(
  stepDesc: string,
  ctx: FlowRuntimeContext,
): { tool: string; params: Record<string, unknown> } | null {
  const desc = stepDesc.trim();

  // Pattern 1: function call syntax — tool(key: 'value')
  // Only accept known MCP tool names to prevent arbitrary tool injection
  const funcMatch = desc.match(/^(\w+)\((.+)\)$/);
  if (funcMatch) {
    const tool = funcMatch[1]!;
    if (!KNOWN_TOOLS.has(tool.toLowerCase())) return null;
    const argsStr = funcMatch[2]!;
    const params: Record<string, unknown> = {};
    const argPattern = /(\w+)\s*:\s*'([^']+)'/g;
    let m;
    while ((m = argPattern.exec(argsStr)) !== null) {
      params[m[1]!] = m[2]!;
    }
    return { tool, params };
  }

  // Pattern 2: tool_name at start of description
  const toolPrefixMatch = desc.match(
    /^(browser_navigate|browser_click|browser_type|browser_wait|browser_dom|browser_open|browser_tabs|browser_page_info|browser_fill_form|screenshot|screenshot_file|ocr|ui_tree|ui_find|ui_press|ui_set_value|click_text|click|type_text|key|drag|scroll|launch|focus|menu_click|wait_for_state)\b/i,
  );
  if (toolPrefixMatch) {
    const tool = toolPrefixMatch[1]!.toLowerCase();
    const rest = desc.slice(toolPrefixMatch[0].length).trim();
    const params: Record<string, unknown> = {};

    if (tool === "browser_navigate") {
      const urlMatch = rest.match(/(?:to\s+)?(\S+\.(?:com|org|net|io|dev|app|co)\S*)/i);
      if (urlMatch) params.url = urlMatch[1]!.startsWith("http") ? urlMatch[1]! : `https://${urlMatch[1]}`;
    } else if (tool === "browser_click") {
      const quoteMatch = rest.match(/'([^']+)'|"([^"]+)"/);
      if (quoteMatch) params.selector = quoteMatch[1] ?? quoteMatch[2]!;
    } else if (tool === "browser_type") {
      const quoteMatch = rest.match(/'([^']+)'|"([^"]+)"/);
      if (quoteMatch) params.text = quoteMatch[1] ?? quoteMatch[2]!;
    } else if (tool === "click_text") {
      const quoteMatch = rest.match(/'([^']+)'|"([^"]+)"/);
      if (quoteMatch) {
        params.text = quoteMatch[1] ?? quoteMatch[2]!;
        if (ctx.windowId) params.windowId = ctx.windowId;
      }
    } else if (tool === "ui_press") {
      const quoteMatch = rest.match(/'([^']+)'|"([^"]+)"/);
      if (quoteMatch) {
        params.title = quoteMatch[1] ?? quoteMatch[2]!;
        if (ctx.pid) params.pid = ctx.pid;
      }
    } else if (tool === "launch") {
      const bundleMatch = rest.match(/'([^']+)'|"([^"]+)"/);
      if (bundleMatch) params.bundleId = bundleMatch[1] ?? bundleMatch[2]!;
    } else if (tool === "focus") {
      const appMatch = rest.match(/'([^']+)'|"([^"]+)"|(\S+)/);
      if (appMatch) params.bundleId = (appMatch[1] ?? appMatch[2] ?? appMatch[3]!).replace(/['"]/g, "");
    } else if (tool === "key") {
      const keyMatch = rest.match(/'([^']+)'|"([^"]+)"|(\S+)/);
      if (keyMatch) params.combo = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]!;
    }
    // screenshot, ocr, ui_tree need no extra params

    return { tool, params };
  }

  return null;
}

/**
 * Converts a reference flow (from references/*.json) into an ActionPlan.
 * Parses tool names and params from step descriptions where possible.
 * Steps that can't be parsed are marked requiresLLM=true for client resolution.
 */
export function flowToPlan(
  flowName: string,
  flow: PlaybookFlow,
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
  runtimeContext?: FlowRuntimeContext,
): ActionPlan {
  const ctx = runtimeContext ?? {};
  const steps: PlanStep[] = flow.steps.map((stepDesc) => {
    const parsed = parseFlowStep(stepDesc, ctx);
    if (parsed) {
      return {
        tool: parsed.tool,
        params: parsed.params,
        expectedPostcondition: null,
        timeout: config.defaultStepTimeout,
        fallbackTool: null,
        requiresLLM: false,
        status: "pending" as const,
        description: stepDesc,
      };
    }
    return {
      tool: "",
      params: {},
      expectedPostcondition: null,
      timeout: config.defaultStepTimeout,
      fallbackTool: null,
      requiresLLM: true,
      status: "pending" as const,
      description: stepDesc,
    };
  });

  const executableCount = steps.filter((s) => !s.requiresLLM).length;
  const confidence = steps.length > 0 ? 0.3 + 0.4 * (executableCount / steps.length) : 0;

  return {
    steps,
    currentStepIndex: 0,
    confidence,
    source: "reference_flow",
    sourceId: flowName,
  };
}

function playbookStepToPlanStep(
  step: PlaybookStep,
  _index: number,
  config: PlannerConfig,
  learningEngine?: LearningEngine | null,
  bundleId?: string,
): PlanStep {
  const tool = ACTION_TO_TOOL[step.action] ?? step.action;
  const params: Record<string, unknown> = {};

  if (step.target) params.target = step.target;
  if (step.text) params.text = step.text;
  if (step.url) params.url = step.url;
  if (step.keys) params.keys = step.keys;
  if (step.code) params.code = step.code;
  if (step.format) params.format = step.format;
  if (step.amount !== undefined) params.amount = step.amount;
  if (step.locateByOcr) {
    params.locateByOcr = step.locateByOcr;
    if (step.offsetX !== undefined) params.offsetX = step.offsetX;
    if (step.offsetY !== undefined) params.offsetY = step.offsetY;
  }
  if (step.keyEvent) params.keyEvent = step.keyEvent;
  if (step.menuPath) params.menuPath = step.menuPath;
  if (step.ms !== undefined) params.ms = step.ms;

  // Normalize keys array → combo string for the key tool
  if (tool === "key" && Array.isArray(params.keys)) {
    params.combo = (params.keys as string[]).join("+");
    delete params.keys;
  }
  // Normalize menuPath array → "/" string for menu_click
  if (tool === "menu_click" && Array.isArray(params.menuPath)) {
    params.menuPath = (params.menuPath as string[]).join("/");
  }

  // Overlay learned locator if confidence is high enough
  applyLearnedLocator(params, tool, learningEngine, bundleId);

  return {
    tool,
    params,
    expectedPostcondition: step.verify
      ? { type: "control_exists", target: step.verify }
      : null,
    timeout: step.verifyTimeoutMs ?? config.defaultStepTimeout,
    fallbackTool: null,
    requiresLLM: false,
    status: "pending",
    description: step.description ?? `${step.action} ${step.target ?? ""}`.trim(),
  };
}

function strategyStepToPlanStep(
  step: StrategyStep,
  _index: number,
  config: PlannerConfig,
  learningEngine?: LearningEngine | null,
  bundleId?: string,
): PlanStep {
  const params = { ...step.params };

  // Overlay learned locator if confidence is high enough
  applyLearnedLocator(params, step.tool, learningEngine, bundleId);

  return {
    tool: step.tool,
    params,
    expectedPostcondition: null,
    timeout: config.defaultStepTimeout,
    fallbackTool: null,
    requiresLLM: false,
    status: "pending",
    description: `${step.tool} (from strategy)`,
  };
}

/**
 * If the learning engine has a proven locator for this tool×app pair,
 * override the step's target/selector with the learned one.
 */
function applyLearnedLocator(
  params: Record<string, unknown>,
  tool: string,
  learningEngine?: LearningEngine | null,
  bundleId?: string,
): void {
  if (!learningEngine || !bundleId) return;

  const rec = learningEngine.recommendLocator(bundleId, tool);
  if (!rec || rec.score < LEARNED_LOCATOR_MIN_SCORE) return;

  // Only override target-based params — don't replace url, keys, code, etc.
  if (params.target !== undefined || params.selector !== undefined) {
    params._originalTarget = params.target ?? params.selector;
    params.target = rec.locator;
    params._learnedLocator = true;
    if (rec.method === "cdp") {
      params.selector = rec.locator;
    }
  }
}
