/**
 * Task Queue — manages tasks to be assigned to Codex terminals
 */

import type { MonitorTask } from "./types.js";

export class TaskQueue {
  private tasks: MonitorTask[] = [];

  /** Add a task to the queue */
  enqueue(prompt: string, options: { priority?: number; terminalId?: string | null } = {}): MonitorTask {
    const task: MonitorTask = {
      id: "task_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      prompt,
      priority: options.priority ?? 10,
      terminalId: options.terminalId ?? null,
      status: "queued",
      createdAt: new Date().toISOString(),
      assignedAt: null,
      completedAt: null,
      result: null,
    };
    this.tasks.push(task);
    this.tasks.sort((a, b) => a.priority - b.priority);
    return task;
  }

  /** Get the next queued task for a specific terminal (or any terminal) */
  next(terminalId: string): MonitorTask | null {
    // First try tasks assigned to this specific terminal
    const specific = this.tasks.find(
      (t) => t.status === "queued" && t.terminalId === terminalId,
    );
    if (specific) return specific;

    // Then try unassigned tasks
    const any = this.tasks.find(
      (t) => t.status === "queued" && t.terminalId === null,
    );
    return any ?? null;
  }

  /** Mark a task as assigned */
  assign(taskId: string, terminalId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "assigned";
      task.terminalId = terminalId;
      task.assignedAt = new Date().toISOString();
    }
  }

  /** Mark a task as running */
  markRunning(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) task.status = "running";
  }

  /** Mark a task as completed */
  complete(taskId: string, result: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      task.result = result;
    }
  }

  /** Mark a task as failed */
  fail(taskId: string, result: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.result = result;
    }
  }

  /** Get all tasks */
  all(): MonitorTask[] {
    return [...this.tasks];
  }

  /** Get queued tasks count */
  queuedCount(): number {
    return this.tasks.filter((t) => t.status === "queued").length;
  }

  /** Remove completed/failed tasks older than given ms */
  cleanup(olderThanMs: number = 3600000): number {
    const cutoff = Date.now() - olderThanMs;
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(
      (t) =>
        t.status === "queued" ||
        t.status === "assigned" ||
        t.status === "running" ||
        (t.completedAt && new Date(t.completedAt).getTime() > cutoff),
    );
    return before - this.tasks.length;
  }
}
