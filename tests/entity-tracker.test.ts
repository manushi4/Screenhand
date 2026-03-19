// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from "vitest";
import { EntityTracker } from "../src/state/entity-tracker.js";

describe("EntityTracker", () => {
  let tracker: EntityTracker;

  beforeEach(() => {
    tracker = new EntityTracker();
  });

  it("creates a new entity on first match", () => {
    const entity = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    expect(entity.entityId).toBeTruthy();
    expect(entity.type).toBe("panel");
    expect(entity.label).toBe("Inspector");
    expect(entity.positions).toHaveLength(1);
    expect(entity.positions[0]!.x).toBe(100);
  });

  it("entity persists when position shifts within threshold (20px)", () => {
    const first = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    const second = tracker.matchOrCreate("panel", "Inspector", { x: 120, y: 210 }, 1);

    expect(second.entityId).toBe(first.entityId);
    expect(second.positions).toHaveLength(2);
  });

  it("creates new entity when position exceeds threshold", () => {
    const first = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    const second = tracker.matchOrCreate("panel", "Inspector", { x: 300, y: 500 }, 1);

    expect(second.entityId).not.toBe(first.entityId);
  });

  it("different labels create separate entities", () => {
    const a = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    const b = tracker.matchOrCreate("panel", "Timeline", { x: 100, y: 200 }, 1);

    expect(a.entityId).not.toBe(b.entityId);
  });

  it("getByType filters correctly", () => {
    tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    tracker.matchOrCreate("tab", "Edit", { x: 200, y: 50 }, 1);
    tracker.matchOrCreate("panel", "Timeline", { x: 100, y: 400 }, 1);

    const panels = tracker.getByType("panel");
    expect(panels).toHaveLength(2);

    const tabs = tracker.getByType("tab");
    expect(tabs).toHaveLength(1);
  });

  it("pruneStale removes old entities", () => {
    const entity = tracker.matchOrCreate("panel", "Old Panel", { x: 100, y: 200 }, 1);
    // Manually backdate the entity
    entity.lastSeen = new Date(Date.now() - 120_000).toISOString();

    const pruned = tracker.pruneStale(60_000);
    expect(pruned).toBe(1);
    expect(tracker.getAll().size).toBe(0);
  });

  it("pruneStale keeps recent entities", () => {
    tracker.matchOrCreate("panel", "Fresh Panel", { x: 100, y: 200 }, 1);

    const pruned = tracker.pruneStale(60_000);
    expect(pruned).toBe(0);
    expect(tracker.getAll().size).toBe(1);
  });

  it("position history capped at 10", () => {
    for (let i = 0; i < 15; i++) {
      tracker.matchOrCreate("panel", "Moving Panel", { x: 100 + i, y: 200 + i }, 1);
    }

    const entities = [...tracker.getAll().values()];
    expect(entities).toHaveLength(1);
    expect(entities[0]!.positions.length).toBeLessThanOrEqual(10);
  });

  it("clear removes all entities", () => {
    tracker.matchOrCreate("panel", "A", { x: 10, y: 20 }, 1);
    tracker.matchOrCreate("tab", "B", { x: 30, y: 40 }, 1);
    tracker.clear();
    expect(tracker.getAll().size).toBe(0);
  });

  it("same label on different windows creates separate entities", () => {
    const a = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    const b = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 2);

    expect(a.entityId).not.toBe(b.entityId);
    expect(a.windowId).toBe(1);
    expect(b.windowId).toBe(2);
  });

  it("rehydrate restores entities", () => {
    const entity = tracker.matchOrCreate("panel", "Inspector", { x: 100, y: 200 }, 1);
    const snapshot = tracker.getAll();

    const newTracker = new EntityTracker();
    newTracker.rehydrate(snapshot);

    const restored = newTracker.getAll();
    expect(restored.size).toBe(1);
    const restoredEntity = restored.get(entity.entityId);
    expect(restoredEntity).toBeDefined();
    expect(restoredEntity!.label).toBe("Inspector");
    expect(restoredEntity!.windowId).toBe(1);
  });
});
