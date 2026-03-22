// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SharedPlaybook, PlaybookQuery } from "./types.js";
import { RemoteCommunityAPI } from "./remote-api.js";

/** Tools that are never allowed in community playbooks (defense in depth). */
const BLOCKED_TOOLS = new Set([
  "applescript", "browser_js", "browser_stealth",  // code execution / anti-detection
  "key", "launch", "focus",                        // RCE via terminal launch + keystroke typing
  "memory_save", "memory_clear", "memory_snapshot", // data exfil / tampering
  "supervisor_start", "supervisor_stop", "supervisor_install", "supervisor_uninstall",
  "job_create", "worker_start",                    // persistence
]);

function hasBlockedTool(playbook: SharedPlaybook): boolean {
  return playbook.steps.some((s) => BLOCKED_TOOLS.has(s.tool));
}

/**
 * PlaybookFetcher — fetches community playbooks from local disk
 * and optionally from a remote API (when SCREENHAND_COMMUNITY_URL is set).
 *
 * Local repo is always read. Remote results are merged and deduplicated.
 */
export class PlaybookFetcher {
  private readonly repoDir: string;
  private cache: SharedPlaybook[] | null = null;
  private readonly remote: RemoteCommunityAPI | null;

  constructor(repoDir?: string, remote?: RemoteCommunityAPI | null) {
    this.repoDir = repoDir ?? path.join(os.homedir(), ".screenhand", "community");
    this.remote = remote ?? RemoteCommunityAPI.fromEnv();
  }

  /**
   * Fetch community playbooks matching the query.
   * Reads from local disk; async variant also merges remote results.
   */
  fetch(query: PlaybookQuery): SharedPlaybook[] {
    return this.filterAndRank(this.loadAll(), query);
  }

  /**
   * Fetch with remote API merge (when SCREENHAND_COMMUNITY_URL is set).
   * Local results are always included; remote results are deduplicated and merged.
   */
  async fetchWithRemote(query: PlaybookQuery): Promise<SharedPlaybook[]> {
    const local = this.loadAll();

    if (!this.remote) {
      return this.filterAndRank(local, query);
    }

    try {
      const remote = await this.remote.fetch(query);
      // Filter remote results for blocked tools (defense in depth — local loadAll already filters)
      const safeRemote = remote.filter((pb) => {
        if (hasBlockedTool(pb)) {
          console.error(`[community] Blocked: remote playbook ${pb.id} uses restricted tool`);
          return false;
        }
        return true;
      });
      // Deduplicate: local wins on ID collision
      const localIds = new Set(local.map((pb) => pb.id));
      const merged = [...local, ...safeRemote.filter((pb) => !localIds.has(pb.id))];
      return this.filterAndRank(merged, query);
    } catch {
      return this.filterAndRank(local, query);
    }
  }

  private filterAndRank(all: SharedPlaybook[], query: PlaybookQuery): SharedPlaybook[] {
    return all
      .filter((pb) => {
        if (query.platform && pb.platform !== query.platform) return false;
        if (query.bundleId && pb.bundleId !== query.bundleId) return false;
        if (query.workflow) {
          const lower = query.workflow.toLowerCase();
          if (
            !pb.name.toLowerCase().includes(lower) &&
            !pb.description.toLowerCase().includes(lower) &&
            !pb.metadata.tags.some((t) => t.toLowerCase().includes(lower))
          ) {
            return false;
          }
        }
        if (query.minScore !== undefined && pb.ratings.score < query.minScore) return false;
        return true;
      })
      .sort((a, b) => {
        const scoreA = a.metadata.successRate * Math.max(a.ratings.score, 1);
        const scoreB = b.metadata.successRate * Math.max(b.ratings.score, 1);
        return scoreB - scoreA;
      })
      .slice(0, query.limit ?? 20);
  }

  /**
   * Get a specific playbook by ID.
   */
  get(id: string): SharedPlaybook | null {
    const all = this.loadAll();
    return all.find((pb) => pb.id === id) ?? null;
  }

  /**
   * Invalidate the cache (after a new playbook is published).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  private loadAll(): SharedPlaybook[] {
    if (this.cache) return this.cache;

    const playbooks: SharedPlaybook[] = [];
    try {
      if (!fs.existsSync(this.repoDir)) return playbooks;
      const files = fs.readdirSync(this.repoDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.repoDir, file), "utf-8");
          const playbook = JSON.parse(raw) as SharedPlaybook;
          // Validate required fields
          if (!playbook.id || !playbook.name || !playbook.platform || !Array.isArray(playbook.steps)) {
            console.error(`[community] Skipping invalid playbook: ${file}`);
            continue;
          }
          // Block playbooks using restricted tools (defense in depth — validator also checks)
          if (hasBlockedTool(playbook)) {
            console.error(`[community] Blocked: community playbook ${file} uses restricted tool`);
            continue;
          }
          playbooks.push(playbook);
        } catch { /* skip malformed */ }
      }
    } catch { /* dir not found */ }

    this.cache = playbooks;
    return playbooks;
  }
}
