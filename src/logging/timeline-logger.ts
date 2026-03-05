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

