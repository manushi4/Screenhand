// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature Extractor — extracts real product features from app websites
 * and generates ScreenHand value-add features.
 *
 * Pure functions — no side effects, no disk I/O, no AI.
 */

import type {
  WebsiteFeature,
  ValueAddFeature,
  FeatureExtractionResult,
} from "./types.js";

// ── Tier assignment keywords (F=entry, B=proficient, S=expert, SSS=grandmaster) ─

/** Single-word keywords checked individually */
const F_WORDS = new Set([
  "basic", "create", "view", "share", "read",
  "browse", "search", "home", "start", "launch", "write",
]);

const B_WORDS = new Set([
  "organize", "format", "customize", "template", "tag", "folder",
  "sort", "filter", "pin", "archive", "move", "rename", "duplicate",
  "favorites", "bookmark", "list", "table", "style", "font",
]);

const S_WORDS = new Set([
  "automate", "shortcut", "export", "import", "collaborate", "sync",
  "scan", "link", "mention", "embed", "attachment", "password",
  "encrypt", "lock", "version", "history", "recover", "backup",
]);

const SSS_WORDS = new Set([
  "api", "integrate", "plugin", "advanced", "workflow", "script",
  "extension", "developer", "sdk", "automation", "pipeline", "webhook",
]);

/** Multi-word phrases checked via substring match */
const SSS_PHRASES = [
  "custom action", "get started",
];

// ── HTML entity decoding ──────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
  "&#x27;": "'", "&#x2F;": "/",
};

function decodeHTMLEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  // Numeric entities: &#123; or &#x1A;
  // Only decode printable chars (>= 0x20), skip control chars
  result = result.replace(/&#(\d+);/g, (orig, code) => {
    const n = Number(code);
    return n >= 0x20 && n !== 0x7F ? String.fromCharCode(n) : "";
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (orig, hex) => {
    const n = parseInt(hex as string, 16);
    return n >= 0x20 && n !== 0x7F ? String.fromCharCode(n) : "";
  });
  return result;
}

// ── Strip control characters ──────────────────────────────────────

function stripControlChars(text: string): string {
  // Remove ASCII control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
  // Preserve \t (0x09), \n (0x0A), \r (0x0D)
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// ── Strip HTML tags — O(n) single-pass state machine ──────────────

function stripTags(html: string): string {
  let result = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i]!;
    if (ch === "<") { inTag = true; continue; }
    if (ch === ">") { inTag = false; continue; }
    if (!inTag) result += ch;
  }
  return result.trim();
}

// ── Strip script and style blocks before processing ───────────────

function stripScriptsAndStyles(html: string): string {
  // Remove <script>...</script> and <style>...</style> blocks
  // Use bounded match to prevent backtracking on malformed HTML
  return html
    .replace(/<script\b[^>]*>[\s\S]{0,100000}?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]{0,100000}?<\/style>/gi, "")
    .replace(/<!--[\s\S]{0,50000}?-->/g, "");
}

// ── Clean extracted text ──────────────────────────────────────────

function cleanText(rawHtml: string): string {
  return stripControlChars(decodeHTMLEntities(stripTags(rawHtml)));
}

// ── Normalize feature name to ID ──────────────────────────────────

function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

// ── Assign level based on keywords ────────────────────────────────

function assignLevel(name: string, description: string): WebsiteFeature["level"] {
  const text = `${name} ${description}`.toLowerCase();
  const words = text.split(/\s+/);

  // Check multi-word SSS phrases first
  for (const phrase of SSS_PHRASES) {
    if (text.includes(phrase)) return "SSS";
  }

  // Check single-word keywords
  for (const w of words) {
    if (SSS_WORDS.has(w)) return "SSS";
  }
  for (const w of words) {
    if (S_WORDS.has(w)) return "S";
  }
  for (const w of words) {
    if (B_WORDS.has(w)) return "B";
  }
  for (const w of words) {
    if (F_WORDS.has(w)) return "F";
  }

  // Fallback: longer descriptions suggest complexity
  if (description.length > 80) return "B";
  return "F";
}

// ── Main: Extract features from HTML ──────────────────────────────

export function extractFeaturesFromHTML(
  html: string,
  appName: string,
  url: string,
): FeatureExtractionResult {
  const seen = new Map<string, WebsiteFeature>();

  // Pre-process: strip scripts, styles, and comments to avoid content leakage
  const cleanHtml = stripScriptsAndStyles(html);

  // ── 1. Extract from headings (h2, h3, h4) ─────────────────────
  const headingRegex = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(cleanHtml)) !== null) {
    const text = cleanText(match[2]!).trim();
    if (!text || text.length < 3 || text.length > 120) continue;
    // Skip navigation/generic headings
    if (/^(menu|nav|footer|header|copyright|legal|privacy)$/i.test(text)) continue;

    const id = nameToId(text);
    if (!id || seen.has(id)) continue;

    // Try to find a nearby paragraph for description
    const afterHeading = cleanHtml.slice(match.index + match[0].length, match.index + match[0].length + 500);
    const pMatch = afterHeading.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = pMatch
      ? cleanText(pMatch[1]!).trim().slice(0, 200)
      : text;

    seen.set(id, {
      id,
      name: text,
      description,
      sourceHeading: text,
      level: assignLevel(text, description),
    });
  }

  // ── 2. Extract from feature cards ──────────────────────────────
  // Pattern: <div class="...feature..."> with a heading inside
  // Bounded to 3000 chars to prevent backtracking on deeply nested divs
  const cardRegex = /<div[^>]*class="[^"]*feature[^"]*"[^>]*>([\s\S]{0,3000}?)<\/div>/gi;
  while ((match = cardRegex.exec(cleanHtml)) !== null) {
    const cardHtml = match[1]!;
    // Find heading inside card
    const innerHeading = cardHtml.match(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/i);
    if (!innerHeading) continue;

    const name = cleanText(innerHeading[1]!).trim();
    if (!name || name.length < 3) continue;

    const id = nameToId(name);
    if (seen.has(id)) continue;

    // Description from paragraph
    const pMatch = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = pMatch
      ? cleanText(pMatch[1]!).trim().slice(0, 200)
      : name;

    seen.set(id, {
      id,
      name,
      description,
      sourceHeading: name,
      level: assignLevel(name, description),
    });
  }

  // ── 3. Extract from list items (feature lists) ─────────────────
  // Look for <ul> or <ol> near "feature" context
  const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((match = listItemRegex.exec(cleanHtml)) !== null) {
    const rawText = cleanText(match[1]!).trim();
    // Only accept list items that look like feature names (not too long, not too short)
    if (!rawText || rawText.length < 5 || rawText.length > 100) continue;
    // Skip items that look like navigation
    if (/^(home|about|contact|blog|pricing|sign up|log in|download)$/i.test(rawText)) continue;
    // Skip items with too many sentences (likely paragraphs, not feature names)
    if ((rawText.match(/\./g) ?? []).length > 2) continue;

    const id = nameToId(rawText);
    if (seen.has(id)) continue;

    // Only add if the surrounding context mentions "feature" (within 500 chars before)
    const contextBefore = cleanHtml.slice(Math.max(0, match.index - 500), match.index).toLowerCase();
    if (!contextBefore.includes("feature") && !contextBefore.includes("capability") && !contextBefore.includes("what you can")) continue;

    seen.set(id, {
      id,
      name: rawText,
      description: rawText,
      sourceHeading: rawText,
      level: assignLevel(rawText, ""),
    });
  }

  // ── 4. Extract from definition lists ───────────────────────────
  const dtRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  while ((match = dtRegex.exec(cleanHtml)) !== null) {
    const name = cleanText(match[1]!).trim();
    const desc = cleanText(match[2]!).trim().slice(0, 200);
    if (!name || name.length < 3) continue;

    const id = nameToId(name);
    if (seen.has(id)) continue;

    seen.set(id, {
      id,
      name,
      description: desc || name,
      sourceHeading: name,
      level: assignLevel(name, desc),
    });
  }

  const websiteFeatures = [...seen.values()];

  // ── Generate value-add features ────────────────────────────────
  const valueAddFeatures = generateValueAddFeatures(appName, websiteFeatures);

  return {
    appName,
    url,
    websiteFeatures,
    valueAddFeatures,
    extractedAt: new Date().toISOString(),
  };
}

// ── Value-Add Feature Generation ──────────────────────────────────

interface ValueAddRule {
  category: ValueAddFeature["category"];
  trigger: (features: WebsiteFeature[]) => boolean;
  generate: (appName: string) => ValueAddFeature;
}

const VALUE_ADD_RULES: ValueAddRule[] = [
  {
    category: "bulk",
    trigger: (fs) => fs.some((f) => /\b(creates?|adds?)\b/i.test(f.name)),
    generate: (app) => ({
      id: "bulk_create",
      name: "Bulk Create",
      description: `Create multiple ${app} items from a list or template`,
      category: "bulk",
      level: "B",
    }),
  },
  {
    category: "bulk",
    trigger: (fs) => fs.some((f) => /\b(deletes?|removes?|trash)\b/i.test(f.name)),
    generate: (app) => ({
      id: "bulk_delete",
      name: "Bulk Delete",
      description: `Delete multiple ${app} items matching criteria`,
      category: "bulk",
      level: "B",
    }),
  },
  {
    category: "bulk",
    trigger: (fs) => fs.some((f) => /\b(exports?|downloads?)\b/i.test(f.name)),
    generate: (app) => ({
      id: "bulk_export",
      name: "Bulk Export",
      description: `Export all ${app} items at once`,
      category: "bulk",
      level: "B",
    }),
  },
  {
    category: "organization",
    trigger: (fs) => fs.some((f) => /\b(folders?|tags?|labels?|categor(?:y|ies))\b/i.test(f.name)),
    generate: (app) => ({
      id: "auto_organize",
      name: "Auto-Organize",
      description: `Sort and organize ${app} items by content, date, or type`,
      category: "organization",
      level: "S",
    }),
  },
  {
    category: "organization",
    trigger: (fs) => fs.some((f) => /\b(search|finds?)\b/i.test(f.name)),
    generate: (app) => ({
      id: "smart_search",
      name: "Smart Search",
      description: `Search across all ${app} content with pattern matching`,
      category: "organization",
      level: "B",
    }),
  },
  {
    category: "intelligence",
    trigger: () => true, // Always available
    generate: (app) => ({
      id: "summarize_all",
      name: "Summarize",
      description: `Read and summarize all ${app} content`,
      category: "intelligence",
      level: "S",
    }),
  },
  {
    category: "intelligence",
    trigger: (fs) => fs.some((f) => /\b(duplicates?|similar)\b/i.test(f.name)),
    generate: (app) => ({
      id: "find_duplicates",
      name: "Find Duplicates",
      description: `Identify duplicate or near-duplicate ${app} items`,
      category: "intelligence",
      level: "S",
    }),
  },
  {
    category: "cross_app",
    trigger: (fs) => fs.some((f) => /\b(shares?|exports?|sends?)\b/i.test(f.name)),
    generate: (app) => ({
      id: "cross_app_export",
      name: "Cross-App Export",
      description: `Export ${app} content to other apps automatically`,
      category: "cross_app",
      level: "S",
    }),
  },
  {
    category: "cross_app",
    trigger: (fs) => fs.some((f) => /\bimports?\b/i.test(f.name)),
    generate: (app) => ({
      id: "cross_app_import",
      name: "Cross-App Import",
      description: `Import content from other apps into ${app}`,
      category: "cross_app",
      level: "S",
    }),
  },
  {
    category: "monitoring",
    trigger: () => true, // Always available
    generate: (app) => ({
      id: "change_monitor",
      name: "Change Monitor",
      description: `Monitor ${app} for changes and notify`,
      category: "monitoring",
      level: "SSS",
    }),
  },
];

export function generateValueAddFeatures(
  appName: string,
  websiteFeatures: WebsiteFeature[],
): ValueAddFeature[] {
  const results: ValueAddFeature[] = [];

  for (const rule of VALUE_ADD_RULES) {
    if (rule.trigger(websiteFeatures)) {
      results.push(rule.generate(appName));
    }
  }

  return results;
}
