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
  lastUsed: string;
  tags: string[];
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
