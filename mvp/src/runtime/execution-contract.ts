/**
 * Canonical execution contract for ScreenHand.
 *
 * Defines the fallback chain of execution methods, the result contract
 * every action must satisfy, execution planning, retry policy, and the
 * fallback runner that ties them together.
 */

// ── 1. Fallback Chain ──────────────────────────────────────────────────

/** Ordered list of execution methods, from fastest/most reliable to slowest/least reliable */
const EXECUTION_METHODS = ["ax", "cdp", "ocr", "coordinates"] as const;
type ExecutionMethod = (typeof EXECUTION_METHODS)[number];

/** What each method is best for */
interface MethodCapability {
  method: ExecutionMethod;
  canClick: boolean;
  canType: boolean;
  canRead: boolean;
  canLocate: boolean;
  canSelect: boolean;
  canScroll: boolean;
  avgLatencyMs: number;
  requiresBridge: boolean;
  requiresCDP: boolean;
}

const METHOD_CAPABILITIES: Record<ExecutionMethod, MethodCapability> = {
  ax: {
    method: "ax",
    canClick: true,
    canType: true,
    canRead: true,
    canLocate: true,
    canSelect: true,
    canScroll: true,
    avgLatencyMs: 50,
    requiresBridge: true,
    requiresCDP: false,
  },
  cdp: {
    method: "cdp",
    canClick: true,
    canType: true,
    canRead: true,
    canLocate: true,
    canSelect: true,
    canScroll: true,
    avgLatencyMs: 10,
    requiresBridge: false,
    requiresCDP: true,
  },
  ocr: {
    method: "ocr",
    canClick: false,
    canType: false,
    canRead: true,
    canLocate: true,
    canSelect: false,
    canScroll: false,
    avgLatencyMs: 600,
    requiresBridge: true,
    requiresCDP: false,
  },
  coordinates: {
    method: "coordinates",
    canClick: true,
    canType: false,
    canRead: false,
    canLocate: false,
    canSelect: false,
    canScroll: true,
    avgLatencyMs: 50,
    requiresBridge: true,
    requiresCDP: false,
  },
};

// ── 2. Action Result Contract ──────────────────────────────────────────

/** Every action must return this */
interface ActionResult {
  ok: boolean;
  method: ExecutionMethod;
  durationMs: number;
  /** If method fell through from a higher-priority one */
  fallbackFrom: ExecutionMethod | null;
  /** Number of retries within this method */
  retries: number;
  error: string | null;
  /** What was found/acted on */
  target: string | null;
}

// ── 3. Execution Plan ──────────────────────────────────────────────────

/** Action capability key used to filter methods */
type ActionType = "click" | "type" | "read" | "locate" | "select" | "scroll";

const ACTION_TO_CAPABILITY: Record<ActionType, keyof MethodCapability> = {
  click: "canClick",
  type: "canType",
  read: "canRead",
  locate: "canLocate",
  select: "canSelect",
  scroll: "canScroll",
};

/**
 * Given an action type and available capabilities, returns the ordered
 * list of methods to try.
 *
 * Filters EXECUTION_METHODS to only those that:
 *   1. Support the requested action
 *   2. Have their infrastructure requirements met
 * Returns in canonical order (ax -> cdp -> ocr -> coordinates).
 */
function planExecution(
  action: ActionType,
  available: { hasBridge: boolean; hasCDP: boolean },
): ExecutionMethod[] {
  const capKey = ACTION_TO_CAPABILITY[action];

  return EXECUTION_METHODS.filter((method) => {
    const cap = METHOD_CAPABILITIES[method];

    // Must support the requested action
    if (!cap[capKey]) return false;

    // Must have required infrastructure
    if (cap.requiresBridge && !available.hasBridge) return false;
    if (cap.requiresCDP && !available.hasCDP) return false;

    return true;
  }) as ExecutionMethod[];
}

// ── 4. Retry Policy ────────────────────────────────────────────────────

interface RetryPolicy {
  maxRetriesPerMethod: number;
  maxTotalRetries: number;
  delayBetweenRetriesMs: number;
  /** Escalate to supervisor after this many total retries */
  escalateAfter: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetriesPerMethod: 2,
  maxTotalRetries: 5,
  delayBetweenRetriesMs: 500,
  escalateAfter: 3,
};

// ── 5. Execution Runner ────────────────────────────────────────────────

/**
 * Returns a promise that resolves after the given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs an action through the fallback chain.
 * Tries each method in order, with retries per method.
 * Returns the result from whichever method succeeded (or the last failure).
 */
async function executeWithFallback(
  action: string,
  plan: ExecutionMethod[],
  policy: RetryPolicy,
  executor: (method: ExecutionMethod, attempt: number) => Promise<ActionResult>,
): Promise<ActionResult> {
  let totalRetries = 0;
  let lastResult: ActionResult | null = null;
  let previousMethod: ExecutionMethod | null = null;

  for (const method of plan) {
    for (let attempt = 0; attempt <= policy.maxRetriesPerMethod; attempt++) {
      if (totalRetries >= policy.maxTotalRetries) {
        // Exhausted total retry budget — return whatever we have
        return lastResult!;
      }

      // Delay between retries (not before the very first attempt)
      if (totalRetries > 0) {
        await delay(policy.delayBetweenRetriesMs);
      }

      const result = await executor(method, attempt);

      // Stamp fallbackFrom if we fell through from a higher-priority method
      if (previousMethod !== null && result.fallbackFrom === null) {
        result.fallbackFrom = previousMethod;
      }

      lastResult = result;

      if (result.ok) {
        return result;
      }

      totalRetries++;
    }

    // This method is exhausted — record it so the next method knows
    previousMethod = method;
  }

  // All methods exhausted
  return lastResult!;
}

// ── Exports ────────────────────────────────────────────────────────────

export {
  EXECUTION_METHODS,
  METHOD_CAPABILITIES,
  DEFAULT_RETRY_POLICY,
  planExecution,
  executeWithFallback,
};

export type {
  ExecutionMethod,
  MethodCapability,
  ActionResult,
  ActionType,
  RetryPolicy,
};
