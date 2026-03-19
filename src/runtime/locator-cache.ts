// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

import type { LearningEngine } from "../learning/engine.js";

export class LocatorCache {
  private readonly store = new Map<string, string>();
  private learningEngine: LearningEngine | null = null;

  /**
   * Inject the learning engine for fallback on cache miss.
   * Called after both are constructed to avoid circular dependencies.
   */
  setLearningEngine(engine: LearningEngine): void {
    this.learningEngine = engine;
  }

  get(siteKey: string, actionKey: string): string | undefined {
    // 1. Check in-memory cache first
    const cached = this.store.get(this.key(siteKey, actionKey));
    if (cached) return cached;

    // 2. Fallback: ask learning engine for a proven locator
    if (this.learningEngine) {
      const learned = this.learningEngine.recommendLocator(siteKey, actionKey);
      if (learned) {
        // Promote to cache for fast subsequent lookups
        this.store.set(this.key(siteKey, actionKey), learned.locator);
        return learned.locator;
      }
    }

    return undefined;
  }

  set(siteKey: string, actionKey: string, locator: string): void {
    this.store.set(this.key(siteKey, actionKey), locator);
  }

  private key(siteKey: string, actionKey: string): string {
    // Use length-prefixed format to avoid collision when keys contain the separator
    return `${siteKey.length}:${siteKey}\0${actionKey}`;
  }
}
