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

import type { WorldModel } from "../state/world-model.js";
import type { Blocker, BlockerType } from "./types.js";

const PERMISSION_PATTERNS = /access|allow|permission|accessibility|camera|microphone|location|contacts/i;
const LOGIN_PATTERNS = /sign in|log in|login|session expired|authenticate/i;
const CAPTCHA_PATTERNS = /captcha|verify you.re human|are you a robot/i;
const RATE_LIMIT_PATTERNS = /rate limit|too many requests|slow down/i;
const NETWORK_ERROR_PATTERNS = /network error|failed to load|no internet|connection refused/i;
const CRASH_DIALOG_PATTERNS = /not responding|crashed|quit unexpectedly/i;
const POPUP_BLOCKED_PATTERNS = /popup.*block|pop-up.*block|blocked.*popup|blocked.*pop-up|window\.open.*blocked/i;

/**
 * Scan the WorldModel and error text to detect blockers, sorted by priority.
 * Returns an empty array only if no blockers can be inferred.
 */
export function detectBlockers(
  worldModel: WorldModel,
  failedStepError: string,
  expectedBundleId: string | null,
): Blocker[] {
  const blockers: Blocker[] = [];
  const state = worldModel.getState();
  const pidFields: Pick<Blocker, "pid"> = state.focusedApp?.pid != null ? { pid: state.focusedApp.pid } : {};

  // 1. Dialog-based blockers (highest priority)
  const dialogs = worldModel.getActiveDialogs();
  for (const dialog of dialogs) {
    const type = classifyDialogType(dialog.title, dialog.type);
    blockers.push({
      type,
      description: `${type}: "${dialog.title || dialog.type}"`,
      bundleId: expectedBundleId,
      ...pidFields,
      dialogTitle: dialog.title,
    });
  }

  // 2. Focus loss
  if (expectedBundleId !== null) {
    const focusedApp = state.focusedApp;
    if (focusedApp && focusedApp.bundleId !== expectedBundleId) {
      blockers.push({
        type: "focus_lost",
        description: `Expected ${expectedBundleId}, got ${focusedApp.bundleId}`,
        bundleId: expectedBundleId,
        ...pidFields,
      });
    }
    if (!focusedApp && state.windows.size === 0) {
      blockers.push({
        type: "app_crashed",
        description: `No windows tracked for ${expectedBundleId}`,
        bundleId: expectedBundleId,
        ...pidFields,
      });
    }
  }

  // 3. Many stale controls = world model outdated
  const staleControls = worldModel.getStaleControls(10_000);
  if (staleControls.length > 10) {
    blockers.push({
      type: "unknown_state",
      description: `${staleControls.length} stale controls`,
      bundleId: expectedBundleId,
      ...pidFields,
    });
  }

  // 4. Error text pattern matching
  const err = failedStepError.toLowerCase();
  if (CAPTCHA_PATTERNS.test(err)) {
    blockers.push({ type: "captcha", description: `Captcha: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (RATE_LIMIT_PATTERNS.test(err)) {
    blockers.push({ type: "rate_limited", description: `Rate limited: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (LOGIN_PATTERNS.test(err) && !blockers.some((b) => b.type === "login_required")) {
    blockers.push({ type: "login_required", description: `Login required: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (NETWORK_ERROR_PATTERNS.test(err)) {
    blockers.push({ type: "network_error", description: `Network error: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (POPUP_BLOCKED_PATTERNS.test(err)) {
    blockers.push({ type: "permission_dialog", description: `Popup blocked: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (/timed\s+out|timeout\s+(exceeded|error|after)|request\s+timeout/i.test(err) ||
      /loading\s+(stuck|failed|error|taking)/i.test(err) ||
      (err.includes("loading") && (err.includes("fail") || err.includes("error") || err.includes("stuck")))) {
    blockers.push({ type: "loading_stuck", description: `Loading stuck: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });
  }
  if (err.includes("not found") || err.includes("locate_failed") || /element.*(gone|missing|disappear|not found)/i.test(err)) {
    blockers.push({ type: "element_gone", description: `Element gone: ${failedStepError}`, bundleId: expectedBundleId, ...pidFields });

    // 4a. selector_drift: element gone but UI controls were recently updated
    // This means the element moved/changed rather than disappearing entirely
    const focusedWindowId = state.focusedWindowId;
    if (focusedWindowId !== null) {
      const win = state.windows.get(focusedWindowId);
      if (win && win.controls.size > 0) {
        const FRESH_THRESHOLD = 5_000;
        let hasFreshControls = false;
        for (const ctrl of win.controls.values()) {
          if (Date.now() - new Date(ctrl.value.updatedAt).getTime() < FRESH_THRESHOLD) {
            hasFreshControls = true;
            break;
          }
        }
        if (hasFreshControls) {
          blockers.push({
            type: "selector_drift",
            description: `Selector drift: element not found but UI is fresh (${win.controls.size} controls)`,
            bundleId: expectedBundleId,
            ...pidFields,
          });
        }
      }
    }
  }

  // 5. Fallback
  if (blockers.length === 0) {
    blockers.push({
      type: "unknown_state",
      description: `Unclassified: ${failedStepError}`,
      bundleId: expectedBundleId,
      ...pidFields,
    });
  }

  // Deduplicate by type
  const seen = new Set<BlockerType>();
  return blockers.filter((b) => {
    if (seen.has(b.type)) return false;
    seen.add(b.type);
    return true;
  });
}

function classifyDialogType(
  title: string,
  dialogRole: string,
): BlockerType {
  const titleLower = title.toLowerCase();
  if (/pop-up|popup|blocked/i.test(titleLower)) return "permission_dialog";
  if (PERMISSION_PATTERNS.test(titleLower)) return "permission_dialog";
  if (LOGIN_PATTERNS.test(titleLower)) return "login_required";
  if (CAPTCHA_PATTERNS.test(titleLower)) return "captcha";
  if (CRASH_DIALOG_PATTERNS.test(titleLower)) return "app_crashed";
  if (dialogRole === "alert") return "unexpected_dialog";
  return "unexpected_dialog";
}
