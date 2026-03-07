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
import type { MacOSBridgeClient } from "../native/macos-bridge-client.js";
import type { UIEvent, UIEventType } from "../types.js";

/**
 * Wraps the native bridge's AX observer events into typed UIEvent objects.
 * Buffers events for consumption by the planning loop.
 */
export class StateObserver extends EventEmitter {
  private observedPids = new Set<number>();
  private eventBuffer: UIEvent[] = [];
  private readonly maxBufferSize: number;

  constructor(
    private readonly bridge: MacOSBridgeClient,
    maxBufferSize = 200,
  ) {
    super();
    this.maxBufferSize = maxBufferSize;

    // Listen for AX events from the bridge
    this.bridge.on("ax-event", (raw: Record<string, unknown>) => {
      const event = this.parseEvent(raw);
      if (event) {
        this.eventBuffer.push(event);
        if (this.eventBuffer.length > this.maxBufferSize) {
          this.eventBuffer.shift();
        }
        this.emit("event", event);
      }
    });
  }

  async startObserving(pid: number, eventTypes?: UIEventType[]): Promise<void> {
    if (this.observedPids.has(pid)) return;

    const notifications = eventTypes
      ? this.mapEventTypesToNotifications(eventTypes)
      : undefined;

    await this.bridge.call("observer.start", {
      pid,
      notifications,
    });

    this.observedPids.add(pid);
  }

  async stopObserving(pid: number): Promise<void> {
    if (!this.observedPids.has(pid)) return;

    await this.bridge.call("observer.stop", { pid });
    this.observedPids.delete(pid);
  }

  /** Get and clear the event buffer. */
  drainEvents(): UIEvent[] {
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    return events;
  }

  /** Get recent events without clearing. */
  peekEvents(limit = 50): UIEvent[] {
    return this.eventBuffer.slice(-limit);
  }

  /** Clear the event buffer. */
  clearEvents(): void {
    this.eventBuffer = [];
  }

  get isObserving(): boolean {
    return this.observedPids.size > 0;
  }

  get observedProcesses(): number[] {
    return [...this.observedPids];
  }

  private parseEvent(raw: Record<string, unknown>): UIEvent | null {
    const type = raw.type as UIEventType | undefined;
    if (!type) return null;

    const event: UIEvent = {
      type,
      timestamp: (raw.timestamp as string) ?? new Date().toISOString(),
      pid: (raw.pid as number) ?? 0,
    };

    if (typeof raw.bundleId === "string") event.bundleId = raw.bundleId;
    if (typeof raw.elementRole === "string") event.elementRole = raw.elementRole;
    if (typeof raw.elementLabel === "string") event.elementLabel = raw.elementLabel;
    if (typeof raw.oldValue === "string") event.oldValue = raw.oldValue;
    if (typeof raw.newValue === "string") event.newValue = raw.newValue;
    if (typeof raw.windowTitle === "string") event.windowTitle = raw.windowTitle;

    return event;
  }

  private mapEventTypesToNotifications(types: UIEventType[]): string[] {
    const map: Record<string, string> = {
      value_changed: "AXValueChanged",
      focus_changed: "AXFocusedUIElementChanged",
      window_created: "AXWindowCreated",
      window_closed: "AXUIElementDestroyed",
      title_changed: "AXTitleChanged",
      menu_opened: "AXMenuOpened",
      layout_changed: "AXLayoutChanged",
      dialog_appeared: "AXSheetCreated",
      app_activated: "AXApplicationActivated",
      app_deactivated: "AXApplicationDeactivated",
    };

    return types
      .map((t) => map[t])
      .filter((n): n is string => n !== undefined);
  }
}
