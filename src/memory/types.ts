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
 * Learning Memory — Data types
 */

export interface ActionEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  result: string | null;
  error: string | null;
}

export interface StrategyStep {
  tool: string;
  params: Record<string, unknown>;
}

export interface Strategy {
  id: string;
  task: string;
  steps: StrategyStep[];
  totalDurationMs: number;
  successCount: number;
  failCount: number;
  lastUsed: string;
  tags: string[];
  /** Tool sequence fingerprint for O(1) exact lookup */
  fingerprint: string;
}

export interface ErrorPattern {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  error: string;
  resolution: string | null;
  occurrences: number;
  lastSeen: string;
}

export interface MemoryStats {
  totalActions: number;
  totalStrategies: number;
  totalErrors: number;
  diskUsageBytes: number;
  topTools: Array<{ tool: string; count: number }>;
  successRate: number;
}
