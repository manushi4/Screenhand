/**
 * Playbook types — executable automation recipes
 */

export interface PlaybookStep {
  /** Action to perform */
  action: "navigate" | "press" | "type_into" | "extract" | "key_combo" | "scroll" | "wait" | "screenshot";
  /** Target — CSS selector, text, or {x,y} */
  target?: string | { selector: string } | { x: number; y: number };
  /** Text to type (for type_into) */
  text?: string;
  /** URL to navigate to (for navigate) */
  url?: string;
  /** Keys for key_combo */
  keys?: string[];
  /** Wait ms */
  ms?: number;
  /** Scroll direction */
  direction?: "up" | "down";
  /** Amount to scroll */
  amount?: number;
  /** Human-readable description of this step */
  description?: string;
  /** CSS selector or JS expression to verify step succeeded */
  verify?: string;
  /** Max time to wait for verify condition (default: 5000ms) */
  verifyTimeoutMs?: number;
  /** Extract format */
  format?: "text" | "json" | "table";
  /** If true, failure of this step is non-fatal — continue to next */
  optional?: boolean;
}

/** Known error pattern with solution — learned from real failures */
export interface PlaybookError {
  error: string;
  context: string;
  solution: string;
  severity: "high" | "medium" | "low";
}

/** Named flow — a sequence of human-readable steps + guards */
export interface PlaybookFlow {
  steps: string[];
  guards?: string[];
  why?: string;
  verification_text_patterns?: string[];
}

export interface Playbook {
  /** Unique playbook identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this playbook does */
  description: string;
  /** Platform/site this targets */
  platform: string;
  /** URL patterns where this playbook applies */
  urlPatterns?: string[];
  /** Detection expressions — JS that returns boolean to check if we're in the right state */
  preconditions?: string[];
  /** Ordered steps to execute */
  steps: PlaybookStep[];
  /** Version for tracking updates */
  version: string;
  /** Tags for matching */
  tags: string[];
  /** Success count */
  successCount: number;
  /** Fail count */
  failCount: number;
  /** Last time this playbook ran */
  lastRun?: string;

  // ── Rich metadata (from battle-tested playbooks like x_v1) ──

  /** Named URLs for the platform */
  urls?: Record<string, string>;
  /** Stable CSS selectors grouped by feature area */
  selectors?: Record<string, Record<string, string>>;
  /** Named automation flows with human-readable steps + guards */
  flows?: Record<string, PlaybookFlow>;
  /** JS detection expressions for state checking */
  detection?: Record<string, string>;
  /** Known errors and their solutions */
  errors?: PlaybookError[];
  /** Safety and policy notes */
  policyNotes?: Record<string, string[]>;
}

export interface PlaybookRunResult {
  playbook: string;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  /** Step index where it failed, or -1 if success */
  failedAtStep: number;
  /** Error message if failed */
  error?: string;
  /** What AI decided when playbook couldn't handle it */
  aiRecovery?: string;
  durationMs: number;
}
