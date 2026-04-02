// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomicSync } from "../util/atomic-write.js";
import type { SharedPlaybook, ContributionMeta, SharedStep } from "./types.js";
import type { Playbook, PlaybookStep } from "../playbook/types.js";
import { RemoteCommunityAPI } from "./remote-api.js";

/**
 * PlaybookPublisher — prepares and publishes validated playbooks
 * to a local shared repository and optionally to a remote API
 * (when SCREENHAND_COMMUNITY_URL is set).
 */
export class PlaybookPublisher {
  private readonly repoDir: string;
  private readonly remote: RemoteCommunityAPI | null;

  constructor(repoDir?: string, remote?: RemoteCommunityAPI | null) {
    this.repoDir = repoDir ?? path.join(os.homedir(), ".screenhand", "community");
    this.remote = remote ?? RemoteCommunityAPI.fromEnv();
    fs.mkdirSync(this.repoDir, { recursive: true });
  }

  /**
   * Publish a validated local playbook to the community repository.
   * Requires the playbook to have been run successfully at least minRuns times.
   */
  publish(
    playbook: Playbook,
    successRate: number,
    executionCount: number,
    _minRuns?: number,
  ): SharedPlaybook | null {
    // Server-side minimum — cannot be overridden by caller
    const MIN_RUNS = 3;
    if (!Number.isFinite(executionCount) || executionCount < MIN_RUNS) return null;
    if (!Number.isFinite(successRate) || successRate < 0.5) return null;

    // Cross-check client-provided metrics against actual playbook data.
    // ALWAYS use the playbook's own tracked counts — never trust client values.
    // If the playbook has no tracked runs, it cannot be verified for publishing.
    const actualRuns = playbook.successCount + playbook.failCount;
    if (actualRuns < MIN_RUNS) return null; // No tracked data = not publishable
    const verifiedRate = playbook.successCount / actualRuns;
    if (verifiedRate < 0.5) return null;

    const shared: SharedPlaybook = {
      id: `community_${playbook.id}_${Date.now().toString(36)}`,
      name: playbook.name,
      description: playbook.description,
      platform: playbook.platform,
      bundleId: playbook.bundleId ?? "",
      version: "1.0.0",
      steps: this.convertSteps(playbook.steps),
      metadata: {
        author: "anonymous",
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        os: process.platform,
        successRate: verifiedRate,
        executionCount: actualRuns,
        tags: playbook.tags ?? [],
      },
      ratings: {
        upvotes: 0,
        downvotes: 0,
        score: 0,
        reportCount: 0,
      },
    };

    // Strip sensitive data from params
    for (const step of shared.steps) {
      this.sanitizeParams(step.params);
    }

    // Sanitize ID to prevent path traversal
    const safeId = shared.id.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const filePath = path.join(this.repoDir, `${safeId}.json`);
    // Verify the file stays inside repoDir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.repoDir))) {
      return null;
    }
    writeFileAtomicSync(filePath, JSON.stringify(shared, null, 2) + "\n");

    // Best-effort sync to remote API — log failures so user knows data didn't leave machine
    if (this.remote) {
      void this.remote.publish(shared).catch((err) => {
        process.stderr.write(`[screenhand] Remote publish failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }

    return shared;
  }

  /**
   * List all published playbooks in the local repository.
   */
  list(): SharedPlaybook[] {
    const playbooks: SharedPlaybook[] = [];
    try {
      const files = fs.readdirSync(this.repoDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(this.repoDir, file), "utf-8");
          playbooks.push(JSON.parse(raw) as SharedPlaybook);
        } catch { /* skip */ }
      }
    } catch { /* dir not found */ }
    return playbooks;
  }

  private convertSteps(steps: PlaybookStep[]): SharedStep[] {
    return steps.map((step) => ({
      action: step.action,
      tool: this.actionToTool(step.action),
      params: this.extractParams(step),
      description: step.description ?? `${step.action} step`,
    }));
  }

  private extractParams(step: PlaybookStep): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    if (step.target !== undefined) params.target = step.target;
    if (step.text !== undefined) params.text = step.text;
    if (step.url !== undefined) params.url = step.url;
    if (step.keys !== undefined) params.keys = step.keys;
    if (step.menuPath !== undefined) params.menuPath = step.menuPath;
    if (step.ms !== undefined) params.ms = step.ms;
    if (step.direction !== undefined) params.direction = step.direction;
    if (step.amount !== undefined) params.amount = step.amount;

    // Normalize to MCP tool param shapes
    if (Array.isArray(params.keys)) {
      params.combo = (params.keys as string[]).join("+");
      delete params.keys;
    }
    if (Array.isArray(params.menuPath)) {
      params.menuPath = (params.menuPath as string[]).join("/");
    }

    return params;
  }

  private actionToTool(action: string): string {
    switch (action) {
      case "click": return "click_with_fallback";
      case "type": return "type_with_fallback";
      case "press": return "key";
      case "navigate": return "browser_navigate";
      case "wait": return "wait_for_state";
      case "scroll": return "scroll_with_fallback";
      default: return action;
    }
  }

  /**
   * Remove potentially sensitive values from params.
   */
  private sanitizeParams(params: Record<string, unknown>): void {
    const sensitiveKeys = [
      "password", "token", "secret", "credential",
      "apikey", "api_key", "auth_token", "secret_key",
      "access_key", "private_key",
    ];
    /** Patterns that indicate sensitive values regardless of key name */
    const sensitiveValuePatterns = [
      /sk-ant-api/i, // Anthropic API keys
      /sk-[a-zA-Z0-9]{20,}/i, // OpenAI-style keys
      /^ghp_[a-zA-Z0-9]{36}$/i, // GitHub PATs
      /^xox[bpsar]-/i, // Slack tokens
      /\bexport\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\b/i, // env var exports
    ];
    for (const key of Object.keys(params)) {
      if (sensitiveKeys.some((s) => key.toLowerCase() === s || key.toLowerCase().replace(/[^a-z_]/g, "") === s)) {
        delete params[key];
        continue;
      }
      const val = params[key];
      // Check string values for sensitive patterns
      if (typeof val === "string") {
        if (sensitiveValuePatterns.some((p) => p.test(val))) {
          delete params[key];
          continue;
        }
        // Strip absolute file paths
        if (val.startsWith("/") && (val.includes("/Users/") || val.includes("/home/"))) {
          params[key] = path.basename(val);
        }
      }
      // Recurse into nested objects
      if (val && typeof val === "object" && !Array.isArray(val)) {
        this.sanitizeParams(val as Record<string, unknown>);
      }
    }
  }
}
