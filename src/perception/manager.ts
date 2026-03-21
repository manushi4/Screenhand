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

import { EventEmitter } from "node:events";
import type { BridgeClient } from "../native/bridge-client.js";
import type { AppContext } from "../types.js";
import type { WorldModel } from "../state/world-model.js";
import { StateObserver } from "../runtime/state-observer.js";
import { AXSource } from "./ax-source.js";
import { CDPSource } from "./cdp-source.js";
import { VisionSource } from "./vision-source.js";
import { PerceptionCoordinator } from "./coordinator.js";
import type { PerceptionCoordinatorConfig, PerceptionStats } from "./types.js";
import { createEmptyStats } from "./types.js";
import type { LearningEngine } from "../learning/engine.js";
import type { AppMap } from "../state/app-map.js";

/**
 * PerceptionManager — creates sources lazily when the bridge is ready,
 * auto-starts perception on first app context, manages context switches,
 * and emits reactive events (dialog_detected, app_switched).
 */
export class PerceptionManager extends EventEmitter {
  private coordinator: PerceptionCoordinator | null = null;
  private sourcesCreated = false;
  private currentContext: AppContext | null = null;
  private currentPid: number | null = null;
  private currentBundleId: string | null = null;
  private lastCdpClient: any = null;
  private pendingLearningEngine: LearningEngine | null = null;
  private pendingAppMap: AppMap | null = null;

  constructor(
    private readonly worldModel: WorldModel,
    private readonly config?: Partial<PerceptionCoordinatorConfig>,
  ) {
    super();
  }

  /**
   * Inject the learning engine. If coordinator already exists, wires immediately.
   * Otherwise, defers until createSources() is called.
   */
  setLearningEngine(engine: LearningEngine): void {
    this.pendingLearningEngine = engine;
    if (this.coordinator) {
      this.coordinator.setLearningEngine(engine);
    }
  }

  /**
   * Inject the app mastery map. If coordinator already exists, wires immediately.
   * Otherwise, defers until createSources() is called.
   */
  setAppMap(map: AppMap): void {
    this.pendingAppMap = map;
    if (this.coordinator) {
      this.coordinator.setAppMap(map);
    }
  }

  /**
   * Create perception sources from the bridge. Called once after ensureBridge().
   */
  createSources(bridge: BridgeClient): void {
    if (this.sourcesCreated) return;
    this.sourcesCreated = true;

    const observer = new StateObserver(bridge);
    const axSource = new AXSource(observer, bridge);
    const cdpSource = new CDPSource();
    const visionSource = new VisionSource(bridge);

    this.coordinator = new PerceptionCoordinator(
      this.worldModel,
      axSource,
      cdpSource,
      visionSource,
      { enableVision: true, ...this.config },
    );

    if (this.pendingLearningEngine) {
      this.coordinator.setLearningEngine(this.pendingLearningEngine);
    }
    if (this.pendingAppMap) {
      this.coordinator.setAppMap(this.pendingAppMap);
    }

    this.coordinator.on("perception", (event) => {
      this.handleReactiveEvent(event);
    });
  }

  /**
   * Ensure perception is started for the given app context.
   * Idempotent — starts if not running, switches context if app changed.
   */
  async ensureStarted(appContext: AppContext, cdpClient?: any): Promise<void> {
    if (!this.coordinator) return;

    const client = cdpClient ?? this.lastCdpClient;

    if (!this.coordinator.isRunning) {
      this.currentContext = appContext;
      this.currentPid = appContext.pid;
      this.currentBundleId = appContext.bundleId;
      await this.coordinator.start(appContext, client);
    } else if (
      this.currentPid !== appContext.pid ||
      (appContext.windowId != null && this.currentContext?.windowId !== appContext.windowId)
    ) {
      // Switch context when PID changes or when windowId is now available but wasn't before
      this.currentContext = appContext;
      this.currentPid = appContext.pid;
      this.currentBundleId = appContext.bundleId;
      await this.coordinator.switchContext(appContext, client);
    }
  }

  /**
   * Activate CDP source with a new client.
   * Uses hot-inject on the running coordinator instead of stop+restart
   * to preserve AX polling state and avoid resetting counters.
   */
  activateCDP(cdpClient: any): void {
    this.lastCdpClient = cdpClient;
    if (this.coordinator?.isRunning) {
      this.coordinator.activateCDP(cdpClient);
    }
  }

  /**
   * Best-effort auto-start: if perception isn't running and a focused app
   * is known, resolve its windowId and start perception silently.
   * Non-blocking — failures are swallowed.
   */
  async tryAutoStart(
    focusedApp: { bundleId: string; pid: number },
    bridge: BridgeClient,
  ): Promise<void> {
    if (!this.coordinator || this.coordinator.isRunning) return;
    if (!focusedApp.pid) return;

    let windowId: number | undefined;
    try {
      const wins = await bridge.call<any[]>("window.list", {});
      const matching = wins?.filter((w: any) => w.pid === focusedApp.pid);
      if (matching && matching.length > 0) {
        const frontmost = matching.find((w: any) => w.focused || w.frontmost || w.isMain);
        windowId = (frontmost ?? matching[0])?.windowId;
      }
    } catch { /* best-effort */ }

    const ctx: AppContext = {
      bundleId: focusedApp.bundleId,
      appName: focusedApp.bundleId,
      pid: focusedApp.pid,
      windowTitle: "",
      ...(windowId != null ? { windowId } : {}),
    };

    await this.ensureStarted(ctx);
  }

  async stop(): Promise<void> {
    if (this.coordinator?.isRunning) {
      await this.coordinator.stop();
    }
    this.currentContext = null;
    this.currentPid = null;
    this.currentBundleId = null;
  }

  get isRunning(): boolean {
    return this.coordinator?.isRunning ?? false;
  }

  getStats(): PerceptionStats {
    return this.coordinator?.getStats() ?? createEmptyStats();
  }

  getFreshnessSummary(): string {
    return this.coordinator?.getFreshnessSummary() ?? "Perception: not initialized";
  }

  getConfig(): PerceptionCoordinatorConfig | null {
    return this.coordinator?.getConfig() ?? null;
  }

  getCoordinator(): PerceptionCoordinator | null {
    return this.coordinator;
  }

  /**
   * Notify perception that a tool call is happening — resets idle timer.
   */
  notifyToolCall(): void {
    this.coordinator?.notifyToolCall();
  }

  private handleReactiveEvent(event: any): void {
    if (event.data?.type === "ax_events" && Array.isArray(event.data.events)) {
      for (const uiEvent of event.data.events) {
        if (uiEvent.type === "dialog_appeared") {
          this.emit("dialog_detected", {
            title: uiEvent.windowTitle ?? "",
            pid: uiEvent.pid,
          });
        }
        if (
          uiEvent.type === "app_activated" &&
          uiEvent.bundleId &&
          uiEvent.bundleId !== this.currentBundleId
        ) {
          this.emit("app_switched", {
            bundleId: uiEvent.bundleId,
            pid: uiEvent.pid,
          });
        }
      }
    }
  }
}
