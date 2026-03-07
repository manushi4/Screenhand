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
 * Job layer types — persistent multi-step automation jobs
 * with state machine, playbook resume, and supervisor integration.
 */

export const JOB_STATES = ["queued", "running", "blocked", "waiting_human", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Transition rules: state → allowed next states */
export const VALID_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued:        ["running", "failed"],
  running:       ["blocked", "waiting_human", "done", "failed"],
  blocked:       ["running", "waiting_human", "failed"],
  waiting_human: ["running", "failed"],
  done:          [],       // terminal
  failed:        ["queued"], // can re-queue
};

export interface JobStep {
  /** Step index within the playbook (or synthetic index for AI steps) */
  index: number;
  action: string;
  target?: string;
  description?: string;
  /** Explicit text payload for type_text / type_into actions */
  text?: string;
  /** Key combo string for key / key_combo actions (e.g. "cmd+a") */
  keys?: string;
  /** Value payload for set_value-style actions */
  value?: string;
  status: "pending" | "done" | "failed" | "skipped";
  error?: string;
  durationMs?: number;
  completedAt?: string;
}

export interface Job {
  id: string;
  /** Human-readable description of what this job does */
  task: string;
  state: JobState;
  /** Playbook ID driving this job (null for AI-only jobs) */
  playbookId: string | null;
  /** Supervisor session ID this job is bound to */
  sessionId: string | null;
  /** Target application bundle ID (e.g. "com.apple.Safari") — null for app-agnostic jobs */
  bundleId: string | null;
  /** Target window ID within the application — null for app-agnostic jobs */
  windowId: number | null;
  /** Index of the last step that succeeded — resume starts from lastStep + 1 */
  lastStep: number;
  /** Snapshot of all steps with their status */
  steps: JobStep[];
  /** Why the job is blocked / waiting for human */
  blockReason: string | null;
  /** Number of times this job has been retried */
  retries: number;
  /** Max retries before moving to failed (default 3) */
  maxRetries: number;
  /** Error from the last failure */
  lastError: string | null;
  /** Tags for filtering / grouping */
  tags: string[];
  /** Priority: lower = higher priority. Default 10. */
  priority: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobSummary {
  total: number;
  byState: Record<JobState, number>;
  oldestQueued: string | null;
  runningJobIds: string[];
}
