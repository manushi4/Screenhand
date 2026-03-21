// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TopologyPolicy } from "../src/learning/topology-policy.js";
import { LearningEngine } from "../src/learning/engine.js";

// ── TopologyPolicy isolation tests ──────────────────────────────────

describe("TopologyPolicy", () => {
  let policy: TopologyPolicy;

  beforeEach(() => {
    policy = new TopologyPolicy(2);
  });

  it("records topology outcomes and queries by bundleId", () => {
    const bundleId = "com.test.app";
    policy.record({ bundleId, fromNode: "main", action: "click-export", toNode: "exportDialog", success: true });
    policy.record({ bundleId, fromNode: "main", action: "right-click", toNode: "contextMenu", success: true });
    policy.record({ bundleId: "com.other.app", fromNode: "main", action: "click", toNode: "panel", success: true });

    const entries = policy.query(bundleId);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.bundleId === bundleId)).toBe(true);
  });

  it("filters query by fromNode", () => {
    const bundleId = "com.test.app";
    policy.record({ bundleId, fromNode: "main", action: "click", toNode: "dialog", success: true });
    policy.record({ bundleId, fromNode: "dialog", action: "click-ok", toNode: "main", success: true });

    const fromMain = policy.query(bundleId, "main");
    expect(fromMain).toHaveLength(1);
    expect(fromMain[0]!.fromNode).toBe("main");
  });

  it("uses Bayesian scoring for edge reliability", () => {
    const bundleId = "com.test.app";

    // Edge A: 8 successes, 2 failures
    for (let i = 0; i < 8; i++) {
      policy.record({ bundleId, fromNode: "main", action: "click-a", toNode: "panelA", success: true });
    }
    for (let i = 0; i < 2; i++) {
      policy.record({ bundleId, fromNode: "main", action: "click-a", toNode: "panelA", success: false });
    }

    // Edge B: 3 successes, 7 failures
    for (let i = 0; i < 3; i++) {
      policy.record({ bundleId, fromNode: "main", action: "click-b", toNode: "panelB", success: true });
    }
    for (let i = 0; i < 7; i++) {
      policy.record({ bundleId, fromNode: "main", action: "click-b", toNode: "panelB", success: false });
    }

    const entries = policy.query(bundleId, "main");
    expect(entries).toHaveLength(2);
    // Edge A should have higher score
    expect(entries[0]!.action).toBe("click-a");
    expect(entries[0]!.score).toBeGreaterThan(entries[1]!.score);
  });

  it("recommends best edge from a given node", () => {
    const bundleId = "com.test.app";
    for (let i = 0; i < 5; i++) {
      policy.record({ bundleId, fromNode: "main", action: "Cmd+M", toNode: "export", success: true });
    }

    const rec = policy.recommend(bundleId, "main", 3);
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("Cmd+M");
    expect(rec!.toNode).toBe("export");
  });

  it("returns null with insufficient samples", () => {
    const bundleId = "com.test.app";
    policy.record({ bundleId, fromNode: "main", action: "click", toNode: "dialog", success: true });

    const rec = policy.recommend(bundleId, "main", 5);
    expect(rec).toBeNull();
  });

  it("clear() empties all entries", () => {
    policy.record({ bundleId: "com.test.app", fromNode: "a", action: "click", toNode: "b", success: true });
    expect(policy.getAllEntries()).toHaveLength(1);

    policy.clear();
    expect(policy.getAllEntries()).toHaveLength(0);
  });

  it("loadEntries() restores from persisted data", () => {
    const entries = [
      {
        key: "com.test.app::main::click::dialog",
        bundleId: "com.test.app",
        fromNode: "main",
        action: "click",
        toNode: "dialog",
        successCount: 5,
        failCount: 1,
        score: 0.78,
        lastUsed: new Date().toISOString(),
      },
    ];
    policy.loadEntries(entries);

    const all = policy.getAllEntries();
    expect(all).toHaveLength(1);
    expect(all[0]!.successCount).toBe(5);
  });
});

// ── LearningEngine topology integration tests ───────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topology-test-"));
}

describe("LearningEngine topology integration", () => {
  let dataDir: string;
  let engine: LearningEngine;

  beforeEach(() => {
    dataDir = makeTmpDir();
    engine = new LearningEngine({ dataDir, priorStrength: 2, minSamplesForConfidence: 3 });
    engine.init();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("records and queries topology via engine wrapper methods", () => {
    const bundleId = "com.test.app";
    engine.recordTopologyOutcome({ bundleId, fromNode: "main", action: "click", toNode: "dialog", success: true });
    engine.recordTopologyOutcome({ bundleId, fromNode: "main", action: "Cmd+M", toNode: "export", success: true });

    const entries = engine.queryTopology(bundleId);
    expect(entries).toHaveLength(2);
  });

  it("persists topology.jsonl across engine instances", () => {
    const bundleId = "com.test.app";
    for (let i = 0; i < 5; i++) {
      engine.recordTopologyOutcome({ bundleId, fromNode: "main", action: "Cmd+M", toNode: "export", success: true });
    }
    engine.flush();

    const engine2 = new LearningEngine({ dataDir, priorStrength: 2, minSamplesForConfidence: 3 });
    engine2.init();

    const entries = engine2.queryTopology(bundleId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.successCount).toBe(5);
  });

  it("includes topologyEntries in getAppSummary", () => {
    const bundleId = "com.test.app";
    engine.recordTopologyOutcome({ bundleId, fromNode: "a", action: "click", toNode: "b", success: true });

    const summary = engine.getAppSummary(bundleId);
    expect(summary.topologyEntries).toBe(1);
  });

  it("reset() clears topology data", () => {
    engine.recordTopologyOutcome({ bundleId: "com.test.app", fromNode: "a", action: "x", toNode: "b", success: true });
    engine.reset();

    const entries = engine.queryTopology("com.test.app");
    expect(entries).toHaveLength(0);
  });
});
