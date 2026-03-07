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
 * Codex Monitor — watches VS Code terminals for AI agent activity
 *
 * Uses the native bridge to:
 * 1. Find VS Code windows + terminal panels via accessibility tree
 * 2. Poll terminal content via OCR (screenshot + vision.ocr)
 * 3. Detect agent status (running/idle/error) via pattern matching
 * 4. Auto-assign queued tasks when a terminal goes idle
 *
 * The monitor runs as a background polling loop, similar to PlaybookRecorder.
 */

import type { BridgeClient } from "../native/bridge-client.js";
import { TaskQueue } from "./task-queue.js";
import type {
  CodexStatus,
  CompletedTask,
  MonitorConfig,
  TerminalState,
} from "./types.js";
import { DEFAULT_MONITOR_CONFIG } from "./types.js";

export class CodexMonitor {
  private terminals = new Map<string, TerminalState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private config: MonitorConfig;
  private running = false;
  private assignTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly queue: TaskQueue;

  /** Callback when a terminal status changes */
  onStatusChange?: (terminal: TerminalState, oldStatus: CodexStatus) => void;
  /** Callback when a task is auto-assigned */
  onTaskAssigned?: (terminalId: string, task: { id: string; prompt: string }) => void;
  /** Callback for log messages */
  onLog?: (msg: string) => void;

  constructor(
    private readonly bridge: BridgeClient,
    config: Partial<MonitorConfig> = {},
  ) {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
    this.queue = new TaskQueue();
  }

  private log(msg: string): void {
    if (this.onLog) this.onLog(msg);
  }

  /**
   * Start monitoring a VS Code terminal.
   * Finds VS Code by PID, identifies terminal panels, begins polling.
   */
  async addTerminal(opts: {
    vscodePid: number;
    windowId?: number;
    label?: string;
  }): Promise<TerminalState> {
    const id = "term_" + opts.vscodePid + "_" + Date.now().toString(36);
    const state: TerminalState = {
      id,
      vscodePid: opts.vscodePid,
      ...(opts.windowId != null ? { windowId: opts.windowId } : {}),
      terminalLabel: opts.label ?? "Terminal",
      status: "unknown",
      lastOutput: "",
      lastTask: null,
      startedAt: new Date().toISOString(),
      lastPollAt: new Date().toISOString(),
      tasksCompleted: 0,
      taskHistory: [],
    };
    this.terminals.set(id, state);
    this.log(`Added terminal ${id} (pid=${opts.vscodePid})`);

    // Do an initial poll
    await this.pollTerminal(state);

    return state;
  }

  /** Remove a terminal from monitoring */
  removeTerminal(terminalId: string): boolean {
    const timer = this.assignTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.assignTimers.delete(terminalId);
    }
    return this.terminals.delete(terminalId);
  }

  /** Start the polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      for (const terminal of this.terminals.values()) {
        try {
          await this.pollTerminal(terminal);
        } catch (err) {
          this.log(`Poll error for ${terminal.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, this.config.pollIntervalMs);
    this.log(`Monitor started (poll every ${this.config.pollIntervalMs}ms)`);
  }

  /** Stop the polling loop */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.assignTimers.values()) {
      clearTimeout(timer);
    }
    this.assignTimers.clear();
    this.log("Monitor stopped");
  }

  /** Get all monitored terminals */
  getTerminals(): TerminalState[] {
    return [...this.terminals.values()];
  }

  /** Get a specific terminal */
  getTerminal(id: string): TerminalState | undefined {
    return this.terminals.get(id);
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Core polling logic ──

  private async pollTerminal(terminal: TerminalState): Promise<void> {
    terminal.lastPollAt = new Date().toISOString();

    // Strategy: use OCR on the VS Code window to read terminal content.
    // This is more reliable than AX tree for terminal text content.
    const output = await this.readTerminalContent(terminal);
    if (output === null) return; // couldn't read

    const oldStatus = terminal.status;
    terminal.lastOutput = output;

    // Detect status from the last few lines of output
    const lastLines = output.split("\n").slice(-15).join("\n");
    terminal.status = this.detectStatus(lastLines);

    // Status transition handling
    if (oldStatus !== terminal.status) {
      this.log(`Terminal ${terminal.id}: ${oldStatus} -> ${terminal.status}`);
      if (this.onStatusChange) {
        this.onStatusChange(terminal, oldStatus);
      }

      // If terminal just went idle, handle task completion + auto-assign
      if (terminal.status === "idle" && (oldStatus === "running" || oldStatus === "unknown")) {
        this.handleTerminalIdle(terminal);
      }
    }
  }

  /**
   * Read terminal content via screenshot + OCR of the VS Code window.
   */
  private async readTerminalContent(terminal: TerminalState): Promise<string | null> {
    try {
      let shotPath: string;

      if (terminal.windowId) {
        // Capture specific window
        const shot = await this.bridge.call<{ path: string }>("cg.captureWindow", {
          windowId: terminal.windowId,
        });
        shotPath = shot.path;
      } else {
        // Try to find VS Code window
        const wins = await this.bridge.call<any[]>("app.windows");
        const vscodeWin = wins.find(
          (w: any) => w.pid === terminal.vscodePid || w.bundleId === "com.microsoft.VSCode",
        );
        if (!vscodeWin) {
          this.log(`VS Code window not found for pid=${terminal.vscodePid}`);
          return null;
        }
        terminal.windowId = vscodeWin.windowId;
        const shot = await this.bridge.call<{ path: string }>("cg.captureWindow", {
          windowId: vscodeWin.windowId,
        });
        shotPath = shot.path;
      }

      // OCR the screenshot
      const ocr = await this.bridge.call<{ text: string }>("vision.ocr", {
        imagePath: shotPath,
      });
      return ocr.text;
    } catch (err) {
      this.log(`OCR failed for ${terminal.id}: ${err instanceof Error ? err.message : String(err)}`);

      // Fallback: try AX tree to read terminal content
      return this.readTerminalViaAX(terminal);
    }
  }

  /**
   * Fallback: read terminal content from accessibility tree.
   */
  private async readTerminalViaAX(terminal: TerminalState): Promise<string | null> {
    try {
      const tree = await this.bridge.call<any>("ax.getElementTree", {
        pid: terminal.vscodePid,
        maxDepth: 6,
      });

      // Find terminal text areas in the AX tree
      const terminalText = this.extractTerminalText(tree);
      return terminalText;
    } catch {
      return null;
    }
  }

  /**
   * Recursively search AX tree for terminal content.
   * VS Code terminals usually show up as AXTextArea or AXGroup with role "terminal".
   */
  private extractTerminalText(node: any, depth = 0): string | null {
    if (depth > 8) return null;

    const role = (node.role || "").toLowerCase();
    const title = (node.title || "").toLowerCase();
    const desc = (node.description || "").toLowerCase();

    // Look for terminal-like elements
    const isTerminal =
      role.includes("terminal") ||
      title.includes("terminal") ||
      desc.includes("terminal") ||
      (role === "textarea" && (title.includes("terminal") || desc.includes("terminal")));

    if (isTerminal && node.value) {
      return node.value;
    }

    if (node.children) {
      for (const child of node.children) {
        const found = this.extractTerminalText(child, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Detect Codex status from terminal output text.
   */
  private detectStatus(text: string): CodexStatus {
    const lower = text.toLowerCase();

    // Check error patterns first (highest priority)
    for (const pattern of this.config.errorPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        // Only if it appears in the last few lines
        const lastLines = text.split("\n").slice(-5).join("\n").toLowerCase();
        if (lastLines.includes(pattern.toLowerCase())) {
          return "error";
        }
      }
    }

    // Check idle patterns (prompt waiting for input)
    const lastLines = text.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lastLines[lastLines.length - 1] ?? "";
    const lastLineTrimmed = lastLine.trim();

    for (const pattern of this.config.idlePatterns) {
      if (lastLineTrimmed.includes(pattern) || lastLineTrimmed.endsWith(pattern.trim())) {
        return "idle";
      }
    }

    // Check running patterns
    for (const pattern of this.config.runningPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return "running";
      }
    }

    // If we can read content but can't determine status
    return "unknown";
  }

  /**
   * Handle a terminal going idle — complete current task and maybe assign next.
   */
  private handleTerminalIdle(terminal: TerminalState): void {
    // Record task completion if there was an active task
    if (terminal.lastTask) {
      const completed: CompletedTask = {
        task: terminal.lastTask,
        startedAt: terminal.taskHistory.length > 0
          ? terminal.taskHistory[terminal.taskHistory.length - 1]?.completedAt ?? terminal.startedAt
          : terminal.startedAt,
        completedAt: new Date().toISOString(),
        output: terminal.lastOutput.split("\n").slice(-20).join("\n"),
      };
      terminal.taskHistory.push(completed);
      terminal.tasksCompleted++;
      terminal.lastTask = null;

      // Complete the task in the queue
      const runningTask = this.queue.all().find(
        (t) => t.status === "running" && t.terminalId === terminal.id,
      );
      if (runningTask) {
        this.queue.complete(runningTask.id, completed.output);
      }

      this.log(`Terminal ${terminal.id}: task completed (${terminal.tasksCompleted} total)`);
    }

    // Auto-assign next task if enabled
    if (this.config.autoAssign) {
      // Clear any existing assign timer
      const existingTimer = this.assignTimers.get(terminal.id);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.assignTimers.delete(terminal.id);
        this.tryAssignTask(terminal);
      }, this.config.assignDelayMs);
      this.assignTimers.set(terminal.id, timer);
    }
  }

  /**
   * Try to assign the next queued task to a terminal.
   */
  private async tryAssignTask(terminal: TerminalState): Promise<boolean> {
    // Only assign if still idle
    if (terminal.status !== "idle") return false;

    const task = this.queue.next(terminal.id);
    if (!task) {
      this.log(`No queued tasks for terminal ${terminal.id}`);
      return false;
    }

    this.queue.assign(task.id, terminal.id);
    terminal.lastTask = task.prompt;

    this.log(`Assigning task "${task.prompt.slice(0, 50)}" to terminal ${terminal.id}`);

    if (this.onTaskAssigned) {
      this.onTaskAssigned(terminal.id, task);
    }

    // Type the task into the terminal
    try {
      await this.typeIntoTerminal(terminal, task.prompt);
      this.queue.markRunning(task.id);
      terminal.status = "running";
      return true;
    } catch (err) {
      this.log(`Failed to type task: ${err instanceof Error ? err.message : String(err)}`);
      this.queue.fail(task.id, String(err));
      return false;
    }
  }

  /**
   * Type a command into the terminal by focusing VS Code and using keyboard input.
   */
  private async typeIntoTerminal(terminal: TerminalState, text: string): Promise<void> {
    // 1. Focus VS Code
    await this.bridge.call("app.focus", { bundleId: "com.microsoft.VSCode" });
    await sleep(300);

    // 2. If we know the terminal label, try to focus that specific terminal pane
    // Use accessibility to find and click the terminal
    try {
      await this.bridge.call("ax.findElement", {
        pid: terminal.vscodePid,
        title: terminal.terminalLabel,
        exact: false,
      });
    } catch {
      // Terminal pane might already be focused, continue
    }

    // 3. Type the command
    await this.bridge.call("cg.typeText", { text });
    await sleep(100);

    // 4. Press Enter to execute
    await this.bridge.call("cg.keyCombo", { keys: ["enter"] });
  }

  /**
   * Manually assign a task to a terminal (bypasses queue).
   */
  async assignDirect(terminalId: string, prompt: string): Promise<boolean> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    terminal.lastTask = prompt;
    try {
      await this.typeIntoTerminal(terminal, prompt);
      terminal.status = "running";
      return true;
    } catch {
      return false;
    }
  }

  /** Update monitor config */
  updateConfig(config: Partial<MonitorConfig>): void {
    this.config = { ...this.config, ...config };
    // Restart polling if interval changed
    if (config.pollIntervalMs && this.running) {
      this.stop();
      this.start();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
