/**
 * Playbook Store — load, save, match playbooks from disk
 *
 * Playbooks are stored as JSON files in the playbooks/ directory.
 * Each file can contain a Playbook directly, or a legacy format
 * that gets converted.
 */

import fs from "node:fs";
import path from "node:path";
import type { Playbook } from "./types.js";

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

  /** Get all loaded playbooks. */
  getAll(): Playbook[] {
    return [...this.playbooks.values()];
  }

  /** Get a playbook by ID. */
  get(id: string): Playbook | undefined {
    return this.playbooks.get(id);
  }

  /** Find playbooks matching a URL. */
  matchByUrl(url: string): Playbook[] {
    return this.getAll().filter((p) => {
      if (!p.urlPatterns || p.urlPatterns.length === 0) return false;
      return p.urlPatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(url);
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
  matchByTask(task: string): Playbook | null {
    const tokens = task.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
    if (tokens.length === 0) return null;

    let best: Playbook | null = null;
    let bestScore = 0;

    for (const p of this.playbooks.values()) {
      const haystack = `${p.name} ${p.description} ${p.tags.join(" ")} ${p.platform}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score++;
      }
      // Weight by reliability
      const reliability = p.successCount + p.failCount > 0
        ? p.successCount / (p.successCount + p.failCount)
        : 0.5;
      score *= reliability;

      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    return bestScore > 0 ? best : null;
  }

  /** Save a playbook to disk. */
  save(playbook: Playbook): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    const filename = `${playbook.id}.json`;
    fs.writeFileSync(
      path.join(this.dir, filename),
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
