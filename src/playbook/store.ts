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
 * Playbook Store — load, save, match playbooks from disk
 *
 * Playbooks are stored as JSON files in the playbooks/ directory.
 * Each file can contain a Playbook directly, or a legacy format
 * that gets converted.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import type { Playbook } from "./types.js";

/** Extract hostname from a URL or URL pattern string */
function extractHost(urlOrPattern: string): string {
  const cleaned = urlOrPattern.replace(/^\*/, "").replace(/\\/g, "");
  try {
    // Try parsing as a URL
    const u = new URL(cleaned.startsWith("http") ? cleaned : "https://" + cleaned);
    return u.hostname.toLowerCase();
  } catch {
    // Fallback: extract domain-like portion
    const match = cleaned.match(/(?:https?:\/\/)?([a-z0-9.-]+)/i);
    return match ? match[1]!.toLowerCase() : "";
  }
}

export class PlaybookStore {
  private playbooks: Map<string, Playbook> = new Map();

  constructor(private readonly dir: string) {}

  /** Load all playbooks from disk into memory. */
  load(): void {
    this.playbooks.clear();
    if (!fs.existsSync(this.dir)) return;

    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8"));
        const playbook = this.normalize(raw, file);
        if (playbook) {
          this.playbooks.set(playbook.id, playbook);
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  /** Reload all playbooks from disk (call after ingestion writes new data). */
  reload(): void {
    this.load();
  }

  /** Get all loaded playbooks. */
  getAll(): Playbook[] {
    return [...this.playbooks.values()];
  }

  /** Get a playbook by ID. */
  get(id: string): Playbook | undefined {
    return this.playbooks.get(id);
  }

  /** Find best playbook matching a domain (e.g., "x.com", "figma.com"). */
  matchByDomain(domain: string): Playbook | null {
    const domainLower = domain.toLowerCase();
    if (domainLower.length === 0) return null;

    // Extract the meaningful part of the domain (before first dot)
    const domainPrefix = domainLower.split(".")[0]!;

    let best: Playbook | null = null;
    let bestScore = 0;

    for (const p of this.playbooks.values()) {
      let score = 0;

      // Check platform name — require prefix to be at least 3 chars to avoid phantom matches
      if (domainPrefix.length >= 3 && p.platform.toLowerCase().includes(domainPrefix)) score += 2;

      // Check URL patterns — extract hostname and compare exactly (no subdomain matching)
      // e.g. "google.com" should NOT match "adstransparency.google.com"
      if (p.urlPatterns?.some((pat) => {
        const host = extractHost(pat);
        return host === domainLower || host === "www." + domainLower;
      })) score += 3;

      // Check URLs map — extract hostname and compare exactly
      if (p.urls) {
        const hasUrl = Object.values(p.urls).some((u) => {
          const host = extractHost(u);
          return host === domainLower || host === "www." + domainLower;
        });
        if (hasUrl) score += 3;
      }

      // Check tags — require tag to be at least 4 chars to avoid phantom matches (e.g. "x" matching "example.com")
      if (p.tags.some((t) => t.length >= 4 && domainLower.includes(t.toLowerCase()))) score += 1;

      // Weight by reliability — floor at 0.1 so valid matches are never zeroed out
      if (score > 0 && p.successCount + p.failCount > 0) {
        score *= Math.max(0.1, p.successCount / (p.successCount + p.failCount));
      }

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    return bestScore > 0 ? best : null;
  }

  /** Find best playbook matching a macOS bundle ID (e.g., "com.blackmagic-design.DaVinciResolveLite"). */
  matchByBundleId(bundleId: string): Playbook | null {
    const idLower = bundleId.toLowerCase();
    // Extract the short app name from bundleId (e.g., "davinciresolvelite" from "com.blackmagic-design.DaVinciResolveLite")
    const shortName = idLower.split(".").pop() ?? idLower;

    let best: Playbook | null = null;
    let bestScore = 0;

    for (const p of this.playbooks.values()) {
      let score = 0;

      // Direct bundleId match (if the reference stores it)
      if (p.bundleId?.toLowerCase() === idLower) score += 10;

      // Check platform name against short app name
      const platLower = p.platform.toLowerCase().replace(/[^a-z0-9]/g, "");
      const shortClean = shortName.replace(/[^a-z0-9]/g, "");
      if (platLower.includes(shortClean) || shortClean.includes(platLower)) score += 3;

      // Check tags — require tag to be at least 4 chars to avoid phantom matches (e.g. "com")
      if (p.tags.some((t) => {
        const cleaned = t.toLowerCase().replace(/[^a-z0-9.]/g, "");
        return cleaned.length >= 4 && idLower.includes(cleaned);
      })) score += 1;

      // Weight by reliability — floor at 0.1 so valid matches are never zeroed out
      if (score > 0 && p.successCount + p.failCount > 0) {
        score *= Math.max(0.1, p.successCount / (p.successCount + p.failCount));
      }

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    return bestScore > 0 ? best : null;
  }

  /** Find playbooks matching a URL. */
  matchByUrl(url: string): Playbook[] {
    return this.getAll().filter((p) => {
      if (!p.urlPatterns || p.urlPatterns.length === 0) return false;
      return p.urlPatterns.some((pattern) => {
        try {
          // Guard against ReDoS: reject patterns that could cause catastrophic backtracking
          if (/([+*])\1|(\([^)]*[+*][^)]*\))[+*]/.test(pattern)) {
            return url.includes(pattern);
          }
          const re = new RegExp(pattern);
          // Use a timeout-safe approach: test with a length limit
          if (url.length > 2048) return false;
          return re.test(url);
        } catch {
          return url.includes(pattern);
        }
      });
    });
  }

  /** Find playbooks matching tags. */
  matchByTags(tags: string[]): Playbook[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return this.getAll()
      .filter((p) => p.tags.some((t) => tagSet.has(t.toLowerCase())))
      .sort((a, b) => b.successCount - a.successCount);
  }

  /** Find playbooks by platform. */
  matchByPlatform(platform: string): Playbook[] {
    return this.getAll()
      .filter((p) => p.platform.toLowerCase() === platform.toLowerCase())
      .sort((a, b) => b.successCount - a.successCount);
  }

  /** Find best playbook for a task description (simple keyword matching). */
  matchByTask(task: string, currentBundleId?: string): Playbook | null {
    // Filter out very common words that cause false matches across unrelated playbooks
    const STOP_WORDS = new Set([
      "the", "and", "for", "with", "from", "into", "that", "this", "then",
      "type", "click", "open", "close", "save", "new", "text", "file",
      "app", "use", "set", "get", "add", "run", "start", "stop",
      "page", "post", "button", "menu", "tab", "window", "link",
      "send", "copy", "paste", "delete", "create", "edit", "view",
      "show", "hide", "move", "drag", "drop", "enter", "press",
      "input", "form", "image", "video", "upload", "download",
      "navigate", "select", "find", "wait", "about",
    ]);
    const tokens = task.toLowerCase().split(/\W+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (tokens.length === 0) return null;

    let best: Playbook | null = null;
    let bestScore = 0;
    let bestRawScore = 0;

    for (const p of this.playbooks.values()) {
      const haystack = `${p.name} ${p.description} ${p.tags.join(" ")} ${p.platform}`.toLowerCase();
      let rawScore = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) rawScore++;
      }

      // Boost playbooks whose bundleId matches the current app
      if (currentBundleId && p.bundleId && p.bundleId.toLowerCase() === currentBundleId.toLowerCase()) {
        rawScore += 2;
      }

      // Weight by reliability for ranking, but check threshold against raw score
      const reliability = p.successCount + p.failCount > 0
        ? p.successCount / (p.successCount + p.failCount)
        : 0.5;
      const score = rawScore * reliability;

      if (score > bestScore) {
        bestScore = score;
        bestRawScore = rawScore;
        best = p;
      }
    }

    // Require at least 50% of meaningful tokens to match (raw, before reliability weighting)
    // AND at least 2 raw token matches to prevent single-word false positives
    const minRawScore = Math.max(Math.ceil(tokens.length * 0.5), 2);
    return bestRawScore >= minRawScore ? best : null;
  }

  /** Save a playbook to disk. */
  save(playbook: Playbook): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    // Sanitize ID to prevent path traversal, truncate to avoid ENAMETOOLONG (max 255 on macOS/Linux)
    const safeId = playbook.id.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 200);
    const filename = `${safeId}.json`;
    const resolved = path.resolve(path.join(this.dir, filename));
    if (!resolved.startsWith(path.resolve(this.dir))) {
      return; // Path traversal attempt — refuse to write
    }
    writeFileAtomicSync(
      resolved,
      JSON.stringify(playbook, null, 2) + "\n",
    );
    this.playbooks.set(playbook.id, playbook);
  }

  /** Record a run outcome. */
  recordOutcome(id: string, success: boolean): void {
    const playbook = this.playbooks.get(id);
    if (!playbook) return;
    if (success) {
      playbook.successCount++;
    } else {
      playbook.failCount++;
    }
    playbook.lastRun = new Date().toISOString();
    this.save(playbook);
  }

  /**
   * Normalize raw JSON into a Playbook.
   * Handles both new format (has steps array) and legacy format (has flows object).
   */
  private normalize(raw: Record<string, unknown>, filename: string): Playbook | null {
    // Already in new format
    if (Array.isArray(raw.steps)) {
      return raw as unknown as Playbook;
    }

    // Legacy format: has flows with steps arrays (like instagram_v2.json)
    if (raw.flows && typeof raw.flows === "object") {
      return this.convertLegacy(raw, filename);
    }

    // Reference format: has selectors but no steps/flows (e.g. *-explore.json from platform_explore)
    if (raw.selectors && typeof raw.selectors === "object") {
      return this.convertLegacy(raw, filename);
    }

    return null;
  }

  /**
   * Convert legacy playbook format to new format.
   * Preserves all rich metadata: selectors, flows, errors, detection, policy notes.
   */
  private convertLegacy(raw: Record<string, unknown>, filename: string): Playbook | null {
    const platform = (raw.platform as string) ?? filename.replace(".json", "");
    const id = (raw.playbook as string) ?? filename.replace(".json", "");
    const description = (raw.description as string) ?? "";

    return {
      id,
      name: `${platform} playbook`,
      description,
      platform,
      urlPatterns: raw.urls ? Object.values(raw.urls as Record<string, string>).map(escapeRegex) : [],
      steps: [], // Legacy playbooks use flows instead of direct steps
      tags: [platform, ...(raw.playbook ? [raw.playbook as string] : [])],
      version: (raw.version as string) ?? "1.0.0",
      successCount: 0,
      failCount: 0,

      // Preserve rich metadata
      ...(raw.bundleId ? { bundleId: raw.bundleId as string } : {}),
      ...(raw.cdpPort ? { cdpPort: raw.cdpPort as number } : {}),
      ...(raw.urls ? { urls: raw.urls as Record<string, string> } : {}),
      ...(raw.selectors ? { selectors: raw.selectors as Record<string, Record<string, string>> } : {}),
      ...(raw.flows ? { flows: raw.flows as Record<string, import("./types.js").PlaybookFlow> } : {}),
      ...(raw.detection ? { detection: raw.detection as Record<string, string> } : {}),
      ...(raw.errors ? { errors: raw.errors as import("./types.js").PlaybookError[] } : {}),
      ...(raw.policy_notes ? { policyNotes: raw.policy_notes as Record<string, string[]> } : {}),
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
