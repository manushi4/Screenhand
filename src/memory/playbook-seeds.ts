// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.

/**
 * Playbook Seeds — converts playbook reference knowledge into memory-compatible formats.
 *
 * Reads all playbooks from disk and extracts:
 *   - errors[]       → ErrorPattern[]  (for quickErrorCheck auto-warnings)
 *   - flows{}        → Learning[]      (for pattern recall)
 *   - selectors{}    → Learning[]      (for verified selector patterns)
 *   - policyNotes{}  → Learning[]      (for rate limits and safety)
 *
 * Called once during MemoryStore.init() to seed the memory system with
 * months of team-curated platform knowledge.
 */

import fs from "node:fs";
import path from "node:path";
import type { ErrorPattern } from "./types.js";
import type { Learning } from "./service.js";

interface PlaybookRaw {
  id?: string;
  platform?: string;
  playbook?: string;
  errors?: Array<{
    error: string;
    context: string;
    solution: string;
    severity: "high" | "medium" | "low";
  }>;
  flows?: Record<string, {
    steps?: string[];
    description?: string;
    guards?: string[];
    why?: string;
    tips?: string[];
    selectors?: Record<string, string>;
  }>;
  selectors?: Record<string, Record<string, string>>;
  policyNotes?: Record<string, string[]>;
  detection?: Record<string, string>;
  urls?: Record<string, string>;
  successCount?: number;
  failCount?: number;
}

// ── Tool name inference from error/solution text ──

const TOOL_KEYWORDS: Record<string, string[]> = {
  browser_click: ["click", "el.click", ".click()", "button"],
  browser_human_click: ["human_click", "dispatchMouseEvent", "CDP Input"],
  browser_fill_form: ["fill_form", "browser_fill_form", "form"],
  browser_type: ["browser_type", "type into", "typing"],
  browser_js: ["browser_js", "evaluate", "script", "execCommand"],
  browser_navigate: ["navigate", "navigation", "url"],
  browser_dom: ["querySelector", "selector", "DOM"],
  browser_wait: ["wait", "timeout", "load"],
  click: ["native click", "coordinates", "screen click"],
  type_text: ["type_text", "native typing"],
  scroll: ["scroll"],
};

function inferTool(text: string): string {
  const lower = text.toLowerCase();
  for (const [tool, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) return tool;
  }
  return "browser_click"; // default — most errors are click-related
}

// ── Main seed functions ──

/**
 * Read all playbooks from a directory and extract error patterns.
 * These get loaded into memory's errorsCache so quickErrorCheck() catches them.
 */
export function seedErrorsFromPlaybooks(playbooksDir: string): ErrorPattern[] {
  const playbooks = loadPlaybooks(playbooksDir);
  const errors: ErrorPattern[] = [];
  const seen = new Set<string>(); // deduplicate by error text

  for (const pb of playbooks) {
    const platform = pb.platform ?? pb.id ?? "unknown";

    // Extract from errors[]
    if (pb.errors && Array.isArray(pb.errors)) {
      for (const err of pb.errors) {
        const key = `${platform}::${err.error}`;
        if (seen.has(key)) continue;
        seen.add(key);

        errors.push({
          id: `pb_err_${platform}_${errors.length}`,
          tool: inferTool(`${err.error} ${err.context} ${err.solution}`),
          params: { _source: "playbook", _platform: platform },
          error: `[${platform}] ${err.error}`,
          resolution: err.solution,
          occurrences: err.severity === "high" ? 10 : err.severity === "medium" ? 5 : 2,
          lastSeen: new Date().toISOString(),
        });
      }
    }

    // Extract from flows — tips and why fields often contain error knowledge
    if (pb.flows) {
      for (const [flowName, flow] of Object.entries(pb.flows)) {
        if (flow.why && flow.why.includes("doesn't") || flow.why?.includes("don't") || flow.why?.includes("NOT")) {
          const key = `${platform}::${flowName}::why`;
          if (seen.has(key)) continue;
          seen.add(key);

          errors.push({
            id: `pb_err_${platform}_flow_${errors.length}`,
            tool: inferTool(flow.why ?? ""),
            params: { _source: "playbook", _platform: platform, _flow: flowName },
            error: `[${platform}/${flowName}] ${flow.why!.slice(0, 200)}`,
            resolution: flow.steps?.join(" → ") ?? null,
            occurrences: 5,
            lastSeen: new Date().toISOString(),
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Read all playbooks and extract learnings (selectors, patterns, policy notes).
 * These get loaded into memory's learningsCache so queryPatterns() finds them.
 */
export function seedLearningsFromPlaybooks(playbooksDir: string): Omit<Learning, "id">[] {
  const playbooks = loadPlaybooks(playbooksDir);
  const learnings: Omit<Learning, "id">[] = [];

  for (const pb of playbooks) {
    const platform = pb.platform ?? pb.id ?? "unknown";
    const reliability = (pb.successCount ?? 0) + (pb.failCount ?? 0) > 0
      ? (pb.successCount ?? 0) / ((pb.successCount ?? 0) + (pb.failCount ?? 0))
      : 0.7;

    // Selectors → learnings (verified working CSS selectors)
    if (pb.selectors) {
      for (const [group, sels] of Object.entries(pb.selectors)) {
        for (const [name, selector] of Object.entries(sels)) {
          // Skip notes/annotations (keys starting with _)
          if (name.startsWith("_")) continue;

          learnings.push({
            scope: `chrome/${platform}`,
            pattern: `${group}.${name}: ${selector}`,
            method: "cdp",
            confidence: reliability,
            successCount: Math.max(1, Math.round(reliability * 10)),
            failCount: Math.round((1 - reliability) * 10),
            lastSeen: new Date().toISOString(),
            fix: null,
          });
        }
      }
    }

    // Flow selectors → learnings
    if (pb.flows) {
      for (const [flowName, flow] of Object.entries(pb.flows)) {
        if (flow.selectors) {
          for (const [name, selector] of Object.entries(flow.selectors)) {
            learnings.push({
              scope: `chrome/${platform}/${flowName}`,
              pattern: `${name}: ${selector}`,
              method: "cdp",
              confidence: reliability,
              successCount: Math.max(1, Math.round(reliability * 10)),
              failCount: Math.round((1 - reliability) * 10),
              lastSeen: new Date().toISOString(),
              fix: null,
            });
          }
        }
      }
    }

    // Policy notes → learnings (rate limits, safety rules)
    if (pb.policyNotes) {
      for (const [category, notes] of Object.entries(pb.policyNotes)) {
        for (const note of notes) {
          learnings.push({
            scope: `policy/${platform}`,
            pattern: `[${category}] ${note}`,
            method: "cdp",
            confidence: 1.0,
            successCount: 10,
            failCount: 0,
            lastSeen: new Date().toISOString(),
            fix: null,
          });
        }
      }
    }

    // Detection expressions → learnings
    if (pb.detection) {
      for (const [name, expr] of Object.entries(pb.detection)) {
        learnings.push({
          scope: `chrome/${platform}/detection`,
          pattern: `${name}: ${expr}`,
          method: "cdp",
          confidence: reliability,
          successCount: Math.max(1, Math.round(reliability * 10)),
          failCount: 0,
          lastSeen: new Date().toISOString(),
          fix: null,
        });
      }
    }
  }

  return learnings;
}

// ── Helpers ──

function loadPlaybooks(dir: string): PlaybookRaw[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const playbooks: PlaybookRaw[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PlaybookRaw;
      // Ensure it has an id
      if (!raw.id) raw.id = file.replace(".json", "");
      if (!raw.platform) raw.platform = raw.id;
      playbooks.push(raw);
    } catch {
      // Skip unparseable files
    }
  }

  return playbooks;
}
