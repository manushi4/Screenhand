// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from "vitest";
import { parseLLMResponse, isSensitiveApp, buildVisualMeta } from "../src/state/visual-mapper.js";
import { AppMap } from "../src/state/app-map.js";
import type { VisualScanResult, VisualMeta } from "../src/state/app-map-types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── parseLLMResponse Tests ─────────────────────────────────────────

describe("parseLLMResponse", () => {
  it("parses valid JSON response", () => {
    const json = JSON.stringify({
      screenDescription: "Notes main window with sidebar and editor",
      confidence: 0.85,
      zones: [
        { label: "toolbar", type: "toolbar", bounds: { top: 0, left: 0, width: 1, height: 0.05 }, purpose: "Main toolbar" },
        { label: "sidebar", type: "sidebar", bounds: { top: 0.05, left: 0, width: 0.25, height: 0.95 }, purpose: "Note list" },
      ],
      elements: [
        { label: "New Note", role: "button", x: 0.85, y: 0.03, zone: "toolbar", purpose: "Create a new note", confidence: 0.9 },
        { label: "Search", role: "textField", x: 0.15, y: 0.08, zone: "sidebar", purpose: "Search notes", confidence: 0.8 },
      ],
    });

    const result = parseLLMResponse(json);
    expect(result).not.toBeNull();
    expect(result!.screenDescription).toBe("Notes main window with sidebar and editor");
    expect(result!.confidence).toBe(0.85);
    expect(result!.zones).toHaveLength(2);
    expect(result!.zones[0]!.label).toBe("toolbar");
    expect(result!.zones[0]!.type).toBe("toolbar");
    expect(result!.elements).toHaveLength(2);
    expect(result!.elements[0]!.label).toBe("New Note");
    expect(result!.elements[0]!.x).toBe(0.85);
    expect(result!.elements[0]!.y).toBe(0.03);
  });

  it("strips markdown fences from response", () => {
    const json = '```json\n{"screenDescription": "test", "confidence": 0.5, "zones": [], "elements": []}\n```';
    const result = parseLLMResponse(json);
    expect(result).not.toBeNull();
    expect(result!.screenDescription).toBe("test");
  });

  it("clamps confidence to 0-1 range", () => {
    const json = JSON.stringify({
      screenDescription: "",
      confidence: 1.5,
      zones: [],
      elements: [{ label: "btn", role: "button", x: 1.2, y: -0.1, zone: "toolbar", purpose: "", confidence: 2.0 }],
    });
    const result = parseLLMResponse(json);
    expect(result!.confidence).toBe(1);
    expect(result!.elements[0]!.x).toBe(1);
    expect(result!.elements[0]!.y).toBe(0);
    expect(result!.elements[0]!.confidence).toBe(1);
  });

  it("returns null for invalid JSON", () => {
    expect(parseLLMResponse("not json at all")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseLLMResponse('"just a string"')).toBeNull();
  });

  it("normalizes zone types", () => {
    const json = JSON.stringify({
      screenDescription: "",
      confidence: 0.5,
      zones: [
        { label: "bar", type: "status-bar", bounds: { top: 0.95, left: 0, width: 1, height: 0.05 }, purpose: "" },
        { label: "unknown", type: "INVALID_TYPE", bounds: { top: 0, left: 0, width: 1, height: 1 }, purpose: "" },
      ],
      elements: [],
    });
    const result = parseLLMResponse(json);
    expect(result!.zones[0]!.type).toBe("status-bar");
    expect(result!.zones[1]!.type).toBe("other"); // Invalid type falls back to "other"
  });

  it("skips elements without label", () => {
    const json = JSON.stringify({
      screenDescription: "",
      confidence: 0.5,
      zones: [],
      elements: [
        { role: "button", x: 0.5, y: 0.5, zone: "toolbar", purpose: "", confidence: 0.5 },
        { label: "Valid", role: "button", x: 0.5, y: 0.5, zone: "toolbar", purpose: "", confidence: 0.5 },
      ],
    });
    const result = parseLLMResponse(json);
    expect(result!.elements).toHaveLength(1);
    expect(result!.elements[0]!.label).toBe("Valid");
  });
});

// ── isSensitiveApp Tests ───────────────────────────────────────────

describe("isSensitiveApp", () => {
  it("blocks 1Password", () => {
    expect(isSensitiveApp("com.1password.1password")).toBe(true);
  });

  it("blocks Keychain Access", () => {
    expect(isSensitiveApp("com.apple.keychainaccess")).toBe(true);
  });

  it("blocks banking apps by pattern", () => {
    expect(isSensitiveApp("com.chase.bank")).toBe(true);
    expect(isSensitiveApp("com.example.healthapp")).toBe(true);
  });

  it("allows normal apps", () => {
    expect(isSensitiveApp("com.apple.Notes")).toBe(false);
    expect(isSensitiveApp("com.apple.finder")).toBe(false);
    expect(isSensitiveApp("com.hnc.Discord")).toBe(false);
  });
});

// ── buildVisualMeta Tests ──────────────────────────────────────────

describe("buildVisualMeta", () => {
  it("builds meta with correct fields", () => {
    const meta = buildVisualMeta("abc123", { w: 1440, h: 900 }, "Notes", "15.0", 0.7, 2);
    expect(meta.screenshotHash).toBe("abc123");
    expect(meta.captureSize.w).toBe(1440);
    expect(meta.appVersion).toBe("15.0");
    expect(meta.confidence).toBe(0.7);
    expect(meta.scaleFactor).toBe(2);
    expect(meta.screensMapped).toEqual(["Notes"]);
    expect(meta.lastScannedAt).toBeTruthy();
  });
});

// ── AppMap.populateFromVisualScan Tests ─────────────────────────────

describe("AppMap.populateFromVisualScan", () => {
  let appMap: AppMap;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-map-test-"));
    appMap = new AppMap({ mapsDir: tmpDir });
    appMap.init();
  });

  const makeScan = (elements: VisualScanResult["elements"]): VisualScanResult => ({
    zones: [
      { label: "toolbar", type: "toolbar", bounds: { top: 0, left: 0, width: 1, height: 0.05 } },
    ],
    elements,
    confidence: 0.7,
  });

  const makeMeta = (): VisualMeta => ({
    lastScannedAt: new Date().toISOString(),
    appVersion: "1.0",
    scaleFactor: 2,
    captureSize: { w: 1440, h: 900 },
    screenshotHash: "test123",
    screensMapped: ["main"],
    confidence: 0.7,
  });

  it("creates new app map and populates elements", () => {
    const scan = makeScan([
      { label: "New Note", role: "button", x: 0.85, y: 0.03, zone: "toolbar", confidence: 0.8 },
      { label: "Search", role: "textField", x: 0.15, y: 0.03, zone: "toolbar", confidence: 0.7 },
    ]);

    const { added, updated } = appMap.populateFromVisualScan("com.apple.Notes", "Notes", scan, makeMeta());
    expect(added).toBe(2);
    expect(updated).toBe(0);

    // Verify elements are stored
    const el = appMap.findElement("com.apple.Notes", "New Note");
    expect(el).not.toBeNull();
    expect(el!.element.relativeX).toBe(0.85);
    expect(el!.element.relativeY).toBe(0.03);
    expect(el!.element.labelSource).toBe("ocr");
    expect(el!.element.visualConfidence).toBe(0.8);
  });

  it("does not overwrite AX-confirmed elements", () => {
    // First: add an element via normal tool usage (simulates AX discovery)
    const data = appMap.createEmpty("com.apple.Notes", "Notes");
    appMap.save(data);
    appMap.addZone("com.apple.Notes", "toolbar", {
      relativePosition: { top: 0, left: 0, width: 1, height: 0.05 },
      type: "toolbar",
      elements: [],
      verified: true,
      lastSeen: new Date().toISOString(),
    });
    appMap.addElement("com.apple.Notes", "toolbar", {
      label: "New Note",
      relativeX: 0.9,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "New Note",
      successCount: 5,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
      labelSource: "ax",
      visualConfidence: 0.95,
    });

    // Now try to overwrite with visual scan
    const scan = makeScan([
      { label: "New Note", role: "button", x: 0.85, y: 0.03, zone: "toolbar", confidence: 0.8 },
    ]);

    const { added, updated } = appMap.populateFromVisualScan("com.apple.Notes", "Notes", scan, makeMeta());
    expect(added).toBe(0);
    expect(updated).toBe(0);

    // Position should remain unchanged
    const el = appMap.findElement("com.apple.Notes", "New Note");
    expect(el!.element.relativeX).toBe(0.9);
    expect(el!.element.labelSource).toBe("ax");
  });

  it("stores visual meta", () => {
    const meta = makeMeta();
    appMap.populateFromVisualScan("com.apple.Notes", "Notes", makeScan([]), meta);

    const stored = appMap.getVisualMeta("com.apple.Notes");
    expect(stored).not.toBeNull();
    expect(stored!.appVersion).toBe("1.0");
    expect(stored!.screenshotHash).toBe("test123");
  });
});

// ── AppMap.validateElementPosition Tests ────────────────────────────

describe("AppMap.validateElementPosition", () => {
  let appMap: AppMap;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-validate-test-"));
    appMap = new AppMap({ mapsDir: tmpDir });
    appMap.init();
  });

  it("returns null for unknown elements", () => {
    const result = appMap.validateElementPosition("com.apple.Notes", "Nonexistent", 0.5, 0.5);
    expect(result).toBeNull();
  });

  it("validates matching positions", () => {
    // Set up an element from visual scan
    const scan: VisualScanResult = {
      zones: [{ label: "toolbar", type: "toolbar", bounds: { top: 0, left: 0, width: 1, height: 0.05 } }],
      elements: [{ label: "Save", role: "button", x: 0.5, y: 0.03, zone: "toolbar", confidence: 0.6 }],
      confidence: 0.6,
    };
    appMap.populateFromVisualScan("test.app", "Test", scan, {
      lastScannedAt: new Date().toISOString(),
      appVersion: "1.0",
      scaleFactor: 2,
      captureSize: { w: 1440, h: 900 },
      screenshotHash: "h",
      screensMapped: [],
      confidence: 0.6,
    });

    // Validate with matching position (within tolerance)
    const result = appMap.validateElementPosition("test.app", "Save", 0.51, 0.04);
    expect(result).toBe(true);

    // Check validation count incremented
    const el = appMap.findElement("test.app", "Save");
    expect(el!.element.validationCount).toBe(1);
  });

  it("detects mismatched positions", () => {
    const scan: VisualScanResult = {
      zones: [{ label: "toolbar", type: "toolbar", bounds: { top: 0, left: 0, width: 1, height: 0.05 } }],
      elements: [{ label: "Delete", role: "button", x: 0.5, y: 0.03, zone: "toolbar", confidence: 0.6 }],
      confidence: 0.6,
    };
    appMap.populateFromVisualScan("test.app", "Test", scan, {
      lastScannedAt: new Date().toISOString(),
      appVersion: "1.0",
      scaleFactor: 2,
      captureSize: { w: 1440, h: 900 },
      screenshotHash: "h",
      screensMapped: [],
      confidence: 0.6,
    });

    // Validate with very different position
    const result = appMap.validateElementPosition("test.app", "Delete", 0.9, 0.9);
    expect(result).toBe(false);

    const el = appMap.findElement("test.app", "Delete");
    expect(el!.element.mismatchCount).toBe(1);
  });

  it("promotes confidence after 3 AX validations", () => {
    const scan: VisualScanResult = {
      zones: [{ label: "canvas", type: "canvas", bounds: { top: 0.05, left: 0, width: 1, height: 0.9 } }],
      elements: [{ label: "OK", role: "button", x: 0.5, y: 0.5, zone: "canvas", confidence: 0.5 }],
      confidence: 0.5,
    };
    appMap.populateFromVisualScan("test.app", "Test", scan, {
      lastScannedAt: new Date().toISOString(),
      appVersion: "1.0",
      scaleFactor: 2,
      captureSize: { w: 1440, h: 900 },
      screenshotHash: "h",
      screensMapped: [],
      confidence: 0.5,
    });

    // Validate 3 times
    appMap.validateElementPosition("test.app", "OK", 0.51, 0.51);
    appMap.validateElementPosition("test.app", "OK", 0.50, 0.49);
    appMap.validateElementPosition("test.app", "OK", 0.52, 0.50);

    const el = appMap.findElement("test.app", "OK");
    expect(el!.element.validationCount).toBe(3);
    expect(el!.element.visualConfidence).toBe(0.9);
    expect(el!.element.labelSource).toBe("ax"); // Promoted!
  });
});

// ── AppMap.isVisualMapStale Tests ──────────────────────────────────

describe("AppMap.isVisualMapStale", () => {
  let appMap: AppMap;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-stale-test-"));
    appMap = new AppMap({ mapsDir: tmpDir });
    appMap.init();
  });

  it("returns true if no visual map exists", () => {
    expect(appMap.isVisualMapStale("com.nonexistent")).toBe(true);
  });

  it("returns true if app version changed", () => {
    const scan: VisualScanResult = { zones: [], elements: [], confidence: 0.5 };
    appMap.populateFromVisualScan("test.app", "Test", scan, {
      lastScannedAt: new Date().toISOString(),
      appVersion: "1.0",
      scaleFactor: 2,
      captureSize: { w: 1440, h: 900 },
      screenshotHash: "h",
      screensMapped: [],
      confidence: 0.7,
    });

    expect(appMap.isVisualMapStale("test.app", "2.0")).toBe(true);
    expect(appMap.isVisualMapStale("test.app", "1.0")).toBe(false);
  });

  it("returns true if confidence too low", () => {
    const scan: VisualScanResult = { zones: [], elements: [], confidence: 0.2 };
    appMap.populateFromVisualScan("test.app", "Test", scan, {
      lastScannedAt: new Date().toISOString(),
      appVersion: "1.0",
      scaleFactor: 2,
      captureSize: { w: 1440, h: 900 },
      screenshotHash: "h",
      screensMapped: [],
      confidence: 0.2,
    });

    expect(appMap.isVisualMapStale("test.app")).toBe(true);
  });
});
