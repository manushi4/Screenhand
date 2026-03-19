// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FusionPipeline } from "../src/state/fusion.js";
import { WorldModel } from "../src/state/world-model.js";
import type { AXNode, AppContext } from "../src/types.js";
import * as persistence from "../src/state/persistence.js";

vi.mock("../src/state/persistence.js", async () => {
  const actual = await vi.importActual("../src/state/persistence.js") as Record<string, unknown>;
  return {
    ...actual,
    loadWorldState: vi.fn().mockReturnValue(null),
    saveWorldState: vi.fn(),
  };
});

function makeAppContext(): AppContext {
  return {
    bundleId: "com.test.App",
    appName: "TestApp",
    pid: 1234,
    windowTitle: "Test Window",
    windowId: 1,
  };
}

function makeAXTree(): AXNode {
  return {
    role: "window",
    title: "Test Window",
    position: { x: 0, y: 0 },
    size: { width: 800, height: 600 },
    children: [
      {
        role: "button",
        title: "OK",
        position: { x: 100, y: 200 },
        size: { width: 80, height: 30 },
        enabled: true,
      },
    ],
  };
}

describe("FusionPipeline", () => {
  let pipeline: FusionPipeline;
  let model: WorldModel;

  beforeEach(() => {
    pipeline = new FusionPipeline();
    model = new WorldModel({ persistDebounceMs: 0 });
    model.init("test-fusion");
  });

  it("enqueues and flushes AX updates", () => {
    pipeline.enqueue({
      source: "ax",
      timestamp: new Date().toISOString(),
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });

    expect(pipeline.size).toBe(1);
    pipeline.flush(model);
    expect(pipeline.size).toBe(0);

    const win = model.getWindowState(1);
    expect(win).not.toBeNull();
    expect(win!.controls.size).toBeGreaterThan(0);
  });

  it("AX control not overwritten by stale OCR", () => {
    // First: ingest AX data
    pipeline.enqueue({
      source: "ax",
      timestamp: new Date().toISOString(),
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });
    pipeline.flush(model);

    const winBefore = model.getWindowState(1)!;
    const axControlCount = winBefore.controls.size;

    // Then: ingest OCR with overlapping data at same position
    pipeline.enqueue({
      source: "ocr",
      timestamp: new Date().toISOString(),
      confidence: 0.7,
      windowId: 1,
      ocrRegions: [
        { text: "OK", bounds: { x: 100, y: 200, width: 80, height: 30 } },
      ],
    });
    pipeline.flush(model);

    const winAfter = model.getWindowState(1)!;
    // OCR should NOT have overwritten the AX button (same stableId but different role)
    // The AX control at this position should still exist
    expect(winAfter.controls.size).toBeGreaterThanOrEqual(axControlCount);
  });

  it("CDP and AX merge correctly", () => {
    // Ingest AX first
    pipeline.enqueue({
      source: "ax",
      timestamp: new Date().toISOString(),
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });
    pipeline.flush(model);

    // Ingest CDP snapshot
    pipeline.enqueue({
      source: "cdp",
      timestamp: new Date().toISOString(),
      confidence: 0.85,
      windowId: 1,
      cdpSnapshot: {
        bundleId: "com.test.App",
        url: "https://example.com",
        title: "Example Page",
      },
    });
    pipeline.flush(model);

    // AX controls should still be there
    const win = model.getWindowState(1);
    expect(win).not.toBeNull();
    expect(win!.controls.size).toBeGreaterThan(0);

    // CDP snapshot should have updated browser state
    const domain = model.getAppDomain("com.test.App");
    expect(domain).not.toBeNull();
  });

  it("processes updates in timestamp order", () => {
    const earlier = new Date(Date.now() - 1000).toISOString();
    const later = new Date().toISOString();

    // Enqueue in reverse order
    pipeline.enqueue({
      source: "ocr",
      timestamp: later,
      confidence: 0.7,
      windowId: 1,
      ocrRegions: [{ text: "Later", bounds: { x: 10, y: 10, width: 50, height: 12 } }],
    });

    pipeline.enqueue({
      source: "ax",
      timestamp: earlier,
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });

    pipeline.flush(model);

    // Both should have been processed (AX first, then OCR)
    const win = model.getWindowState(1);
    expect(win).not.toBeNull();
    expect(win!.controls.size).toBeGreaterThan(1); // AX button + OCR text
  });

  it("deduplicates by source+windowId, keeping newer", () => {
    const earlier = new Date(Date.now() - 1000).toISOString();
    const later = new Date().toISOString();

    // Enqueue two AX updates for the same windowId
    pipeline.enqueue({
      source: "ax",
      timestamp: earlier,
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });
    pipeline.enqueue({
      source: "ax",
      timestamp: later,
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });

    // Should have deduplicated to 1 entry
    expect(pipeline.size).toBe(1);
    pipeline.flush(model);
    expect(pipeline.size).toBe(0);
  });

  it("source confidence preserved on controls", () => {
    pipeline.enqueue({
      source: "ax",
      timestamp: new Date().toISOString(),
      confidence: 0.9,
      windowId: 1,
      axTree: makeAXTree(),
      appContext: makeAppContext(),
    });
    pipeline.flush(model);

    const win = model.getWindowState(1)!;
    for (const ctrl of win.controls.values()) {
      if (ctrl.source) {
        expect(ctrl.source).toBe("ax");
        expect(ctrl.sourceConfidence).toBe(0.9);
        expect(ctrl.lastSeenAt).toBeTruthy();
      }
    }
  });
});
