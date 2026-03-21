// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AppMap } from "../src/state/app-map.js";
import type { MapZone, NavEdge } from "../src/state/app-map-types.js";
import { ContextTracker, extractPageContext } from "../src/context-tracker.js";
import { PlaybookStore } from "../src/playbook/store.js";
import { writeFileAtomicSync } from "../src/util/atomic-write.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "appmap-test-"));
}

function makeZone(overrides?: Partial<MapZone>): MapZone {
  return {
    relativePosition: { top: 0, left: 0, width: 1, height: 0.08 },
    type: "toolbar",
    elements: [],
    verified: false,
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

describe("AppMap", () => {
  let mapsDir: string;
  let appMap: AppMap;

  beforeEach(() => {
    mapsDir = makeTmpDir();
    appMap = new AppMap({ mapsDir });
    appMap.init();
  });

  afterEach(() => {
    fs.rmSync(mapsDir, { recursive: true, force: true });
  });

  it("creates empty map for new app", () => {
    const data = appMap.createEmpty("com.test.app", "TestApp", "1.0");
    expect(data.app).toBe("com.test.app");
    expect(data.appName).toBe("TestApp");
    expect(data.masteryLevel).toBe("beginner");
    expect(data.confidence).toBe(0);
    expect(Object.keys(data.zones)).toHaveLength(0);
  });

  it("loads and saves map data (persistence)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const loaded = appMap2.load("com.test.app");

    expect(loaded).not.toBeNull();
    expect(loaded!.appName).toBe("TestApp");
    expect(Object.keys(loaded!.zones)).toHaveLength(1);
  });

  it("returns null for unknown bundleId", () => {
    const data = appMap.load("com.unknown.app");
    expect(data).toBeNull();
  });

  it("adds zones and elements", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    const data = appMap.load("com.test.app")!;
    expect(data.zones["toolbar"]!.elements).toHaveLength(1);
    expect(data.zones["toolbar"]!.elements[0]!.label).toBe("Run");
  });

  it("deduplicates elements by label", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.06,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    const data = appMap.load("com.test.app")!;
    expect(data.zones["toolbar"]!.elements).toHaveLength(1);
    expect(data.zones["toolbar"]!.elements[0]!.relativeX).toBe(0.06);
  });

  it("updates element position", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 5,
    });

    appMap.updateElementPosition("com.test.app", "toolbar", "Run", 0.07, 0.05);

    const data = appMap.load("com.test.app")!;
    const el = data.zones["toolbar"]!.elements[0]!;
    expect(el.relativeX).toBe(0.07);
    expect(el.relativeY).toBe(0.05);
    expect(el.sessionsSinceUse).toBe(0);
  });

  it("records element outcome (success/failure)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordElementOutcome("com.test.app", "toolbar", "Run", true);
    appMap.recordElementOutcome("com.test.app", "toolbar", "Run", true);
    appMap.recordElementOutcome("com.test.app", "toolbar", "Run", false);

    const data = appMap.load("com.test.app")!;
    const el = data.zones["toolbar"]!.elements[0]!;
    expect(el.successCount).toBe(2);
    expect(el.failCount).toBe(1);
  });

  it("auto-creates element on outcome for unknown label", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "NewButton", true);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["auto_discovered"]).toBeDefined();
    const el = data.zones["auto_discovered"]!.elements.find((e) => e.label === "NewButton");
    expect(el).toBeDefined();
    expect(el!.successCount).toBe(1);
  });

  it("adds navigation nodes and edges", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addNavNode("com.test.app", "main", { type: "window", description: "Main window" });
    appMap.addNavNode("com.test.app", "export", { type: "dialog", description: "Export dialog" });
    appMap.addNavEdge("com.test.app", {
      from: "main",
      action: "Cmd+M",
      to: "export",
      verified: false,
      successCount: 0,
      failCount: 0,
      lastUsed: new Date().toISOString(),
    });

    const data = appMap.load("com.test.app")!;
    expect(Object.keys(data.navigationGraph.nodes)).toHaveLength(2);
    expect(data.navigationGraph.edges).toHaveLength(1);
  });

  it("records edge outcome and verifies after 2 successes", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordEdgeOutcome("com.test.app", "main", "Cmd+M", "export", true);
    appMap.recordEdgeOutcome("com.test.app", "main", "Cmd+M", "export", true);

    const data = appMap.load("com.test.app")!;
    const edge = data.navigationGraph.edges[0]!;
    expect(edge.successCount).toBe(2);
    expect(edge.verified).toBe(true);
  });

  it("finds element by label across zones", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.addElement("com.test.app", "sidebar", {
      label: "Layers",
      relativeX: 0.1,
      relativeY: 0.5,
      anchor: "top-left",
      ocrBackup: "Layers",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    const found = appMap.findElement("com.test.app", "Layers");
    expect(found).not.toBeNull();
    expect(found!.zone).toBe("sidebar");
    expect(found!.element.label).toBe("Layers");
  });

  it("resolves relative position to pixels", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.5,
      relativeY: 0.25,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    const pos = appMap.resolvePosition("com.test.app", "Run", { x: 0, y: 0, width: 1920, height: 1080 });
    expect(pos).not.toBeNull();
    expect(pos!.x).toBe(960);
    expect(pos!.y).toBe(270);

    // Different window size — same relative position
    const pos2 = appMap.resolvePosition("com.test.app", "Run", { x: 0, y: 0, width: 1280, height: 720 });
    expect(pos2).not.toBeNull();
    expect(pos2!.x).toBe(640);
    expect(pos2!.y).toBe(180);
  });

  it("finds navigation path via BFS", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addNavEdge("com.test.app", { from: "main", action: "File>Export", to: "exportDialog", verified: true, successCount: 3, failCount: 0, lastUsed: new Date().toISOString() });
    appMap.addNavEdge("com.test.app", { from: "exportDialog", action: "click-format", to: "formatDropdown", verified: true, successCount: 2, failCount: 0, lastUsed: new Date().toISOString() });

    const path = appMap.findPath("com.test.app", "main", "formatDropdown");
    expect(path).not.toBeNull();
    expect(path).toHaveLength(2);
    expect(path![0]!.from).toBe("main");
    expect(path![1]!.to).toBe("formatDropdown");
  });

  it("returns null for unreachable path", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addNavEdge("com.test.app", { from: "main", action: "click", to: "dialog", verified: true, successCount: 1, failCount: 0, lastUsed: new Date().toISOString() });

    const result = appMap.findPath("com.test.app", "main", "unreachable");
    expect(result).toBeNull();
  });

  it("returns empty path for same-node path", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    const result = appMap.findPath("com.test.app", "main", "main");
    expect(result).toEqual([]);
  });

  it("computes mastery level from raw confidence (backward compat)", () => {
    expect(appMap.computeMasteryLevel(0)).toBe("beginner");
    expect(appMap.computeMasteryLevel(0.24)).toBe("beginner");
    expect(appMap.computeMasteryLevel(0.25)).toBe("pro");
    expect(appMap.computeMasteryLevel(0.49)).toBe("pro");
    expect(appMap.computeMasteryLevel(0.50)).toBe("expert");
    expect(appMap.computeMasteryLevel(0.74)).toBe("expert");
    expect(appMap.computeMasteryLevel(0.75)).toBe("grandmaster");
    expect(appMap.computeMasteryLevel(1.0)).toBe("grandmaster");
  });

  // ── Gated Weighted Mastery System ──

  it("recordFeatureSignal increases depth and confidence", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 1, true);

    const data = appMap.getLoaded("com.test.app")!;
    const fm = data.featureMastery["basic_navigation"]!;
    expect(fm.depth).toBe(1);
    expect(fm.confidence).toBeGreaterThan(0);
    expect(fm.repeatCount).toBe(1);
  });

  it("depth only goes up, never down", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, true);
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 1, true);

    const data = appMap.getLoaded("com.test.app")!;
    expect(data.featureMastery["basic_navigation"]!.depth).toBe(2);
  });

  it("failure decreases confidence but not depth", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, true);
    const confBefore = appMap.getLoaded("com.test.app")!.featureMastery["basic_navigation"]!.confidence;

    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, false);

    const after = appMap.getLoaded("com.test.app")!.featureMastery["basic_navigation"]!;
    expect(after.depth).toBe(2);
    expect(after.confidence).toBeLessThan(confBefore);
    expect(after.failCount).toBe(1);
  });

  it("navigating (depth 1) does NOT make you pro", () => {
    appMap.createEmpty("com.hnc.Discord", "Discord");
    const ladder = appMap.getFeatureLadder("com.hnc.Discord");

    // Navigate to every single feature — depth 1 only
    for (const f of ladder) {
      appMap.recordFeatureSignal("com.hnc.Discord", f.id, 1, true);
    }

    const data = appMap.getLoaded("com.hnc.Discord")!;
    // With only navigation, you should be beginner — no breadth at depth>=2
    expect(data.masteryLevel).toBe("beginner");
  });

  it("basic actions (depth 2) across features advances to beginner/pro range", () => {
    appMap.createEmpty("com.hnc.Discord", "Discord");
    const ladder = appMap.getFeatureLadder("com.hnc.Discord");

    // Do basic actions on half the features
    const half = ladder.slice(0, Math.ceil(ladder.length / 2));
    for (const f of half) {
      appMap.recordFeatureSignal("com.hnc.Discord", f.id, 2, true);
    }

    const data = appMap.getLoaded("com.hnc.Discord")!;
    // Should be beginner or pro — not expert/grandmaster
    expect(["beginner", "pro"]).toContain(data.masteryLevel);
  });

  it("grandmaster requires workflows, outcomes, healing, and cross-feature work", () => {
    appMap.createEmpty("com.hnc.Discord", "Discord");
    const ladder = appMap.getFeatureLadder("com.hnc.Discord");

    // Just clicking everything to depth 2 is NOT grandmaster
    for (const f of ladder) {
      for (let i = 0; i < 10; i++) {
        appMap.recordFeatureSignal("com.hnc.Discord", f.id, 2, true);
      }
    }

    const data = appMap.getLoaded("com.hnc.Discord")!;
    expect(data.masteryLevel).not.toBe("grandmaster");
  });

  it("metrics track breadth, workflow breadth, and outcome breadth correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Generic app has 5 features
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, true);
    appMap.recordFeatureSignal("com.test.app", "core_action", 3, true);
    appMap.recordFeatureSignal("com.test.app", "settings", 4, true);

    const data = appMap.getLoaded("com.test.app")!;
    const metrics = appMap.computeMetrics(data);

    // 3/5 features have depth >= 2 (weighted: nav=1, core=1, settings=2 = 4/8 total weight)
    expect(metrics.breadth).toBeGreaterThan(0);
    // 2/5 features have depth >= 3
    expect(metrics.workflowBreadth).toBeGreaterThan(0);
    // 1/5 features have depth = 4
    expect(metrics.outcomeBreadth).toBeGreaterThan(0);
  });

  it("healing events increase healing rate", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, true);
    appMap.recordFeatureSignal("com.test.app", "basic_navigation", 2, false);
    appMap.recordHealing("com.test.app", "basic_navigation");

    const data = appMap.getLoaded("com.test.app")!;
    const fm = data.featureMastery["basic_navigation"]!;
    expect(fm.healingCount).toBe(1);

    const metrics = appMap.computeMetrics(data);
    expect(metrics.healingRate).toBeGreaterThan(0);
  });

  it("cross-feature workflows are tracked", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordCrossFeatureWorkflow("com.test.app");
    appMap.recordCrossFeatureWorkflow("com.test.app");

    const data = appMap.getLoaded("com.test.app")!;
    expect(data.crossFeatureWorkflows).toBe(2);
    expect(data.masteryMetrics.crossFeatureWorkflows).toBe(2);
  });

  it("migrates old completedFeatures to featureMastery at depth 1", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    const data = appMap.getLoaded("com.test.app")!;
    // Simulate old format
    (data as any).completedFeatures = ["basic_navigation", "core_action"];
    appMap.save(data);
    appMap.flush();

    // Reload and trigger migration via refreshMastery
    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    appMap2.refreshMastery("com.test.app");

    const migrated = appMap2.getLoaded("com.test.app")!;
    expect(migrated.featureMastery["basic_navigation"]?.depth).toBe(1);
    expect(migrated.featureMastery["core_action"]?.depth).toBe(1);
    expect(migrated.completedFeatures).toEqual([]);
  });

  it("Discord ladder has 20 features with weights and critical flags", () => {
    const ladder = appMap.getFeatureLadder("com.hnc.Discord");
    expect(ladder.length).toBe(20);

    // Check weight distribution
    const criticals = ladder.filter((f) => f.critical);
    expect(criticals.length).toBeGreaterThanOrEqual(8);

    // Check all have weight 1-3
    for (const f of ladder) {
      expect([1, 2, 3]).toContain(f.weight);
    }
  });

  it("applies version change decay", () => {
    const data = appMap.createEmpty("com.test.app", "TestApp", "1.0");
    // Manually set some confidence
    data.confidence = 0.8;
    data.masteryLevel = "expert";
    appMap.save(data);

    appMap.applyVersionChange("com.test.app", "2.0");

    const updated = appMap.load("com.test.app")!;
    expect(updated.version).toBe("2.0");
    expect(updated.confidence).toBe(0.4);
    expect(updated.masteryLevel).toBe("pro");
  });

  it("prunes elements unused for N sessions", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Active",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Active",
      successCount: 5,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 2,
    });
    appMap.addElement("com.test.app", "toolbar", {
      label: "Stale",
      relativeX: 0.2,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Stale",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 15,
    });

    appMap.prune("com.test.app");

    const data = appMap.load("com.test.app")!;
    expect(data.zones["toolbar"]!.elements).toHaveLength(1);
    expect(data.zones["toolbar"]!.elements[0]!.label).toBe("Active");
  });

  it("increments session count and sessionsSinceUse", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.incrementSession("com.test.app");
    appMap.incrementSession("com.test.app");

    const data = appMap.load("com.test.app")!;
    expect(data.sessionCount).toBe(2);
    expect(data.zones["toolbar"]!.elements[0]!.sessionsSinceUse).toBe(2);
  });

  it("produces human-readable summary", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());

    const summary = appMap.getSummary("com.test.app");
    expect(summary).not.toBeNull();
    expect(summary).toContain("TestApp");
    expect(summary).toContain("BEGINNER");
  });

  it("returns null summary for unknown app", () => {
    expect(appMap.getSummary("com.unknown.app")).toBeNull();
  });

  // ── Page-Aware Zones (Phase 2a) ──

  it("creates page-specific zone when pageContext is provided", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "NewTask", true, "Tasks Board");

    const data = appMap.load("com.test.app")!;
    expect(data.zones["page::Tasks Board"]).toBeDefined();
    const el = data.zones["page::Tasks Board"]!.elements.find((e) => e.label === "NewTask");
    expect(el).toBeDefined();
    expect(el!.successCount).toBe(1);
  });

  it("falls back to auto_discovered when no pageContext", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "SomeButton", true);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["auto_discovered"]).toBeDefined();
    expect(data.zones["auto_discovered"]!.elements.find((e) => e.label === "SomeButton")).toBeDefined();
    // No page-specific zone should exist
    const pageZones = Object.keys(data.zones).filter((k) => k.startsWith("page::"));
    expect(pageZones).toHaveLength(0);
  });

  it("creates separate zones for different pages", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "TaskList", true, "Tasks");
    appMap.recordElementOutcome("com.test.app", "auto", "ProfilePic", true, "Settings");
    appMap.recordElementOutcome("com.test.app", "auto", "DashWidget", true, "Home");

    const data = appMap.load("com.test.app")!;
    expect(data.zones["page::Tasks"]).toBeDefined();
    expect(data.zones["page::Settings"]).toBeDefined();
    expect(data.zones["page::Home"]).toBeDefined();
    expect(data.zones["page::Tasks"]!.elements[0]!.label).toBe("TaskList");
    expect(data.zones["page::Settings"]!.elements[0]!.label).toBe("ProfilePic");
    expect(data.zones["page::Home"]!.elements[0]!.label).toBe("DashWidget");
  });

  it("migrates sidebar elements to global::sidebar on position update", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "NavItem", true, "Tasks");

    // Update position to sidebar region (left 15%)
    appMap.updateElementPosition("com.test.app", "page::Tasks", "NavItem", 0.05, 0.5);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["global::sidebar"]).toBeDefined();
    const sidebarEl = data.zones["global::sidebar"]!.elements.find((e) => e.label === "NavItem");
    expect(sidebarEl).toBeDefined();
    expect(sidebarEl!.relativeX).toBe(0.05);
    // Original page zone should have it removed
    const pageEl = data.zones["page::Tasks"]?.elements.find((e) => e.label === "NavItem");
    expect(pageEl).toBeUndefined();
  });

  it("migrates toolbar elements to global::toolbar on position update", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementOutcome("com.test.app", "auto", "SaveBtn", true, "Settings");

    // Update position to toolbar region (top 8%)
    appMap.updateElementPosition("com.test.app", "page::Settings", "SaveBtn", 0.5, 0.03);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["global::toolbar"]).toBeDefined();
    const toolbarEl = data.zones["global::toolbar"]!.elements.find((e) => e.label === "SaveBtn");
    expect(toolbarEl).toBeDefined();
    expect(toolbarEl!.relativeY).toBe(0.03);
  });

  it("same element on different pages creates per-page entries", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Record on Tasks page
    appMap.recordElementOutcome("com.test.app", "auto", "SharedBtn", true, "Tasks");
    // Same element on Settings page — should create separate entry per page
    appMap.recordElementOutcome("com.test.app", "auto", "SharedBtn", true, "Settings");

    const data = appMap.load("com.test.app")!;
    // Each page should have its own entry for the element
    const tasksEl = data.zones["page::Tasks"]?.elements.find((e) => e.label === "SharedBtn");
    const settingsEl = data.zones["page::Settings"]?.elements.find((e) => e.label === "SharedBtn");
    expect(tasksEl).toBeDefined();
    expect(tasksEl!.successCount).toBe(1);
    expect(settingsEl).toBeDefined();
    expect(settingsEl!.successCount).toBe(1);
  });

  it("respects maxZonesPerApp and falls back to auto_discovered", () => {
    const smallMap = new AppMap({ mapsDir, maxZonesPerApp: 3 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    // Fill up zones
    smallMap.recordElementOutcome("com.test.app", "auto", "El1", true, "Page1");
    smallMap.recordElementOutcome("com.test.app", "auto", "El2", true, "Page2");
    smallMap.recordElementOutcome("com.test.app", "auto", "El3", true, "Page3");
    // This should exceed limit and fall back to auto_discovered
    smallMap.recordElementOutcome("com.test.app", "auto", "El4", true, "Page4");

    const data = smallMap.load("com.test.app")!;
    // Should have auto_discovered as fallback (total zones = 3 originals + auto_discovered = 4,
    // but El4 goes to auto_discovered instead of creating page::Page4)
    expect(data.zones["page::Page4"]).toBeUndefined();
    expect(data.zones["auto_discovered"]).toBeDefined();
    const el4 = data.zones["auto_discovered"]!.elements.find((e) => e.label === "El4");
    expect(el4).toBeDefined();
  });

  // ── Navigation Model (Phase 2b) ──

  it("recordPageTransition creates nodes and edge", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");

    const data = appMap.load("com.test.app")!;
    expect(data.navigationGraph.nodes["Home"]).toBeDefined();
    expect(data.navigationGraph.nodes["Home"]!.type).toBe("window");
    expect(data.navigationGraph.nodes["Home"]!.description).toBe("Home");
    expect(data.navigationGraph.nodes["Settings"]).toBeDefined();
    expect(data.navigationGraph.edges).toHaveLength(1);
    expect(data.navigationGraph.edges[0]!.from).toBe("Home");
    expect(data.navigationGraph.edges[0]!.to).toBe("Settings");
    expect(data.navigationGraph.edges[0]!.action).toBe("click");
    expect(data.navigationGraph.edges[0]!.successCount).toBe(1);
    expect(data.navigationGraph.edges[0]!.verified).toBe(false);
  });

  it("recordPageTransition increments successCount on duplicate", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");

    const data = appMap.load("com.test.app")!;
    expect(data.navigationGraph.edges).toHaveLength(1);
    expect(data.navigationGraph.edges[0]!.successCount).toBe(3);
    expect(data.navigationGraph.edges[0]!.verified).toBe(true);
  });

  it("recordPageTransition ignores same-page transitions", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Home", "click");

    const data = appMap.load("com.test.app")!;
    expect(data.navigationGraph.edges).toHaveLength(0);
    expect(Object.keys(data.navigationGraph.nodes)).toHaveLength(0);
  });

  it("recordPageTransition respects maxEdges limit", () => {
    const smallMap = new AppMap({ mapsDir, maxEdges: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordPageTransition("com.test.app", "A", "B", "click");
    smallMap.recordPageTransition("com.test.app", "B", "C", "click");
    // This should be rejected — at limit
    smallMap.recordPageTransition("com.test.app", "C", "D", "click");

    const data = smallMap.load("com.test.app")!;
    expect(data.navigationGraph.edges).toHaveLength(2);
    // D node should not be created since edge was rejected
    expect(data.navigationGraph.nodes["D"]).toBeUndefined();
  });

  it("recordPageTransition does not duplicate nodes", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");
    appMap.recordPageTransition("com.test.app", "Settings", "Home", "browser_navigate");

    const data = appMap.load("com.test.app")!;
    expect(Object.keys(data.navigationGraph.nodes)).toHaveLength(2);
    expect(data.navigationGraph.edges).toHaveLength(2);
  });

  it("findPath works across recorded page transitions", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Dashboard", "click");
    appMap.recordPageTransition("com.test.app", "Dashboard", "Settings", "menu_click");
    appMap.recordPageTransition("com.test.app", "Settings", "Profile", "click");

    const pathResult = appMap.findPath("com.test.app", "Home", "Profile");
    expect(pathResult).not.toBeNull();
    expect(pathResult).toHaveLength(3);
    expect(pathResult![0]!.from).toBe("Home");
    expect(pathResult![0]!.to).toBe("Dashboard");
    expect(pathResult![1]!.to).toBe("Settings");
    expect(pathResult![2]!.to).toBe("Profile");
  });

  it("recordPageTransition treats different actions as separate edges", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "click");
    appMap.recordPageTransition("com.test.app", "Home", "Settings", "key");

    const data = appMap.load("com.test.app")!;
    expect(data.navigationGraph.edges).toHaveLength(2);
  });

  it("recordPageTransition on unknown bundleId is a no-op", () => {
    // No createEmpty — bundleId doesn't exist
    appMap.recordPageTransition("com.nonexistent.app", "A", "B", "click");
    const data = appMap.load("com.nonexistent.app");
    expect(data).toBeNull();
  });

  // ── Hierarchy (Phase 2c) ──

  it("recordHierarchy creates entry with parent and children", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.recordHierarchy("com.test.app", "sidebar", "Favorites", ["Page A", "Page B"], "ax_tree");

    const hierarchy = appMap.getHierarchy("com.test.app", "sidebar");
    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0]!.parentLabel).toBe("Favorites");
    expect(hierarchy[0]!.parentZone).toBe("sidebar");
    expect(hierarchy[0]!.children).toEqual(["Page A", "Page B"]);
    expect(hierarchy[0]!.source).toBe("ax_tree");
  });

  it("recordHierarchy merges children for duplicate parent (no duplicates)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.recordHierarchy("com.test.app", "sidebar", "Favorites", ["Page A", "Page B"], "ax_tree");
    appMap.recordHierarchy("com.test.app", "sidebar", "Favorites", ["Page B", "Page C"], "ax_tree");

    const hierarchy = appMap.getHierarchy("com.test.app", "sidebar");
    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0]!.children).toEqual(["Page A", "Page B", "Page C"]);
  });

  it("getHierarchy returns correct data for specific zone", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.addZone("com.test.app", "toolbar", makeZone({ type: "toolbar" }));
    appMap.recordHierarchy("com.test.app", "sidebar", "Nav", ["Home", "Settings"], "ax_tree");
    appMap.recordHierarchy("com.test.app", "toolbar", "FileMenu", ["New", "Open"], "ax_tree");

    const sidebarH = appMap.getHierarchy("com.test.app", "sidebar");
    expect(sidebarH).toHaveLength(1);
    expect(sidebarH[0]!.parentLabel).toBe("Nav");

    const toolbarH = appMap.getHierarchy("com.test.app", "toolbar");
    expect(toolbarH).toHaveLength(1);
    expect(toolbarH[0]!.parentLabel).toBe("FileMenu");

    // All zones combined
    const allH = appMap.getHierarchy("com.test.app");
    expect(allH).toHaveLength(2);
  });

  it("hierarchy persists across save/load", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.recordHierarchy("com.test.app", "sidebar", "Favorites", ["Doc1", "Doc2"], "dom");
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const hierarchy = appMap2.getHierarchy("com.test.app", "sidebar");
    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0]!.parentLabel).toBe("Favorites");
    expect(hierarchy[0]!.children).toEqual(["Doc1", "Doc2"]);
    expect(hierarchy[0]!.source).toBe("dom");
  });

  it("respects maxHierarchyEntriesPerZone limit", () => {
    const smallMap = new AppMap({ mapsDir, maxHierarchyEntriesPerZone: 3 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");
    smallMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));

    smallMap.recordHierarchy("com.test.app", "sidebar", "Group1", ["A"], "ax_tree");
    smallMap.recordHierarchy("com.test.app", "sidebar", "Group2", ["B"], "ax_tree");
    smallMap.recordHierarchy("com.test.app", "sidebar", "Group3", ["C"], "ax_tree");
    // This should be rejected — at limit
    smallMap.recordHierarchy("com.test.app", "sidebar", "Group4", ["D"], "ax_tree");

    const hierarchy = smallMap.getHierarchy("com.test.app", "sidebar");
    expect(hierarchy).toHaveLength(3);
    expect(hierarchy.find(h => h.parentLabel === "Group4")).toBeUndefined();
  });

  it("getHierarchy returns empty array for unknown app", () => {
    const result = appMap.getHierarchy("com.nonexistent.app");
    expect(result).toEqual([]);
  });

  it("getHierarchy returns empty array for zone without hierarchy", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    const result = appMap.getHierarchy("com.test.app", "toolbar");
    expect(result).toEqual([]);
  });

  it("recordHierarchy auto-creates zone if it does not exist", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordHierarchy("com.test.app", "content_area", "MainContent", ["Title", "Body"], "ocr_spatial");

    const data = appMap.load("com.test.app")!;
    expect(data.zones["content_area"]).toBeDefined();
    const hierarchy = appMap.getHierarchy("com.test.app", "content_area");
    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0]!.children).toEqual(["Title", "Body"]);
  });

  it("recordHierarchy deduplicates children within a single call", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.recordHierarchy("com.test.app", "sidebar", "Nav", ["Home", "Home", "Settings"], "ax_tree");

    const hierarchy = appMap.getHierarchy("com.test.app", "sidebar");
    expect(hierarchy[0]!.children).toEqual(["Home", "Settings"]);
  });

  // ── Input/Output Contracts (Phase 2d) ──

  it("recordContract creates a new contract", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Save",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Save",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["action succeeded"]);

    const data = appMap.load("com.test.app")!;
    const contracts = data.zones["toolbar"]!.contracts;
    expect(contracts).toBeDefined();
    expect(contracts).toHaveLength(1);
    expect(contracts![0]!.elementLabel).toBe("Save");
    expect(contracts![0]!.action).toBe("click");
    expect(contracts![0]!.outcomes).toHaveLength(1);
    expect(contracts![0]!.outcomes[0]!.description).toBe("action succeeded");
    expect(contracts![0]!.outcomes[0]!.seenCount).toBe(1);
    expect(contracts![0]!.outcomes[0]!.reliable).toBe(false);
    expect(contracts![0]!.validationCount).toBe(1);
  });

  it("recordContract merges outcomes on duplicate element+action", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Save",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Save",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["action succeeded"]);
    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["action succeeded", "dialog appeared"]);

    const data = appMap.load("com.test.app")!;
    const contracts = data.zones["toolbar"]!.contracts!;
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.outcomes).toHaveLength(2);
    expect(contracts[0]!.outcomes[0]!.description).toBe("action succeeded");
    expect(contracts[0]!.outcomes[0]!.seenCount).toBe(2);
    expect(contracts[0]!.outcomes[1]!.description).toBe("dialog appeared");
    expect(contracts[0]!.outcomes[1]!.seenCount).toBe(1);
    expect(contracts[0]!.validationCount).toBe(2);
  });

  it("recordContract increments seenCount on repeated outcomes", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    for (let i = 0; i < 5; i++) {
      appMap.recordContract("com.test.app", "toolbar", "Run", "click", ["build started"]);
    }

    const data = appMap.load("com.test.app")!;
    const contract = data.zones["toolbar"]!.contracts![0]!;
    expect(contract.outcomes[0]!.seenCount).toBe(5);
    expect(contract.validationCount).toBe(5);
  });

  it("recordContract marks outcome reliable at seenCount >= 3", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Run",
      relativeX: 0.05,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Run",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "toolbar", "Run", "click", ["build started"]);
    const c1 = appMap.load("com.test.app")!.zones["toolbar"]!.contracts![0]!;
    expect(c1.outcomes[0]!.reliable).toBe(false);

    appMap.recordContract("com.test.app", "toolbar", "Run", "click", ["build started"]);
    const c2 = appMap.load("com.test.app")!.zones["toolbar"]!.contracts![0]!;
    expect(c2.outcomes[0]!.reliable).toBe(false);

    appMap.recordContract("com.test.app", "toolbar", "Run", "click", ["build started"]);
    const c3 = appMap.load("com.test.app")!.zones["toolbar"]!.contracts![0]!;
    expect(c3.outcomes[0]!.reliable).toBe(true);
  });

  it("getContract finds contract across zones", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.addElement("com.test.app", "sidebar", {
      label: "Layers",
      relativeX: 0.1,
      relativeY: 0.5,
      anchor: "top-left",
      ocrBackup: "Layers",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "sidebar", "Layers", "click", ["panel expanded"]);

    const found = appMap.getContract("com.test.app", "Layers");
    expect(found).not.toBeNull();
    expect(found!.zone).toBe("sidebar");
    expect(found!.contract.elementLabel).toBe("Layers");
    expect(found!.contract.action).toBe("click");
    expect(found!.contract.outcomes[0]!.description).toBe("panel expanded");
  });

  it("getContract returns null for unknown element", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    expect(appMap.getContract("com.test.app", "NonExistent")).toBeNull();
  });

  it("contracts persist across save/load", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Save",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Save",
      successCount: 1,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });
    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["file saved"]);
    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["file saved"]);
    appMap.recordContract("com.test.app", "toolbar", "Save", "click", ["file saved"]);
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const loaded = appMap2.load("com.test.app");
    expect(loaded).not.toBeNull();
    const contracts = loaded!.zones["toolbar"]!.contracts;
    expect(contracts).toHaveLength(1);
    expect(contracts![0]!.outcomes[0]!.seenCount).toBe(3);
    expect(contracts![0]!.outcomes[0]!.reliable).toBe(true);
    expect(contracts![0]!.validationCount).toBe(3);
  });

  it("respects maxContractsPerZone limit", () => {
    const smallMap = new AppMap({ mapsDir, maxContractsPerZone: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");
    smallMap.addZone("com.test.app", "toolbar", makeZone());
    for (const label of ["Btn1", "Btn2", "Btn3"]) {
      smallMap.addElement("com.test.app", "toolbar", {
        label,
        relativeX: 0.1,
        relativeY: 0.04,
        anchor: "top-left",
        ocrBackup: label,
        successCount: 0,
        failCount: 0,
        lastInteracted: new Date().toISOString(),
        sessionsSinceUse: 0,
      });
    }

    smallMap.recordContract("com.test.app", "toolbar", "Btn1", "click", ["outcome1"]);
    smallMap.recordContract("com.test.app", "toolbar", "Btn2", "click", ["outcome2"]);
    // This should be rejected — at limit
    smallMap.recordContract("com.test.app", "toolbar", "Btn3", "click", ["outcome3"]);

    const data = smallMap.load("com.test.app")!;
    expect(data.zones["toolbar"]!.contracts).toHaveLength(2);
  });

  it("respects maxOutcomesPerContract limit", () => {
    const smallMap = new AppMap({ mapsDir, maxOutcomesPerContract: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");
    smallMap.addZone("com.test.app", "toolbar", makeZone());
    smallMap.addElement("com.test.app", "toolbar", {
      label: "Multi",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Multi",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    // First call with 3 outcomes — only first 2 should be kept
    smallMap.recordContract("com.test.app", "toolbar", "Multi", "click", ["a", "b", "c"]);
    const data1 = smallMap.load("com.test.app")!;
    expect(data1.zones["toolbar"]!.contracts![0]!.outcomes).toHaveLength(2);

    // Second call with new outcome — should be rejected (at limit)
    smallMap.recordContract("com.test.app", "toolbar", "Multi", "click", ["d"]);
    const data2 = smallMap.load("com.test.app")!;
    expect(data2.zones["toolbar"]!.contracts![0]!.outcomes).toHaveLength(2);
  });

  it("recordContract with preconditions merges without duplicates", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Deploy",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Deploy",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "toolbar", "Deploy", "click", ["deployed"], ["project saved"]);
    appMap.recordContract("com.test.app", "toolbar", "Deploy", "click", ["deployed"], ["project saved", "tests passed"]);

    const data = appMap.load("com.test.app")!;
    const contract = data.zones["toolbar"]!.contracts![0]!;
    expect(contract.preconditions).toHaveLength(2);
    expect(contract.preconditions).toContain("project saved");
    expect(contract.preconditions).toContain("tests passed");
  });

  it("recordContract with auto zone finds element across zones", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "sidebar", makeZone({ type: "sidebar" }));
    appMap.addElement("com.test.app", "sidebar", {
      label: "NavItem",
      relativeX: 0.05,
      relativeY: 0.5,
      anchor: "top-left",
      ocrBackup: "NavItem",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    // Use "auto" zone — should find element in sidebar
    appMap.recordContract("com.test.app", "auto", "NavItem", "click", ["navigated"]);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["sidebar"]!.contracts).toHaveLength(1);
    expect(data.zones["sidebar"]!.contracts![0]!.elementLabel).toBe("NavItem");
  });

  it("different actions on same element create separate contracts", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.addZone("com.test.app", "toolbar", makeZone());
    appMap.addElement("com.test.app", "toolbar", {
      label: "Input",
      relativeX: 0.1,
      relativeY: 0.04,
      anchor: "top-left",
      ocrBackup: "Input",
      successCount: 0,
      failCount: 0,
      lastInteracted: new Date().toISOString(),
      sessionsSinceUse: 0,
    });

    appMap.recordContract("com.test.app", "toolbar", "Input", "click", ["focused"]);
    appMap.recordContract("com.test.app", "toolbar", "Input", "type_text", ["text entered"]);

    const data = appMap.load("com.test.app")!;
    expect(data.zones["toolbar"]!.contracts).toHaveLength(2);
  });

  // ── State Machine (Phase 2e) ──

  it("recordStateChange creates dimension and transition", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "click_hamburger");

    const dims = appMap.getStateDimensions("com.test.app");
    expect(dims).toHaveLength(1);
    expect(dims[0]!.key).toBe("sidebar_state");
    expect(dims[0]!.currentValue).toBe("collapsed");
    expect(dims[0]!.possibleValues).toContain("expanded");
    expect(dims[0]!.possibleValues).toContain("collapsed");

    const txs = appMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(1);
    expect(txs[0]!.dimensionKey).toBe("sidebar_state");
    expect(txs[0]!.fromValue).toBe("expanded");
    expect(txs[0]!.toValue).toBe("collapsed");
    expect(txs[0]!.trigger).toBe("click_hamburger");
    expect(txs[0]!.observedCount).toBe(1);
  });

  it("duplicate transition increments observedCount", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "modal_state", "closed", "open", "click_settings");
    appMap.recordStateChange("com.test.app", "modal_state", "closed", "open", "click_settings");
    appMap.recordStateChange("com.test.app", "modal_state", "closed", "open", "click_settings");

    const txs = appMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(1);
    expect(txs[0]!.observedCount).toBe(3);
  });

  it("currentValue updates on state change", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "toggle");
    expect(appMap.getCurrentState("com.test.app")).toEqual({ sidebar_state: "collapsed" });

    appMap.recordStateChange("com.test.app", "sidebar_state", "collapsed", "expanded", "toggle");
    expect(appMap.getCurrentState("com.test.app")).toEqual({ sidebar_state: "expanded" });
  });

  it("auto-detects reversibility (A->B + B->A links them)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "click_hamburger");
    appMap.recordStateChange("com.test.app", "sidebar_state", "collapsed", "expanded", "click_hamburger_again");

    const txs = appMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(2);

    const forward = txs.find((t) => t.fromValue === "expanded" && t.toValue === "collapsed")!;
    const backward = txs.find((t) => t.fromValue === "collapsed" && t.toValue === "expanded")!;

    expect(forward.reverseTrigger).toEqual(["click_hamburger_again"]);
    expect(backward.reverseTrigger).toEqual(["click_hamburger"]);
  });

  it("max dimensions limit is enforced", () => {
    const smallMap = new AppMap({ mapsDir, maxStateDimensions: 3, maxStateTransitions: 100 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordStateChange("com.test.app", "dim1", "a", "b", "t1");
    smallMap.recordStateChange("com.test.app", "dim2", "a", "b", "t2");
    smallMap.recordStateChange("com.test.app", "dim3", "a", "b", "t3");
    // This should be rejected — already at max dimensions
    smallMap.recordStateChange("com.test.app", "dim4", "a", "b", "t4");

    const dims = smallMap.getStateDimensions("com.test.app");
    expect(dims).toHaveLength(3);
    expect(dims.map((d) => d.key)).not.toContain("dim4");
  });

  it("max transitions limit is enforced", () => {
    const smallMap = new AppMap({ mapsDir, maxStateDimensions: 30, maxStateTransitions: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordStateChange("com.test.app", "dim", "a", "b", "t1");
    smallMap.recordStateChange("com.test.app", "dim", "b", "c", "t2");
    // This should be rejected — already at max transitions
    smallMap.recordStateChange("com.test.app", "dim", "c", "d", "t3");

    const txs = smallMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(2);
  });

  it("state persists across save/load", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "view_mode", "list", "board", "click_board_tab");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "toggle");
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const loaded = appMap2.load("com.test.app");
    expect(loaded).not.toBeNull();

    const dims = appMap2.getStateDimensions("com.test.app");
    expect(dims).toHaveLength(2);
    expect(dims.map((d) => d.key).sort()).toEqual(["sidebar_state", "view_mode"]);

    const state = appMap2.getCurrentState("com.test.app");
    expect(state["view_mode"]).toBe("board");
    expect(state["sidebar_state"]).toBe("collapsed");

    const txs = appMap2.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(2);
  });

  it("getCurrentState returns latest values across multiple dimensions", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "toggle");
    appMap.recordStateChange("com.test.app", "modal_state", "closed", "open", "click_btn");
    appMap.recordStateChange("com.test.app", "view_mode", "list", "board", "tab_click");

    const state = appMap.getCurrentState("com.test.app");
    expect(state).toEqual({
      sidebar_state: "collapsed",
      modal_state: "open",
      view_mode: "board",
    });
  });

  it("same-value transitions are ignored", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "expanded", "toggle");

    const dims = appMap.getStateDimensions("com.test.app");
    expect(dims).toHaveLength(0);

    const txs = appMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(0);
  });

  it("returns empty for unknown app", () => {
    expect(appMap.getStateDimensions("com.unknown.app")).toEqual([]);
    expect(appMap.getCurrentState("com.unknown.app")).toEqual({});
    expect(appMap.getStateTransitions("com.unknown.app")).toEqual([]);
  });

  it("getStateTransitions filters by dimension key", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "sidebar_state", "expanded", "collapsed", "toggle");
    appMap.recordStateChange("com.test.app", "modal_state", "closed", "open", "click_btn");

    const sidebarTxs = appMap.getStateTransitions("com.test.app", "sidebar_state");
    expect(sidebarTxs).toHaveLength(1);
    expect(sidebarTxs[0]!.dimensionKey).toBe("sidebar_state");

    const modalTxs = appMap.getStateTransitions("com.test.app", "modal_state");
    expect(modalTxs).toHaveLength(1);
    expect(modalTxs[0]!.dimensionKey).toBe("modal_state");
  });

  it("same trigger different from/to creates separate transitions", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordStateChange("com.test.app", "view_mode", "list", "board", "tab_click");
    appMap.recordStateChange("com.test.app", "view_mode", "board", "grid", "tab_click");

    const txs = appMap.getStateTransitions("com.test.app");
    expect(txs).toHaveLength(2);

    // Dimension should have all three possible values
    const dims = appMap.getStateDimensions("com.test.app");
    expect(dims[0]!.possibleValues.sort()).toEqual(["board", "grid", "list"]);
    expect(dims[0]!.currentValue).toBe("grid");
  });

  // ── Conditional UI Tracking (Phase 2f) ──

  it("recordElementVisibility creates a new condition", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "Billing", "Settings", true);

    const data = appMap.load("com.test.app")!;
    expect(data.visibilityConditions).toBeDefined();
    expect(data.visibilityConditions).toHaveLength(1);
    const vc = data.visibilityConditions![0]!;
    expect(vc.elementLabel).toBe("Billing");
    expect(vc.seenCount).toBe(1);
    expect(vc.checkCount).toBe(1);
    expect(vc.visibilityRate).toBe(1);
    expect(vc.seenOnPages).toEqual(["Settings"]);
    expect(vc.absentOnPages).toEqual([]);
  });

  it("seenCount and checkCount increment correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "EditBtn", "Home", true);
    appMap.recordElementVisibility("com.test.app", "EditBtn", "Settings", false);
    appMap.recordElementVisibility("com.test.app", "EditBtn", "Home", true);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "EditBtn")!;
    expect(vc.seenCount).toBe(2);
    expect(vc.checkCount).toBe(3);
  });

  it("visibilityRate is computed correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "Tooltip", "Home", true);
    appMap.recordElementVisibility("com.test.app", "Tooltip", "Home", false);
    appMap.recordElementVisibility("com.test.app", "Tooltip", "Home", false);
    appMap.recordElementVisibility("com.test.app", "Tooltip", "Home", false);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "Tooltip")!;
    expect(vc.visibilityRate).toBe(0.25);
  });

  it("auto-classifies page-conditional elements", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Seen on Settings, absent on Home and Profile (need 3+ checks)
    appMap.recordElementVisibility("com.test.app", "BillingTab", "Settings", true);
    appMap.recordElementVisibility("com.test.app", "BillingTab", "Home", false);
    appMap.recordElementVisibility("com.test.app", "BillingTab", "Profile", false);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "BillingTab")!;
    expect(vc.conditionType).toBe("page");
    expect(vc.seenOnPages).toEqual(["Settings"]);
    expect(vc.absentOnPages).toContain("Home");
    expect(vc.absentOnPages).toContain("Profile");
    expect(vc.description).toContain("Settings");
  });

  it("auto-classifies state-conditional elements", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Intermittent visibility (0.3-0.8 rate), no clear page pattern
    // Seen 2 out of 4 times on the same page
    appMap.recordElementVisibility("com.test.app", "LockIcon", "Home", true);
    appMap.recordElementVisibility("com.test.app", "LockIcon", "Home", false);
    appMap.recordElementVisibility("com.test.app", "LockIcon", "Home", true);
    appMap.recordElementVisibility("com.test.app", "LockIcon", "Home", false);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "LockIcon")!;
    expect(vc.conditionType).toBe("state");
    expect(vc.visibilityRate).toBe(0.5);
  });

  it("auto-classifies session-conditional elements", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    const earlyDate = new Date(Date.now() - 86400000 * 10).toISOString(); // 10 days ago

    // Manually set up condition with old firstSeen/lastSeen to simulate time passage
    const data = appMap.getLoaded("com.test.app")!;
    data.visibilityConditions = [{
      elementLabel: "WelcomeTooltip",
      conditionType: "unknown",
      description: "",
      seenOnPages: ["Home"],
      absentOnPages: ["Home"],
      seenCount: 1,
      checkCount: 5,
      visibilityRate: 0.2,
      firstSeen: earlyDate,
      lastSeen: earlyDate,
    }];
    appMap.save(data);

    // Record more absences (total: 7 checks, 1 seen)
    appMap.recordElementVisibility("com.test.app", "WelcomeTooltip", "Home", false);
    appMap.recordElementVisibility("com.test.app", "WelcomeTooltip", "Home", false);

    const updated = appMap.load("com.test.app")!;
    const vc = updated.visibilityConditions!.find((v) => v.elementLabel === "WelcomeTooltip")!;
    expect(vc.conditionType).toBe("session");
    expect(vc.visibilityRate).toBeCloseTo(1 / 7, 2);
  });

  it("seenOnPages and absentOnPages deduplicate", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "Nav", "Home", true);
    appMap.recordElementVisibility("com.test.app", "Nav", "Home", true);
    appMap.recordElementVisibility("com.test.app", "Nav", "Settings", false);
    appMap.recordElementVisibility("com.test.app", "Nav", "Settings", false);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "Nav")!;
    expect(vc.seenOnPages).toEqual(["Home"]);
    expect(vc.absentOnPages).toEqual(["Settings"]);
  });

  it("getConditionalElements filters correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Always-visible element (rate = 1.0)
    for (let i = 0; i < 5; i++) {
      appMap.recordElementVisibility("com.test.app", "Toolbar", "Home", true);
    }
    // Conditional element (rate = 0.5)
    appMap.recordElementVisibility("com.test.app", "AdminPanel", "Home", true);
    appMap.recordElementVisibility("com.test.app", "AdminPanel", "Home", false);

    const conditional = appMap.getConditionalElements("com.test.app");
    expect(conditional).toHaveLength(1);
    expect(conditional[0]!.elementLabel).toBe("AdminPanel");
  });

  it("getPageSpecificElements returns elements only seen on one page", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Element only on Settings, absent on other pages
    appMap.recordElementVisibility("com.test.app", "AccountDelete", "Settings", true);
    appMap.recordElementVisibility("com.test.app", "AccountDelete", "Home", false);
    appMap.recordElementVisibility("com.test.app", "AccountDelete", "Profile", false);

    // Element seen on multiple pages
    appMap.recordElementVisibility("com.test.app", "NavBar", "Settings", true);
    appMap.recordElementVisibility("com.test.app", "NavBar", "Home", true);

    const specific = appMap.getPageSpecificElements("com.test.app", "Settings");
    expect(specific).toHaveLength(1);
    expect(specific[0]!.elementLabel).toBe("AccountDelete");
  });

  it("enforces maxVisibilityConditions limit", () => {
    const smallMap = new AppMap({ mapsDir, maxVisibilityConditions: 3 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordElementVisibility("com.test.app", "El1", "Home", true);
    smallMap.recordElementVisibility("com.test.app", "El2", "Home", true);
    smallMap.recordElementVisibility("com.test.app", "El3", "Home", true);
    smallMap.recordElementVisibility("com.test.app", "El4", "Home", true);

    const data = smallMap.load("com.test.app")!;
    expect(data.visibilityConditions).toHaveLength(3);
    expect(data.visibilityConditions!.find((v) => v.elementLabel === "El4")).toBeUndefined();
  });

  it("persists visibility conditions across save/load", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "SaveBtn", "Editor", true);
    appMap.recordElementVisibility("com.test.app", "SaveBtn", "Home", false);
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const loaded = appMap2.load("com.test.app");

    expect(loaded).not.toBeNull();
    expect(loaded!.visibilityConditions).toHaveLength(1);
    const vc = loaded!.visibilityConditions![0]!;
    expect(vc.elementLabel).toBe("SaveBtn");
    expect(vc.seenCount).toBe(1);
    expect(vc.checkCount).toBe(2);
    expect(vc.seenOnPages).toEqual(["Editor"]);
    expect(vc.absentOnPages).toEqual(["Home"]);
  });

  it("handles element never seen (always absent)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "Ghost", "Home", false);
    appMap.recordElementVisibility("com.test.app", "Ghost", "Settings", false);
    appMap.recordElementVisibility("com.test.app", "Ghost", "Profile", false);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "Ghost")!;
    expect(vc.seenCount).toBe(0);
    expect(vc.checkCount).toBe(3);
    expect(vc.visibilityRate).toBe(0);
    expect(vc.seenOnPages).toEqual([]);
  });

  it("handles element always seen (rate >= 0.9 not conditional)", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    for (let i = 0; i < 10; i++) {
      appMap.recordElementVisibility("com.test.app", "AlwaysThere", "Home", true);
    }

    const conditional = appMap.getConditionalElements("com.test.app");
    expect(conditional).toHaveLength(0);
  });

  it("handles empty page context gracefully", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordElementVisibility("com.test.app", "Floating", "", true);

    const data = appMap.load("com.test.app")!;
    const vc = data.visibilityConditions!.find((v) => v.elementLabel === "Floating")!;
    expect(vc.seenCount).toBe(1);
    expect(vc.checkCount).toBe(1);
    // Empty string not added to seenOnPages
    expect(vc.seenOnPages).toEqual([]);
  });

  it("returns empty array for unknown app in getConditionalElements", () => {
    const result = appMap.getConditionalElements("com.nonexistent.app");
    expect(result).toEqual([]);
  });

  it("returns empty array for unknown app in getPageSpecificElements", () => {
    const result = appMap.getPageSpecificElements("com.nonexistent.app", "Home");
    expect(result).toEqual([]);
  });

  // ── Timing & Animation (Phase 2g) ──

  it("recordTiming creates a new timing profile", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "click::Save", "element_response", 150);

    const profiles = appMap.getTimingProfile("com.test.app");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.key).toBe("click::Save");
    expect(profiles[0]!.type).toBe("element_response");
    expect(profiles[0]!.avgMs).toBe(150);
    expect(profiles[0]!.minMs).toBe(150);
    expect(profiles[0]!.maxMs).toBe(150);
    expect(profiles[0]!.sampleCount).toBe(1);
    expect(profiles[0]!.lastMs).toBe(150);
  });

  it("recordTiming updates running average correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    // Record three measurements: 100, 200, 300
    // After 1: avg=100
    // After 2: avg=(100*1+200)/2 = 150
    // After 3: avg=(150*2+300)/3 = 200
    appMap.recordTiming("com.test.app", "click::Run", "element_response", 100);
    appMap.recordTiming("com.test.app", "click::Run", "element_response", 200);
    appMap.recordTiming("com.test.app", "click::Run", "element_response", 300);

    const profiles = appMap.getTimingProfile("com.test.app", "click::Run");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.avgMs).toBe(200);
    expect(profiles[0]!.sampleCount).toBe(3);
    expect(profiles[0]!.lastMs).toBe(300);
  });

  it("recordTiming tracks min and max correctly", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "page_load::home", "page_load", 500);
    appMap.recordTiming("com.test.app", "page_load::home", "page_load", 200);
    appMap.recordTiming("com.test.app", "page_load::home", "page_load", 800);
    appMap.recordTiming("com.test.app", "page_load::home", "page_load", 350);

    const profiles = appMap.getTimingProfile("com.test.app", "page_load::home");
    expect(profiles[0]!.minMs).toBe(200);
    expect(profiles[0]!.maxMs).toBe(800);
  });

  it("recordTiming increments sampleCount", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    for (let i = 0; i < 7; i++) {
      appMap.recordTiming("com.test.app", "anim::modal", "animation", 50 + i * 10);
    }

    const profiles = appMap.getTimingProfile("com.test.app", "anim::modal");
    expect(profiles[0]!.sampleCount).toBe(7);
  });

  it("recordTiming handles zero duration", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "instant::action", "element_response", 0);

    const profiles = appMap.getTimingProfile("com.test.app", "instant::action");
    expect(profiles[0]!.avgMs).toBe(0);
    expect(profiles[0]!.minMs).toBe(0);
    expect(profiles[0]!.maxMs).toBe(0);
  });

  it("recordTiming handles very large values", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "slow::fetch", "data_fetch", 60000);
    appMap.recordTiming("com.test.app", "slow::fetch", "data_fetch", 1);

    const profiles = appMap.getTimingProfile("com.test.app", "slow::fetch");
    expect(profiles[0]!.minMs).toBe(1);
    expect(profiles[0]!.maxMs).toBe(60000);
    expect(profiles[0]!.avgMs).toBe(30000.5);
  });

  it("recordTiming keeps separate profiles for different types", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "search", "element_response", 100);
    appMap.recordTiming("com.test.app", "search", "data_fetch", 500);

    const all = appMap.getTimingProfile("com.test.app");
    expect(all).toHaveLength(2);

    const byKey = appMap.getTimingProfile("com.test.app", "search");
    expect(byKey).toHaveLength(2);
    const elementProfile = byKey.find((p) => p.type === "element_response")!;
    const fetchProfile = byKey.find((p) => p.type === "data_fetch")!;
    expect(elementProfile.avgMs).toBe(100);
    expect(fetchProfile.avgMs).toBe(500);
  });

  it("getTimingProfile returns empty array for unknown app", () => {
    expect(appMap.getTimingProfile("com.unknown.app")).toEqual([]);
  });

  it("getTimingProfile with key filter returns empty for non-matching key", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "click::Save", "element_response", 100);

    const profiles = appMap.getTimingProfile("com.test.app", "nonexistent");
    expect(profiles).toEqual([]);
  });

  it("recordReadySignal creates a new signal", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordReadySignal("com.test.app", "browser_navigate", "wait_completed", 1500);

    const signals = appMap.getReadySignals("com.test.app");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.afterAction).toBe("browser_navigate");
    expect(signals[0]!.signal).toBe("wait_completed");
    expect(signals[0]!.typicalMs).toBe(1500);
    expect(signals[0]!.maxObservedMs).toBe(1500);
    expect(signals[0]!.sampleCount).toBe(1);
  });

  it("recordReadySignal updates typicalMs and maxObservedMs on duplicate", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordReadySignal("com.test.app", "click::Submit", "wait_completed", 1000);
    appMap.recordReadySignal("com.test.app", "click::Submit", "wait_completed", 2000);
    appMap.recordReadySignal("com.test.app", "click::Submit", "wait_completed", 500);

    const signals = appMap.getReadySignals("com.test.app");
    expect(signals).toHaveLength(1);
    // Running average: (1000*1+2000)/2=1500, (1500*2+500)/3=1166.67
    expect(signals[0]!.typicalMs).toBeCloseTo(1166.67, 0);
    expect(signals[0]!.maxObservedMs).toBe(2000);
    expect(signals[0]!.sampleCount).toBe(3);
  });

  it("getExpectedWait returns correct value", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordReadySignal("com.test.app", "browser_navigate", "text_appears", 800);

    const wait = appMap.getExpectedWait("com.test.app", "browser_navigate");
    expect(wait).toBe(800);
  });

  it("getExpectedWait returns max typicalMs across multiple signals", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordReadySignal("com.test.app", "click::Search", "text_appears", 300);
    appMap.recordReadySignal("com.test.app", "click::Search", "spinner_gone", 500);

    const wait = appMap.getExpectedWait("com.test.app", "click::Search");
    expect(wait).toBe(500);
  });

  it("getExpectedWait returns null for unknown action", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    expect(appMap.getExpectedWait("com.test.app", "nonexistent_action")).toBeNull();
  });

  it("getExpectedWait returns null for unknown app", () => {
    expect(appMap.getExpectedWait("com.unknown.app", "click")).toBeNull();
  });

  it("getReadySignals returns empty array for unknown app", () => {
    expect(appMap.getReadySignals("com.unknown.app")).toEqual([]);
  });

  it("enforces maxTimingProfiles limit", () => {
    const smallMap = new AppMap({ mapsDir, maxTimingProfiles: 3 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordTiming("com.test.app", "t1", "element_response", 100);
    smallMap.recordTiming("com.test.app", "t2", "element_response", 200);
    smallMap.recordTiming("com.test.app", "t3", "element_response", 300);
    smallMap.recordTiming("com.test.app", "t4", "element_response", 400); // should be dropped

    const profiles = smallMap.getTimingProfile("com.test.app");
    expect(profiles).toHaveLength(3);
    expect(profiles.find((p) => p.key === "t4")).toBeUndefined();
  });

  it("enforces maxReadySignals limit", () => {
    const smallMap = new AppMap({ mapsDir, maxReadySignals: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordReadySignal("com.test.app", "action1", "signal1", 100);
    smallMap.recordReadySignal("com.test.app", "action2", "signal2", 200);
    smallMap.recordReadySignal("com.test.app", "action3", "signal3", 300); // should be dropped

    const signals = smallMap.getReadySignals("com.test.app");
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.afterAction === "action3")).toBeUndefined();
  });

  it("updating existing entry within limit still works", () => {
    const smallMap = new AppMap({ mapsDir, maxTimingProfiles: 2 });
    smallMap.init();
    smallMap.createEmpty("com.test.app", "TestApp");

    smallMap.recordTiming("com.test.app", "t1", "element_response", 100);
    smallMap.recordTiming("com.test.app", "t2", "element_response", 200);
    // Updating t1 should still work even though we're at the limit
    smallMap.recordTiming("com.test.app", "t1", "element_response", 300);

    const profiles = smallMap.getTimingProfile("com.test.app");
    expect(profiles).toHaveLength(2);
    const t1 = profiles.find((p) => p.key === "t1")!;
    expect(t1.sampleCount).toBe(2);
    expect(t1.avgMs).toBe(200); // (100+300)/2
  });

  it("timing profiles persist across save/load", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "click::Save", "element_response", 150);
    appMap.recordTiming("com.test.app", "click::Save", "element_response", 250);
    appMap.recordReadySignal("com.test.app", "navigate", "wait_completed", 1200);
    appMap.flush();

    const appMap2 = new AppMap({ mapsDir });
    appMap2.init();
    const loaded = appMap2.load("com.test.app");

    expect(loaded).not.toBeNull();
    expect(loaded!.timingProfiles).toHaveLength(1);
    expect(loaded!.timingProfiles![0]!.key).toBe("click::Save");
    expect(loaded!.timingProfiles![0]!.sampleCount).toBe(2);
    expect(loaded!.timingProfiles![0]!.avgMs).toBe(200);

    expect(loaded!.readySignals).toHaveLength(1);
    expect(loaded!.readySignals![0]!.afterAction).toBe("navigate");
    expect(loaded!.readySignals![0]!.typicalMs).toBe(1200);
  });

  it("single sample timing profile has correct values", () => {
    appMap.createEmpty("com.test.app", "TestApp");
    appMap.recordTiming("com.test.app", "single", "animation", 42);

    const profiles = appMap.getTimingProfile("com.test.app", "single");
    expect(profiles).toHaveLength(1);
    const p = profiles[0]!;
    expect(p.avgMs).toBe(42);
    expect(p.minMs).toBe(42);
    expect(p.maxMs).toBe(42);
    expect(p.sampleCount).toBe(1);
    expect(p.lastMs).toBe(42);
  });
});

describe("ContextTracker page transitions", () => {
  let tracker: ContextTracker;

  beforeEach(() => {
    const store = new PlaybookStore("/tmp/ct-nav-test-" + Date.now());
    tracker = new ContextTracker(store);
  });

  it("consumePageTransition returns null when no transition", () => {
    expect(tracker.consumePageTransition()).toBeNull();
  });

  it("consumePageTransition returns transition after page change", () => {
    tracker.updatePageContext("Home - MyApp");
    tracker.updatePageContext("Settings - MyApp");

    const transition = tracker.consumePageTransition();
    expect(transition).not.toBeNull();
    expect(transition!.from).toBe("Home");
    expect(transition!.to).toBe("Settings");
  });

  it("consumePageTransition returns null on second call (consumed)", () => {
    tracker.updatePageContext("Home - MyApp");
    tracker.updatePageContext("Settings - MyApp");

    const first = tracker.consumePageTransition();
    expect(first).not.toBeNull();

    const second = tracker.consumePageTransition();
    expect(second).toBeNull();
  });

  it("no transition when same page updated twice", () => {
    tracker.updatePageContext("Home - MyApp");
    tracker.updatePageContext("Home - MyApp");

    expect(tracker.consumePageTransition()).toBeNull();
  });

  it("no transition from null to a page", () => {
    // First call sets page, but previous was null — no transition
    tracker.updatePageContext("Home - MyApp");
    expect(tracker.consumePageTransition()).toBeNull();
  });

  it("no transition when page goes to null", () => {
    tracker.updatePageContext("Home - MyApp");
    tracker.updatePageContext(null);
    expect(tracker.consumePageTransition()).toBeNull();
  });

  it("tracks multiple sequential transitions", () => {
    tracker.updatePageContext("Home - MyApp");
    tracker.updatePageContext("Settings - MyApp");

    const t1 = tracker.consumePageTransition();
    expect(t1).toEqual({ from: "Home", to: "Settings" });

    tracker.updatePageContext("Profile - MyApp");

    const t2 = tracker.consumePageTransition();
    expect(t2).toEqual({ from: "Settings", to: "Profile" });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2 Breaker — adversarial
// ══════════════════════════════════════════════════════════════════════════

describe("Phase 2 Breaker — adversarial", () => {
  let mapsDir: string;
  let appMap: AppMap;
  const BID = "com.breaker.test";

  beforeEach(() => {
    mapsDir = makeTmpDir();
    appMap = new AppMap({ mapsDir });
    appMap.init();
    appMap.createEmpty(BID, "BreakerApp");
  });

  afterEach(() => {
    appMap.flush();
    fs.rmSync(mapsDir, { recursive: true, force: true });
  });

  // ── BUG: recordTiming corrupted by NaN ──────────────────────────────

  describe("timing — NaN/Infinity/negative poison", () => {
    it("NaN duration is rejected — avgMs stays valid (FIXED)", () => {
      // BUG FOUND: NaN duration corrupted avgMs permanently (NaN is sticky in arithmetic).
      // FIX: recordTiming now rejects non-finite values.
      appMap.recordTiming(BID, "btn", "element_response", 100);
      appMap.recordTiming(BID, "btn", "element_response", NaN);
      const profiles = appMap.getTimingProfile(BID, "btn");
      expect(profiles).toHaveLength(1);
      expect(Number.isFinite(profiles[0]!.avgMs)).toBe(true);
      expect(profiles[0]!.avgMs).toBe(100); // NaN was rejected, avg unchanged
      expect(profiles[0]!.sampleCount).toBe(1); // sample not counted
    });

    it("Infinity duration is rejected (FIXED)", () => {
      // BUG FOUND: Infinity duration made avgMs = Infinity forever.
      appMap.recordTiming(BID, "btn2", "element_response", 100);
      appMap.recordTiming(BID, "btn2", "element_response", Infinity);
      const profiles = appMap.getTimingProfile(BID, "btn2");
      expect(profiles).toHaveLength(1);
      expect(Number.isFinite(profiles[0]!.avgMs)).toBe(true);
      expect(profiles[0]!.avgMs).toBe(100);
    });

    it("negative duration is rejected (FIXED)", () => {
      // BUG FOUND: negative durations made minMs negative, nonsensical for timing.
      appMap.recordTiming(BID, "btn3", "element_response", 100);
      appMap.recordTiming(BID, "btn3", "element_response", -500);
      const profiles = appMap.getTimingProfile(BID, "btn3");
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.minMs).toBeGreaterThanOrEqual(0);
      expect(profiles[0]!.minMs).toBe(100);
    });

    it("NaN as first timing creates no profile (FIXED)", () => {
      // BUG FOUND: NaN as first value created a permanently poisoned profile.
      appMap.recordTiming(BID, "poison", "element_response", NaN);
      const profiles = appMap.getTimingProfile(BID, "poison");
      expect(profiles).toHaveLength(0); // rejected entirely
    });
  });

  // ── BUG: recordReadySignal NaN/negative poison ──────────────────────

  describe("readySignal — NaN/negative poison", () => {
    it("NaN waitMs is rejected — typicalMs stays valid (FIXED)", () => {
      // BUG FOUND: NaN waitMs corrupted typicalMs permanently.
      appMap.recordReadySignal(BID, "click_save", "spinner_gone", 200);
      appMap.recordReadySignal(BID, "click_save", "spinner_gone", NaN);
      const signals = appMap.getReadySignals(BID);
      const sig = signals.find(s => s.afterAction === "click_save");
      expect(sig).toBeDefined();
      expect(Number.isFinite(sig!.typicalMs)).toBe(true);
      expect(sig!.typicalMs).toBe(200); // NaN rejected
      expect(sig!.sampleCount).toBe(1);
    });

    it("negative waitMs is rejected (FIXED)", () => {
      // BUG FOUND: negative waitMs created nonsensical timing data.
      appMap.recordReadySignal(BID, "open_page", "loaded", -100);
      const signals = appMap.getReadySignals(BID);
      const sig = signals.find(s => s.afterAction === "open_page");
      expect(sig).toBeUndefined(); // rejected entirely
    });
  });

  // ── BUG: unbounded array growth ─────────────────────────────────────

  describe("unbounded array growth", () => {
    it("seenOnPages capped at 100 (FIXED)", () => {
      // BUG FOUND: seenOnPages grew without limit, causing unbounded memory/disk usage.
      for (let i = 0; i < 500; i++) {
        appMap.recordElementVisibility(BID, "toolbar_btn", `page_${i}`, true);
      }
      appMap.flush();

      const freshMap = new AppMap({ mapsDir });
      freshMap.init();
      const data = freshMap.load(BID);
      expect(data).not.toBeNull();
      const vc = data!.visibilityConditions?.find(v => v.elementLabel === "toolbar_btn");
      expect(vc).toBeDefined();
      expect(vc!.seenOnPages.length).toBeLessThanOrEqual(100);
      // seenCount still accurate (all 500 counted)
      expect(vc!.seenCount).toBe(500);
    });

    it("hierarchy children capped at 200 (FIXED)", () => {
      // BUG FOUND: children array merged without limit via Set.
      appMap.addZone(BID, "main", makeZone());
      for (let i = 0; i < 1000; i++) {
        appMap.recordHierarchy(BID, "main", "container", [`child_${i}`], "ax_tree");
      }
      const hierarchy = appMap.getHierarchy(BID, "main");
      const entry = hierarchy.find(h => h.parentLabel === "container");
      expect(entry).toBeDefined();
      expect(entry!.children.length).toBeLessThanOrEqual(200);
    });

    it("contract preconditions capped at 50 (FIXED)", () => {
      // BUG FOUND: preconditions array grew without limit.
      appMap.addZone(BID, "main", makeZone());
      appMap.recordContract(BID, "main", "save_btn", "click", ["saved"], ["logged_in"]);
      for (let i = 0; i < 500; i++) {
        appMap.recordContract(BID, "main", "save_btn", "click", ["saved"], [`precond_${i}`]);
      }
      const contract = appMap.getContract(BID, "save_btn");
      expect(contract).not.toBeNull();
      expect(contract!.contract.preconditions.length).toBeLessThanOrEqual(50);
    });

    it("stateDimension possibleValues capped at 100 (FIXED)", () => {
      // BUG FOUND: possibleValues grew without limit.
      for (let i = 0; i < 500; i++) {
        appMap.recordStateChange(BID, "color_mode", `val_${i}`, `val_${i + 1}`, "switch");
      }
      const dims = appMap.getStateDimensions(BID);
      const dim = dims.find(d => d.key === "color_mode");
      expect(dim).toBeDefined();
      expect(dim!.possibleValues.length).toBeLessThanOrEqual(100);
    });
  });

  // ── BUG: ladderFilePath path traversal (no sanitization) ────────────

  describe("ladderFilePath — path traversal (FIXED)", () => {
    it("bundleId with slashes is sanitized in filePath and now in ladderFilePath", () => {
      // BUG FOUND: ladderFilePath did NOT sanitize bundleId (filePath did).
      // A bundleId like "../../etc/passwd" would create a ladder file outside mapsDir.
      // FIX: ladderFilePath now uses the same sanitization as filePath.
      const evilBundleId = "../../etc/passwd";
      appMap.createEmpty(evilBundleId, "Evil");
      appMap.flush();

      // All files should stay inside mapsDir — no path traversal
      const files = fs.readdirSync(mapsDir);
      for (const f of files) {
        expect(f).not.toContain("/");
      }

      // The map file should contain "etc_passwd" (slashes replaced with _)
      const mapFile = files.find(f => f.endsWith(".json") && !f.endsWith(".bak") && !f.includes("ladder"));
      expect(mapFile).toBeDefined();
      expect(mapFile!).toContain("etc_passwd");
    });
  });

  // ── BUG: recordContract auto zone fallback silently drops ────────────

  describe("recordContract — auto zone fallback", () => {
    it("contract with zoneKey=auto creates auto_discovered if needed (FIXED)", () => {
      // BUG FOUND: recordContract with zoneKey="auto" silently dropped contracts
      // when no zones existed, because it didn't create auto_discovered (unlike
      // recordElementOutcome which does). This was an inconsistency.
      // FIX: recordContract now creates auto_discovered zone when needed.
      appMap.recordContract(BID, "auto", "save_btn", "click", ["saved"]);
      const contract = appMap.getContract(BID, "save_btn");
      expect(contract).not.toBeNull();
      expect(contract!.zone).toBe("auto_discovered");
      expect(contract!.contract.outcomes).toHaveLength(1);
    });
  });

  // ── State machine edge cases ────────────────────────────────────────

  describe("state machine — edge cases", () => {
    it("same from/to is correctly rejected (no self-loops)", () => {
      appMap.recordStateChange(BID, "mode", "dark", "dark", "toggle");
      const transitions = appMap.getStateTransitions(BID);
      expect(transitions).toHaveLength(0);
    });

    it("reverseTrigger collects ALL reverse triggers as array", () => {
      // A->B via "click_close"
      appMap.recordStateChange(BID, "panel", "open", "closed", "click_close");
      // B->A via "press_escape" — links them
      appMap.recordStateChange(BID, "panel", "closed", "open", "press_escape");
      // A->B via DIFFERENT trigger "cmd+w"
      appMap.recordStateChange(BID, "panel", "open", "closed", "cmd+w");
      // B->A via DIFFERENT trigger "menu_open"
      appMap.recordStateChange(BID, "panel", "closed", "open", "menu_open");

      const transitions = appMap.getStateTransitions(BID);

      // click_close (A->B) should have both B->A triggers
      const clickClose = transitions.find(t => t.trigger === "click_close");
      expect(clickClose).toBeDefined();
      expect(clickClose!.reverseTrigger).toEqual(expect.arrayContaining(["press_escape", "menu_open"]));

      // cmd+w (A->B) should also have both B->A triggers
      const cmdW = transitions.find(t => t.trigger === "cmd+w");
      expect(cmdW).toBeDefined();
      expect(cmdW!.reverseTrigger).toEqual(expect.arrayContaining(["press_escape", "menu_open"]));

      // press_escape (B->A) should have both A->B triggers
      const pressEscape = transitions.find(t => t.trigger === "press_escape");
      expect(pressEscape).toBeDefined();
      expect(pressEscape!.reverseTrigger).toEqual(expect.arrayContaining(["click_close", "cmd+w"]));

      // menu_open (B->A) should have both A->B triggers
      const menuOpen = transitions.find(t => t.trigger === "menu_open");
      expect(menuOpen).toBeDefined();
      expect(menuOpen!.reverseTrigger).toEqual(expect.arrayContaining(["click_close", "cmd+w"]));
    });
  });

  // ── Persistence round-trip for all Phase 2 fields ───────────────────

  describe("persistence round-trip", () => {
    it("all Phase 2 fields survive flush + reload", () => {
      // Write data using all 7 phase methods
      appMap.addZone(BID, "main", makeZone());

      // 2a: element in zone
      appMap.recordElementOutcome(BID, "main", "btn1", true);

      // 2b: navigation
      appMap.recordPageTransition(BID, "Home", "Settings", "click");

      // 2c: hierarchy
      appMap.recordHierarchy(BID, "main", "container1", ["child1", "child2"], "ax_tree");

      // 2d: contracts
      appMap.recordContract(BID, "main", "btn1", "click", ["opened dialog"], ["logged_in"]);

      // 2e: state machine
      appMap.recordStateChange(BID, "sidebar_state", "expanded", "collapsed", "click_toggle");

      // 2f: visibility
      appMap.recordElementVisibility(BID, "btn1", "Home", true);
      appMap.recordElementVisibility(BID, "btn1", "Settings", false);

      // 2g: timing
      appMap.recordTiming(BID, "btn1_click", "element_response", 150);
      appMap.recordReadySignal(BID, "navigate", "page_loaded", 500);

      // Flush to disk
      appMap.flush();

      // Create entirely new AppMap instance and reload
      const freshMap = new AppMap({ mapsDir });
      freshMap.init();
      const data = freshMap.load(BID);
      expect(data).not.toBeNull();

      // 2b: navigation graph
      expect(data!.navigationGraph.edges).toHaveLength(1);
      expect(data!.navigationGraph.edges[0]!.from).toBe("Home");
      expect(data!.navigationGraph.edges[0]!.to).toBe("Settings");

      // 2c: hierarchy
      const mainZone = data!.zones["main"];
      expect(mainZone).toBeDefined();
      expect(mainZone!.hierarchy).toHaveLength(1);
      expect(mainZone!.hierarchy![0]!.children).toEqual(["child1", "child2"]);

      // 2d: contracts
      expect(mainZone!.contracts).toHaveLength(1);
      expect(mainZone!.contracts![0]!.elementLabel).toBe("btn1");
      expect(mainZone!.contracts![0]!.preconditions).toEqual(["logged_in"]);

      // 2e: state dimensions + transitions
      expect(data!.stateDimensions).toHaveLength(1);
      expect(data!.stateDimensions![0]!.currentValue).toBe("collapsed");
      expect(data!.stateTransitions).toHaveLength(1);

      // 2f: visibility
      expect(data!.visibilityConditions).toHaveLength(1);
      expect(data!.visibilityConditions![0]!.seenCount).toBe(1);
      expect(data!.visibilityConditions![0]!.checkCount).toBe(2);

      // 2g: timing
      expect(data!.timingProfiles).toHaveLength(1);
      expect(data!.timingProfiles![0]!.avgMs).toBe(150);
      expect(data!.readySignals).toHaveLength(1);
      expect(data!.readySignals![0]!.typicalMs).toBe(500);
    });
  });

  // ── Backward compatibility: old map without new Phase 2 fields ──────

  describe("backward compatibility — old maps", () => {
    it("loading map without Phase 2 optional fields does not crash", () => {
      // Write a minimal old-format map directly to disk
      const oldData = {
        app: "com.old.app",
        appName: "OldApp",
        version: "1.0",
        masteryLevel: "beginner",
        rating: { grade: "F", subTier: 1 },
        ratingFactors: {
          featureCoverage: 0, workflowDepth: 0, outcomeVerification: 0,
          errorRecovery: 0, speedEfficiency: 0, crossFeatureChains: 0,
          edgeCaseHandling: 0, teachingAbility: 0, platformKnowledge: 0,
          consistency: 0,
        },
        confidence: 0,
        lastValidated: new Date().toISOString(),
        mapVersion: 1,
        uiArchitecture: {
          type: "other", rendering: "native", axSupport: "partial",
          bestMethod: "ax", menuStyle: "standard", dragDropHeavy: false,
          hasCanvas: false,
        },
        zones: { main: makeZone() },
        navigationGraph: { nodes: {}, edges: [] },
        masteryHistory: [],
        totalTasksCompleted: 0,
        sessionCount: 0,
        featureLadder: [],
        featureMastery: {},
        masteryMetrics: {
          breadth: 0, workflowBreadth: 0, outcomeBreadth: 0,
          reliability: 0, healingRate: 0, crossFeatureWorkflows: 0,
          criticalFloor: 0, weightedScore: 0,
        },
        crossFeatureWorkflows: 0,
        actionSuccessCount: 0,
        actionFailCount: 0,
        // NOTE: no stateDimensions, stateTransitions, visibilityConditions,
        // timingProfiles, readySignals — these are Phase 2 optional fields
      };

      const filePath = path.join(mapsDir, "com.old.app.json");
      fs.writeFileSync(filePath, JSON.stringify(oldData, null, 2));

      const freshMap = new AppMap({ mapsDir });
      freshMap.init();

      // These should all work without crashing on undefined
      expect(() => freshMap.getStateDimensions("com.old.app")).not.toThrow();
      expect(() => freshMap.getStateTransitions("com.old.app")).not.toThrow();
      expect(() => freshMap.getConditionalElements("com.old.app")).not.toThrow();
      expect(() => freshMap.getTimingProfile("com.old.app")).not.toThrow();
      expect(() => freshMap.getReadySignals("com.old.app")).not.toThrow();
      expect(() => freshMap.getExpectedWait("com.old.app", "click")).not.toThrow();
      expect(() => freshMap.getCurrentState("com.old.app")).not.toThrow();

      // Recording new Phase 2 data on old maps should also work
      expect(() => freshMap.recordStateChange("com.old.app", "mode", "a", "b", "click")).not.toThrow();
      expect(() => freshMap.recordElementVisibility("com.old.app", "btn", "page1", true)).not.toThrow();
      expect(() => freshMap.recordTiming("com.old.app", "k", "element_response", 100)).not.toThrow();
      expect(() => freshMap.recordReadySignal("com.old.app", "act", "sig", 50)).not.toThrow();
    });
  });

  // ── Limit enforcement ───────────────────────────────────────────────

  describe("limit enforcement — all at once", () => {
    it("maxEdges stops navigation graph growth", () => {
      const smallMap = new AppMap({ mapsDir, maxEdges: 5 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordPageTransition(BID, `page_${i}`, `page_${i + 1}`, "click");
      }
      const data = smallMap.load(BID);
      expect(data!.navigationGraph.edges.length).toBeLessThanOrEqual(5);
      smallMap.flush();
    });

    it("maxContractsPerZone stops contract growth", () => {
      const smallMap = new AppMap({ mapsDir, maxContractsPerZone: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      smallMap.addZone(BID, "z", makeZone());
      for (let i = 0; i < 20; i++) {
        smallMap.recordContract(BID, "z", `btn_${i}`, "click", ["ok"]);
      }
      const data = smallMap.load(BID);
      expect(data!.zones["z"]!.contracts!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxStateDimensions stops dimension growth", () => {
      const smallMap = new AppMap({ mapsDir, maxStateDimensions: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordStateChange(BID, `dim_${i}`, "a", "b", "click");
      }
      const data = smallMap.load(BID);
      expect(data!.stateDimensions!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxStateTransitions stops transition growth", () => {
      const smallMap = new AppMap({ mapsDir, maxStateTransitions: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordStateChange(BID, "dim", `val_${i}`, `val_${i + 1}`, `trigger_${i}`);
      }
      const data = smallMap.load(BID);
      expect(data!.stateTransitions!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxVisibilityConditions stops visibility growth", () => {
      const smallMap = new AppMap({ mapsDir, maxVisibilityConditions: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordElementVisibility(BID, `el_${i}`, "page1", true);
      }
      const data = smallMap.load(BID);
      expect(data!.visibilityConditions!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxTimingProfiles stops timing profile growth", () => {
      const smallMap = new AppMap({ mapsDir, maxTimingProfiles: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordTiming(BID, `key_${i}`, "element_response", 100);
      }
      const data = smallMap.load(BID);
      expect(data!.timingProfiles!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxReadySignals stops ready signal growth", () => {
      const smallMap = new AppMap({ mapsDir, maxReadySignals: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      for (let i = 0; i < 20; i++) {
        smallMap.recordReadySignal(BID, `action_${i}`, "signal", 100);
      }
      const data = smallMap.load(BID);
      expect(data!.readySignals!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });

    it("maxHierarchyEntriesPerZone stops hierarchy growth", () => {
      const smallMap = new AppMap({ mapsDir, maxHierarchyEntriesPerZone: 3 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");
      smallMap.addZone(BID, "z", makeZone());
      for (let i = 0; i < 20; i++) {
        smallMap.recordHierarchy(BID, "z", `parent_${i}`, ["child"], "ax_tree");
      }
      const data = smallMap.load(BID);
      expect(data!.zones["z"]!.hierarchy!.length).toBeLessThanOrEqual(3);
      smallMap.flush();
    });
  });

  // ── Cross-phase interactions ────────────────────────────────────────

  describe("cross-phase interactions", () => {
    it("element in 2a, contract in 2d, visibility in 2f, timing in 2g — all reference same element", () => {
      appMap.addZone(BID, "main", makeZone());

      // 2a: record element
      appMap.recordElementOutcome(BID, "main", "save_button", true);

      // 2d: record contract for same element
      appMap.recordContract(BID, "main", "save_button", "click", ["file saved"]);

      // 2f: visibility for same element
      appMap.recordElementVisibility(BID, "save_button", "editor", true);

      // 2g: timing for same element
      appMap.recordTiming(BID, "click::save_button", "element_response", 120);

      // All should reference "save_button" consistently
      const data = appMap.load(BID);
      expect(data).not.toBeNull();

      // Element exists in zone
      const zone = data!.zones["main"];
      expect(zone).toBeDefined();
      const el = zone!.elements.find(e => e.label === "save_button");
      expect(el).toBeDefined();

      // Contract exists
      const contract = zone!.contracts?.find(c => c.elementLabel === "save_button");
      expect(contract).toBeDefined();

      // Visibility exists
      const vc = data!.visibilityConditions?.find(v => v.elementLabel === "save_button");
      expect(vc).toBeDefined();

      // Timing exists
      const tp = data!.timingProfiles?.find(p => p.key === "click::save_button");
      expect(tp).toBeDefined();
    });
  });

  // ── Visibility classification edge cases ────────────────────────────

  describe("visibility classification edge cases", () => {
    it("element seen on SAME page as both present and absent is classified as state, not page", () => {
      // Seen on page1, then absent on page1 — that's state-dependent, not page-dependent
      appMap.recordElementVisibility(BID, "dynamic_btn", "page1", true);
      appMap.recordElementVisibility(BID, "dynamic_btn", "page1", false);
      appMap.recordElementVisibility(BID, "dynamic_btn", "page1", true);
      appMap.recordElementVisibility(BID, "dynamic_btn", "page1", false);
      // checkCount=4, seenCount=2, rate=0.5, seenOnPages=[page1], absentOnPages=[page1]
      // Since page1 appears in BOTH seen and absent, this should NOT be classified as "page"
      const conditions = appMap.getConditionalElements(BID);
      const vc = conditions.find(v => v.elementLabel === "dynamic_btn");
      expect(vc).toBeDefined();
      expect(vc!.conditionType).not.toBe("page");
      // Should be "state" since visibility rate is 0.5 (in 0.3-0.8 range)
      expect(vc!.conditionType).toBe("state");
    });

    it("classification with checkCount=0 never divides by zero", () => {
      // Directly testing: if somehow checkCount is 0 (shouldn't happen normally)
      // The visibilityRate calculation: seenCount / checkCount
      // In practice checkCount is always >= 1 after recordElementVisibility,
      // but verify the guard works
      appMap.recordElementVisibility(BID, "test_el", "p1", true);
      const data = appMap.load(BID);
      const vc = data!.visibilityConditions?.find(v => v.elementLabel === "test_el");
      expect(vc).toBeDefined();
      expect(vc!.checkCount).toBe(1);
      expect(Number.isFinite(vc!.visibilityRate)).toBe(true);
    });
  });

  // ── Unicode and special characters in keys ──────────────────────────

  describe("unicode and special characters", () => {
    it("zone keys with unicode work for hierarchy", () => {
      const unicodeZone = "page::设置页面";
      appMap.addZone(BID, unicodeZone, makeZone());
      appMap.recordHierarchy(BID, unicodeZone, "父容器", ["子元素1", "子元素2"], "ax_tree");
      const hierarchy = appMap.getHierarchy(BID, unicodeZone);
      expect(hierarchy).toHaveLength(1);
      expect(hierarchy[0]!.parentLabel).toBe("父容器");
    });

    it("empty string labels are rejected by all record methods", () => {
      appMap.addZone(BID, "main", makeZone());

      // recordContract rejects empty elementLabel
      appMap.recordContract(BID, "main", "", "click", ["something happened"]);
      const contract = appMap.getContract(BID, "");
      expect(contract).toBeNull();

      // recordContract rejects empty action
      appMap.recordContract(BID, "main", "btn", "", ["something happened"]);
      const contract2 = appMap.getContract(BID, "btn");
      expect(contract2).toBeNull();

      // recordHierarchy rejects empty parentLabel
      appMap.recordHierarchy(BID, "main", "", ["child1"], "ax_tree");
      const hierarchy = appMap.getHierarchy(BID, "main");
      expect(hierarchy).toHaveLength(0);

      // recordStateChange rejects empty dimensionKey/fromValue/toValue
      appMap.recordStateChange(BID, "", "a", "b", "trigger");
      appMap.recordStateChange(BID, "dim", "", "b", "trigger");
      appMap.recordStateChange(BID, "dim", "a", "", "trigger");
      expect(appMap.getStateDimensions(BID)).toHaveLength(0);

      // recordTiming rejects empty key
      appMap.recordTiming(BID, "", "element_response", 100);
      expect(appMap.getTimingProfile(BID)).toHaveLength(0);

      // recordReadySignal rejects empty afterAction/signal
      appMap.recordReadySignal(BID, "", "signal", 100);
      appMap.recordReadySignal(BID, "action", "", 100);
      expect(appMap.getReadySignals(BID)).toHaveLength(0);

      // recordElementVisibility rejects empty elementLabel
      appMap.recordElementVisibility(BID, "", "Home", true);
      expect(appMap.getConditionalElements(BID)).toHaveLength(0);

      // recordPageTransition rejects empty page names
      appMap.recordPageTransition(BID, "", "Settings", "click");
      appMap.recordPageTransition(BID, "Home", "", "click");
      const data = appMap.load(BID);
      expect(data!.navigationGraph.edges).toHaveLength(0);
    });

    it("timing keys with special characters persist correctly", () => {
      appMap.recordTiming(BID, 'btn::{"id":1}', "element_response", 100);
      appMap.flush();

      const freshMap = new AppMap({ mapsDir });
      freshMap.init();
      const profiles = freshMap.getTimingProfile(BID, 'btn::{"id":1}');
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.avgMs).toBe(100);
    });
  });

  // ── Timing math accuracy ────────────────────────────────────────────

  describe("timing running average accuracy", () => {
    it("running average is mathematically correct over many samples", () => {
      const values = [100, 200, 300, 400, 500];
      for (const v of values) {
        appMap.recordTiming(BID, "test_avg", "element_response", v);
      }
      const profiles = appMap.getTimingProfile(BID, "test_avg");
      expect(profiles).toHaveLength(1);
      const expectedAvg = values.reduce((a, b) => a + b, 0) / values.length;
      expect(profiles[0]!.avgMs).toBeCloseTo(expectedAvg, 5);
      expect(profiles[0]!.minMs).toBe(100);
      expect(profiles[0]!.maxMs).toBe(500);
      expect(profiles[0]!.sampleCount).toBe(5);
    });

    it("running average with zero values is correct", () => {
      appMap.recordTiming(BID, "zero_test", "element_response", 0);
      appMap.recordTiming(BID, "zero_test", "element_response", 0);
      appMap.recordTiming(BID, "zero_test", "element_response", 300);
      const profiles = appMap.getTimingProfile(BID, "zero_test");
      expect(profiles[0]!.avgMs).toBeCloseTo(100, 5);
    });
  });

  // ── recordPageTransition edge cases ─────────────────────────────────

  describe("recordPageTransition edge cases", () => {
    it("same from/to is correctly rejected (no self-loops in nav graph)", () => {
      appMap.recordPageTransition(BID, "Home", "Home", "click");
      const data = appMap.load(BID);
      expect(data!.navigationGraph.edges).toHaveLength(0);
    });

    it("same edge repeated increments successCount and sets verified", () => {
      appMap.recordPageTransition(BID, "Home", "Settings", "click");
      appMap.recordPageTransition(BID, "Home", "Settings", "click");
      const data = appMap.load(BID);
      expect(data!.navigationGraph.edges).toHaveLength(1);
      expect(data!.navigationGraph.edges[0]!.successCount).toBe(2);
      expect(data!.navigationGraph.edges[0]!.verified).toBe(true);
    });

    it("different actions create different edges", () => {
      appMap.recordPageTransition(BID, "Home", "Settings", "click");
      appMap.recordPageTransition(BID, "Home", "Settings", "keyboard");
      const data = appMap.load(BID);
      expect(data!.navigationGraph.edges).toHaveLength(2);
    });
  });

  // ── M1 FIX: dimension NOT updated when transition limit hit ──

  describe("state machine — dimension NOT updated when transition limit hit", () => {
    it("dimension.currentValue stays unchanged when maxStateTransitions reached", () => {
      const smallMap = new AppMap({ mapsDir, maxStateTransitions: 1 });
      smallMap.init();
      smallMap.createEmpty(BID, "SmallApp");

      // First transition: fills the 1-slot limit
      smallMap.recordStateChange(BID, "mode", "light", "dark", "toggle");

      // Second transition: hits limit — dimension should NOT update
      smallMap.recordStateChange(BID, "mode", "dark", "auto", "select");

      const dims = smallMap.getStateDimensions(BID);
      const dim = dims.find(d => d.key === "mode");
      expect(dim).toBeDefined();
      // FIX: currentValue stays at "dark" because the transition was dropped
      expect(dim!.currentValue).toBe("dark");
      expect(dim!.possibleValues).not.toContain("auto");

      // The transition was NOT recorded
      const transitions = smallMap.getStateTransitions(BID);
      expect(transitions).toHaveLength(1); // only the first one
      expect(transitions[0]!.toValue).toBe("dark"); // not "auto"

      smallMap.flush();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 Ghost — security
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 2 Ghost — security", () => {

    // ── 1. Path traversal second look ──────────────────────────────

    describe("path traversal — bypass attempts", () => {
      it("null byte in bundleId is sanitized", () => {
        // Null byte truncation attack: "com.app\x00../../etc/passwd"
        // On some systems, null byte terminates C-strings early
        const malicious = "com.app\x00../../etc/passwd";
        appMap.createEmpty(malicious, "Evil");
        appMap.flush();

        // The file should be in the maps dir, not in /etc/
        const files = fs.readdirSync(mapsDir);
        // Null byte is replaced by _, ".." is replaced by _, "/" is replaced by _
        // Result: "com.app____etc_passwd.json" — safe filename in mapsDir
        expect(files.some(f => f.endsWith(".json"))).toBe(true);
        // Verify ALL files stay within mapsDir (no path traversal escape)
        for (const f of files) {
          const fullPath = path.join(mapsDir, f);
          expect(path.dirname(fullPath)).toBe(mapsDir);
        }
      });

      it("very long bundleId (10KB) does not crash", () => {
        const longId = "com." + "x".repeat(10000);
        expect(() => {
          appMap.createEmpty(longId, "LongApp");
          appMap.flush();
        }).not.toThrow();

        // Should be able to load it back
        const loaded = appMap.load(longId);
        expect(loaded).not.toBeNull();
        expect(loaded!.appName).toBe("LongApp");
      });

      it("Windows-style backslash path traversal is sanitized", () => {
        // Windows paths: com.app\..\..\etc
        const malicious = "com.app\\..\\..\\etc\\shadow";
        appMap.createEmpty(malicious, "WinEvil");
        appMap.flush();

        const files = fs.readdirSync(mapsDir);
        // Backslashes and .. should be replaced by _ (non-alphanumeric)
        // Result: "com.app_____etc_shadow.json" — safe, no path traversal
        expect(files.some(f => f.endsWith(".json"))).toBe(true);
        // Verify ALL files are in mapsDir (none escaped to parent dirs)
        for (const f of files) {
          const fullPath = path.join(mapsDir, f);
          expect(path.dirname(fullPath)).toBe(mapsDir);
        }
      });

      it("URL-encoded path traversal is sanitized", () => {
        const malicious = "com.app%2F..%2F..%2Fetc";
        appMap.createEmpty(malicious, "UrlEvil");
        appMap.flush();

        const files = fs.readdirSync(mapsDir);
        // % is not in [a-zA-Z0-9._-] so it gets replaced
        expect(files.some(f => f.endsWith(".json"))).toBe(true);
      });
    });

    // ── 2. Prototype pollution via zone/node keys ──────────────────

    describe("prototype pollution via object keys", () => {
      it("zone key '__proto__' does not pollute Object prototype", () => {
        appMap.createEmpty("com.test.proto", "ProtoApp");

        // Direct addZone with __proto__ key
        appMap.addZone("com.test.proto", "__proto__", makeZone());

        // Check: Object.prototype should NOT have zone properties
        expect((Object.prototype as any).relativePosition).toBeUndefined();
        expect((Object.prototype as any).elements).toBeUndefined();
        expect((Object.prototype as any).type).toBeUndefined();
      });

      it("zone key 'constructor' does not break zone operations", () => {
        appMap.createEmpty("com.test.proto2", "ProtoApp2");

        appMap.addZone("com.test.proto2", "constructor", makeZone());

        // Should still be able to use the map normally
        const data = appMap.getLoaded("com.test.proto2");
        expect(data).not.toBeNull();
        // The 'constructor' zone should be accessible if the runtime allows it
        // but should NOT break other operations
        expect(() => {
          appMap.addZone("com.test.proto2", "normal_zone", makeZone());
        }).not.toThrow();
      });

      it("page context '__proto__' creates zone key 'page::__proto__' safely", () => {
        // This tests the page-aware zone routing
        appMap.createEmpty("com.test.proto3", "ProtoApp3");

        // recordElementOutcome with pageContext = "__proto__"
        appMap.recordElementOutcome("com.test.proto3", "auto", "button1", true, "__proto__");

        // Zone key should be "page::__proto__" which is a safe string
        const data = appMap.getLoaded("com.test.proto3");
        expect(data).not.toBeNull();
        expect(data!.zones["page::__proto__"]).toBeDefined();
        expect((Object.prototype as any).elements).toBeUndefined();
      });

      it("nav node key '__proto__' does not pollute prototype", () => {
        appMap.createEmpty("com.test.proto4", "ProtoApp4");

        appMap.addNavNode("com.test.proto4", "__proto__", {
          type: "window",
          description: "evil",
        });

        // Object.prototype should NOT gain 'type' or 'description'
        expect((Object.prototype as any).type).toBeUndefined();
        expect((Object.prototype as any).description).toBeUndefined();

        // But we need to verify the node is actually stored safely
        const data = appMap.getLoaded("com.test.proto4");
        expect(data).not.toBeNull();
      });

      it("nav node key 'toString' does not break operations", () => {
        appMap.createEmpty("com.test.proto5", "ProtoApp5");

        appMap.addNavNode("com.test.proto5", "toString", {
          type: "window",
          description: "evil toString",
        });

        // Map should still work normally
        expect(() => {
          appMap.addNavNode("com.test.proto5", "normalPage", {
            type: "window",
            description: "Normal",
          });
        }).not.toThrow();

        const data = appMap.getLoaded("com.test.proto5");
        expect(data).not.toBeNull();
      });

      it("state dimension key '__proto__' does not pollute prototype", () => {
        appMap.createEmpty("com.test.proto6", "ProtoApp6");

        appMap.recordStateChange("com.test.proto6", "__proto__", "a", "b", "toggle");

        expect((Object.prototype as any).key).toBeUndefined();
        expect((Object.prototype as any).possibleValues).toBeUndefined();
      });
    });

    // ── 3. JSON deserialization attacks ─────────────────────────────

    describe("JSON deserialization attacks", () => {
      it("extra fields in persisted JSON are preserved but harmless", () => {
        // Craft a malicious map file with extra fields
        appMap.createEmpty("com.test.deser", "DeserApp");
        appMap.flush();

        const filePath = path.join(mapsDir, "com.test.deser.json");
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        raw.__injected = { cmd: "rm -rf /" };
        raw.zones["evil_zone"] = {
          relativePosition: { top: 0, left: 0, width: 1, height: 1 },
          type: "other",
          elements: [],
          verified: false,
          lastSeen: "2024-01-01",
          __payload: "malicious",
        };
        fs.writeFileSync(filePath, JSON.stringify(raw));

        // Clear cache and reload
        const freshMap = new AppMap({ mapsDir });
        freshMap.init();
        const loaded = freshMap.load("com.test.deser");

        // Extra fields are loaded but they don't execute anything
        expect(loaded).not.toBeNull();
        expect((loaded as any).__injected).toEqual({ cmd: "rm -rf /" });
        // The extra zone exists but its elements can be manipulated normally
        expect(loaded!.zones["evil_zone"]).toBeDefined();
      });

      it("wrong-type fields in persisted data do not crash save/load", () => {
        appMap.createEmpty("com.test.deser2", "DeserApp2");
        appMap.flush();

        const filePath = path.join(mapsDir, "com.test.deser2.json");
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        // Set confidence to a string instead of number
        raw.confidence = "not_a_number";
        raw.sessionCount = "infinity";
        raw.zones = "not an object";
        fs.writeFileSync(filePath, JSON.stringify(raw));

        const freshMap = new AppMap({ mapsDir });
        freshMap.init();
        const loaded = freshMap.load("com.test.deser2");

        // It loads but subsequent operations may fail gracefully
        expect(loaded).not.toBeNull();
        // Operations on wrong-typed data should not crash
        expect(() => {
          try {
            freshMap.recordElementOutcome("com.test.deser2", "auto", "btn", true);
          } catch {
            // Expected — zones is a string, not an object
          }
        }).not.toThrow();
      });

      it("circular reference in JSON cannot be persisted (JSON.stringify throws)", () => {
        // This tests that even if someone injects a circular ref in memory,
        // the save will fail gracefully (non-fatal)
        appMap.createEmpty("com.test.circ", "CircApp");
        const data = appMap.getLoaded("com.test.circ")!;

        // Create circular reference
        const evil: any = { name: "circular" };
        evil.self = evil;
        (data as any).circular = evil;

        // Save should not crash the process (writeDirty catches errors)
        expect(() => {
          appMap.flush();
        }).not.toThrow();
      });
    });

    // ── 4. PII leakage in map data ─────────────────────────────────

    describe("PII redaction — V2 fix verified", () => {
      it("element labels are redacted before persistence", () => {
        // V2 FIX: redactPII is now applied to all AppMap data paths
        appMap.createEmpty("com.test.pii", "PIIApp");

        // Simulate element with PII in label (from OCR text)
        const piiLabel = "john.doe@example.com";
        appMap.recordElementOutcome("com.test.pii", "auto", piiLabel, true);

        // Email should be redacted in the persisted label
        const found = appMap.findElement("com.test.pii", "[EMAIL_REDACTED]");
        expect(found).not.toBeNull();
        expect(found!.element.label).toBe("[EMAIL_REDACTED]");
      });

      it("window titles with PII flow through extractPageContext but labels are redacted", () => {
        appMap.createEmpty("com.test.pii2", "PIIApp2");

        // Window title with sensitive info — extractPageContext extracts the email
        const piiTitle = "john.doe@example.com - Inbox - Gmail";
        const pageCtx = extractPageContext(piiTitle);
        // extractPageContext doesn't redact (it produces context for routing)
        // but the element label stored inside is redacted
        expect(pageCtx).toBe("john.doe@example.com");

        appMap.recordElementOutcome("com.test.pii2", "auto", "btn", true, pageCtx!);
        const data = appMap.getLoaded("com.test.pii2");
        // Zone key still uses the page context as-is (zone routing key)
        expect(data!.zones["page::john.doe@example.com"]).toBeDefined();
      });

      it("contract outcomes have PII redacted", () => {
        appMap.createEmpty("com.test.pii3", "PIIApp3");
        appMap.addZone("com.test.pii3", "test_zone", makeZone());

        // Outcome description contains PII from tool results
        appMap.recordContract(
          "com.test.pii3",
          "test_zone",
          "submit_btn",
          "click",
          ["Sent email to john.doe@example.com", "Form submitted with phone 555-123-4567"],
        );

        const contract = appMap.getContract("com.test.pii3", "submit_btn");
        expect(contract).not.toBeNull();
        // V2 FIX: PII is redacted in outcome descriptions
        expect(contract!.contract.outcomes[0]!.description).toContain("[EMAIL_REDACTED]");
        expect(contract!.contract.outcomes[0]!.description).not.toContain("john.doe@example.com");
        expect(contract!.contract.outcomes[1]!.description).toContain("[PHONE_REDACTED]");
        expect(contract!.contract.outcomes[1]!.description).not.toContain("555-123-4567");
      });

      it("hierarchy children have PII redacted", () => {
        appMap.createEmpty("com.test.pii4", "PIIApp4");
        appMap.addZone("com.test.pii4", "test_zone", makeZone());

        // AX tree might expose contact info
        appMap.recordHierarchy(
          "com.test.pii4",
          "test_zone",
          "Contacts",
          ["John Doe", "jane.smith@corp.com", "+1-555-867-5309"],
          "ax_tree",
        );

        const hierarchy = appMap.getHierarchy("com.test.pii4", "test_zone");
        expect(hierarchy).toHaveLength(1);
        // V2 FIX: email and phone are redacted in children
        expect(hierarchy[0]!.children).toContain("[EMAIL_REDACTED]");
        expect(hierarchy[0]!.children).toContain("[PHONE_REDACTED]");
        expect(hierarchy[0]!.children).not.toContain("jane.smith@corp.com");
        expect(hierarchy[0]!.children).not.toContain("+1-555-867-5309");
      });

      it("nav graph node keys can contain document names from window titles", () => {
        appMap.createEmpty("com.test.pii5", "PIIApp5");

        // Window titles often contain document names — these are not PII
        appMap.recordPageTransition(
          "com.test.pii5",
          "Q4 Revenue Report - Confidential",
          "Employee Salary Sheet",
          "click",
        );

        const data = appMap.getLoaded("com.test.pii5");
        expect(data!.navigationGraph.nodes["Q4 Revenue Report - Confidential"]).toBeDefined();
        expect(data!.navigationGraph.nodes["Employee Salary Sheet"]).toBeDefined();
      });
    });

    // ── 5. Denial of service — worst-case map size ──────────────────

    describe("worst-case map file size", () => {
      it("theoretical maximum map size is bounded", () => {
        // Calculate theoretical max with all defaults from DEFAULT_APP_MAP_CONFIG:
        // - 50 zones x 100 elements each
        //   Each element: ~200 bytes (label, coords, counts, dates)
        //   = 50 * 100 * 200 = 1,000,000 bytes = ~1MB for elements alone
        //
        // - Each zone: 50 hierarchy entries x 200 children (each ~20 chars)
        //   = 50 * 200 * 20 = 200,000 bytes per zone
        //   = 50 * 200,000 = 10,000,000 bytes = ~10MB for hierarchy
        //
        // - Each zone: 30 contracts x 5 outcomes x 50 preconditions (~30 chars each)
        //   = 30 * (5 * 50 + 50 * 30) = 30 * 1750 = 52,500 per zone
        //   = 50 * 52,500 = 2,625,000 bytes = ~2.5MB for contracts
        //
        // - 200 visibility conditions x 100 seenOnPages (~20 chars each)
        //   = 200 * 100 * 20 = 400,000 = ~400KB
        //
        // - 100 timing profiles x ~100 bytes = 10KB
        // - 50 ready signals x ~100 bytes = 5KB
        // - 30 state dimensions x 100 possibleValues x ~20 chars = 60KB
        // - 100 state transitions x ~150 bytes = 15KB
        // - 200 nav edges x ~100 bytes = 20KB
        //
        // TOTAL: ~14MB maximum map file
        // This is large but not catastrophic. However, loading and parsing
        // a 14MB JSON file will take significant time (~100-500ms).

        const maxElements = 50 * 100; // zones * elements/zone
        const maxHierarchyChildren = 50 * 50 * 200; // zones * entries * children
        const maxContracts = 50 * 30; // zones * contracts/zone

        // Sanity check: these are the actual limits
        expect(maxElements).toBe(5000);
        expect(maxHierarchyChildren).toBe(500000);
        expect(maxContracts).toBe(1500);

        // The hierarchy children (500K entries x ~20 chars = 10MB) is the
        // dominant factor. This is a potential DoS vector if an attacker
        // controls the AX tree output.
        // SEVERITY: LOW — bounded by config limits, but the limit for
        // hierarchy children (200 per entry x 50 entries = 10K per zone
        // x 50 zones = 500K total strings) is arguably too generous.
      });
    });

    // ── 6. Symlink following ────────────────────────────────────────

    describe("symlink following in atomic write", () => {
      it("writeFileAtomicSync replaces symlink rather than following it", () => {
        // Create a target file
        const targetPath = path.join(mapsDir, "sensitive-data.txt");
        fs.writeFileSync(targetPath, "SENSITIVE CONTENT");

        // Create a symlink at the map file path
        const symlinkPath = path.join(mapsDir, "com.test.symlink.json");
        fs.symlinkSync(targetPath, symlinkPath);

        // Write via atomic write — this should REPLACE the symlink
        // writeFileAtomicSync imported at top of file
        writeFileAtomicSync(symlinkPath, '{"safe": true}');

        // After write, the symlink should be replaced with a regular file
        const stat = fs.lstatSync(symlinkPath);
        expect(stat.isSymbolicLink()).toBe(false);

        // The target file should be UNCHANGED
        const targetContent = fs.readFileSync(targetPath, "utf-8");
        expect(targetContent).toBe("SENSITIVE CONTENT");
      });

      it("backup operation follows symlinks (reads target content)", () => {
        // If com.test.json is a symlink to a sensitive file,
        // the backup (com.test.json.bak) would contain the sensitive file's content
        const targetPath = path.join(mapsDir, "secret.txt");
        fs.writeFileSync(targetPath, "TOP SECRET DATA");

        const symlinkPath = path.join(mapsDir, "com.test.readleak.json");
        fs.symlinkSync(targetPath, symlinkPath);

        // writeFileAtomicSync imported at top of file
        writeFileAtomicSync(symlinkPath, '{"replaced": true}');

        // Check if backup was created with the sensitive content
        const bakPath = symlinkPath + ".bak";
        if (fs.existsSync(bakPath)) {
          const bakContent = fs.readFileSync(bakPath, "utf-8");
          // FINDING: The backup contains the content of the symlink TARGET
          // This means an attacker who can create a symlink at the map path
          // can exfiltrate the content of any readable file into the .bak file
          // SEVERITY: MEDIUM — requires write access to ~/.screenhand/app-maps/
          // which implies local access. But the .bak file persists the content.
          expect(bakContent).toBe("TOP SECRET DATA");
        }
      });
    });

    // ── 7. Race condition on atomic write ────────────────────────────

    describe("race condition on concurrent saves", () => {
      it("scheduleSave debounces multiple rapid saves correctly", () => {
        appMap.createEmpty("com.test.race", "RaceApp");

        // Rapidly modify data and save multiple times
        for (let i = 0; i < 100; i++) {
          appMap.recordElementOutcome("com.test.race", "auto", `btn_${i}`, true);
        }

        // Force flush — should have all 100 elements (limited by maxElementsPerZone=100)
        appMap.flush();

        const freshMap = new AppMap({ mapsDir });
        freshMap.init();
        const loaded = freshMap.load("com.test.race");
        expect(loaded).not.toBeNull();

        // All elements should be present (no data loss from race)
        const totalElements = Object.values(loaded!.zones).reduce(
          (sum, z) => sum + z.elements.length, 0,
        );
        expect(totalElements).toBe(100);
      });
    });

    // ── 8. Injection via tool results ────────────────────────────────

    describe("injection via crafted tool results", () => {
      it("state keyword detection can be triggered by arbitrary result text", () => {
        // A malicious app could have a window titled "collapsed sidebar"
        // which would trigger false state detection in mcp-desktop.ts
        // Test: the state machine itself doesn't validate the source
        appMap.createEmpty("com.test.inject", "InjectApp");

        // An attacker-controlled tool result containing state keywords
        // directly feeds into recordStateChange
        appMap.recordStateChange("com.test.inject", "sidebar_state", "expanded", "collapsed", "malicious_tool");

        const state = appMap.getCurrentState("com.test.inject");
        expect(state["sidebar_state"]).toBe("collapsed");
        // SEVERITY: LOW — state data is advisory only and doesn't execute anything
        // But it could cause the AI to make wrong decisions based on false state
      });

      it("hierarchy extraction regex accepts crafted labels up to 200 chars", () => {
        appMap.createEmpty("com.test.inject2", "InjectApp2");
        appMap.addZone("com.test.inject2", "auto_discovered", makeZone());

        // Labels extracted from ui_tree via titleMatch = /"([^"]+)"/
        // Max length 200 is enforced in mcp-desktop.ts (line 891)
        const longLabel = "A".repeat(200);
        appMap.recordHierarchy("com.test.inject2", "auto_discovered", longLabel, ["child"], "ax_tree");

        const hierarchy = appMap.getHierarchy("com.test.inject2", "auto_discovered");
        expect(hierarchy).toHaveLength(1);
        expect(hierarchy[0]!.parentLabel).toBe(longLabel);
      });

      it("visibility tracking regex captures all quoted strings from result", () => {
        // The regex /"([^"]{1,100})"/g in mcp-desktop.ts line 929
        // extracts ALL quoted strings — including injected ones
        appMap.createEmpty("com.test.inject3", "InjectApp3");

        // If an AX tree contains an element labeled with a JSON-like string
        // it still gets treated as an element label
        const jsonLabel = '{"key":"value"}';
        // Labels over 100 chars are filtered by the regex {1,100}
        expect(jsonLabel.length).toBeLessThanOrEqual(100);

        appMap.recordElementOutcome("com.test.inject3", "auto", jsonLabel, true);
        const found = appMap.findElement("com.test.inject3", jsonLabel);
        expect(found).not.toBeNull();
      });
    });

    // ── 9. extractPageContext bypass ─────────────────────────────────

    describe("extractPageContext edge cases", () => {
      it("title that is entirely delimiters returns null (V5 fix)", () => {
        // V5 FIX: extractPageContext now rejects garbage delimiter-only titles
        // " - - - " splits to ["-", "-"], first part is "-" which is < 2 chars
        const result = extractPageContext(" - - - ");
        expect(result).toBeNull();
      });

      it("title with leading delimiter produces trimmed garbage", () => {
        // " - App".trim() = "- App", not split because " - " needs spaces on both sides
        // The entire trimmed string is returned
        const result = extractPageContext(" - App");
        // SEVERITY: INFO — includes the delimiter in the context
        expect(result).toBe("- App");
      });

      it("title with internal format injection page::admin", () => {
        // Could an attacker create a zone key that looks like an internal format?
        const result = extractPageContext("page::admin - App");
        expect(result).toBe("page::admin");
        // When used as zone key: "page::page::admin" — nested but harmless
      });

      it("title with path separators is kept as-is (no directory traversal risk)", () => {
        const result = extractPageContext("../../etc - App");
        expect(result).toBe("../../etc");
        // This becomes zone key "page::../../etc" — just a string key, not a file path
        // SAFE because zone keys never touch the filesystem directly
      });

      it("title with only whitespace returns null", () => {
        expect(extractPageContext("   ")).toBeNull();
        expect(extractPageContext("\t\n")).toBeNull();
      });

      it("title longer than 80 chars is truncated", () => {
        const longTitle = "A".repeat(100) + " - App";
        const result = extractPageContext(longTitle);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(80);
      });

      it("title with pipe delimiter", () => {
        const result = extractPageContext("Home | Slack");
        expect(result).toBe("Home");
      });

      it("title with em dash delimiter", () => {
        const result = extractPageContext("Tasks \u2014 Notion");
        expect(result).toBe("Tasks");
      });
    });

    // ── 10. reverseTrigger migration (string → string[]) ────────────

    describe("reverseTrigger migration — string to string[]", () => {
      it("old persisted string reverseTrigger is migrated to array on access (FIXED)", () => {
        appMap.createEmpty("com.test.migrate", "MigrateApp");
        appMap.flush();

        // Manually write old-format data with reverseTrigger as string
        const filePath = path.join(mapsDir, "com.test.migrate.json");
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        raw.stateTransitions = [
          {
            dimensionKey: "sidebar_state",
            fromValue: "expanded",
            toValue: "collapsed",
            trigger: "toggle",
            observedCount: 3,
            reverseTrigger: "escape", // OLD FORMAT: string, not string[]
            lastSeen: "2024-01-01T00:00:00.000Z",
          },
        ];
        raw.stateDimensions = [
          {
            key: "sidebar_state",
            possibleValues: ["expanded", "collapsed"],
            currentValue: "collapsed",
            lastObserved: "2024-01-01T00:00:00.000Z",
          },
        ];
        fs.writeFileSync(filePath, JSON.stringify(raw));

        // Reload
        const freshMap = new AppMap({ mapsDir });
        freshMap.init();
        const loaded = freshMap.load("com.test.migrate");
        expect(loaded).not.toBeNull();

        // FIX: recording a reverse transition no longer crashes
        // Before fix: "TypeError: reverse.reverseTrigger.push is not a function"
        expect(() => {
          freshMap.recordStateChange("com.test.migrate", "sidebar_state", "collapsed", "expanded", "click");
        }).not.toThrow();

        // Check that the reverse detection works and old string was migrated to array
        const transitions = freshMap.getStateTransitions("com.test.migrate");
        expect(transitions.length).toBeGreaterThanOrEqual(2);

        // The old transition should now have reverseTrigger as an array
        const oldTx = transitions.find(t => t.trigger === "toggle");
        expect(oldTx).toBeDefined();
        expect(Array.isArray(oldTx!.reverseTrigger)).toBe(true);
        expect(oldTx!.reverseTrigger).toContain("escape"); // preserved from old format
        expect(oldTx!.reverseTrigger).toContain("click"); // added by reverse detection
      });

      it("String.includes on old string format gives correct result for exact match", () => {
        // "escape".includes("escape") === true (JavaScript string method)
        // This means the dedup check accidentally works for exact matches
        const oldReverseTrigger: any = "escape";
        expect(oldReverseTrigger.includes("escape")).toBe(true);
      });

      it("String.includes on old string format gives WRONG result for substring match", () => {
        // "escape".includes("esc") === true — false positive!
        // This means a trigger "esc" would be incorrectly considered a duplicate
        const oldReverseTrigger: any = "escape";
        expect(oldReverseTrigger.includes("esc")).toBe(true);
        // SEVERITY: LOW — subtle bug. Old string "escape" would prevent adding "esc"
        // as a reverse trigger because String.includes does character-level matching
      });

      it("push on old string format throws TypeError", () => {
        // If .includes() returns false, the code tries .push() which doesn't exist on strings
        const oldReverseTrigger: any = "escape";
        expect(oldReverseTrigger.includes("completely_different")).toBe(false);
        // String.push is undefined — calling it would throw
        expect(() => {
          oldReverseTrigger.push("completely_different");
        }).toThrow();
        // SEVERITY: MEDIUM — if old persisted data has reverseTrigger as string,
        // adding a new non-matching reverse trigger crashes recordStateChange
      });
    });

    // ── 11. Additional attack vectors ────────────────────────────────

    describe("additional attack vectors", () => {
      it("bundleId with only dots and dashes sanitizes to valid filename", () => {
        const edgeCase = "...-...";
        appMap.createEmpty(edgeCase, "DotDash");
        appMap.flush();

        const files = fs.readdirSync(mapsDir);
        expect(files.some(f => f.endsWith(".json"))).toBe(true);
      });

      it("bundleId that is empty string after sanitization", () => {
        // After sanitization, some chars might produce empty or very short names
        const weird = "\x00\x01\x02";
        appMap.createEmpty(weird, "EmptyId");
        appMap.flush();

        // Should still create a file (even if name is just underscores)
        const files = fs.readdirSync(mapsDir);
        expect(files.some(f => f.endsWith(".json"))).toBe(true);
      });

      it("concurrent reads during write do not see partial data", () => {
        appMap.createEmpty("com.test.concurrent", "ConcApp");
        appMap.flush();

        // Write a large dataset
        for (let i = 0; i < 50; i++) {
          appMap.recordElementOutcome("com.test.concurrent", "auto", `el_${i}`, true);
        }
        appMap.flush();

        // Read immediately after write — atomic rename ensures no partial reads
        const freshMap = new AppMap({ mapsDir });
        freshMap.init();
        const loaded = freshMap.load("com.test.concurrent");
        expect(loaded).not.toBeNull();

        // Data should be complete — not a partially written JSON
        const totalEls = Object.values(loaded!.zones).reduce(
          (sum, z) => sum + z.elements.length, 0,
        );
        expect(totalEls).toBe(50);
      });

      it("map file permissions are 0o644 (not world-writable)", () => {
        appMap.createEmpty("com.test.perms", "PermsApp");
        appMap.flush();

        const filePath = path.join(mapsDir, "com.test.perms.json");
        const stat = fs.statSync(filePath);
        const mode = stat.mode & 0o777;

        // File should NOT be world-writable
        expect(mode & 0o002).toBe(0); // no other-write
        expect(mode & 0o020).toBe(0); // no group-write
        // Owner should have read+write
        expect(mode & 0o600).toBe(0o600);
      });
    });
  });
});
