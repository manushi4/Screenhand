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

export type BlockerType =
  | "unexpected_dialog"
  | "permission_dialog"
  | "login_required"
  | "captcha"
  | "rate_limited"
  | "app_crashed"
  | "focus_lost"
  | "element_gone"
  | "selector_drift"
  | "network_error"
  | "loading_stuck"
  | "unknown_state";

export interface Blocker {
  type: BlockerType;
  description: string;
  bundleId: string | null;
  pid?: number;
  dialogTitle?: string;
}

export interface RecoveryStrategy {
  id: string;
  blockerType: BlockerType;
  label: string;
  steps: RecoveryStep[];
  postcondition: StateAssertion | null;
  source: "builtin" | "reference" | "memory";
}

export interface RecoveryStep {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

export interface RecoveryBudget {
  maxRecoveryTimeMs: number;
  maxStrategies: number;
  usedStrategyIds: Set<string>;
}

export const DEFAULT_RECOVERY_BUDGET: Omit<RecoveryBudget, "usedStrategyIds"> = {
  maxRecoveryTimeMs: 30_000,
  maxStrategies: 3,
};

export type RecoveryOutcome =
  | { recovered: true; strategyId: string; durationMs: number }
  | { recovered: false; reason: "budget_exhausted" | "no_strategy" | "all_strategies_failed" };

export interface RecoveryEvent {
  timestamp: string;
  blocker: Blocker;
  strategyId: string;
  strategyLabel: string;
  success: boolean;
  durationMs: number;
  error: string | null;
}
