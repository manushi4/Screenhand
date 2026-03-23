// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/** Source of ingested knowledge. */
export type KnowledgeSourceType =
  | "menu_scan"
  | "documentation"
  | "shortcut_list"
  | "tutorial"
  | "expert_recording"
  | "community";

export interface KnowledgeSource {
  type: KnowledgeSourceType;
  url?: string;
  filePath?: string;
  bundleId?: string;
  platform?: string;
  ingestedAt: string;
  itemCount: number;
}

/** A single item extracted from a knowledge source. */
export interface IngestedItem {
  type: "shortcut" | "menu_path" | "selector" | "flow" | "error" | "tip";
  key: string;
  value: string;
  context?: string;
  confidence: number;
  source: KnowledgeSourceType;
}

/** A menu item extracted from AX tree scanning. */
export interface MenuItem {
  path: string[];
  title: string;
  shortcut: string | null;
  enabled: boolean;
  hasSubmenu: boolean;
}

/** Result of a menu bar scan. */
export interface MenuScanResult {
  bundleId: string;
  appName: string;
  totalMenus: number;
  totalItems: number;
  shortcuts: Record<string, string>;
  menuTree: MenuNode[];
  scannedAt: string;
}

export interface MenuNode {
  title: string;
  shortcut: string | null;
  enabled: boolean;
  children: MenuNode[];
}

/** Parsed shortcut from documentation. */
export interface ParsedShortcut {
  name: string;
  keys: string;
  context?: string | undefined;
  category?: string | undefined;
}

/** Parsed workflow step from documentation or tutorial. */
export interface ParsedFlowStep {
  description: string;
  tool?: string | undefined;
  params?: Record<string, unknown> | undefined;
  postcondition?: string | undefined;
}

/** Result of parsing documentation. */
export interface DocParseResult {
  url: string;
  title: string;
  shortcuts: ParsedShortcut[];
  flows: Array<{ name: string; steps: ParsedFlowStep[] }>;
  tips: string[];
  parsedAt: string;
}

/** Coverage report for an app. */
export interface CoverageReport {
  app: string;
  bundleId: string;

  // What we know
  shortcutsKnown: number;
  selectorsKnown: number;
  flowsKnown: number;
  playbooksAvailable: number;
  errorsDocumented: number;

  // What we know (website)
  websiteFeaturesKnown: number;

  // What we're missing
  menuPathsNotCovered: string[];
  shortcutsNotInReference: string[];
  workflowsWithNoPlaybook: string[];

  // Quality
  selectorStabilityScore: number;
  playbookSuccessRate: number;
  averageRecoveryTime: number;

  // Recommendations
  highValueGaps: string[];

  generatedAt: string;
}

// ── Website Feature Discovery ──────────────────────────────────────

/** A feature extracted from an app's official website. */
export interface WebsiteFeature {
  id: string;
  name: string;
  description: string;
  /** Source heading or section on the website */
  sourceHeading: string;
  /** Inferred difficulty tier */
  level: "beginner" | "pro" | "expert" | "grandmaster";
}

/** A value-add feature that ScreenHand uniquely provides for an app. */
export interface ValueAddFeature {
  id: string;
  name: string;
  description: string;
  /** Category of value-add */
  category: "bulk" | "cross_app" | "intelligence" | "organization" | "monitoring";
  level: "pro" | "expert" | "grandmaster";
}

/** Result of website feature extraction. */
export interface FeatureExtractionResult {
  appName: string;
  url: string;
  websiteFeatures: WebsiteFeature[];
  valueAddFeatures: ValueAddFeature[];
  extractedAt: string;
}
