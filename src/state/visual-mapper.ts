// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisualMapper — Phase 3: Visual App Mapping.
 *
 * Two-phase approach:
 *   Phase A (quickScan): Screenshot → fast OCR → spatial clustering → element coordinates.
 *     No LLM needed, ~500ms, works offline.
 *   Phase B (llmEnrich): Screenshot + AX tree → Claude Vision API → semantic zone labels.
 *     Needs ANTHROPIC_API_KEY, ~5-15s, runs in background.
 *
 * Results populate the existing AppMap (fills -1,-1 coordinates, adds zone labels).
 * LLM labels are hypotheses (confidence 0.5) until validated by 3+ AX matches.
 */

import * as crypto from "node:crypto";
import type { AppMap } from "./app-map.js";
import type {
  VisualScanResult,
  VisualMeta,
  LLMEnrichmentResult,
  ZoneType,
} from "./app-map-types.js";
import type { BridgeClient } from "../native/bridge-client.js";

// ── Sensitive App Blocklist ────────────────────────────────────────

const BLOCKED_BUNDLE_IDS = new Set([
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.lastpass.LastPass",
  "com.bitwarden.desktop",
  "com.dashlane.dashlanephonefinal",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",  // System Settings (may show accounts)
]);

export function isSensitiveApp(bundleId: string): boolean {
  if (BLOCKED_BUNDLE_IDS.has(bundleId)) return true;
  // Block known banking/health patterns
  if (/bank|health|medical|wallet/i.test(bundleId)) return true;
  return false;
}

// ── Quick Scan (Phase A) ──────────────────────────────────────────

/**
 * Perform a quick visual scan using OCR only (no LLM).
 * Takes a screenshot, runs fast OCR, clusters results into zones.
 * Returns structured elements with positions.
 */
export async function quickScan(
  bridge: BridgeClient,
  pid: number,
  windowBounds?: { x: number; y: number; width: number; height: number },
): Promise<{ scan: VisualScanResult; hash: string; captureSize: { w: number; h: number } } | null> {
  // Take screenshot using cg.captureScreen (the bridge's actual method)
  let screenshotResult: { path?: string; width?: number; height?: number };
  try {
    screenshotResult = await bridge.call<any>("cg.captureScreen", {});
  } catch {
    return null;
  }

  if (!screenshotResult?.path) return null;

  const captureW = screenshotResult.width ?? windowBounds?.width ?? 1440;
  const captureH = screenshotResult.height ?? windowBounds?.height ?? 900;

  // Detect Retina scale factor: capture pixels / logical window size
  const scaleFactor = windowBounds?.width
    ? Math.round(captureW / windowBounds.width) || 2
    : 2;

  // Window bounds in capture-pixel space (for coordinate normalization)
  const winPixelX = windowBounds ? windowBounds.x * scaleFactor : 0;
  const winPixelY = windowBounds ? windowBounds.y * scaleFactor : 0;
  const winPixelW = windowBounds ? windowBounds.width * scaleFactor : captureW;
  const winPixelH = windowBounds ? windowBounds.height * scaleFactor : captureH;

  // Compute screenshot hash for staleness detection
  const hash = crypto.createHash("sha256").update(screenshotResult.path).digest("hex").slice(0, 16);

  // Run OCR on the captured screenshot file
  // Bridge returns: { text, confidence, bounds: { x, y, width, height } }
  let ocrResult: { regions?: Array<{ text: string; confidence?: number; bounds?: { x: number; y: number; width: number; height: number }; x?: number; y?: number; width?: number; height?: number }> };
  try {
    ocrResult = await bridge.call<any>("vision.ocr", {
      imagePath: screenshotResult.path,
    });
  } catch {
    return { scan: { zones: [], elements: [], confidence: 0.2 }, hash, captureSize: { w: captureW, h: captureH } };
  }

  if (!ocrResult?.regions || ocrResult.regions.length === 0) {
    return { scan: { zones: [], elements: [], confidence: 0.2 }, hash, captureSize: { w: captureW, h: captureH } };
  }

  // Convert OCR regions to elements with positions relative to WINDOW (0-1),
  // not full screen. This matches the coordinator's AX normalization.
  const elements: VisualScanResult["elements"] = [];
  for (const region of ocrResult.regions) {
    const text = (region.text ?? "").trim();
    if (!text || text.length < 2 || text.length > 100) continue;

    // OCR returns bounds nested: { bounds: { x, y, width, height } }
    const pixelX = region.bounds?.x ?? region.x ?? 0;
    const pixelY = region.bounds?.y ?? region.y ?? 0;

    // Convert from full-screen pixel coords to window-relative (0-1)
    const relX = winPixelW > 0 ? (pixelX - winPixelX) / winPixelW : 0;
    const relY = winPixelH > 0 ? (pixelY - winPixelY) / winPixelH : 0;

    // Skip elements outside the window
    if (relX < -0.05 || relX > 1.05 || relY < -0.05 || relY > 1.05) continue;

    elements.push({
      label: text,
      role: "staticText",
      x: Math.round(Math.max(0, Math.min(1, relX)) * 1000) / 1000,
      y: Math.round(Math.max(0, Math.min(1, relY)) * 1000) / 1000,
      zone: classifyZone(Math.max(0, Math.min(1, relY))),
      confidence: 0.6,
    });
  }

  // Cluster elements into zones based on Y position
  const zones = clusterIntoZones(elements, captureW, captureH);

  const confidence = elements.length > 10 ? 0.7 : elements.length > 3 ? 0.5 : 0.3;

  return {
    scan: { zones, elements, confidence },
    hash,
    captureSize: { w: captureW, h: captureH },
  };
}

// ── LLM Enrichment (Phase B) ──────────────────────────────────────

/**
 * Enrich a visual map using Claude Vision API.
 * Sends screenshot + AX tree to LLM for semantic labeling.
 * Returns structured zones and elements with purposes.
 */
export async function llmEnrich(
  screenshotBase64: string,
  axTree: string,
  appName: string,
  bundleId: string,
  windowTitle: string,
  captureSize: { w: number; h: number },
): Promise<LLMEnrichmentResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = buildLLMPrompt(appName, bundleId, windowTitle, captureSize, axTree);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshotBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      process.stderr.write(`[visual-mapper] LLM API error: ${resp.status}\n`);
      return null;
    }

    const body = await resp.json() as any;
    const text = body?.content?.[0]?.text;
    if (!text) return null;

    return parseLLMResponse(text);
  } catch (err) {
    process.stderr.write(`[visual-mapper] LLM enrichment failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

function buildLLMPrompt(
  appName: string,
  bundleId: string,
  windowTitle: string,
  captureSize: { w: number; h: number },
  axTree: string,
): string {
  const truncatedAX = axTree.length > 3000 ? axTree.slice(0, 3000) + "\n...(truncated)" : axTree;

  return `You are labeling a macOS application screenshot for UI automation.

App: ${appName} (${bundleId})
Window: ${windowTitle}
Size: ${captureSize.w}x${captureSize.h}

AX accessibility tree (for cross-reference):
${truncatedAX}

Return a JSON object with this exact structure:
{
  "screenDescription": "one-line description of this screen",
  "confidence": 0.0-1.0,
  "zones": [
    {"label": "zone name", "type": "toolbar|sidebar|canvas|panel|dialog|menu|status-bar|tab-bar|other", "bounds": {"top": 0.0, "left": 0.0, "width": 1.0, "height": 0.1}, "purpose": "what this zone does"}
  ],
  "elements": [
    {"label": "element name", "role": "button|textField|menu|checkbox|list|tab|other", "x": 0.0, "y": 0.0, "zone": "zone name", "purpose": "what clicking this does", "confidence": 0.0-1.0}
  ]
}

Rules:
1. Match AX tree labels where possible. Use the EXACT AX label when available.
2. All positions are fractions of window dimensions (0.0-1.0). x,y is the center point.
3. Only label INTERACTIVE elements (buttons, fields, menus, tabs, checkboxes, links).
4. Do NOT include specific user data (names, emails, file contents) in labels — only UI structure.
5. Return ONLY the JSON object. No markdown fences, no commentary.`;
}

/** Parse LLM JSON response, handling markdown fences and malformed output. */
export function parseLLMResponse(text: string): LLMEnrichmentResult | null {
  // Strip markdown fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") return null;

    const result: LLMEnrichmentResult = {
      screenDescription: typeof parsed.screenDescription === "string" ? parsed.screenDescription : "",
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      zones: [],
      elements: [],
    };

    // Parse zones
    if (Array.isArray(parsed.zones)) {
      for (const z of parsed.zones) {
        if (!z?.label || !z?.bounds) continue;
        const zoneType = validateZoneType(z.type);
        result.zones.push({
          label: String(z.label),
          type: zoneType,
          bounds: {
            top: clamp01(z.bounds.top ?? 0),
            left: clamp01(z.bounds.left ?? 0),
            width: clamp01(z.bounds.width ?? 0),
            height: clamp01(z.bounds.height ?? 0),
          },
          purpose: String(z.purpose ?? ""),
        });
      }
    }

    // Parse elements
    if (Array.isArray(parsed.elements)) {
      for (const el of parsed.elements) {
        if (!el?.label) continue;
        result.elements.push({
          label: String(el.label),
          role: String(el.role ?? "other"),
          x: clamp01(el.x ?? 0),
          y: clamp01(el.y ?? 0),
          zone: String(el.zone ?? "other"),
          purpose: String(el.purpose ?? ""),
          confidence: typeof el.confidence === "number" ? clamp01(el.confidence) : 0.5,
        });
      }
    }

    return result;
  } catch {
    process.stderr.write("[visual-mapper] Failed to parse LLM JSON response\n");
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const VALID_ZONE_TYPES = new Set<ZoneType>([
  "toolbar", "sidebar", "canvas", "canvas-zoomable", "panel",
  "dialog", "menu", "nested-menu", "status-bar", "palette", "tab-bar", "other",
]);

function validateZoneType(t: unknown): ZoneType {
  if (typeof t === "string" && VALID_ZONE_TYPES.has(t as ZoneType)) return t as ZoneType;
  // Common LLM output normalization
  if (typeof t === "string") {
    const normalized = t.toLowerCase().replace(/[\s_]+/g, "-");
    if (VALID_ZONE_TYPES.has(normalized as ZoneType)) return normalized as ZoneType;
  }
  return "other";
}

function clamp01(n: number): number {
  if (typeof n !== "number" || isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Classify an element into a zone based on its Y position. */
function classifyZone(relY: number): string {
  if (relY < 0.06) return "toolbar";
  if (relY > 0.95) return "status-bar";
  return "canvas";
}

/** Cluster elements into spatial zones by Y-band grouping. */
function clusterIntoZones(
  elements: VisualScanResult["elements"],
  _captureW: number,
  _captureH: number,
): VisualScanResult["zones"] {
  const bands: Record<string, { minY: number; maxY: number; count: number }> = {};

  for (const el of elements) {
    const zone = el.zone;
    if (!bands[zone]) {
      bands[zone] = { minY: el.y, maxY: el.y, count: 0 };
    }
    bands[zone]!.minY = Math.min(bands[zone]!.minY, el.y);
    bands[zone]!.maxY = Math.max(bands[zone]!.maxY, el.y);
    bands[zone]!.count++;
  }

  const zones: VisualScanResult["zones"] = [];
  for (const [label, band] of Object.entries(bands)) {
    const height = Math.max(0.05, band.maxY - band.minY + 0.02);
    zones.push({
      label,
      type: label as ZoneType,
      bounds: {
        top: Math.max(0, band.minY - 0.01),
        left: 0,
        width: 1,
        height,
      },
    });
  }

  return zones;
}

/**
 * Build VisualMeta from scan results.
 */
export function buildVisualMeta(
  hash: string,
  captureSize: { w: number; h: number },
  windowTitle: string,
  appVersion: string,
  confidence: number,
  scaleFactor = 2,
): VisualMeta {
  return {
    lastScannedAt: new Date().toISOString(),
    appVersion,
    scaleFactor,
    captureSize,
    screenshotHash: hash,
    screensMapped: [windowTitle],
    confidence,
  };
}
