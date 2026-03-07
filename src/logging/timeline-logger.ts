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

import type { ActionStatus, ActionTelemetry } from "../types.js";

export class TimelineLogger {
  private readonly timeline: ActionTelemetry[] = [];

  start(action: string, sessionId: string): ActionTelemetry {
    return {
      action,
      sessionId,
      startedAt: new Date().toISOString(),
      locateMs: 0,
      actMs: 0,
      verifyMs: 0,
      retries: 0,
    };
  }

  finish(telemetry: ActionTelemetry, status: ActionStatus): ActionTelemetry {
    const finishedAt = new Date().toISOString();
    const totalMs =
      new Date(finishedAt).getTime() - new Date(telemetry.startedAt).getTime();

    const finalized: ActionTelemetry = {
      ...telemetry,
      finishedAt,
      totalMs,
      status,
    };

    this.timeline.push(finalized);
    return finalized;
  }

  getRecent(limit = 50): ActionTelemetry[] {
    return this.timeline.slice(-limit);
  }
}
