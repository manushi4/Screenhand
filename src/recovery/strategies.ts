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

import type { BlockerType, RecoveryStrategy, RecoveryStep } from "./types.js";

/**
 * Built-in recovery strategies keyed by BlockerType, in priority order.
 * Strategies with empty steps are escalations — they signal that human
 * intervention is needed.
 */
const BUILTIN_STRATEGIES: ReadonlyArray<RecoveryStrategy> = [
  // ── unexpected_dialog ──
  {
    id: "dismiss_dialog_cancel",
    blockerType: "unexpected_dialog",
    label: "Dismiss dialog via Cancel",
    steps: [{ tool: "click_text", params: { text: "Cancel" }, description: "Click Cancel" }],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "dismiss_dialog_ok",
    blockerType: "unexpected_dialog",
    label: "Dismiss dialog via OK",
    steps: [{ tool: "click_text", params: { text: "OK" }, description: "Click OK" }],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "dismiss_dialog_escape",
    blockerType: "unexpected_dialog",
    label: "Dismiss dialog via Escape",
    steps: [{ tool: "key", params: { combo: "Escape" }, description: "Press Escape" }],
    postcondition: null,
    source: "builtin",
  },

  // ── permission_dialog ──
  {
    id: "grant_permission_allow",
    blockerType: "permission_dialog",
    label: "Grant permission via Allow",
    steps: [{ tool: "click_text", params: { text: "Allow" }, description: "Click Allow" }],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "grant_permission_ok",
    blockerType: "permission_dialog",
    label: "Grant permission via OK",
    steps: [{ tool: "click_text", params: { text: "OK" }, description: "Click OK" }],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "safari_allow_popup",
    blockerType: "permission_dialog",
    label: "Allow Safari popup via notification bar",
    steps: [
      { tool: "key", params: { combo: "cmd+z" }, description: "Undo popup block (shows notification)" },
      { tool: "screenshot", params: {}, description: "Check for popup notification bar" },
    ],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "safari_enable_popups_applescript",
    blockerType: "permission_dialog",
    label: "Enable popups for site via AppleScript",
    steps: [
      { tool: "applescript", params: { script: 'tell application "Safari" to activate' }, description: "Activate Safari" },
      { tool: "key", params: { combo: "cmd+," }, description: "Open Safari preferences" },
      { tool: "screenshot", params: {}, description: "Navigate to popup settings" },
    ],
    postcondition: null,
    source: "builtin",
  },

  // ── focus_lost ──
  {
    id: "refocus_app",
    blockerType: "focus_lost",
    label: "Refocus target application",
    steps: [{ tool: "focus", params: {}, description: "Focus target app" }],
    postcondition: null,
    source: "builtin",
  },

  // ── app_crashed ──
  {
    id: "relaunch_app",
    blockerType: "app_crashed",
    label: "Relaunch crashed application",
    steps: [
      { tool: "launch", params: {}, description: "Launch application" },
      { tool: "screenshot", params: {}, description: "Wait for app ready" },
    ],
    postcondition: null,
    source: "builtin",
  },

  // ── element_gone ──
  {
    id: "rescan_ax_tree",
    blockerType: "element_gone",
    label: "Rescan AX tree to relocate element",
    steps: [{ tool: "ui_tree", params: {}, description: "Refresh AX tree" }],
    postcondition: null,
    source: "builtin",
  },

  // ── selector_drift ──
  {
    id: "rescan_for_drift",
    blockerType: "selector_drift",
    label: "Rescan AX tree for selector drift",
    steps: [{ tool: "ui_tree", params: {}, description: "Rescan for drift" }],
    postcondition: null,
    source: "builtin",
  },

  // ── loading_stuck ──
  {
    id: "wait_for_load",
    blockerType: "loading_stuck",
    label: "Wait and recheck",
    steps: [{ tool: "screenshot", params: {}, description: "Wait via screenshot" }],
    postcondition: null,
    source: "builtin",
  },

  // ── network_error ──
  {
    id: "reload_page",
    blockerType: "network_error",
    label: "Reload page",
    steps: [{ tool: "key", params: { combo: "cmd+r" }, description: "Reload page" }],
    postcondition: null,
    source: "builtin",
  },

  // ── unknown_state ──
  {
    id: "full_perception_refresh",
    blockerType: "unknown_state",
    label: "Full perception refresh",
    steps: [
      { tool: "screenshot", params: {}, description: "Take screenshot" },
      { tool: "ui_tree", params: {}, description: "Refresh AX tree" },
    ],
    postcondition: null,
    source: "builtin",
  },

  // ── Escalation-only (no automated recovery possible) ──
  {
    id: "escalate_login",
    blockerType: "login_required",
    label: "Escalate: login required",
    steps: [],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "escalate_captcha",
    blockerType: "captcha",
    label: "Escalate: captcha",
    steps: [],
    postcondition: null,
    source: "builtin",
  },
  {
    id: "escalate_rate_limited",
    blockerType: "rate_limited",
    label: "Escalate: rate limited",
    steps: [],
    postcondition: null,
    source: "builtin",
  },
];

/** Return built-in strategies matching a blocker type, in priority order. */
export function getBuiltinStrategies(blockerType: BlockerType): RecoveryStrategy[] {
  return BUILTIN_STRATEGIES.filter((s) => s.blockerType === blockerType);
}

/**
 * Parse a solution text into concrete recovery steps.
 * Pattern-matches common instruction phrases to map to tool calls.
 * Falls back to screenshot with full solution as description.
 */
export function parseSolutionToSteps(
  solution: string,
): RecoveryStep[] {
  const steps: RecoveryStep[] = [];

  // Split multi-sentence solutions into individual instructions
  const sentences = solution.split(/[.;]\s+/).filter((s) => s.trim().length > 5);
  if (sentences.length === 0) sentences.push(solution);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const step = matchSolutionSentence(lower, sentence);
    steps.push(step);
  }

  return steps;
}

function matchSolutionSentence(lower: string, original: string): RecoveryStep {
  // Click/tap/select patterns
  const clickMatch = lower.match(/(?:click|tap|select|choose|press)\s+(?:the\s+)?['"]?([^'",.]+)['"]?/i);
  if (clickMatch && !/(?:cmd|ctrl|alt|shift|command)/i.test(clickMatch[1]!)) {
    // Trim trailing filler words like "button and wait", "and then", "to confirm"
    let clickText = clickMatch[1]!.trim()
      .replace(/\s+(?:button|link|icon|tab|menu|option)(?:\s+.*)?$/i, "")
      .replace(/\s+(?:and\s+.*|to\s+.*|in\s+.*|on\s+.*|from\s+.*|into\s+.*)$/i, "")
      .trim();
    if (!clickText) clickText = clickMatch[1]!.trim();
    return { tool: "click_text", params: { text: clickText }, description: original };
  }

  // Keyboard shortcut patterns
  const keyMatch = lower.match(/(?:press|use|hit)\s+(?:the\s+)?(?:shortcut\s+)?((?:cmd|ctrl|alt|shift|command|control|option)[\s+]+\w+)/i);
  if (keyMatch) {
    const key = keyMatch[1]!.replace(/\s+/g, "+").replace(/command/i, "Cmd").replace(/control/i, "Ctrl");
    return { tool: "key", params: { combo: key }, description: original };
  }

  // Navigate/go to/open URL patterns
  const navMatch = lower.match(/(?:navigate\s+to|go\s+to|open|visit)\s+(?:the\s+)?(?:url\s+)?(https?:\/\/\S+)/i);
  if (navMatch) {
    const url = navMatch[1]!;
    // Reject javascript: and data: URLs
    if (/^javascript:/i.test(url) || /^data:/i.test(url)) {
      return { tool: "screenshot", params: {}, description: `Blocked unsafe URL: ${original}` };
    }
    return { tool: "browser_navigate", params: { url }, description: original };
  }

  // Type/enter/input patterns
  const typeMatch = lower.match(/(?:type|enter|input)\s+['"]?([^'",.]+)['"]?/i);
  if (typeMatch) {
    return { tool: "type_text", params: { text: typeMatch[1]!.trim() }, description: original };
  }

  // Fallback: screenshot with full solution as description
  return { tool: "screenshot", params: {}, description: `Reference solution: ${original}` };
}

/**
 * Parse app-specific recovery strategies from reference JSON errors.
 */
export function parseReferenceStrategies(
  errors: Array<{ error: string; context?: string; solution: string; severity?: string }>,
  blockerType: BlockerType,
): RecoveryStrategy[] {
  return errors.map((e, idx) => ({
    id: `ref_${blockerType}_${idx}`,
    blockerType,
    label: `Reference: ${e.error}`,
    steps: parseSolutionToSteps(e.solution),
    postcondition: null,
    source: "reference" as const,
  }));
}

/**
 * Inject bundleId into strategy steps that need it (focus, launch).
 * Returns a shallow clone.
 */
export function buildStrategyWithContext(
  strategy: RecoveryStrategy,
  bundleId: string | null,
  pid?: number,
): RecoveryStrategy {
  if (!bundleId && !pid) return strategy;
  return {
    ...strategy,
    steps: strategy.steps.map((step) => {
      if (bundleId && (step.tool === "focus" || step.tool === "launch")) {
        return { ...step, params: { ...step.params, bundleId } };
      }
      if (pid != null && step.tool === "ui_tree") {
        return { ...step, params: { ...step.params, pid } };
      }
      return step;
    }),
  };
}
