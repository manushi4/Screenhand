import type { ActionBudget } from "./types.js";

export const DEFAULT_ACTION_BUDGET: ActionBudget = {
  locateMs: 800,
  actMs: 200,
  verifyMs: 2000,
  maxRetries: 1,
};

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 2_000;
export const DEFAULT_PROFILE = "automation";

