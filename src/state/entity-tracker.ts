// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import type { TrackedEntity } from "./types.js";

const MAX_POSITIONS = 10;
const PROXIMITY_THRESHOLD = 50; // pixels

/**
 * EntityTracker — persistent cross-frame identity for UI elements.
 *
 * A panel that moves 10px between frames keeps the same entityId
 * instead of getting a new stableId (which includes quantized position).
 * Matches by label similarity + position proximity.
 */
export class EntityTracker {
  private entities = new Map<string, TrackedEntity>();

  /**
   * Match an incoming element to an existing entity, or create a new one.
   * Fuzzy match by label (exact) + window scope + position proximity (within threshold).
   */
  matchOrCreate(
    type: TrackedEntity["type"],
    label: string,
    position: { x: number; y: number },
    windowId: number,
  ): TrackedEntity {
    const now = new Date().toISOString();

    // Try to find an existing entity with the same label, window, and nearby position
    for (const entity of this.entities.values()) {
      if (entity.type !== type || entity.label !== label) continue;
      if (entity.windowId !== windowId) continue;

      // Check position proximity against last known position
      const lastPos = entity.positions[entity.positions.length - 1];
      if (lastPos) {
        const dx = Math.abs(lastPos.x - position.x);
        const dy = Math.abs(lastPos.y - position.y);
        if (dx <= PROXIMITY_THRESHOLD && dy <= PROXIMITY_THRESHOLD) {
          // Match found — update position history
          entity.lastSeen = now;
          entity.positions.push({ x: position.x, y: position.y, timestamp: now });
          if (entity.positions.length > MAX_POSITIONS) {
            entity.positions = entity.positions.slice(-MAX_POSITIONS);
          }
          return entity;
        }
      } else {
        // No position history (e.g. after rehydrate with empty positions) —
        // match by label+type+window alone, and seed the position
        entity.lastSeen = now;
        entity.positions.push({ x: position.x, y: position.y, timestamp: now });
        return entity;
      }
    }

    // No match — create new entity
    const entityId = crypto.randomUUID();
    const entity: TrackedEntity = {
      entityId,
      type,
      label,
      windowId,
      stableIds: [],
      firstSeen: now,
      lastSeen: now,
      positions: [{ x: position.x, y: position.y, timestamp: now }],
      properties: {},
    };
    this.entities.set(entityId, entity);
    return entity;
  }

  /**
   * Get entities filtered by type.
   */
  getByType(type: TrackedEntity["type"]): TrackedEntity[] {
    return [...this.entities.values()].filter((e) => e.type === type);
  }

  /**
   * Get all tracked entities.
   */
  getAll(): Map<string, TrackedEntity> {
    return new Map(this.entities);
  }

  /**
   * Remove entities not seen within maxAgeMs.
   */
  pruneStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, entity] of this.entities) {
      if (new Date(entity.lastSeen).getTime() < cutoff) {
        this.entities.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Rehydrate internal state from persisted entities.
   * Clears current state first to avoid duplication.
   */
  rehydrate(entities: Map<string, TrackedEntity>): void {
    this.entities.clear();
    for (const [id, entity] of entities) {
      this.entities.set(id, { ...entity, positions: [...entity.positions] });
    }
  }

  /**
   * Clear all entities.
   */
  clear(): void {
    this.entities.clear();
  }
}
