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
 * Predefined seed strategies — common macOS desktop workflows.
 * Loaded on first boot so the memory system has knowledge from day one.
 */

import type { Strategy, StrategyStep } from "./types.js";

let seedCounter = 0;

function makeFingerprint(tools: string[]): string {
  return tools.join("→");
}

function seed(task: string, steps: StrategyStep[], tags: string[]): Strategy {
  seedCounter++;
  return {
    id: `seed_${String(seedCounter).padStart(3, "0")}`,
    task,
    steps,
    totalDurationMs: 0,
    successCount: 10,
    failCount: 0,
    lastUsed: new Date().toISOString(),
    tags,
    fingerprint: makeFingerprint(steps.map((s) => s.tool)),
  };
}

export const SEED_STRATEGIES: Strategy[] = [
  // 1. Take a photo with Photo Booth
  seed("Take a photo with Photo Booth", [
    { tool: "launch", params: { bundleId: "com.apple.PhotoBooth" } },
    { tool: "ui_press", params: { title: "Take Photo" } },
  ], ["photo", "booth", "camera"]),

  // 2. Open a URL in Chrome
  seed("Open a URL in Chrome", [
    { tool: "launch", params: { bundleId: "com.google.Chrome" } },
    { tool: "browser_navigate", params: { url: "" } },
  ], ["chrome", "browse", "url"]),

  // 3. Save current document
  seed("Save current document", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "key", params: { combo: "cmd+s" } },
  ], ["save", "document"]),

  // 4. Copy from one app and paste into another
  seed("Copy from one app and paste into another", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "key", params: { combo: "cmd+c" } },
    { tool: "focus", params: { bundleId: "" } },
    { tool: "key", params: { combo: "cmd+v" } },
  ], ["copy", "paste"]),

  // 5. Navigate to a folder in Finder
  seed("Navigate to a folder in Finder", [
    { tool: "focus", params: { bundleId: "com.apple.finder" } },
    { tool: "key", params: { combo: "cmd+shift+g" } },
    { tool: "type_text", params: { text: "" } },
  ], ["finder", "folder", "navigate"]),

  // 6. Create a new folder in Finder
  seed("Create a new folder in Finder", [
    { tool: "focus", params: { bundleId: "com.apple.finder" } },
    { tool: "key", params: { combo: "cmd+shift+n" } },
    { tool: "type_text", params: { text: "" } },
  ], ["finder", "folder", "create"]),

  // 7. Close the current window
  seed("Close the current window", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "key", params: { combo: "cmd+w" } },
  ], ["close", "window"]),

  // 8. Select all and copy
  seed("Select all content and copy", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "key", params: { combo: "cmd+a" } },
    { tool: "key", params: { combo: "cmd+c" } },
  ], ["select", "all", "copy"]),

  // 9. List running apps
  seed("List all running applications", [
    { tool: "apps", params: {} },
  ], ["apps", "list", "running"]),

  // 10. Inspect app UI tree
  seed("Inspect an app's UI element tree", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "ui_tree", params: { pid: 0 } },
  ], ["inspect", "tree", "accessibility"]),

  // 11. Open a new tab in Chrome and navigate
  seed("Open a new Chrome tab and navigate to URL", [
    { tool: "focus", params: { bundleId: "com.google.Chrome" } },
    { tool: "key", params: { combo: "cmd+t" } },
    { tool: "browser_navigate", params: { url: "" } },
  ], ["chrome", "tab", "new"]),

  // 12. Export as PDF via menu
  seed("Export document as PDF", [
    { tool: "focus", params: { bundleId: "" } },
    { tool: "menu_click", params: { menuPath: "File/Export as PDF" } },
  ], ["export", "pdf"]),
];
