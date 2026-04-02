// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// ── Relative Positioning ────────────────────────────────────────────

/** All position values are 0.0-1.0 (percentage of window dimensions). */
export interface RelativePosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

// ── Map Elements ────────────────────────────────────────────────────

export interface MapElement {
  label: string;
  /** 0.0-1.0 from left edge of window */
  relativeX: number;
  /** 0.0-1.0 from top edge of window */
  relativeY: number;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  /** OCR text fallback if relative position misses */
  ocrBackup: string;
  successCount: number;
  failCount: number;
  lastInteracted: string;
  /** Incremented each session the app is used; reset to 0 on interaction */
  sessionsSinceUse: number;
  /** How this element's label was discovered */
  labelSource?: "ax" | "ocr" | "llm" | "manual";
  /** LLM-assigned confidence in this element's position/label (0-1) */
  visualConfidence?: number;
  /** Times live AX confirmed this element's position */
  validationCount?: number;
  /** Times live AX contradicted this element's position */
  mismatchCount?: number;
}

// ── Hierarchy ─────────────────────────────────────────────────────────

/** Hierarchical containment: parent → children relationships discovered during tool usage */
export interface ElementHierarchy {
  /** Element label acting as parent container */
  parentLabel: string;
  /** Zone where parent lives */
  parentZone: string;
  /** Child element labels contained within parent */
  children: string[];
  /** How containment was discovered */
  source: "ax_tree" | "dom" | "ocr_spatial" | "manual";
  lastSeen: string;
}

// ── Input/Output Contracts ────────────────────────────────────────────

/** An observed outcome from interacting with an element */
export interface ContractOutcome {
  /** Description of what changed */
  description: string;
  /** Was this outcome consistently observed? (true when seenCount >= 3) */
  reliable: boolean;
  /** Times this specific outcome was seen */
  seenCount: number;
}

/** What an element does when interacted with */
export interface ElementContract {
  /** The element this contract describes */
  elementLabel: string;
  /** Action performed (click, type, key, etc.) */
  action: string;
  /** What must be true before this action works */
  preconditions: string[];
  /** What happens after the action (observed outcomes) */
  outcomes: ContractOutcome[];
  /** How to undo this action (if known) */
  undoPath?: string;
  /** Number of times this contract was validated */
  validationCount: number;
  lastValidated: string;
}

// ── Zones ───────────────────────────────────────────────────────────

export type ZoneType =
  | "toolbar"
  | "sidebar"
  | "canvas"
  | "canvas-zoomable"
  | "panel"
  | "dialog"
  | "menu"
  | "nested-menu"
  | "status-bar"
  | "palette"
  | "tab-bar"
  | "other";

export interface MapZone {
  relativePosition: RelativePosition;
  type: ZoneType;
  /** How this zone is triggered (e.g., "right-click" for context menus) */
  trigger?: string;
  elements: MapElement[];
  /** Parent/child containment relationships within this zone */
  hierarchy?: ElementHierarchy[];
  /** Input/output contracts: what elements DO when interacted with */
  contracts?: ElementContract[];
  verified: boolean;
  lastSeen: string;
}

// ── Navigation Graph ────────────────────────────────────────────────

export interface NavNode {
  type: "window" | "panel" | "dialog" | "palette" | "tab" | "menu";
  description: string;
}

export interface NavEdge {
  from: string;
  action: string;
  to: string;
  verified: boolean;
  successCount: number;
  failCount: number;
  lastUsed: string;
  /** Wire #11: Bayesian reliability score from TopologyPolicy (L5), if available */
  topologyScore?: number;
}

// ── UI Architecture ─────────────────────────────────────────────────

export interface UIArchitecture {
  type: "MDI" | "SDI" | "tab-based" | "canvas-centric" | "web-hybrid" | "other";
  rendering: "native" | "custom-paint" | "web-view" | "hybrid";
  axSupport: "full" | "partial" | "minimal" | "none";
  bestMethod: string;
  menuStyle: "standard" | "floating-palette" | "ribbon" | "hamburger";
  dragDropHeavy: boolean;
  hasCanvas: boolean;
  canvasType?: string;
}

// ── Feature Ladder (Gated Weighted Mastery) ────────────────────────

export interface FeatureDefinition {
  id: string;
  description: string;
  /** Feature difficulty tier — maps to rating grades */
  level: FeatureTier;
  /** 1=basic consumer, 2=operational, 3=system-critical/admin */
  weight: 1 | 2 | 3;
  /** Must meet minimum depth for higher tiers */
  critical: boolean;
}

/** Feature difficulty tiers — maps to rating grades (F=entry, B=proficient, S=expert, SSS=grandmaster) */
export type FeatureTier = "F" | "B" | "S" | "SSS";

/** Per-feature mastery tracking — depth, not checkboxes */
export interface FeatureMastery {
  /** 0=never, 1=navigated, 2=basic action, 3=multi-step workflow, 4=verified outcome */
  depth: 0 | 1 | 2 | 3 | 4;
  /** 0-1 based on evidence strength: repeats, verification, recency */
  confidence: number;
  /** Number of successful interactions at current depth */
  repeatCount: number;
  /** Successful multi-step sequences completed */
  workflowCount: number;
  /** Recovery from failure at this feature */
  healingCount: number;
  /** Total failures encountered */
  failCount: number;
  lastSeen: string;
  lastVerified: string | null;
}

// ── Rating System (F → 0) ──────────────────────────────────────────
//
// Game-style rating: F E D C B A S SS SSS 0
// Each grade has 3 sub-tiers: e.g. B1 (entry), B2 (mid), B3 (top)
// Graded by 10 weighted factors scored 0-100
//
// Years-equivalent mapping:
//   F   = just opened the app
//   E   = ~1 week user
//   D   = ~1-3 months
//   C   = ~6-12 months
//   B   = ~1-3 years (consistent daily user)
//   A   = ~3-5 years (power user / team lead)
//   S   = ~5-10 years (department architect)
//   SS  = ~10-20 years (platform expert, builds systems)
//   SSS = ~20+ years (framework builder, trains others)
//   0   = Class Zero — transcendent mastery, all 10 factors maxed

/** Rating grades from lowest to highest */
export const RATING_GRADES = ["F", "E", "D", "C", "B", "A", "S", "SS", "SSS", "0"] as const;
export type RatingGrade = typeof RATING_GRADES[number];

/** Sub-tier within a grade: 1=entry, 2=mid, 3=top */
export type RatingSubTier = 1 | 2 | 3;

/** Full rating display: e.g. "B2", "S3", "SSS1" */
export interface Rating {
  grade: RatingGrade;
  subTier: RatingSubTier;
}

/**
 * 10 factors that determine rating. Each scored 0-100.
 * ALL session-gated: you cannot max any factor in a few sessions.
 *
 * Hard-to-fake factors (57% weight) — these separate real users from automation:
 *   1. Consistency (20)        — many sessions over time, sustained reliability
 *   2. Platform Knowledge (15) — shortcuts, hidden features, undocumented behaviors
 *   3. Edge Case Handling (12) — dialogs, permissions, network errors, unexpected states
 *   4. Teaching Ability (10)   — playbooks/references generated that others can use
 *
 * Evidence-based factors (43% weight) — session-gated to prevent inflation:
 *   5. Feature Coverage (10)     — % of app features completed × session maturity
 *   6. Workflow Depth (8)        — multi-step tasks completed × session maturity
 *   7. Outcome Verification (8)  — verified results × session maturity
 *   8. Error Recovery (7)        — failed, diagnosed, fixed without help
 *   9. Cross-Feature Chains (5)  — workflows combining 3+ features
 *  10. Repeat Mastery (5)        — features used deeply across multiple sessions
 */
export interface RatingFactors {
  /** % of features at depth >= 2, session-gated (need 20+ sessions to max) */
  featureCoverage: number;
  /** % of features at depth >= 3, session-gated */
  workflowDepth: number;
  /** % of features at depth = 4, session-gated */
  outcomeVerification: number;
  /** Recovery rate: healings / failures (0 if untested) */
  errorRecovery: number;
  /** Repeat mastery: features used 10+ times, session-gated */
  speedEfficiency: number;
  /** Cross-feature workflow count, normalized (need 50+ to max) */
  crossFeatureChains: number;
  /** Edge cases handled: dialog dismissals, error recovery, unexpected states (need 50+) */
  edgeCaseHandling: number;
  /** Playbooks exported + reference contributions (need 10+ to max) */
  teachingAbility: number;
  /** Shortcuts used + hidden features discovered (need 50+ to max) */
  platformKnowledge: number;
  /** Sessions over time × sustained reliability (need 50+ sessions to max) */
  consistency: number;
}

/** Factor weights — hard-to-fake signals dominate (57%), session-gated evidence (43%) */
export const RATING_FACTOR_WEIGHTS: Record<keyof RatingFactors, number> = {
  consistency: 20,         // THE core signal — can't fake showing up 50+ times
  platformKnowledge: 15,   // shortcuts, deep features — proves real knowledge
  edgeCaseHandling: 12,    // surviving unexpected states — proves resilience
  teachingAbility: 10,     // exporting playbooks — proves codifiable mastery
  featureCoverage: 10,     // breadth of features used (session-gated)
  workflowDepth: 8,        // multi-step workflows completed (session-gated)
  outcomeVerification: 8,  // verified outcomes (session-gated)
  errorRecovery: 7,        // healing from failures — honest if it happens
  crossFeatureChains: 5,   // combining features end-to-end
  speedEfficiency: 5,      // repeat mastery across sessions
};

/** Aggregate metrics for rating computation */
export interface MasteryMetrics {
  /** Weighted % of features at depth >= 2 */
  breadth: number;
  /** Weighted % of features at depth >= 3 */
  workflowBreadth: number;
  /** Weighted % of features at depth = 4 */
  outcomeBreadth: number;
  /** Overall pass rate across all features */
  reliability: number;
  /** Recovery success rate after failures */
  healingRate: number;
  /** End-to-end tasks spanning multiple features */
  crossFeatureWorkflows: number;
  /** Minimum depth across critical features */
  criticalFloor: number;
  /** Weighted score: sum of (depth/4 * weight * confidence) */
  weightedScore: number;
}

// ── State Machine ───────────────────────────────────────────────────

/** A named UI state dimension (e.g., sidebar_state, theme_mode) */
export interface StateDimension {
  /** Unique key: e.g., "sidebar_state", "view_mode", "modal_state" */
  key: string;
  /** Possible values: e.g., ["expanded", "collapsed"] */
  possibleValues: string[];
  /** Currently known value (last observed) */
  currentValue: string;
  lastObserved: string;
}

/** A state transition: action causes state change */
export interface StateTransition {
  /** Which state dimension changed */
  dimensionKey: string;
  /** From value */
  fromValue: string;
  /** To value */
  toValue: string;
  /** What triggered the change */
  trigger: string;
  /** How many times this transition was observed */
  observedCount: number;
  /** Is this transition reversible? If so, what are the reverse triggers? */
  reverseTrigger?: string[];
  lastSeen: string;
}
// ── Legacy Mastery (kept for migration) ─────────────────────────────

/** @deprecated Use RatingGrade. Kept for backward compatibility in persisted data. */
export type MasteryLevel = "beginner" | "pro" | "expert" | "grandmaster";

export interface MasteryHistoryEntry {
  date: string;
  level: MasteryLevel;
  rating?: Rating;
  confidence: number;
  zonesKnown: number;
  edgesVerified: number;
}

// ── Conditional UI Tracking ──────────────────────────────────────

/** Tracks when/where an element appears or disappears across observations. */
export interface VisibilityCondition {
  /** The element this condition applies to */
  elementLabel: string;
  /** Type of condition: page-specific, state-dependent, session-specific, or unknown */
  conditionType: "page" | "state" | "session" | "unknown";
  /** Human-readable description of when element appears */
  description: string;
  /** Pages where element was observed (if page-conditional) */
  seenOnPages: string[];
  /** Pages where element was NOT observed (if page-conditional) */
  absentOnPages: string[];
  /** Total times element was seen */
  seenCount: number;
  /** Total observation opportunities (times we checked) */
  checkCount: number;
  /** Visibility rate: seenCount / checkCount */
  visibilityRate: number;
  /** ISO timestamp of most recent observation */
  lastSeen: string;
  /** ISO timestamp of first observation */
  firstSeen: string;
}

// ── Timing & Animation ──────────────────────────────────────────────

/** Per-element or per-action timing statistics */
export interface TimingProfile {
  /** What was timed (element label, page transition, action) */
  key: string;
  /** Type of timing measurement */
  type: "element_response" | "page_load" | "animation" | "data_fetch";
  /** Average response time in ms */
  avgMs: number;
  /** Minimum observed ms */
  minMs: number;
  /** Maximum observed ms */
  maxMs: number;
  /** Number of measurements */
  sampleCount: number;
  /** Last measured value in ms */
  lastMs: number;
  lastMeasured: string;
}

/** Ready-state signal: how to know when UI is ready after an action */
export interface ReadySignal {
  /** What action triggers the wait */
  afterAction: string;
  /** How we know it's ready */
  signal: string;
  /** Typical wait time in ms */
  typicalMs: number;
  /** Max observed wait time in ms */
  maxObservedMs: number;
  sampleCount: number;
  lastSeen: string;
}

// ── App Map Data ────────────────────────────────────────────────────

export interface AppMapData {
  app: string;
  appName: string;
  version: string;
  /** @deprecated Use rating. Kept for migration. */
  masteryLevel: MasteryLevel;
  /** Game-style rating: F-0 with sub-tiers */
  rating: Rating;
  /** Per-factor scores (0-100 each) */
  ratingFactors: RatingFactors;
  confidence: number;
  lastValidated: string;
  /** Set by recomputeTier/refreshMastery — NOT by perception validation */
  lastRecomputed?: string;
  mapVersion: number;
  uiArchitecture: UIArchitecture;
  zones: Record<string, MapZone>;
  navigationGraph: {
    nodes: Record<string, NavNode>;
    edges: NavEdge[];
  };
  masteryHistory: MasteryHistoryEntry[];
  totalTasksCompleted: number;
  sessionCount: number;
  /** Per-app feature ladder */
  featureLadder: FeatureDefinition[];
  /** Per-feature depth tracking */
  featureMastery: Record<string, FeatureMastery>;
  /** @deprecated Use featureMastery. Kept for migration from old format. */
  completedFeatures?: string[];
  /** Computed aggregate metrics */
  masteryMetrics: MasteryMetrics;
  /** End-to-end workflows spanning multiple features */
  crossFeatureWorkflows: number;
  /** Action tool outcomes */
  actionSuccessCount: number;
  actionFailCount: number;
  /** Shortcuts used (tracked for platform knowledge factor) */
  shortcutsUsed?: number;
  /** Playbooks exported (tracked for teaching ability factor) */
  playbooksExported?: number;
  /** Edge cases handled (dialogs dismissed, unexpected states recovered) */
  edgeCasesHandled?: number;
  /** Known UI state dimensions (e.g., sidebar expanded/collapsed) */
  stateDimensions?: StateDimension[];
  /** Observed state transitions (action triggers state change) */
  stateTransitions?: StateTransition[];
  /** Tracked element visibility patterns for conditional UI detection */
  visibilityConditions?: VisibilityCondition[];
  /** Per-element/action timing data */
  timingProfiles?: TimingProfile[];
  /** Ready-state detection signals */
  readySignals?: ReadySignal[];
  /** Visual mapping metadata (Phase 3) */
  visualMeta?: VisualMeta;
}

// ── Visual Mapping (Phase 3) ────────────────────────────────────────

/** Metadata from a visual scan (screenshot + OCR/LLM labeling) */
export interface VisualMeta {
  /** When the visual scan was last performed */
  lastScannedAt: string;
  /** App CFBundleShortVersionString at scan time (for staleness detection) */
  appVersion: string;
  /** Display scale factor at capture time (for coordinate normalization) */
  scaleFactor: number;
  /** Window dimensions at capture time */
  captureSize: { w: number; h: number };
  /** SHA-256 of the screenshot used (for change detection) */
  screenshotHash: string;
  /** Window titles of screens that were mapped */
  screensMapped: string[];
  /** Overall map confidence (0-1) */
  confidence: number;
}

/** Result of a visual quick-scan (OCR-based, no LLM needed) */
export interface VisualScanResult {
  zones: Array<{ label: string; type: ZoneType; bounds: RelativePosition }>;
  elements: Array<{
    label: string;
    role: string;
    x: number;
    y: number;
    zone: string;
    purpose?: string;
    confidence: number;
  }>;
  confidence: number;
}

/** Result of LLM enrichment (semantic labels, purposes, navigation hints) */
export interface LLMEnrichmentResult {
  zones: Array<{
    label: string;
    type: ZoneType;
    bounds: RelativePosition;
    purpose: string;
  }>;
  elements: Array<{
    label: string;
    role: string;
    x: number;
    y: number;
    zone: string;
    purpose: string;
    confidence: number;
  }>;
  screenDescription: string;
  confidence: number;
}

// ── Config ──────────────────────────────────────────────────────────

export interface AppMapConfig {
  mapsDir: string;
  /** Optional directory with seed app maps shipped via npm (read-only fallback) */
  seedDir?: string;
  staleThresholdDays: number;
  versionDecayFactor: number;
  pruneSessionThreshold: number;
  maxZonesPerApp: number;
  maxElementsPerZone: number;
  maxEdges: number;
  maxHistoryEntries: number;
  maxHierarchyEntriesPerZone: number;
  maxContractsPerZone: number;
  maxOutcomesPerContract: number;
  maxStateDimensions: number;
  maxStateTransitions: number;
  maxVisibilityConditions: number;
  maxTimingProfiles: number;
  maxReadySignals: number;
}

export const DEFAULT_APP_MAP_CONFIG: AppMapConfig = {
  mapsDir: "",
  staleThresholdDays: 7,
  versionDecayFactor: 0.5,
  pruneSessionThreshold: 10,
  maxZonesPerApp: 50,
  maxElementsPerZone: 100,
  maxEdges: 200,
  maxHistoryEntries: 100,
  maxHierarchyEntriesPerZone: 50,
  maxContractsPerZone: 30,
  maxOutcomesPerContract: 5,
  maxStateDimensions: 30,
  maxStateTransitions: 100,
  maxVisibilityConditions: 200,
  maxTimingProfiles: 100,
  maxReadySignals: 50,
};

// ── Rating Utility ──────────────────────────────────────────────────

/** Convert Rating to display string: "B2", "SS3", "0" */
export function ratingToString(r: Rating): string {
  if (r.grade === "0") return "0"; // Class Zero has no sub-tier display
  return `${r.grade}${r.subTier}`;
}

/** Grade thresholds: weighted score needed for each grade (0-100 scale) */
export const GRADE_THRESHOLDS: { grade: RatingGrade; minScore: number }[] = [
  { grade: "0",   minScore: 97 },  // Class Zero — near-perfect across all factors
  { grade: "SSS", minScore: 90 },  // 20+ years equivalent
  { grade: "SS",  minScore: 82 },  // 10-20 years
  { grade: "S",   minScore: 73 },  // 5-10 years
  { grade: "A",   minScore: 62 },  // 3-5 years
  { grade: "B",   minScore: 50 },  // 1-3 years
  { grade: "C",   minScore: 38 },  // 6-12 months
  { grade: "D",   minScore: 25 },  // 1-3 months
  { grade: "E",   minScore: 12 },  // ~1 week
  { grade: "F",   minScore: 0 },   // just opened the app
];
