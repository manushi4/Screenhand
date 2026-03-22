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

import type { StateAssertion } from "../state/types.js";

export type GoalStatus = "pending" | "active" | "completed" | "failed" | "replanning";
export type SubgoalStatus = "pending" | "active" | "completed" | "failed" | "skipped";
export type PlanSource = "playbook" | "strategy" | "reference_flow" | "llm" | "learned";
export type PlanStepStatus = "pending" | "executing" | "completed" | "failed";

export type ReplanReason =
  | "postcondition_mismatch"
  | "unexpected_dialog"
  | "element_not_found"
  | "app_switched"
  | "confidence_low"
  | "timeout";

export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  subgoals: Subgoal[];
  createdAt: string;
  completedAt: string | null;
  /** Resume point after pausing for an LLM step. */
  pausedAt?: { subgoalIndex: number; stepIndex: number };
}

export interface Subgoal {
  id: string;
  description: string;
  status: SubgoalStatus;
  plan: ActionPlan | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

export interface ActionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  confidence: number;
  source: PlanSource;
  sourceId: string | null;
}

export interface PlanStep {
  tool: string;
  params: Record<string, unknown>;
  expectedPostcondition: StateAssertion | null;
  timeout: number;
  fallbackTool: string | null;
  requiresLLM: boolean;
  status: PlanStepStatus;
  description: string;
  /** Tracks who resolved an LLM step: the client or auto-execution. */
  resolvedBy?: "client" | "auto";
  /** Wire #13: warning if tool×locator has known failure patterns */
  _patternWarning?: string;
}

export interface PlanResult {
  goalId: string;
  success: boolean;
  subgoalsCompleted: number;
  totalSubgoals: number;
  stepsExecuted: number;
  replans: number;
  durationMs: number;
  error: string | null;
  /** Full execution trace: action, expected, actual for every step */
  executionLog: string[];
}

export interface StepResult {
  step: PlanStep;
  success: boolean;
  durationMs: number;
  postconditionMet: boolean;
  error: string | null;
  usedFallback: boolean;
}

export interface PlannerConfig {
  defaultMaxAttempts: number;
  defaultStepTimeout: number;
  postconditionWaitMs: number;
  minConfidenceForExecution: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  defaultMaxAttempts: 3,
  defaultStepTimeout: 10_000,
  postconditionWaitMs: 2_000,
  minConfidenceForExecution: 0.3,
};

/** Returned when plan execution pauses at a step that requires LLM interpretation. */
export interface ExecutionPause {
  paused: true;
  reason: "requires_llm";
  stepIndex: number;
  stepDescription: string;
  subgoalIndex: number;
  completedSteps: number;
  totalSteps: number;
}
