// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import type { CoverageReport, MenuScanResult } from "./types.js";
import type { LearningEngine } from "../learning/engine.js";
import type { GoalStore } from "../planner/goal-store.js";

interface ReferenceFile {
  id: string;
  platform: string;
  bundleId?: string;
  shortcuts?: Record<string, Record<string, string>>;
  selectors?: Record<string, Record<string, string>>;
  flows?: Record<string, { steps: string[]; description?: string }>;
  errors?: Array<{ error: string; solution: string }>;
}

interface PlaybookFile {
  id: string;
  platform?: string;
  bundleId?: string;
  name: string;
  steps: unknown[];
}

/**
 * CoverageAuditor — answers "How well do we know this app?"
 *
 * Compares reference files, playbooks, menu scans, and learning data
 * to identify gaps and generate recommendations.
 */
/**
 * Normalize a menu path shortcut name by extracting the last segment.
 * "Edit > Undo" → "undo", "File.Save" → "save"
 */
function normalizeShortcutName(name: string): string {
  const parts = name.split(/[.>]/);
  return (parts[parts.length - 1] ?? name).trim().toLowerCase();
}

/**
 * Strip parenthetical descriptions from key combos.
 * "Cmd+N (desktop app)" → "cmd+n"
 */
function normalizeKeyCombo(keys: string): string {
  return keys.replace(/\s*\([^)]*\)\s*/g, "").trim().toLowerCase();
}

export class CoverageAuditor {
  constructor(
    private readonly referencesDir: string,
    private readonly playbooksDir: string,
    private readonly learningEngine?: LearningEngine,
    private readonly goalStore?: GoalStore,
  ) {}

  /**
   * Generate a full coverage report for an app.
   */
  audit(bundleId: string, appName: string, menuScan?: MenuScanResult): CoverageReport {
    const refs = this.loadReferences(bundleId);
    const playbooks = this.loadPlaybooks(bundleId, appName);

    // Count what we know
    let shortcutsKnown = 0;
    let selectorsKnown = 0;
    let flowsKnown = 0;
    let errorsDocumented = 0;

    for (const ref of refs) {
      if (ref.shortcuts) {
        for (const category of Object.values(ref.shortcuts)) {
          shortcutsKnown += Object.keys(category).length;
        }
      }
      if (ref.selectors) {
        for (const group of Object.values(ref.selectors)) {
          selectorsKnown += Object.keys(group).length;
        }
      }
      if (ref.flows) {
        flowsKnown += Object.keys(ref.flows).length;
      }
      if (ref.errors) {
        errorsDocumented += ref.errors.length;
      }
    }

    // Count website features
    let websiteFeaturesKnown = 0;
    for (const ref of refs) {
      const wf = (ref as unknown as Record<string, unknown>).websiteFeatures;
      if (Array.isArray(wf)) websiteFeaturesKnown += wf.length;
    }

    // Compare menu scan against reference shortcuts
    const menuPathsNotCovered: string[] = [];
    const shortcutsNotInReference: string[] = [];

    if (menuScan) {
      // Build a map keyed by normalized name → normalized keys for comparison
      const refShortcuts = new Map<string, string>();
      for (const ref of refs) {
        if (ref.shortcuts) {
          for (const category of Object.values(ref.shortcuts)) {
            for (const [name, keys] of Object.entries(category)) {
              refShortcuts.set(name.toLowerCase(), normalizeKeyCombo(keys));
            }
          }
        }
      }

      for (const [menuPath, keys] of Object.entries(menuScan.shortcuts)) {
        const normalizedName = normalizeShortcutName(menuPath);
        const normalizedKeys = normalizeKeyCombo(keys);
        const refKeys = refShortcuts.get(normalizedName);
        if (refKeys !== normalizedKeys) {
          shortcutsNotInReference.push(`${menuPath}: ${keys}`);
        }
      }

      // Find menu paths not covered at all
      const flatPaths = this.flattenMenuPaths(menuScan.menuTree);
      for (const p of flatPaths) {
        const covered = refs.some((ref) => {
          if (!ref.flows) return false;
          return Object.values(ref.flows).some((f) =>
            f.steps.some((s) => s.toLowerCase().includes(p.toLowerCase())),
          );
        });
        if (!covered) {
          menuPathsNotCovered.push(p);
        }
      }
    }

    // Identify common workflows without playbooks
    const COMMON_WORKFLOWS = [
      "export", "import", "save as", "new project", "undo",
      "preferences", "settings", "print", "share",
    ];
    const workflowsWithNoPlaybook = COMMON_WORKFLOWS.filter((w) => {
      const hasPlaybook = playbooks.some(
        (p) => p.name.toLowerCase().includes(w),
      );
      const hasFlow = refs.some(
        (r) => r.flows && Object.keys(r.flows).some((k) => k.includes(w)),
      );
      return !hasPlaybook && !hasFlow;
    });

    // Quality scores from learning engine
    let selectorStabilityScore = 0;
    let playbookSuccessRate = 0;
    let averageRecoveryTime = 0;

    // Compute playbookSuccessRate from GoalStore
    if (this.goalStore) {
      const allGoals = this.goalStore.list();
      const playbookGoals = allGoals.filter((g) =>
        g.subgoals.some((sg) => sg.plan?.source === "playbook"),
      );
      if (playbookGoals.length > 0) {
        const completed = playbookGoals.filter((g) => g.status === "completed").length;
        playbookSuccessRate = completed / playbookGoals.length;
      }
    }

    if (this.learningEngine) {
      const summary = this.learningEngine.getAppSummary(bundleId);
      if (summary.locatorEntries > 0) {
        const entries = this.learningEngine.locators.getAllEntries()
          .filter((e) => e.key.startsWith(`${bundleId}::`));
        if (entries.length > 0) {
          selectorStabilityScore =
            entries.reduce((sum, e) => sum + e.score, 0) / entries.length;
        }
      }

      const recEntries = this.learningEngine.recovery.getAllEntries()
        .filter((e) => e.key.endsWith(`::${bundleId}`));
      if (recEntries.length > 0) {
        averageRecoveryTime =
          recEntries.reduce((sum, e) => sum + e.avgDurationMs, 0) / recEntries.length;
      }
    }

    // Generate recommendations
    const highValueGaps: string[] = [];
    if (shortcutsKnown === 0) {
      highValueGaps.push("No shortcuts documented — run scan_menu_bar to extract keyboard shortcuts");
    }
    if (selectorsKnown === 0) {
      highValueGaps.push("No selectors documented — run platform_explore to discover stable selectors");
    }
    if (playbooks.length === 0) {
      highValueGaps.push("No playbooks available — record common workflows with playbook_record");
    }
    if (errorsDocumented === 0) {
      highValueGaps.push("No error patterns documented — errors will be learned automatically over time");
    }
    if (websiteFeaturesKnown === 0) {
      highValueGaps.push("No website features extracted — run discover_features to learn app capabilities from official website");
    }
    if (workflowsWithNoPlaybook.length > 0) {
      highValueGaps.push(
        `Common workflows without playbooks: ${workflowsWithNoPlaybook.join(", ")}`,
      );
    }
    if (menuScan && shortcutsNotInReference.length > 10) {
      highValueGaps.push(
        `${shortcutsNotInReference.length} shortcuts found in menu bar but missing from reference`,
      );
    }

    return {
      app: appName,
      bundleId,
      shortcutsKnown,
      selectorsKnown,
      flowsKnown,
      playbooksAvailable: playbooks.length,
      errorsDocumented,
      websiteFeaturesKnown,
      menuPathsNotCovered: menuPathsNotCovered.slice(0, 50),
      shortcutsNotInReference: shortcutsNotInReference.slice(0, 50),
      workflowsWithNoPlaybook,
      selectorStabilityScore,
      playbookSuccessRate,
      averageRecoveryTime,
      highValueGaps,
      generatedAt: new Date().toISOString(),
    };
  }

  private loadReferences(bundleId: string): ReferenceFile[] {
    const refs: ReferenceFile[] = [];
    // Derive short name for matching: "com.apple.iphonesimulator" → "iphonesimulator"
    const bundleParts = bundleId.split(".");
    const shortName = (bundleParts[bundleParts.length - 1] ?? "").toLowerCase();
    try {
      const files = fs.readdirSync(this.referencesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.referencesDir, file), "utf-8");
          const ref = JSON.parse(raw) as ReferenceFile;
          if (
            ref.bundleId === bundleId ||
            ref.platform === bundleId ||
            ref.platform?.toLowerCase() === shortName ||
            ref.id?.toLowerCase() === shortName
          ) {
            refs.push(ref);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }
    return refs;
  }

  private loadPlaybooks(bundleId: string, appName: string): PlaybookFile[] {
    const playbooks: PlaybookFile[] = [];
    // Derive short platform name from bundleId: "com.apple.Notes" → "notes"
    const bundleParts = bundleId.split(".");
    const shortName = (bundleParts[bundleParts.length - 1] ?? "").toLowerCase();
    const appNameLower = appName.toLowerCase();

    // Also match by filename prefix (e.g. "simulator-launch-app.json" matches appName "Simulator")
    const filenamePrefixes = [shortName, appNameLower];

    // Find the platform name from reference files for cross-matching
    // e.g. bundleId "com.apple.iphonesimulator" → platform "simulator" in reference
    const refPlatforms: string[] = [];
    try {
      const refFiles = fs.readdirSync(this.referencesDir);
      for (const file of refFiles) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.referencesDir, file), "utf-8");
          const ref = JSON.parse(raw) as { bundleId?: string; platform?: string };
          if (ref.bundleId === bundleId && ref.platform) {
            refPlatforms.push(ref.platform.toLowerCase());
          }
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }

    try {
      const files = fs.readdirSync(this.playbooksDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.playbooksDir, file), "utf-8");
          const pb = JSON.parse(raw) as PlaybookFile;
          // Match by bundleId (exact), platform name (case-insensitive), app name, or ref platform
          const platformLower = (pb.platform ?? "").toLowerCase();
          const fileBase = file.replace(".json", "").toLowerCase();
          if (
            pb.bundleId === bundleId ||
            platformLower === bundleId ||
            platformLower === shortName ||
            platformLower === appNameLower ||
            refPlatforms.includes(platformLower) ||
            filenamePrefixes.some(p => fileBase.startsWith(p + "-")) ||
            refPlatforms.some(rp => fileBase.startsWith(rp + "-"))
          ) {
            playbooks.push(pb);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }
    return playbooks;
  }

  private flattenMenuPaths(nodes: Array<{ title: string; children: any[] }>, prefix: string[] = []): string[] {
    const paths: string[] = [];
    for (const node of nodes) {
      const p = [...prefix, node.title];
      if (!node.children || node.children.length === 0) {
        paths.push(p.join(" > "));
      } else {
        paths.push(...this.flattenMenuPaths(node.children, p));
      }
    }
    return paths;
  }
}
