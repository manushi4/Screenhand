/**
 * JobStore — atomic JSON persistence for jobs.
 *
 * All jobs are cached in memory. Writes are sync + atomic (temp+rename).
 * File: jobs.json (array of Job objects).
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync, readJsonWithRecovery } from "../util/atomic-write.js";
import type { Job, JobState } from "./types.js";

const MAX_COMPLETED_JOBS = 200;

export class JobStore {
  private readonly filePath: string;
  private jobs: Job[] = [];
  private initialized = false;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "jobs.json");
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.jobs = readJsonWithRecovery<Job[]>(this.filePath) ?? [];
  }

  /** Get all jobs, optionally filtered by state. */
  list(state?: JobState): Job[] {
    if (state) return this.jobs.filter((j) => j.state === state);
    return [...this.jobs];
  }

  /** Get a single job by ID. */
  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Insert a new job. */
  add(job: Job): void {
    this.jobs.push(job);
    this.persist();
  }

  /** Update an existing job in place, then persist. */
  update(id: string, patch: Partial<Job>): Job | undefined {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return undefined;
    this.jobs[idx] = { ...this.jobs[idx]!, ...patch, updatedAt: new Date().toISOString() };
    this.persist();
    return this.jobs[idx];
  }

  /** Remove a job by ID. */
  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length < before) {
      this.persist();
      return true;
    }
    return false;
  }

  /** Evict old completed/failed jobs beyond the cap. */
  prune(): number {
    const terminal = this.jobs
      .filter((j) => j.state === "done" || j.state === "failed")
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

    if (terminal.length <= MAX_COMPLETED_JOBS) return 0;

    const evictCount = terminal.length - MAX_COMPLETED_JOBS;
    const evictIds = new Set(terminal.slice(0, evictCount).map((j) => j.id));
    this.jobs = this.jobs.filter((j) => !evictIds.has(j.id));
    this.persist();
    return evictCount;
  }

  /** Next queued job by priority (lower number = higher priority), then creation order. */
  nextQueued(): Job | undefined {
    return this.jobs
      .filter((j) => j.state === "queued")
      .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  }

  private persist(): void {
    try {
      writeFileAtomicSync(this.filePath, JSON.stringify(this.jobs, null, 2));
    } catch {
      // Non-critical — in-memory cache is authoritative
    }
  }
}
