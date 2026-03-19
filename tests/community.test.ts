// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PlaybookPublisher } from "../src/community/publisher.js";
import { PlaybookFetcher } from "../src/community/fetcher.js";
import { PlaybookValidator } from "../src/community/validator.js";
import type { Playbook, PlaybookStep } from "../src/playbook/types.js";
import type { SharedPlaybook } from "../src/community/types.js";
import type { ToolExecutor } from "../src/planner/executor.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "community-test-"));
}

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "test-playbook",
    name: "Test Export Workflow",
    description: "Export a video from DaVinci Resolve",
    platform: "davinci-resolve",
    bundleId: "com.blackmagic-design.DaVinciResolveLite",
    steps: [
      { action: "click", target: "Deliver", description: "Switch to Deliver page" } as PlaybookStep,
      { action: "click", target: "Add to Render Queue", description: "Add to queue" } as PlaybookStep,
      { action: "click", target: "Start Render", description: "Start rendering" } as PlaybookStep,
    ],
    version: "1.0.0",
    tags: ["export", "render", "video"],
    successCount: 10,
    failCount: 1,
    ...overrides,
  };
}

// ── PlaybookPublisher ──────────────────────────────────────

describe("PlaybookPublisher", () => {
  let tmpDir: string;
  let publisher: PlaybookPublisher;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    publisher = new PlaybookPublisher(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publishes a playbook with sufficient runs and success rate", () => {
    const playbook = makePlaybook();
    const result = publisher.publish(playbook, 0.9, 5);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Test Export Workflow");
    expect(result!.platform).toBe("davinci-resolve");
    expect(result!.bundleId).toBe("com.blackmagic-design.DaVinciResolveLite");
    expect(result!.steps.length).toBe(3);
    // Cross-check uses playbook's own counts: 10 success / 11 total
    expect(result!.metadata.successRate).toBeCloseTo(10 / 11, 5);
    expect(result!.metadata.executionCount).toBe(11);
    expect(result!.metadata.tags).toEqual(["export", "render", "video"]);

    // File should exist on disk
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
  });

  it("rejects playbook with insufficient runs", () => {
    const playbook = makePlaybook();
    const result = publisher.publish(playbook, 0.9, 2); // minRuns defaults to 3
    expect(result).toBeNull();
  });

  it("rejects playbook with low success rate", () => {
    const playbook = makePlaybook();
    const result = publisher.publish(playbook, 0.3, 10);
    expect(result).toBeNull();
  });

  it("enforces server-side minRuns regardless of client override", () => {
    const playbook = makePlaybook();
    // 2 runs with minRuns=1 override → should FAIL because server minimum is 3
    const result = publisher.publish(playbook, 0.8, 2, 1);
    expect(result).toBeNull();
    // 3 runs → should pass
    const result2 = publisher.publish(playbook, 0.8, 3);
    expect(result2).not.toBeNull();
  });

  it("sanitizes sensitive params (passwords, file paths)", () => {
    const playbook = makePlaybook({
      steps: [
        {
          action: "type",
          target: "#password-field",
          text: "my-secret-password",
          description: "Enter password",
        } as unknown as PlaybookStep,
        {
          action: "click",
          target: "/Users/john/Documents/secret.pdf",
          description: "Open file",
        } as unknown as PlaybookStep,
      ],
    });

    const result = publisher.publish(playbook, 0.9, 5);
    expect(result).not.toBeNull();

    // Sensitive params should be stripped or sanitized
    // The publisher converts steps via convertSteps which extracts params
    // then sanitizeParams strips keys containing "password", "secret", etc.
    // and replaces absolute paths with basename
    for (const step of result!.steps) {
      for (const [key, val] of Object.entries(step.params)) {
        if (typeof val === "string") {
          expect(val).not.toContain("/Users/");
        }
      }
    }
  });

  it("lists published playbooks", () => {
    publisher.publish(makePlaybook({ id: "pb-1", name: "First" }), 0.9, 5);
    publisher.publish(makePlaybook({ id: "pb-2", name: "Second" }), 0.8, 4);

    const listed = publisher.list();
    expect(listed.length).toBe(2);
    const names = listed.map((p) => p.name);
    expect(names).toContain("First");
    expect(names).toContain("Second");
  });

  it("generates unique IDs for different playbook IDs", () => {
    const r1 = publisher.publish(makePlaybook({ id: "pb-alpha" }), 0.9, 5);
    const r2 = publisher.publish(makePlaybook({ id: "pb-beta" }), 0.9, 5);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // Different playbook IDs → different community IDs
    expect(r1!.id).not.toBe(r2!.id);
  });
});

// ── PlaybookFetcher ────────────────────────────────────────

describe("PlaybookFetcher", () => {
  let tmpDir: string;
  let publisher: PlaybookPublisher;
  let fetcher: PlaybookFetcher;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    publisher = new PlaybookPublisher(tmpDir);
    fetcher = new PlaybookFetcher(tmpDir);

    // Publish some test playbooks
    publisher.publish(
      makePlaybook({ id: "resolve-export", name: "DaVinci Export", platform: "davinci-resolve", bundleId: "com.blackmagic-design.DaVinciResolveLite", tags: ["export", "video"] }),
      0.95, 10,
    );
    publisher.publish(
      makePlaybook({ id: "figma-export", name: "Figma Export PNG", platform: "figma", bundleId: "com.figma.Desktop", tags: ["export", "design"] }),
      0.8, 6,
    );
    publisher.publish(
      makePlaybook({ id: "resolve-color", name: "DaVinci Color Grade", platform: "davinci-resolve", bundleId: "com.blackmagic-design.DaVinciResolveLite", tags: ["color", "grade"] }),
      0.7, 4,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fetches all playbooks with empty query", () => {
    const results = fetcher.fetch({});
    expect(results.length).toBe(3);
  });

  it("filters by platform", () => {
    const results = fetcher.fetch({ platform: "davinci-resolve" });
    expect(results.length).toBe(2);
    for (const pb of results) {
      expect(pb.platform).toBe("davinci-resolve");
    }
  });

  it("filters by bundleId", () => {
    const results = fetcher.fetch({ bundleId: "com.figma.Desktop" });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("Figma Export PNG");
  });

  it("filters by workflow keyword", () => {
    const results = fetcher.fetch({ workflow: "color" });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("DaVinci Color Grade");
  });

  it("sorts by success rate descending", () => {
    const results = fetcher.fetch({ platform: "davinci-resolve" });
    expect(results[0]!.metadata.successRate).toBeGreaterThanOrEqual(results[1]!.metadata.successRate);
  });

  it("respects limit", () => {
    const results = fetcher.fetch({ limit: 1 });
    expect(results.length).toBe(1);
  });

  it("gets a specific playbook by ID", () => {
    const all = fetcher.fetch({});
    const id = all[0]!.id;
    const result = fetcher.get(id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
  });

  it("returns null for unknown ID", () => {
    expect(fetcher.get("nonexistent")).toBeNull();
  });

  it("invalidates cache after publish", () => {
    const before = fetcher.fetch({});
    expect(before.length).toBe(3);

    publisher.publish(
      makePlaybook({ id: "new-pb", name: "New Playbook", platform: "photoshop" }),
      0.9, 5,
    );

    // Cache still has old data
    const cached = fetcher.fetch({});
    expect(cached.length).toBe(3);

    // After invalidation, picks up new playbook
    fetcher.invalidateCache();
    const refreshed = fetcher.fetch({});
    expect(refreshed.length).toBe(4);
  });

  it("returns empty for no matches", () => {
    const results = fetcher.fetch({ platform: "nonexistent-app" });
    expect(results.length).toBe(0);
  });
});

// ── PlaybookValidator ──────────────────────────────────────

describe("PlaybookValidator", () => {
  function makeSharedPlaybook(overrides?: Partial<SharedPlaybook>): SharedPlaybook {
    return {
      id: "community_test_1",
      name: "Test Playbook",
      description: "A test playbook",
      platform: "test-app",
      bundleId: "com.test.app",
      version: "1.0.0",
      steps: [
        { action: "click", tool: "click_text", params: { text: "Submit" }, description: "Click Submit" },
        { action: "type", tool: "type_text", params: { text: "hello" }, description: "Type hello" },
        { action: "press", tool: "key", params: { key: "Enter" }, description: "Press Enter" },
      ],
      metadata: {
        author: "test",
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        os: "darwin",
        successRate: 0.9,
        executionCount: 10,
        tags: ["test"],
      },
      ratings: { upvotes: 5, downvotes: 0, score: 5, reportCount: 0 },
      ...overrides,
    };
  }

  it("validates a playbook with all steps passing", async () => {
    const executor: ToolExecutor = async () => ({ ok: true, result: "done" });
    const validator = new PlaybookValidator(executor);

    const result = await validator.validate(makeSharedPlaybook());
    expect(result.success).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(result.totalSteps).toBe(3);
    expect(result.errors.length).toBe(0);
  });

  it("stops on first failing step", async () => {
    let callCount = 0;
    const executor: ToolExecutor = async () => {
      callCount++;
      if (callCount === 2) return { ok: false, error: "Element not found" };
      return { ok: true, result: "done" };
    };
    const validator = new PlaybookValidator(executor);

    const result = await validator.validate(makeSharedPlaybook());
    expect(result.success).toBe(false);
    expect(result.stepsCompleted).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Element not found");
  });

  it("catches thrown errors", async () => {
    const executor: ToolExecutor = async () => {
      throw new Error("Bridge crash");
    };
    const validator = new PlaybookValidator(executor);

    const result = await validator.validate(makeSharedPlaybook());
    expect(result.success).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.errors[0]).toContain("Bridge crash");
  });

  it("passes correct tool and params to executor", async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const executor: ToolExecutor = async (tool, params) => {
      calls.push({ tool, params });
      return { ok: true };
    };
    const validator = new PlaybookValidator(executor);

    await validator.validate(makeSharedPlaybook());
    expect(calls.length).toBe(3);
    expect(calls[0]!.tool).toBe("click_text");
    expect(calls[0]!.params).toEqual({ text: "Submit" });
    expect(calls[1]!.tool).toBe("type_text");
    expect(calls[2]!.tool).toBe("key");
  });

  it("findBest returns first successful playbook", async () => {
    let callIdx = 0;
    const executor: ToolExecutor = async () => {
      callIdx++;
      // First playbook's first step fails, second playbook succeeds
      if (callIdx === 1) return { ok: false, error: "fail" };
      return { ok: true };
    };
    const validator = new PlaybookValidator(executor);

    const pb1 = makeSharedPlaybook({ id: "bad", steps: [{ action: "click", tool: "click_text", params: { text: "X" }, description: "Click X" }] });
    const pb2 = makeSharedPlaybook({ id: "good", steps: [{ action: "click", tool: "click_text", params: { text: "Y" }, description: "Click Y" }] });

    const best = await validator.findBest([pb1, pb2]);
    expect(best).not.toBeNull();
    expect(best!.playbook.id).toBe("good");
    expect(best!.success).toBe(true);
  });

  it("findBest returns null when no playbook succeeds", async () => {
    const executor: ToolExecutor = async () => ({ ok: false, error: "fail" });
    const validator = new PlaybookValidator(executor);

    const pb = makeSharedPlaybook({ steps: [{ action: "click", tool: "click_text", params: {}, description: "Click" }] });
    const best = await validator.findBest([pb]);
    expect(best).toBeNull();
  });

  it("rejects empty-step playbook", async () => {
    const executor: ToolExecutor = async () => ({ ok: true });
    const validator = new PlaybookValidator(executor);

    const result = await validator.validate(makeSharedPlaybook({ steps: [] }));
    expect(result.success).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.errors[0]).toContain("no steps");
  });
});
