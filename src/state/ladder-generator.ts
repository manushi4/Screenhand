// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Auto-generates feature ladders and signal keyword maps from reference JSON files.
 *
 * When no BUILTIN_LADDERS entry exists for an app, this module derives a meaningful
 * feature ladder from the app's reference file (selectors, flows, shortcuts).
 * This means ANY app with a reference file automatically gets proper mastery tracking
 * instead of falling back to the useless 5-item generic ladder.
 *
 * Pure functions — no side effects, no disk I/O, no AI.
 */

import type { FeatureDefinition, FeatureTier } from "./app-map-types.js";

// ── Input type (matches reference JSON structure) ────────────────

export interface ReferenceData {
  selectors?: Record<string, Record<string, string>>;
  flows?: Record<string, { steps?: string[]; guards?: string[]; why?: string }>;
  shortcuts?: Record<string, Record<string, string>>;
  policyNotes?: Record<string, string[]>;
  errors?: Array<{ error: string; context: string; solution: string; severity: string }>;
  websiteFeatures?: Array<{ id: string; name: string; description: string; level: string }>;
  valueAddFeatures?: Array<{ id: string; name: string; description: string; level: string; category: string }>;
}

// ── Output type for generated ladder + signals ───────────────────

export interface GeneratedLadder {
  ladder: FeatureDefinition[];
  signals: Record<string, string[]>;
  /** Hash of reference inputs — used to detect when regeneration is needed */
  hash: string;
}

// ── Keyword sets for tier assignment (F=entry, B=proficient, S=expert, SSS=grandmaster) ──

const F_KEYWORDS = new Set([
  "navigation", "browse", "basic", "search", "header", "page", "nav", "home",
  "page_header", "quick_find",
]);

const B_KEYWORDS = new Set([
  "settings", "create", "views", "sort", "filter", "template", "new", "sidebar",
  "create_new", "slash_commands", "notification", "preferences",
]);

const S_KEYWORDS = new Set([
  "database", "admin", "moderation", "permissions", "automation", "advanced",
  "server", "import", "export", "workflow", "security", "form",
]);

const SSS_KEYWORDS = new Set([
  "ai", "api", "integration", "custom", "governance", "crisis", "identity",
  "billing", "orchestrat", "pipeline",
]);

// ── Stop words to exclude from signal keywords ───────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "to", "or", "and", "at", "for", "of", "is", "on",
  "by", "it", "if", "be", "as", "this", "that", "with", "from", "then",
  "via", "e.g.", "etc", "note", "use",
]);

// ── Selector groups to skip (not real features) ──────────────────

const SKIP_GROUPS = new Set(["auto_discovered"]);

// ── Main: Generate ladder from reference ─────────────────────────

export function generateLadderFromReference(ref: ReferenceData): GeneratedLadder {
  const features: FeatureDefinition[] = [];
  const signals: Record<string, string[]> = {};

  const selectorGroups = ref.selectors ?? {};
  const flows = ref.flows ?? {};

  // Minimum threshold: need at least 2 meaningful selector groups
  // (but website features can stand alone — they come from official sources)
  const meaningfulGroups = Object.keys(selectorGroups).filter(k => !SKIP_GROUPS.has(k));
  const hasWebsiteFeatures = (ref.websiteFeatures?.length ?? 0) > 0 || (ref.valueAddFeatures?.length ?? 0) > 0;
  if (meaningfulGroups.length < 2 && Object.keys(flows).length < 2 && !hasWebsiteFeatures) {
    return { ladder: [], signals: {}, hash: computeHash(ref) };
  }

  // Track which flow names are already covered by selector groups
  const coveredFlows = new Set<string>();

  // ── Step 1: Features from selector groups ──────────────────────

  for (const groupName of meaningfulGroups) {
    const sels = selectorGroups[groupName]!;
    const selCount = Object.keys(sels).length;

    const level = assignLevel(groupName, selCount, false, 0);
    const weight = assignWeight(groupName, selCount, level);
    const critical = selCount >= 6 || weight === 3;

    const featureId = groupName;
    const description = describeFeature(groupName, sels);

    features.push({ id: featureId, description, level, weight, critical });

    // Generate signal keywords from selector keys and values
    const keywords = extractKeywordsFromSelectors(groupName, sels);
    signals[featureId] = keywords;

    // Mark related flows as covered
    for (const flowName of Object.keys(flows)) {
      if (flowNamesRelated(groupName, flowName)) {
        coveredFlows.add(flowName);
        // Merge flow keywords into this feature's signals
        const flowKw = extractKeywordsFromFlow(flowName, flows[flowName]!);
        signals[featureId] = deduplicateArray([...signals[featureId]!, ...flowKw]);
      }
    }
  }

  // ── Step 2: Additional features from uncovered flows ───────────

  for (const [flowName, flow] of Object.entries(flows)) {
    if (coveredFlows.has(flowName)) continue;

    const stepCount = flow.steps?.length ?? 0;
    const guardCount = flow.guards?.length ?? 0;
    const level = assignLevel(flowName, 0, true, stepCount + guardCount);
    const weight = assignWeight(flowName, stepCount, level);
    const critical = guardCount >= 2 || weight === 3;

    const featureId = flowName;
    const description = flow.steps?.[0] ?? `${flowName.replace(/_/g, " ")} workflow`;

    features.push({ id: featureId, description, level, weight, critical });

    const keywords = extractKeywordsFromFlow(flowName, flow);
    signals[featureId] = keywords;
  }

  // ── Step 2.5: Features from website extraction ─────────────────

  if (ref.websiteFeatures) {
    for (const wf of ref.websiteFeatures) {
      const featureId = `web_${wf.id}`;
      if (features.some((f) => f.id === featureId)) continue;
      // Skip if an exact selector group or flow already covers this feature
      // (use exact key match, not fuzzy flowNamesRelated — avoids false positives
      // where a short website feature id like "export" matches "export_pdf_flow")
      if (selectorGroups[wf.id] !== undefined || flows[wf.id] !== undefined) continue;
      const level = (["F", "B", "S", "SSS"].includes(wf.level)
        ? wf.level
        : "F") as FeatureTier;
      const weight = assignWeight(wf.id, 0, level);
      features.push({
        id: featureId,
        description: wf.description || wf.name,
        level,
        weight,
        critical: false,
      });
      signals[featureId] = extractKeywordsFromName(wf.name);
    }
  }

  // ── Step 2.6: ScreenHand value-add features ───────────────────

  if (ref.valueAddFeatures) {
    for (const va of ref.valueAddFeatures) {
      const featureId = `va_${va.id}`;
      if (features.some((f) => f.id === featureId)) continue;
      const level = (["B", "S", "SSS"].includes(va.level)
        ? va.level
        : "S") as FeatureTier;
      features.push({
        id: featureId,
        description: va.description,
        level,
        weight: 2,
        critical: false,
      });
      signals[featureId] = extractKeywordsFromName(va.name);
    }
  }

  // ── Step 3: Sort by level progression ──────────────────────────

  const levelOrder: Record<FeatureTier, number> = {
    F: 0, B: 1, S: 2, SSS: 3,
  };
  features.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return { ladder: features, signals, hash: computeHash(ref) };
}

// ── Level assignment heuristics ──────────────────────────────────

function assignLevel(
  name: string,
  selectorCount: number,
  isFlow: boolean,
  complexity: number,
): FeatureTier {
  const nameLower = name.toLowerCase();
  const parts = nameLower.split(/[_\s-]+/);

  // Check SSS first (most specific)
  if (parts.some(p => SSS_KEYWORDS.has(p))) return "SSS";
  if (parts.some(p => S_KEYWORDS.has(p))) return "S";
  if (parts.some(p => B_KEYWORDS.has(p))) return "B";
  if (parts.some(p => F_KEYWORDS.has(p))) return "F";

  // Fallback based on complexity
  if (isFlow) {
    if (complexity >= 8) return "S";
    if (complexity >= 5) return "B";
    return "F";
  }

  // Selector group: more selectors = more complex
  if (selectorCount >= 8) return "S";
  if (selectorCount >= 4) return "B";
  return "F";
}

// ── Weight assignment ────────────────────────────────────────────

function assignWeight(
  name: string,
  complexity: number,
  level: FeatureTier,
): 1 | 2 | 3 {
  if (level === "SSS") return 3;
  if (level === "S" && complexity >= 6) return 3;
  if (level === "S" || level === "B") return 2;
  return 1;
}

// ── Description generation ───────────────────────────────────────

function describeFeature(groupName: string, sels: Record<string, string>): string {
  const humanName = groupName.replace(/_/g, " ");
  const selNames = Object.keys(sels).slice(0, 3).map(k => k.replace(/_/g, " ")).join(", ");
  return `${humanName}: ${selNames}`;
}

// ── Keyword extraction from selectors ────────────────────────────

function extractKeywordsFromSelectors(
  groupName: string,
  sels: Record<string, string>,
): string[] {
  const keywords: string[] = [];

  // Add group name parts
  for (const part of groupName.split("_")) {
    if (!STOP_WORDS.has(part.toLowerCase()) && part.length > 1) {
      keywords.push(part.toLowerCase());
    }
  }

  // Add selector key parts
  for (const key of Object.keys(sels)) {
    for (const part of key.split("_")) {
      const lower = part.toLowerCase();
      if (!STOP_WORDS.has(lower) && lower.length > 2) {
        keywords.push(lower);
      }
    }
  }

  // Extract significant words from selector values
  for (const val of Object.values(sels)) {
    // Extract quoted text: 'text' or "text"
    const quoted = val.match(/['"]([^'"]{2,20})['"]/g);
    if (quoted) {
      for (const q of quoted) {
        const clean = q.replace(/['"]/g, "").toLowerCase();
        if (!STOP_WORDS.has(clean)) keywords.push(clean);
      }
    }
    // Extract shortcut keys like Cmd+K
    const shortcuts = val.match(/Cmd\+\S+/gi);
    if (shortcuts) {
      for (const s of shortcuts) keywords.push(s.toLowerCase());
    }
  }

  return deduplicateArray(keywords);
}

// ── Keyword extraction from flows ────────────────────────────────

function extractKeywordsFromFlow(
  flowName: string,
  flow: { steps?: string[]; guards?: string[]; why?: string },
): string[] {
  const keywords: string[] = [];

  // Flow name parts
  for (const part of flowName.split("_")) {
    if (!STOP_WORDS.has(part.toLowerCase()) && part.length > 1) {
      keywords.push(part.toLowerCase());
    }
  }

  // Extract from steps
  if (flow.steps) {
    for (const step of flow.steps) {
      // Extract quoted text
      const quoted = step.match(/['"]([^'"]{2,25})['"]/g);
      if (quoted) {
        for (const q of quoted) {
          const clean = q.replace(/['"]/g, "").toLowerCase();
          if (!STOP_WORDS.has(clean) && clean.length > 2) keywords.push(clean);
        }
      }
      // Extract shortcut keys
      const shortcuts = step.match(/Cmd\+\S+/gi);
      if (shortcuts) {
        for (const s of shortcuts) keywords.push(s.toLowerCase());
      }
      // Extract action verbs and significant nouns
      const words = step.split(/\s+/);
      for (const w of words) {
        const lower = w.toLowerCase().replace(/[^a-z0-9+]/g, "");
        if (lower.length > 3 && !STOP_WORDS.has(lower)) {
          keywords.push(lower);
        }
      }
    }
  }

  return deduplicateArray(keywords);
}

// ── Keyword extraction from feature name ──────────────────────

function extractKeywordsFromName(name: string): string[] {
  const keywords: string[] = [];
  for (const part of name.split(/[\s_-]+/)) {
    const lower = part.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (lower.length > 2 && !STOP_WORDS.has(lower)) {
      keywords.push(lower);
    }
  }
  return deduplicateArray(keywords);
}

// ── Flow-to-selector group name matching ─────────────────────────

function flowNamesRelated(groupName: string, flowName: string): boolean {
  const gParts = new Set(groupName.split("_"));
  const fParts = flowName.split("_");

  // At least 50% of flow name parts match group name parts
  const matches = fParts.filter(p => gParts.has(p)).length;
  if (matches >= Math.ceil(fParts.length * 0.5)) return true;

  // Direct substring match
  if (groupName.includes(flowName) || flowName.includes(groupName)) return true;

  return false;
}

// ── Hash computation for cache invalidation ──────────────────────

function computeHash(ref: ReferenceData): string {
  const keys = [
    ...Object.keys(ref.selectors ?? {}).sort(),
    ...Object.keys(ref.flows ?? {}).sort(),
    ...(ref.websiteFeatures ?? []).map((f) => f.id).sort(),
    ...(ref.valueAddFeatures ?? []).map((f) => f.id).sort(),
  ].join("|");

  // Simple string hash (djb2)
  let hash = 5381;
  for (let i = 0; i < keys.length; i++) {
    hash = ((hash << 5) + hash + keys.charCodeAt(i)) | 0;
  }
  return `ref_${Math.abs(hash).toString(36)}`;
}

// ── Utilities ────────────────────────────────────────────────────

function deduplicateArray(arr: string[]): string[] {
  return [...new Set(arr)];
}
