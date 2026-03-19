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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomicSync, readJsonWithRecovery } from "../util/atomic-write.js";
import type {
  WorldState,
  WindowState,
  ControlState,
  DialogState,
  AppDomainState,
  StateAssertion,
  StateTransition,
  TrackedEntity,
} from "./types.js";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".screenhand", "state");

function stateFilePath(stateDir: string, sessionId: string): string {
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const filePath = path.join(stateDir, `${safeId}.json`);
  // Double-check the resolved path stays inside stateDir
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(stateDir))) {
    return path.join(stateDir, "invalid_session.json");
  }
  return filePath;
}

interface SerializedWorldState {
  windows: Record<string, SerializedWindowState>;
  focusedWindowId: number | null;
  focusedApp: WorldState["focusedApp"];
  activeDialogs: SerializedDialogState[];
  appDomains: Record<string, AppDomainState>;
  lastFullScan: string;
  sessionId: string;
  expectedPostcondition?: StateAssertion | null;
  updatedAt?: string;
  confidence?: number;
  pendingGoal?: string | null;
  recentTransitions?: StateTransition[];
  trackedEntities?: Record<string, TrackedEntity>;
}

interface SerializedWindowState extends Omit<WindowState, "controls"> {
  controls: Record<string, ControlState>;
}

interface SerializedDialogState extends Omit<DialogState, "controls"> {
  controls: Record<string, ControlState>;
}

export function worldStateToJSON(state: WorldState): string {
  const serialized: SerializedWorldState = {
    windows: Object.fromEntries(
      Array.from(state.windows.entries()).map(([id, win]) => [
        String(id),
        {
          ...win,
          controls: Object.fromEntries(win.controls),
        },
      ]),
    ),
    focusedWindowId: state.focusedWindowId,
    focusedApp: state.focusedApp,
    activeDialogs: state.activeDialogs.map((d) => ({
      ...d,
      controls: Object.fromEntries(d.controls),
    })),
    appDomains: Object.fromEntries(state.appDomains),
    lastFullScan: state.lastFullScan,
    sessionId: state.sessionId,
    expectedPostcondition: state.expectedPostcondition,
    updatedAt: state.updatedAt,
    confidence: state.confidence,
    pendingGoal: state.pendingGoal,
    recentTransitions: state.recentTransitions,
    trackedEntities: Object.fromEntries(state.trackedEntities),
  };
  return JSON.stringify(serialized);
}

export function worldStateFromJSON(json: SerializedWorldState): WorldState {
  const windows = new Map<number, WindowState>();
  for (const [idStr, win] of Object.entries(json.windows ?? {})) {
    windows.set(Number(idStr), {
      ...win,
      controls: new Map(Object.entries(win.controls)),
      // Defaults for new WindowState fields (backwards compat)
      focusedElement: win.focusedElement ?? null,
      visibleControls: win.visibleControls ?? [],
      dialogStack: win.dialogStack ?? [],
      scrollPosition: win.scrollPosition ?? null,
      lastAXScanAt: win.lastAXScanAt ?? null,
      lastCDPScanAt: win.lastCDPScanAt ?? null,
      lastOCRAt: win.lastOCRAt ?? null,
      lastScreenshotHash: win.lastScreenshotHash ?? null,
    });
  }

  const activeDialogs: DialogState[] = (json.activeDialogs ?? []).map((d) => ({
    ...d,
    controls: new Map(Object.entries(d.controls)),
    // Defaults for new DialogState fields (backwards compat)
    message: d.message ?? null,
    buttons: d.buttons ?? [],
    source: d.source ?? ("ax" as const),
  }));

  const appDomains = new Map<string, AppDomainState>(
    Object.entries(json.appDomains ?? {}),
  );

  return {
    windows,
    focusedWindowId: json.focusedWindowId,
    focusedApp: json.focusedApp,
    activeDialogs,
    appDomains,
    lastFullScan: json.lastFullScan,
    sessionId: json.sessionId,
    expectedPostcondition: json.expectedPostcondition ?? null,
    updatedAt: json.updatedAt ?? json.lastFullScan,
    confidence: json.confidence ?? 1.0,
    pendingGoal: json.pendingGoal ?? null,
    recentTransitions: json.recentTransitions ?? [],
    trackedEntities: new Map(Object.entries(json.trackedEntities ?? {})),
  };
}

export function saveWorldState(state: WorldState, stateDir?: string): void {
  const dir = stateDir ?? DEFAULT_STATE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = stateFilePath(dir, state.sessionId);
  writeFileAtomicSync(filePath, worldStateToJSON(state));
}

export function loadWorldState(sessionId: string, stateDir?: string): WorldState | null {
  const dir = stateDir ?? DEFAULT_STATE_DIR;
  const filePath = stateFilePath(dir, sessionId);
  const raw = readJsonWithRecovery<SerializedWorldState>(filePath);
  if (!raw) return null;
  return worldStateFromJSON(raw);
}

export type SaveFn = (state: WorldState) => void;

export class DebouncedPersister {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: WorldState | null = null;
  private readonly saveFn: SaveFn;

  constructor(debounceMs: number, saveFn?: SaveFn) {
    this.saveFn = saveFn ?? ((s) => saveWorldState(s));
    if (debounceMs <= 0) {
      // Zero debounce = no-op persister (for tests)
      this.schedule = () => {};
      this.flush = () => {};
      return;
    }
    // Store debounceMs for use in schedule
    const ms = debounceMs;
    this.schedule = (state: WorldState) => {
      this.pending = state;
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending) {
          this.saveFn(this.pending);
          this.pending = null;
        }
      }, ms);
    };
  }

  schedule(_state: WorldState): void {
    // Overridden in constructor when debounceMs > 0
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      this.saveFn(this.pending);
      this.pending = null;
    }
  }
}
