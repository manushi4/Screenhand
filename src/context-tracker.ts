// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.

/**
 * ContextTracker — lightweight singleton that connects tool execution to playbook knowledge.
 *
 * Three jobs, each fires at the right moment:
 *   1. DETECT context  — on domain/app change (from tool params), cache matching playbook
 *   2. GET hints       — per tool call, return 0-2 relevant hint strings (0ms, in-memory)
 *   3. COLLECT outcome — per tool call, push to in-memory buffer (no disk, no AI)
 *   4. FLUSH           — on session_release or every N actions, merge learnings into playbook
 */

import fs from "node:fs";
import path from "node:path";
import type { Playbook, PlaybookError } from "./playbook/types.js";
import type { PlaybookStore } from "./playbook/store.js";
import type { AppMap } from "./state/app-map.js";
import type { AppMapData } from "./state/app-map-types.js";

// ── Types ──

export interface ToolOutcome {
  tool: string;
  target: string | null;
  domain: string;
  success: boolean;
  error: string | null;
  timestamp: string;
}

interface CachedContext {
  domain: string;
  playbook: Playbook | null;
  /** Flat list of errors from playbook, indexed by tool name for fast lookup */
  errorsByTool: Map<string, PlaybookError[]>;
  /** Flat map of all selectors from playbook: name → selector string */
  allSelectors: Map<string, string>;
  /** App mastery map data (if available) */
  appMapData: AppMapData | null;
}

// ── Tool → error relevance mapping ──
// Maps tool names to the error context keywords that are relevant to them
const TOOL_ERROR_KEYWORDS: Record<string, string[]> = {
  browser_click: ["click", "button", "element"],
  browser_human_click: ["click", "button", "element"],
  click: ["click", "button", "element"],
  click_text: ["click", "button", "element"],
  click_with_fallback: ["click", "button", "element"],
  browser_type: ["type", "input", "form", "field", "value"],
  type_text: ["type", "input", "form", "field", "value"],
  type_with_fallback: ["type", "input", "form", "field", "value"],
  browser_fill_form: ["form", "field", "input", "value"],
  browser_navigate: ["navigate", "url", "page", "load"],
  browser_dom: ["dom", "selector", "element"],
  browser_js: ["script", "eval", "js"],
  browser_wait: ["wait", "load", "timeout"],
  scroll: ["scroll"],
  scroll_with_fallback: ["scroll"],
};

// Tools that carry a URL in their params
const URL_TOOLS = new Set([
  "browser_open", "browser_navigate",
]);

// Tools that carry a bundleId — native app tools where context should trigger
const BUNDLE_ID_TOOLS = new Set([
  "focus", "launch", "ui_tree", "ui_find", "ui_press", "ui_set_value", "menu_click",
  "click_with_fallback", "type_with_fallback", "read_with_fallback",
  "locate_with_fallback", "select_with_fallback", "scroll_with_fallback",
  "wait_for_state",
]);

// Tools that carry a target/selector in their params
const TARGET_PARAM_NAMES = ["selector", "target", "text", "label", "placeholder"];

const FLUSH_THRESHOLD = 50;
const MIN_OCCURRENCES_TO_PROMOTE = 2;

export class ContextTracker {
  private context: CachedContext | null = null;
  private learnings: ToolOutcome[] = [];
  private actionCount = 0;
  private appMap: AppMap | null = null;
  private _currentPageContext: string | null = null;
  private _previousPageContext: string | null = null;
  private _pendingTransition: { from: string; to: string } | null = null;

  constructor(
    private readonly store: PlaybookStore,
    private readonly execPlaybooksDir?: string,
  ) {}

  /**
   * Current page/view context derived from window title.
   * Used by AppMap to place elements in page-specific zones
   * instead of the flat "auto_discovered" bucket.
   */
  get currentPageContext(): string | null {
    return this._currentPageContext;
  }

  /** Set the AppMap instance for loading app mastery data on context change. */
  setAppMap(map: AppMap): void {
    this.appMap = map;
  }

  /** Get the current app mastery map data (if loaded). */
  getAppMapData(): AppMapData | null {
    return this.context?.appMapData ?? null;
  }

  /**
   * Update the page context from a window title.
   * Called after each tool call with the focused window's title.
   * Extracts the first segment (page/view name) for page-aware zone routing.
   * Tracks transitions: when page changes, stores a consumable transition.
   */
  updatePageContext(windowTitle: string | null): void {
    const oldPage = this._currentPageContext;

    if (!windowTitle) {
      this._currentPageContext = null;
      return;
    }

    const newPage = extractPageContext(windowTitle);
    this._currentPageContext = newPage;

    // Detect transition: both old and new must be non-null and different
    if (oldPage && newPage && oldPage !== newPage) {
      this._previousPageContext = oldPage;
      this._pendingTransition = { from: oldPage, to: newPage };
    }
  }

  /**
   * Consume a pending page transition (returns null if no transition occurred).
   * Each transition is consumed once — subsequent calls return null until the
   * next page change.
   */
  consumePageTransition(): { from: string; to: string } | null {
    const transition = this._pendingTransition;
    this._pendingTransition = null;
    return transition;
  }

  // ═══════════════════════════════════════════════
  // 1. DETECT — update context when domain changes
  // ═══════════════════════════════════════════════

  /**
   * Call after every tool call. Extracts domain from URL params or
   * bundleId from native tool params. Only does a playbook lookup
   * when the context key actually changes.
   */
  updateContext(toolName: string, params: Record<string, unknown>): void {
    // Path 1: URL-bearing tools (browser_open, browser_navigate)
    if (URL_TOOLS.has(toolName)) {
      const url = params.url as string | undefined;
      if (!url) return;

      let domain: string;
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return;
      }

      if (!domain) return; // javascript:, data:, blob: URLs have empty hostname
      if (this.context?.domain === domain) return;

      const playbook = this.store.matchByDomain(domain);
      this.context = buildCachedContext(domain, playbook);
      return;
    }

    // Path 2: bundleId-bearing tools (native app automation)
    if (BUNDLE_ID_TOOLS.has(toolName)) {
      const rawBundleId = params.bundleId ?? params.pid;
      if (!rawBundleId || typeof rawBundleId !== "string") return;
      const bundleId = rawBundleId;

      const contextKey = `native:${bundleId}`;
      if (this.context?.domain === contextKey) return;

      const playbook = this.store.matchByBundleId(bundleId);
      this.context = buildCachedContext(contextKey, playbook);

      // Load app mastery map on bundleId change
      if (this.appMap) {
        this.context.appMapData = this.appMap.load(bundleId) ?? null;
        this.appMap.incrementSession(bundleId);
      }
    }
  }

  /**
   * Extract domain from a browser window title and load matching reference.
   * Covers Safari and other non-CDP browsers where URL isn't in tool params.
   */
  updateContextFromWindowTitle(bundleId: string, windowTitle: string): void {
    if (!windowTitle) return;

    // Only for known browser bundleIds
    const BROWSER_BUNDLE_IDS = new Set([
      "com.apple.Safari", "com.brave.Browser",
      "org.chromium.Chromium", "com.vivaldi.Vivaldi",
      "com.operasoftware.Opera",
    ]);
    if (!BROWSER_BUNDLE_IDS.has(bundleId)) return;

    // Try extracting domain from title patterns:
    // "Page Title — Safari" or "Page Title - Safari" or URL directly in title
    let domain: string | null = null;

    // Pattern 1: title contains a URL-like segment
    const urlMatch = windowTitle.match(/https?:\/\/([^/\s]+)/);
    if (urlMatch?.[1]) {
      domain = urlMatch[1].replace(/^www\./, "");
    }

    // Pattern 2: common "title — domain.com" or "title - domain.com — Browser"
    if (!domain) {
      // Strip trailing " — Safari", " - Brave" etc.
      const stripped = windowTitle.replace(/\s*[—–-]\s*(Safari|Brave|Chromium|Vivaldi|Opera)\s*$/, "");
      // Check if the last segment looks like a domain
      const parts = stripped.split(/\s*[—–-]\s*/);
      const lastPart = parts[parts.length - 1]?.trim() ?? "";
      if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(lastPart)) {
        domain = lastPart.toLowerCase();
      }
    }

    if (!domain) return;
    if (this.context?.domain === domain) return;

    const playbook = this.store.matchByDomain(domain);
    this.context = buildCachedContext(domain, playbook);
  }

  // ═══════════════════════════════════════════════
  // 2. GET HINTS — 0-2 lines per tool call
  // ═══════════════════════════════════════════════

  /**
   * Returns relevant hints for this tool call. Max 2 hints.
   * Cost: map lookups only, ~0ms.
   */
  getHints(toolName: string, params: Record<string, unknown>): string[] {
    if (!this.context?.playbook) return [];

    const hints: string[] = [];

    // Check for known errors relevant to this tool
    const errors = this.context.errorsByTool.get(toolName);
    if (errors && errors.length > 0) {
      // Pick highest severity error
      const top = errors[0]!;
      hints.push(`⚠ Known issue (${this.context.playbook.platform}): ${top.error} → ${top.solution}`);
    }

    // Check if there's a preferred selector for what the tool is targeting
    if (hints.length < 2) {
      const target = extractTarget(params);
      if (target) {
        // Look for a matching selector in playbook
        const match = findRelevantSelector(target, this.context.allSelectors);
        if (match) {
          hints.push(`💡 Preferred selector (${this.context.playbook.platform}): ${match}`);
        }
      }
    }

    // Check if an executable playbook exists in playbooks/ dir
    if (hints.length < 2 && this.execPlaybooksDir) {
      const pb = this.context.playbook;
      const execPath = path.join(this.execPlaybooksDir, `${pb.id}.json`);
      try {
        if (fs.existsSync(execPath)) {
          const execPb = JSON.parse(fs.readFileSync(execPath, "utf-8"));
          if (Array.isArray(execPb.steps) && execPb.steps.length > 0) {
            hints.push(`📋 Executable playbook "${pb.id}" has ${execPb.steps.length} steps. Use job_create(task=..., playbookId="${pb.id}") for auto-execution.`);
          }
        }
      } catch { /* skip — don't break hints for a file read error */ }
    }

    // App mastery map hint
    if (hints.length < 2 && this.context?.appMapData) {
      const map = this.context.appMapData;
      const zones = Object.keys(map.zones).length;
      const verifiedPaths = map.navigationGraph.edges.filter((e) => e.verified).length;
      const totalPaths = map.navigationGraph.edges.length;
      const ratingDisplay = map.rating
        ? (map.rating.grade === "0" ? "0" : `${map.rating.grade}${map.rating.subTier}`)
        : map.masteryLevel.toUpperCase();

      // Include page-specific zone info if we have page context
      let pageInfo = "";
      if (this._currentPageContext) {
        const pageZoneKey = `page::${this._currentPageContext}`;
        const pageZone = map.zones[pageZoneKey];
        if (pageZone) {
          pageInfo = `, page "${this._currentPageContext}" ${pageZone.elements.length} els`;
        } else {
          pageInfo = `, page "${this._currentPageContext}" (new)`;
        }
      }

      // Navigation graph info
      const navNodes = Object.keys(map.navigationGraph.nodes).length;
      let navInfo = "";
      if (navNodes > 0) {
        navInfo = `, nav: ${navNodes} pages ${totalPaths} transitions`;

        // Show outgoing edges from current page
        if (this._currentPageContext) {
          const outgoing = map.navigationGraph.edges.filter(
            (e) => e.from === this._currentPageContext,
          );
          if (outgoing.length > 0) {
            const destinations = outgoing
              .slice(0, 3)
              .map((e) => `${e.to} (${e.action})`)
              .join(", ");
            const more = outgoing.length > 3 ? ` +${outgoing.length - 3} more` : "";
            navInfo += ` [from here: ${destinations}${more}]`;
          }
        }
      }

      hints.push(
        `🗺 Map: ${map.appName} — Rating ${ratingDisplay} ` +
        `(${(map.confidence * 100).toFixed(0)}%, ${zones} zones, ` +
        `${verifiedPaths}/${totalPaths} paths${pageInfo}${navInfo})`,
      );
    }

    return hints;
  }

  // ═══════════════════════════════════════════════
  // 3. COLLECT — record outcome in memory buffer
  // ═══════════════════════════════════════════════

  /**
   * Record a tool outcome. Just an array push — no disk, no AI.
   */
  recordOutcome(
    toolName: string,
    params: Record<string, unknown>,
    success: boolean,
    error: string | null,
  ): void {
    if (!this.context) return;

    this.learnings.push({
      tool: toolName,
      target: extractTarget(params),
      domain: this.context.domain,
      success,
      error,
      timestamp: new Date().toISOString(),
    });

    this.actionCount++;

    // Auto-flush at threshold
    if (this.actionCount >= FLUSH_THRESHOLD) {
      this.flush();
    }
  }

  // ═══════════════════════════════════════════════
  // 4. FLUSH — merge learnings into playbook (one write)
  // ═══════════════════════════════════════════════

  /**
   * Merge collected learnings into the matched playbook.
   * Call on session_release or process exit.
   * One disk write via PlaybookStore.save().
   */
  flush(): void {
    if (this.learnings.length === 0) return;
    if (!this.context?.playbook) {
      this.learnings = [];
      this.actionCount = 0;
      return;
    }

    const playbook = this.context.playbook;
    let changed = false;

    // ── Promote selectors that worked 2+ times ──
    const selectorSuccessCount = new Map<string, number>();
    for (const l of this.learnings) {
      if (l.success && l.target && /^[#.\[]|^[a-z]+[\[.#\s>+~]/.test(l.target) &&
          !/\bon\w+\s*=/i.test(l.target)) {
        const key = l.target!;
        selectorSuccessCount.set(key, (selectorSuccessCount.get(key) ?? 0) + 1);
      }
    }

    if (!playbook.selectors) playbook.selectors = {};
    if (!playbook.selectors["auto_discovered"]) playbook.selectors["auto_discovered"] = {};
    for (const [selector, count] of selectorSuccessCount) {
      if (count >= MIN_OCCURRENCES_TO_PROMOTE) {
        // Don't overwrite existing selectors
        const existing = this.context.allSelectors;
        const alreadyKnown = [...existing.values()].some(s => s === selector);
        if (!alreadyKnown) {
          const key = `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
          playbook.selectors["auto_discovered"]![key] = selector;
          changed = true;
        }
      }
    }

    // ── Promote error patterns seen 2+ times with a common error message ──
    const errorCounts = new Map<string, { count: number; tool: string; error: string }>();
    for (const l of this.learnings) {
      if (!l.success && l.error) {
        const key = `${l.tool}::${l.error}`;
        const existing = errorCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          errorCounts.set(key, { count: 1, tool: l.tool, error: l.error });
        }
      }
    }

    if (!playbook.errors) playbook.errors = [];
    for (const [, { count, tool, error }] of errorCounts) {
      if (count >= MIN_OCCURRENCES_TO_PROMOTE) {
        // Don't add duplicates
        const alreadyKnown = playbook.errors.some(e => e.error === error);
        if (!alreadyKnown) {
          playbook.errors.push({
            error,
            context: `tool: ${tool}, domain: ${this.context.domain}`,
            solution: "No resolution yet — investigate and update this entry",
            severity: count >= 4 ? "high" : "medium",
          });
          changed = true;
        }
      }
    }

    // ── Save if changed ──
    if (changed) {
      this.store.save(playbook);
    }

    // Reset
    this.learnings = [];
    this.actionCount = 0;
  }

  /** Get the currently matched playbook (if any). */
  getActivePlaybook(): Playbook | null {
    return this.context?.playbook ?? null;
  }

  /** Get the current domain being tracked. */
  getCurrentDomain(): string | null {
    return this.context?.domain ?? null;
  }
}

// ── Helpers ──

function buildCachedContext(domain: string, playbook: Playbook | null): CachedContext {
  const errorsByTool = new Map<string, PlaybookError[]>();
  const allSelectors = new Map<string, string>();

  if (playbook) {
    // Index errors by relevant tool names
    if (playbook.errors) {
      for (const err of playbook.errors) {
        const errLower = `${err.error} ${err.context} ${err.solution}`.toLowerCase();
        for (const [tool, keywords] of Object.entries(TOOL_ERROR_KEYWORDS)) {
          if (keywords.some(kw => errLower.includes(kw))) {
            const existing = errorsByTool.get(tool) ?? [];
            existing.push(err);
            errorsByTool.set(tool, existing);
          }
        }
      }

      // Sort each tool's errors by severity
      const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      for (const [tool, errors] of errorsByTool) {
        errors.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
        errorsByTool.set(tool, errors);
      }
    }

    // Flatten all selectors into one map
    if (playbook.selectors) {
      for (const [group, sels] of Object.entries(playbook.selectors)) {
        for (const [name, sel] of Object.entries(sels)) {
          allSelectors.set(`${group}.${name}`, sel);
        }
      }
    }
  }

  return { domain, playbook, errorsByTool, allSelectors, appMapData: null };
}

function extractTarget(params: Record<string, unknown>): string | null {
  for (const name of TARGET_PARAM_NAMES) {
    const val = params[name];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

function findRelevantSelector(target: string, selectors: Map<string, string>): string | null {
  if (selectors.size === 0 || !target) return null;

  const targetLower = target.toLowerCase();

  // Check if any selector name loosely matches the target
  for (const [name, sel] of selectors) {
    const nameLower = name.toLowerCase();
    // If target text matches a selector name (e.g., target="Search" matches "toolbar.search")
    if (nameLower.includes(targetLower) || targetLower.includes(nameLower.split(".").pop() ?? "")) {
      return `${name}: ${sel}`;
    }
  }

  return null;
}

/**
 * Extract a page/view context from a window title.
 *
 * Window titles commonly follow patterns like:
 *   "Tasks - My Workspace - Notion"      → "Tasks"
 *   "Settings > General - MyApp"          → "Settings > General"
 *   "Home | Slack"                        → "Home"
 *   "Untitled - Figma"                    → "Untitled"
 *   "MyApp"                              → "MyApp" (single segment, still useful)
 *
 * Strategy: split on common delimiters (" - ", " | ", " — "), take the first
 * segment as the page context. This is intentionally simple and conservative.
 */
export function extractPageContext(windowTitle: string): string | null {
  if (!windowTitle || windowTitle.trim().length === 0) return null;

  const title = windowTitle.trim();

  // Split on common title delimiters: " - ", " — ", " | "
  const parts = title.split(/\s+[-—|]\s+/);

  // Take the first segment — this is typically the page/view/document name
  const page = parts[0]?.trim();
  if (!page || page.length === 0) return null;

  // V5: Reject garbage — too short or consisting only of punctuation/delimiters
  if (page.length < 2) return null;
  if (/^[\s\-—|_.,;:!?]+$/.test(page)) return null;

  // Truncate overly long page contexts (window titles can be verbose)
  if (page.length > 80) return page.slice(0, 80);

  return page;
}
