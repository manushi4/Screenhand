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

/**
 * Codex Monitor types — track AI coding agents in VS Code terminals
 */

export type CodexStatus = "running" | "idle" | "error" | "unknown";

export interface TerminalState {
  /** Unique ID for this monitored terminal */
  id: string;
  /** VS Code PID */
  vscodePid: number;
  /** VS Code window ID (for screenshot/OCR) */
  windowId?: number;
  /** Terminal panel identifier (from AX tree) */
  terminalLabel: string;
  /** Current detected status of the agent */
  status: CodexStatus;
  /** Last lines of terminal output (extracted via AX/OCR) */
  lastOutput: string;
  /** What the agent was last working on */
  lastTask: string | null;
  /** When monitoring started */
  startedAt: string;
  /** Last time we polled this terminal */
  lastPollAt: string;
  /** Number of tasks completed in this terminal */
  tasksCompleted: number;
  /** History of completed tasks */
  taskHistory: CompletedTask[];
}

export interface CompletedTask {
  task: string;
  startedAt: string;
  completedAt: string;
  output: string;
}

export interface MonitorTask {
  /** Unique task ID */
  id: string;
  /** The prompt/command to send to Codex */
  prompt: string;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Which terminal to assign to (null = any available) */
  terminalId: string | null;
  /** Task status */
  status: "queued" | "assigned" | "running" | "completed" | "failed";
  /** When the task was created */
  createdAt: string;
  /** When the task was assigned to a terminal */
  assignedAt: string | null;
  /** When the task completed */
  completedAt: string | null;
  /** Terminal output after completion */
  result: string | null;
}

export interface MonitorConfig {
  /** Poll interval in ms (default: 3000) */
  pollIntervalMs: number;
  /** Patterns that indicate the agent is running */
  runningPatterns: string[];
  /** Patterns that indicate the agent is idle/done */
  idlePatterns: string[];
  /** Patterns that indicate an error */
  errorPatterns: string[];
  /** Auto-assign next task when terminal goes idle (default: true) */
  autoAssign: boolean;
  /** Delay before assigning next task after idle detected (ms) */
  assignDelayMs: number;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  pollIntervalMs: 3000,
  runningPatterns: [
    "Thinking",
    "Working",
    "Generating",
    "Analyzing",
    "Reading",
    "Writing",
    "Searching",
    "Running",
    "Executing",
    "...",
    "spinning",
    "in progress",
  ],
  idlePatterns: [
    "codex>",
    "Codex>",
    "> ",
    "$ ",
    "Done",
    "Complete",
    "Finished",
    "Task completed",
    "All done",
    "ready",
    "waiting for input",
    "What would you like",
    "How can I help",
  ],
  errorPatterns: [
    "Error:",
    "error:",
    "FAILED",
    "failed",
    "Exception",
    "Traceback",
    "panic:",
    "FATAL",
    "Cannot",
    "could not",
  ],
  autoAssign: true,
  assignDelayMs: 2000,
};
