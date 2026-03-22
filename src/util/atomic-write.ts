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
 * Atomic file writes — temp file + rename to prevent corruption on crash.
 *
 * Also provides corrupt-file recovery: if the primary file is unreadable,
 * falls back to the `.bak` backup created on the previous successful write.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Write data atomically: write to a temp file in the same directory,
 * then rename over the target. On POSIX, rename is atomic within the
 * same filesystem, so readers always see either the old or new content.
 *
 * Also keeps a single `.bak` of the previous version for recovery.
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  try {
    fs.writeFileSync(tmp, data, { mode: 0o644 });

    // Back up current file before overwriting (ignore if it doesn't exist yet)
    // V4: Check for symlinks on BOTH primary and .bak to prevent data exfiltration
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        // Primary is a symlink — remove it before writing
        fs.unlinkSync(filePath);
      } else {
        // Check .bak target for symlinks before copying
        try {
          const bakStat = fs.lstatSync(filePath + ".bak");
          if (bakStat.isSymbolicLink()) {
            fs.unlinkSync(filePath + ".bak"); // Remove symlink, then copy
          }
        } catch { /* .bak doesn't exist yet — fine */ }
        fs.copyFileSync(filePath, filePath + ".bak");
      }
    } catch {
      // No existing file to back up (ENOENT) — fine
    }

    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp file could not be cleaned up — log so it can be investigated
      console.error(`[atomic-write] WARN: Failed to clean up temp file: ${tmp}`);
    }
    throw err;
  }
}

/**
 * Async variant — same temp+rename approach but non-blocking.
 * Falls back to sync rename (rename is fast, effectively atomic).
 */
export function writeFileAtomic(filePath: string, data: string, callback: (err: Error | null) => void): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  fs.writeFile(tmp, data, { mode: 0o644 }, (writeErr) => {
    if (writeErr) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      callback(writeErr);
      return;
    }

    // Back up current file (best-effort, sync is fine for a copy)
    // V4: Check for symlinks on BOTH primary and .bak
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(filePath);
      } else {
        try {
          const bakStat = fs.lstatSync(filePath + ".bak");
          if (bakStat.isSymbolicLink()) {
            fs.unlinkSync(filePath + ".bak");
          }
        } catch { /* .bak doesn't exist — fine */ }
        fs.copyFileSync(filePath, filePath + ".bak");
      }
    } catch { /* ignore — ENOENT means no file to back up */ }

    fs.rename(tmp, filePath, (renameErr) => {
      if (renameErr) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      callback(renameErr);
    });
  });
}

/**
 * Read a JSON file with corrupt-file recovery.
 * If the primary file fails to parse, tries the `.bak` backup.
 * Returns the parsed object, or null if both are unreadable.
 */
export function readJsonWithRecovery<T = unknown>(filePath: string): T | null {
  // Try primary file
  const primary = tryParseJsonFile<T>(filePath);
  if (primary !== null) return primary;

  // Primary is missing or corrupt — try backup
  const backup = tryParseJsonFile<T>(filePath + ".bak");
  if (backup !== null) {
    console.error(`[atomic-write] WARN: Primary file corrupt, recovered from backup: ${filePath}`);
    // Restore backup as primary so next read is fast
    try { fs.copyFileSync(filePath + ".bak", filePath); } catch { /* ignore */ }
    return backup;
  }

  // Both primary and backup are missing or corrupt — log warning so data loss is visible
  console.error(`[atomic-write] WARN: Both primary and backup corrupt for ${filePath}, returning null`);
  return null;
}

function tryParseJsonFile<T>(filePath: string): T | null {
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
