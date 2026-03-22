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
import type { AppContext } from "../types.js";
import type { WorldModel } from "../state/world-model.js";
import type { AXSource } from "./ax-source.js";
import type { CDPSource } from "./cdp-source.js";
import { VisionSource } from "./vision-source.js";
import type {
  PerceptionCoordinatorConfig,
  PerceptionEvent,
  PerceptionStats,
  ROI,
} from "./types.js";
import { DEFAULT_PERCEPTION_CONFIG, createEmptyStats } from "./types.js";
import type { LearningEngine } from "../learning/engine.js";
import type { AppMap } from "../state/app-map.js";
import { acquireCaptureLock, releaseCaptureLock } from "../observer/state.js";
import { FusionPipeline } from "../state/fusion.js";

/** Race a promise against a timeout. Rejects with "timeout" if the promise doesn't settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * PerceptionCoordinator — manages multi-rate perception sources and feeds
 * results into the world model.
 *
 * Runs three interval loops at different rates:
 * - FAST (100ms): AX push events + CDP mutations (event-driven, cheap)
 * - MEDIUM (500ms): AX tree poll + CDP DOM snapshot (structured, moderate)
 * - SLOW (2000ms): Screenshot diff + ROI OCR (visual, expensive)
 *
 * The coordinator runs in the MCP server process. Heavy work (capture/OCR)
 * is delegated to the native bridge (separate process) or observer daemon.
 */
export class PerceptionCoordinator extends EventEmitter {
  private readonly config: PerceptionCoordinatorConfig;
  private stats: PerceptionStats;

  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private mediumTimer: ReturnType<typeof setInterval> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;

  private activePid: number | null = null;
  private activeWindowId: number | null = null;
  private activeAppContext: AppContext | null = null;
  private cdpClient: any = null;
  /** CDP connection factory — called to create/reconnect persistent clients */
  private cdpConnectFn: (() => Promise<any>) | null = null;

  private running = false;
  private learningEngine: LearningEngine | null = null;
  private appMap: AppMap | null = null;
  private browserEnricher: (() => Promise<void>) | null = null;
  private readonly fusionPipeline = new FusionPipeline();

  // In-flight guards to prevent timer pileup when async cycles exceed their interval
  private fastInFlight = false;
  private mediumInFlight = false;
  private slowInFlight = false;

  // Debounce timer for switchContext to coalesce rapid app switches
  private switchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolve callback for the previous debounced switchContext promise
  private switchDebounceResolve: (() => void) | null = null;

  // Idle gating: pause perception when no tool calls for IDLE_THRESHOLD_MS
  private static readonly IDLE_THRESHOLD_MS = 3_000;
  private lastToolCallAt: number = Date.now();
  private idle = false;

  constructor(
    private readonly worldModel: WorldModel,
    private readonly axSource: AXSource | null,
    private readonly cdpSource: CDPSource | null,
    private readonly visionSource: VisionSource | null,
    config?: Partial<PerceptionCoordinatorConfig>,
  ) {
    super();
    this.config = { ...DEFAULT_PERCEPTION_CONFIG, ...config };
    this.stats = createEmptyStats();
  }

  /**
   * Inject the learning engine for recording sensor outcomes.
   */
  setLearningEngine(engine: LearningEngine): void {
    this.learningEngine = engine;
    this.fusionPipeline.setLearningEngine(engine);
  }

  /**
   * Inject the app mastery map for validating spatial knowledge during slow cycle.
   */
  setAppMap(map: AppMap): void {
    this.appMap = map;
  }

  /**
   * Set a browser enricher callback for non-CDP browsers (Safari).
   * Called during medium cycle to fetch URL/title/tabs via AppleScript.
   * Pass null to clear the enricher (e.g. on app switch away from Safari).
   */
  setBrowserEnricher(fn: (() => Promise<void>) | null): void {
    this.browserEnricher = fn;
  }

  /**
   * Notify that a tool call is happening — resets idle timer and starts stream if needed.
   * Call this from the intelligence wrapper PRE-CALL.
   */
  notifyToolCall(): void {
    this.lastToolCallAt = Date.now();
    if (this.idle) {
      this.idle = false;
      this.emit("wake");
      // Start stream capture on wake for fast perception (only if running)
      if (this.running && this.visionSource && this.activeWindowId && !this.visionSource.isStreaming) {
        void this.visionSource.startStream(this.activeWindowId).catch(() => {});
      }
    }
  }

  /**
   * Check if perception should be idle (no tool calls for 3s).
   * Stops stream capture when entering idle.
   */
  private isIdle(): boolean {
    const elapsed = Date.now() - this.lastToolCallAt;
    const shouldIdle = elapsed > PerceptionCoordinator.IDLE_THRESHOLD_MS;
    if (shouldIdle && !this.idle) {
      this.idle = true;
      this.emit("idle");
      // Stop stream capture to save battery at idle
      if (this.visionSource?.isStreaming) {
        void this.visionSource.stopStream().catch(() => {});
      }
    }
    return shouldIdle;
  }

  /**
   * Start continuous perception loops.
   */
  async start(
    appContext: AppContext,
    cdpClient?: any,
  ): Promise<void> {
    if (this.running) return;

    this.activePid = appContext.pid;
    this.activeWindowId = appContext.windowId ?? null;
    this.activeAppContext = appContext;
    this.cdpClient = cdpClient ?? null;
    this.running = true;
    this.stats = createEmptyStats();
    this.stats.started = true;
    this.stats.startedAt = new Date().toISOString();
    this.cdpConsecutiveFailures = 0;
    this.axConsecutiveFailures = 0;
    this.fastInFlight = false;
    this.mediumInFlight = false;
    this.slowInFlight = false;
    this.lastToolCallAt = Date.now();
    this.idle = false;

    // Enable safe CLI capture for browser apps to avoid CGWindowListCreateImage SIGSEGV
    if (this.visionSource && typeof this.visionSource.setSafeCLI === "function") {
      const family = this.worldModel.getAppFamily();
      this.visionSource.setSafeCLI(family === "browser");
    }

    // Start continuous stream capture for fast perception (non-blocking, best-effort)
    if (this.config.enableVision && this.visionSource && this.activeWindowId) {
      void this.visionSource.startStream(this.activeWindowId).catch(() => {});
    }

    // Start AX observation
    if (this.config.enableAX && this.axSource && this.activePid) {
      try {
        await this.axSource.startObserving(this.activePid);
      } catch {
        // AX not available
      }
    }

    // Install CDP mutation observer
    if (this.config.enableCDP && this.cdpSource && this.cdpClient) {
      try {
        await this.cdpSource.installMutationObserver(this.cdpClient);
      } catch {
        // CDP not available
      }
    }

    // Start interval loops — in-flight guards prevent pileup when async cycle
    // takes longer than the interval (e.g. bridge latency spike).
    this.fastTimer = setInterval(() => {
      if (this.fastInFlight) return;
      this.fastInFlight = true;
      void this.fastCycle().catch(() => {}).finally(() => { this.fastInFlight = false; });
    }, this.config.fastIntervalMs);

    this.mediumTimer = setInterval(() => {
      if (this.mediumInFlight) return;
      this.mediumInFlight = true;
      void this.mediumCycle().catch(() => {}).finally(() => { this.mediumInFlight = false; });
    }, this.config.mediumIntervalMs);

    if (this.config.enableVision) {
      this.slowTimer = setInterval(() => {
        if (this.slowInFlight) return;
        this.slowInFlight = true;
        void this.slowCycle().catch(() => {}).finally(() => { this.slowInFlight = false; });
      }, this.config.slowIntervalMs);
    }

    this.emit("started", appContext);
  }

  /**
   * Stop all perception loops.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.switchDebounceTimer !== null) {
      clearTimeout(this.switchDebounceTimer);
      this.switchDebounceTimer = null;
      if (this.switchDebounceResolve !== null) {
        this.switchDebounceResolve();
        this.switchDebounceResolve = null;
      }
    }

    // Stop stream capture
    if (this.visionSource?.isStreaming) {
      void this.visionSource.stopStream().catch(() => {});
    }

    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
    if (this.mediumTimer) {
      clearInterval(this.mediumTimer);
      this.mediumTimer = null;
    }
    if (this.slowTimer) {
      clearInterval(this.slowTimer);
      this.slowTimer = null;
    }

    if (this.axSource && this.activePid) {
      try {
        await this.axSource.stopObserving(this.activePid);
      } catch {
        // ignore
      }
    }

    this.activePid = null;
    this.activeWindowId = null;
    this.activeAppContext = null;
    this.cdpClient = null;
    this.browserEnricher = null;
    this.stats.started = false;
    this.fastInFlight = false;
    this.mediumInFlight = false;
    this.slowInFlight = false;

    this.emit("stopped");
  }

  /**
   * Switch perception to a new app/window context.
   * Debounced by 150ms — rapid successive calls coalesce to the last context.
   */
  switchContext(
    appContext: AppContext,
    cdpClient?: any,
  ): Promise<void> {
    if (this.switchDebounceTimer !== null) {
      clearTimeout(this.switchDebounceTimer);
      this.switchDebounceTimer = null;
      // Resolve the previous caller's promise — their switch was superseded, not failed
      if (this.switchDebounceResolve !== null) {
        this.switchDebounceResolve();
        this.switchDebounceResolve = null;
      }
    }

    return new Promise<void>((resolve) => {
      this.switchDebounceResolve = resolve;
      this.switchDebounceTimer = setTimeout(() => {
        this.switchDebounceTimer = null;
        this.switchDebounceResolve = null;
        void this.doSwitchContext(appContext, cdpClient).then(resolve).catch((err) => {
          console.error(`[Perception] switchContext failed: ${err?.message ?? err}`);
          resolve(); // Resolve anyway so callers don't hang, but error is logged
        });
      }, 150);
    });
  }

  /**
   * Internal: perform the actual context switch (stop + reset + start).
   */
  private async doSwitchContext(
    appContext: AppContext,
    cdpClient?: any,
  ): Promise<void> {
    await this.stop();
    this.visionSource?.reset();
    this.cdpSource?.reset();
    await this.start(appContext, cdpClient);
  }

  /**
   * Get current perception statistics.
   */
  getStats(): PerceptionStats {
    return { ...this.stats };
  }

  /**
   * Get a perception freshness summary for intelligence wrapper hints.
   */
  getFreshnessSummary(): string {
    if (!this.stats.started) return "Perception: not active";

    const now = Date.now();
    const STALE_THRESHOLD_MS = 5_000;
    const sources: string[] = [];
    const warnings: string[] = [];

    // Per-source detail
    if (this.config.enableAX) {
      if (this.stats.lastAXAt) {
        const ageMs = now - new Date(this.stats.lastAXAt).getTime();
        sources.push(`AX: ${ageMs}ms ago`);
        if (ageMs > STALE_THRESHOLD_MS) warnings.push("AX");
      } else {
        sources.push("AX: no data yet");
      }
    } else {
      sources.push("AX: DISABLED");
    }

    if (this.config.enableCDP) {
      if (this.stats.lastCDPAt) {
        const ageMs = now - new Date(this.stats.lastCDPAt).getTime();
        sources.push(`CDP: ${ageMs}ms ago`);
        if (ageMs > STALE_THRESHOLD_MS) warnings.push("CDP");
      } else {
        sources.push("CDP: no data yet");
      }
    } else {
      sources.push("CDP: DISABLED");
    }

    if (this.config.enableVision) {
      if (this.stats.lastVisionAt) {
        const ageMs = now - new Date(this.stats.lastVisionAt).getTime();
        sources.push(`Vision: ${ageMs}ms ago`);
        if (ageMs > STALE_THRESHOLD_MS) warnings.push("Vision");
      } else {
        sources.push("Vision: no data yet");
      }
    } else {
      sources.push("Vision: DISABLED");
    }

    let summary = `Perception: ${sources.join(", ")}`;
    if (warnings.length > 0) {
      summary += ` ⚠ STALE: ${warnings.join(", ")} (>5s)`;
    }
    return summary;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getConfig(): PerceptionCoordinatorConfig {
    return { ...this.config };
  }

  // ── Loop implementations ──

  private async fastCycle(): Promise<void> {
    if (!this.running || this.isIdle()) return;
    const timestamp = new Date().toISOString();

    try {
      // Drain AX events
      if (this.config.enableAX && this.axSource) {
        try {
          const axEvent = this.axSource.drainEvents();
          if (axEvent && axEvent.data.type === "ax_events") {
            this.stats.axEventsProcessed += axEvent.data.events.length;
            this.worldModel.ingestUIEvents(axEvent.data.events);
            this.emit("perception", axEvent);
          }
        } catch (err: any) {
          console.error(`[Perception] fastCycle AX drain error: ${err?.message ?? err}`);
        }
      }

      // Drain CDP mutations
      if (this.config.enableCDP && this.cdpSource) {
        try {
          const cdpEvent = this.cdpSource.drainMutations();
          if (cdpEvent && cdpEvent.data.type === "cdp_mutations") {
            this.stats.cdpMutationsProcessed += cdpEvent.data.mutations.length;
            // Ingest mutations into world model
            if (this.activeAppContext) {
              this.worldModel.ingestCDPMutations(
                this.activeAppContext.bundleId,
                cdpEvent.data.mutations,
              );
            }
            this.emit("perception", cdpEvent);
          }
        } catch (err: any) {
          console.error(`[Perception] fastCycle CDP drain error: ${err?.message ?? err}`);
        }
      }
    } finally {
      this.stats.fastCycles++;
      this.stats.lastFastAt = timestamp;
    }
  }

  private async mediumCycle(): Promise<void> {
    if (!this.running || this.isIdle()) return;
    const timestamp = new Date().toISOString();

    // Determine sensor polling order — use learning engine ranking if available
    const sensorOrder = this.getMediumCycleSensorOrder();

    const MEDIUM_CYCLE_TIMEOUT_MS = 15_000;
    for (const sensor of sensorOrder) {
      try {
        if (sensor === "ax") {
          await withTimeout(this.pollAX(), MEDIUM_CYCLE_TIMEOUT_MS, "pollAX");
        } else if (sensor === "cdp") {
          await withTimeout(this.pollCDP(), MEDIUM_CYCLE_TIMEOUT_MS, "pollCDP");
        }
      } catch (e: any) {
        console.error(`[Perception] ${sensor} medium cycle error: ${e?.message ?? e}`);
      }
    }

    // Enrich browser state for non-CDP browsers (Safari)
    if (this.browserEnricher) {
      try { await this.browserEnricher(); } catch { /* best-effort */ }
    }

    this.stats.mediumCycles++;
    this.stats.lastMediumAt = timestamp;
  }

  /**
   * Determine the order to poll sensors in the medium cycle.
   * If the learning engine has ranked data for the current app, use that order.
   * Otherwise, fall back to the default: AX → CDP.
   */
  /**
   * Inject or update the CDP client after perception has started.
   * Called when a browser CDP connection is established.
   */
  /**
   * Inject or update the CDP client after perception has started.
   * Accepts either a live client or a connect function (preferred — enables reconnection).
   */
  activateCDP(cdpClient: any, connectFn?: () => Promise<any>): void {
    console.error(`[Perception] activateCDP called, client=${!!cdpClient}, connectFn=${!!connectFn}, enableCDP=${this.config.enableCDP}, cdpSource=${!!this.cdpSource}`);
    this.cdpClient = cdpClient;
    if (connectFn) this.cdpConnectFn = connectFn;
    this.cdpConsecutiveFailures = 0;
    if (this.config.enableCDP && this.cdpSource && cdpClient) {
      void this.cdpSource.installMutationObserver(cdpClient).catch((e) => {
        console.error(`[Perception] installMutationObserver failed: ${e?.message ?? e}`);
      });
    }
  }

  /**
   * Update the active window ID after perception has started.
   * Called when window resolution succeeds late (after start).
   */
  setActiveWindowId(windowId: number): void {
    this.activeWindowId = windowId;
  }

  private getMediumCycleSensorOrder(): Array<"ax" | "cdp"> {
    const defaultOrder: Array<"ax" | "cdp"> = [];
    // Allow AX polling even without windowId — pollAX uses windowId ?? 0 (full app tree)
    if (this.config.enableAX && this.axSource && this.activePid) {
      defaultOrder.push("ax");
    }
    if (this.config.enableCDP && this.cdpSource && this.cdpClient) {
      defaultOrder.push("cdp");
    }

    if (!this.learningEngine || !this.activeAppContext || defaultOrder.length <= 1) {
      return defaultOrder;
    }

    const ranked = this.learningEngine.rankSensors(this.activeAppContext.bundleId);
    if (ranked.length === 0) return defaultOrder;

    // Build ordered list from ranking, only including sensors that are available
    const available = new Set(defaultOrder);
    const ordered: Array<"ax" | "cdp"> = [];
    for (const { sourceType } of ranked) {
      const s = sourceType as "ax" | "cdp";
      if (available.has(s)) {
        ordered.push(s);
        available.delete(s);
      }
    }
    // Append any remaining sensors not covered by ranking
    for (const s of defaultOrder) {
      if (available.has(s)) {
        ordered.push(s);
      }
    }

    return ordered;
  }

  private axConsecutiveFailures = 0;

  private async pollAX(): Promise<void> {
    if (
      !this.config.enableAX ||
      !this.axSource ||
      !this.activePid ||
      !this.activeAppContext
    ) return;

    // If AX has failed many times, the app PID is likely dead — skip polling
    // and emit a stale warning so the caller knows to restart perception
    if (this.axConsecutiveFailures > 5) {
      return;
    }

    // Adaptive skip: if recent AX polls are extremely slow, skip this cycle
    if (this.axSource.shouldSkipPoll()) {
      return;
    }

    // Derive windowId if not set — use first tracked window for this pid
    if (this.activeWindowId === null) {
      for (const [id, win] of this.worldModel.getState().windows) {
        if (win.pid === this.activePid) {
          this.activeWindowId = id;
          break;
        }
      }
    }

    try {
      const { event: treeEvent, latencyMs: axLatency, nodeCount } = await this.axSource.pollAXTree(
        this.activePid,
        this.activeWindowId ?? 0,
        this.activeAppContext,
      );
      const axSuccess = !!(treeEvent && treeEvent.data.type === "ax_tree");
      if (treeEvent && treeEvent.data.type === "ax_tree") {
        this.stats.axTreePolls++;
        this.stats.lastAXAt = new Date().toISOString();
        this.axConsecutiveFailures = 0;
        this.fusionPipeline.enqueue({
          source: "ax",
          timestamp: new Date().toISOString(),
          confidence: 0.9,
          windowId: treeEvent.data.windowId,
          axTree: treeEvent.data.tree,
          appContext: treeEvent.data.appContext,
        });
        this.fusionPipeline.flush(this.worldModel);
        this.emit("perception", treeEvent);
      } else {
        this.axConsecutiveFailures++;
      }
      if (this.learningEngine && this.activeAppContext) {
        this.learningEngine.recordSensorOutcome({
          bundleId: this.activeAppContext.bundleId,
          sourceType: "ax",
          success: axSuccess,
          latencyMs: axLatency,
          nodeCount,
        });
      }
    } catch (err: any) {
      this.axConsecutiveFailures++;
      console.error(`[Perception] pollAX error #${this.axConsecutiveFailures}: ${err?.message ?? err}`);
    }
  }

  private cdpConsecutiveFailures = 0;

  private async pollCDP(): Promise<void> {
    if (!this.config.enableCDP || !this.cdpSource || !this.cdpClient) {
      if (this.stats.cdpSnapshots === 0 && this.stats.mediumCycles > 0 && this.stats.mediumCycles % 20 === 0) {
        console.error(`[Perception] pollCDP skipped: enableCDP=${this.config.enableCDP} cdpSource=${!!this.cdpSource} cdpClient=${!!this.cdpClient}`);
      }
      return;
    }

    // If CDP has failed too many times, periodically retry reconnection (every 10th cycle)
    // instead of giving up forever — the target app may have restarted
    if (this.cdpConsecutiveFailures > 10) {
      if (this.cdpConsecutiveFailures % 10 === 0 && this.cdpConnectFn) {
        try {
          this.cdpClient = await this.cdpConnectFn();
          const failureCount = this.cdpConsecutiveFailures;
          this.cdpConsecutiveFailures = 0;
          console.error(`[Perception] CDP reconnected after ${failureCount} failures`);
        } catch {
          this.cdpConsecutiveFailures++;
        }
      } else {
        this.cdpConsecutiveFailures++;
      }
      return;
    }

    const cdpStart = Date.now();
    try {
      const snapEvent = await this.cdpSource.pollSnapshot(this.cdpClient);
      const cdpLatency = Date.now() - cdpStart;
      const cdpSuccess = !!(snapEvent && snapEvent.data.type === "cdp_snapshot");
      if (this.stats.cdpSnapshots === 0) {
        console.error(`[Perception] pollCDP result: success=${cdpSuccess} latency=${cdpLatency}ms event_type=${snapEvent?.data?.type ?? "null"}`);
      }
      if (snapEvent && snapEvent.data.type === "cdp_snapshot") {
        this.stats.cdpSnapshots++;
        this.stats.lastCDPAt = new Date().toISOString();
        this.cdpConsecutiveFailures = 0;
        if (this.activeAppContext) {
          this.fusionPipeline.enqueue({
            source: "cdp",
            timestamp: new Date().toISOString(),
            confidence: 0.85,
            windowId: this.activeWindowId ?? 0,
            cdpSnapshot: {
              bundleId: this.activeAppContext.bundleId,
              url: snapEvent.data.url,
              title: snapEvent.data.title,
            },
          });
          this.fusionPipeline.flush(this.worldModel);
        }
        this.emit("perception", snapEvent);
      }
      if (this.learningEngine && this.activeAppContext) {
        this.learningEngine.recordSensorOutcome({
          bundleId: this.activeAppContext.bundleId,
          sourceType: "cdp",
          success: cdpSuccess,
          latencyMs: cdpLatency,
        });
      }
    } catch (err: any) {
      this.cdpConsecutiveFailures++;
      console.error(`[Perception] pollCDP error #${this.cdpConsecutiveFailures}: ${err?.message ?? err}`);
      // Try to reconnect using the connect factory if available
      if (this.cdpConsecutiveFailures <= 3 && this.cdpConnectFn) {
        try {
          this.cdpClient = await this.cdpConnectFn();
          this.cdpConsecutiveFailures = 0;
        } catch {
          // reconnect failed — will retry next cycle
        }
      }
      if (this.learningEngine && this.activeAppContext) {
        this.learningEngine.recordSensorOutcome({
          bundleId: this.activeAppContext.bundleId,
          sourceType: "cdp",
          success: false,
          latencyMs: Date.now() - cdpStart,
        });
      }
    }
  }

  private async slowCycle(): Promise<void> {
    if (!this.running || !this.visionSource || this.isIdle())
      return;

    // For browsers, use safe CLI capture mode (screencapture) instead of
    // CGWindowListCreateImage which crashes on GPU-heavy pages (WebGL, canvas).
    // Safe CLI mode is already enabled via setSafeCLI() in start().
    // This allows vision/OCR for canvas-heavy apps like Canva in Chrome.

    // Skip vision if learning engine shows it consistently fails for this app,
    // but retry every 20th cycle to re-evaluate (apps may gain windows later)
    if (this.learningEngine && this.activeAppContext) {
      const ranked = this.learningEngine.rankSensors(this.activeAppContext.bundleId);
      const visionRank = ranked.find(r => r.sourceType === "vision");
      if (visionRank && visionRank.score < 0.1 && ranked.length >= 2 && this.stats.slowCycles % 20 !== 0) {
        this.stats.slowCycles++;
        return; // Vision consistently fails for this app — skip (retry every 20th cycle)
      }
    }

    const timestamp = new Date().toISOString();

    // Acquire capture lock to prevent concurrent captures with observer daemon
    if (!this.config.skipCaptureLock && !acquireCaptureLock()) {
      this.stats.slowCycles++;
      return; // Observer daemon is capturing — skip this cycle
    }

    let didWork = false;
    try {
      // Screenshot diff — optimized single-capture pipeline
      const windowId = this.activeWindowId ?? 0;
      if (windowId === 0) return; // Vision needs a real window ID for screenshot
      didWork = true;
      const SLOW_CYCLE_TIMEOUT_MS = 25_000;
      const { diffEvent, ocrEvent, yoloElements } = await withTimeout(
        this.visionSource.captureAndDiffOptimized(windowId, this.config.maxROIsPerCycle),
        SLOW_CYCLE_TIMEOUT_MS,
        "captureAndDiffOptimized",
      );
      if (diffEvent) {
        this.stats.visionDiffs++;
        this.stats.lastVisionAt = new Date().toISOString();

        // Store screenshot hash in world model for change detection
        if (diffEvent.data.type === "vision_diff" && diffEvent.data.hash && this.activeWindowId !== null) {
          this.worldModel.updateWindowScreenshotHash(this.activeWindowId, diffEvent.data.hash);
        }

        this.emit("perception", diffEvent);
      }
      if (ocrEvent) {
        this.stats.visionOCRs++;
        // Merge OCR regions into world model via fusion pipeline
        if (ocrEvent.data.type === "vision_ocr" && ocrEvent.data.regions.length > 0) {
          this.fusionPipeline.enqueue({
            source: "ocr",
            timestamp: new Date().toISOString(),
            confidence: 0.7,
            windowId,
            ocrRegions: ocrEvent.data.regions,
          });
          this.fusionPipeline.flush(this.worldModel);
        }
        // Touch lastValidated on app map when OCR confirms screen content
        if (this.appMap && this.activeAppContext) {
          const mapData = this.appMap.load(this.activeAppContext.bundleId);
          if (mapData) {
            mapData.lastValidated = new Date().toISOString();
            this.appMap.save(mapData);
          }
        }

        this.emit("perception", ocrEvent);
      }
      // Fuse YOLO element detections with OCR text regions
      if (yoloElements && yoloElements.length > 0) {
        const ocrRegions = (ocrEvent?.data.type === "vision_ocr" && ocrEvent.data.regions)
          ? ocrEvent.data.regions
          : [];
        const fused = VisionSource.fuseOcrAndYolo(ocrRegions, yoloElements);
        if (fused.length > 0) {
          this.fusionPipeline.enqueue({
            source: "ocr",
            timestamp: new Date().toISOString(),
            confidence: 0.8,
            windowId,
            ocrRegions: fused.map((f) => ({
              text: f.text || `[${f.class}]`,
              bounds: f.bounds,
            })),
          });
          this.fusionPipeline.flush(this.worldModel);
        }
        this.emit("perception", {
          source: "vision_yolo",
          rate: "slow",
          timestamp: new Date().toISOString(),
          data: {
            type: "vision_yolo",
            elements: fused,
            count: fused.length,
          },
        });
      }
      // Record vision sensor outcome
      if (this.learningEngine && this.activeAppContext) {
        this.learningEngine.recordSensorOutcome({
          bundleId: this.activeAppContext.bundleId,
          sourceType: "vision",
          success: !!diffEvent,
          latencyMs: Date.now() - new Date(timestamp).getTime(),
        });
      }
    } catch {
      // Vision source failed (bridge crash, timeout, etc.) — continue running
      if (this.learningEngine && this.activeAppContext) {
        this.learningEngine.recordSensorOutcome({
          bundleId: this.activeAppContext.bundleId,
          sourceType: "vision",
          success: false,
          latencyMs: Date.now() - new Date(timestamp).getTime(),
        });
      }
    } finally {
      if (didWork) {
        this.stats.slowCycles++;
        this.stats.lastSlowAt = timestamp;
      }
      if (!this.config.skipCaptureLock) releaseCaptureLock();
    }
  }
}
