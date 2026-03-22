// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import type { ParsedShortcut, MenuScanResult, DocParseResult } from "./types.js";
import { shortcutsToReferenceFormat } from "./shortcut-extractor.js";

interface ReferenceFile {
  id: string;
  name: string;
  platform: string;
  bundleId?: string;
  shortcuts?: Record<string, Record<string, string>>;
  selectors?: Record<string, Record<string, string>>;
  flows?: Record<string, { steps: string[]; description?: string; _parsed?: Array<{ tool: string; params: Record<string, unknown> }> }>;
  errors?: Array<{ error: string; solution: string; severity?: string }>;
  [key: string]: unknown;
}

/**
 * ReferenceMerger — merges ingested knowledge into existing reference files.
 * Creates new reference files when no matching file exists.
 */
export class ReferenceMerger {
  constructor(private readonly referencesDir: string) {}

  /**
   * Merge shortcuts from a menu scan into the reference file.
   */
  mergeMenuScan(scan: MenuScanResult): { filePath: string; added: number; updated: number } {
    const ref = this.loadOrCreate(scan.bundleId, scan.appName);
    const { shortcuts: scannedShortcuts } = this.menuScanToShortcuts(scan);

    let added = 0;
    let updated = 0;

    if (!ref.shortcuts) ref.shortcuts = {};

    for (const [category, entries] of Object.entries(scannedShortcuts)) {
      if (!ref.shortcuts[category]) {
        ref.shortcuts[category] = {};
      }
      for (const [name, keys] of Object.entries(entries)) {
        if (!ref.shortcuts[category]![name]) {
          added++;
        } else if (ref.shortcuts[category]![name] !== keys) {
          updated++;
        }
        ref.shortcuts[category]![name] = keys;
      }
    }

    const filePath = this.save(ref);
    return { filePath, added, updated };
  }

  /**
   * Merge shortcuts from parsed documentation.
   */
  mergeDocShortcuts(
    shortcuts: ParsedShortcut[],
    bundleId: string,
    appName: string,
  ): { filePath: string; added: number; updated: number } {
    const ref = this.loadOrCreate(bundleId, appName);
    const formatted = shortcutsToReferenceFormat(shortcuts);

    let added = 0;
    let updated = 0;

    if (!ref.shortcuts) ref.shortcuts = {};

    for (const [category, entries] of Object.entries(formatted)) {
      if (!ref.shortcuts[category]) {
        ref.shortcuts[category] = {};
      }
      for (const [name, keys] of Object.entries(entries)) {
        if (!ref.shortcuts[category]![name]) {
          added++;
        } else if (ref.shortcuts[category]![name] !== keys) {
          updated++;
        }
        ref.shortcuts[category]![name] = keys;
      }
    }

    const filePath = this.save(ref);
    return { filePath, added, updated };
  }

  /**
   * Merge flows from parsed documentation.
   */
  mergeDocFlows(
    docResult: DocParseResult,
    bundleId: string,
    appName: string,
  ): { filePath: string; added: number } {
    const ref = this.loadOrCreate(bundleId, appName);
    if (!ref.flows) ref.flows = {};

    let added = 0;

    for (const flow of docResult.flows) {
      const key = flow.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

      if (!ref.flows[key]) {
        const parsed = flow.steps
          .filter((s) => s.tool)
          .map((s) => ({ tool: s.tool!, params: s.params ?? {} }));
        ref.flows[key] = {
          steps: flow.steps.map((s) => s.description),
          description: flow.name,
          ...(parsed.length > 0 ? { _parsed: parsed } : {}),
        };
        added++;
      }
    }

    const filePath = this.save(ref);
    return { filePath, added };
  }

  /**
   * Merge errors/solutions into reference.
   */
  mergeErrors(
    errors: Array<{ error: string; solution: string; severity?: string }>,
    bundleId: string,
    appName: string,
  ): { filePath: string; added: number } {
    const ref = this.loadOrCreate(bundleId, appName);
    if (!ref.errors) ref.errors = [];

    let added = 0;
    const existingErrors = new Set(ref.errors.map((e) => e.error.toLowerCase()));

    for (const err of errors) {
      if (!existingErrors.has(err.error.toLowerCase())) {
        ref.errors.push(err);
        existingErrors.add(err.error.toLowerCase());
        added++;
      }
    }

    const filePath = this.save(ref);
    return { filePath, added };
  }

  /**
   * Load existing reference file for a bundleId, or create a new one.
   */
  private loadOrCreate(bundleId: string, appName: string): ReferenceFile {
    // Search for existing file by bundleId
    try {
      const files = fs.readdirSync(this.referencesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(
            path.join(this.referencesDir, file),
            "utf-8",
          );
          const ref = JSON.parse(raw) as ReferenceFile;
          if (ref.bundleId === bundleId) return ref;
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* dir doesn't exist */
    }

    // Create new reference
    const platform = appName.toLowerCase().replace(/\s+/g, "-");
    return {
      id: platform,
      name: `${appName} — Auto-Generated Reference`,
      platform,
      bundleId,
      shortcuts: {},
      selectors: {},
      flows: {},
      errors: [],
    };
  }

  private save(ref: ReferenceFile): string {
    fs.mkdirSync(this.referencesDir, { recursive: true });
    // Sanitize ref.id to prevent path traversal (e.g. "../../.ssh/evil")
    const safeId = ref.id.replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(this.referencesDir, `${safeId}.json`);
    writeFileAtomicSync(filePath, JSON.stringify(ref, null, 2) + "\n");
    return filePath;
  }

  private menuScanToShortcuts(
    scan: MenuScanResult,
  ): { shortcuts: Record<string, Record<string, string>> } {
    const shortcuts: Record<string, Record<string, string>> = {};

    for (const topMenu of scan.menuTree) {
      const category = topMenu.title;
      if (!shortcuts[category]) shortcuts[category] = {};

      const items = this.flattenMenuNode(topMenu, []);
      for (const item of items) {
        if (item.shortcut) {
          shortcuts[category]![item.label] = item.shortcut;
        }
      }
    }

    return { shortcuts };
  }

  private flattenMenuNode(
    node: { title: string; shortcut: string | null; children: any[] },
    parentPath: string[],
  ): Array<{ label: string; shortcut: string | null }> {
    const items: Array<{ label: string; shortcut: string | null }> = [];
    const path = [...parentPath, node.title];

    if (node.shortcut) {
      items.push({ label: path.slice(1).join(" > "), shortcut: node.shortcut });
    }

    for (const child of node.children ?? []) {
      items.push(...this.flattenMenuNode(child, path));
    }

    return items;
  }
}
