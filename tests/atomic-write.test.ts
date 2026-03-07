import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeFileAtomicSync,
  writeFileAtomic,
  readJsonWithRecovery,
} from "../src/util/atomic-write.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeFileAtomicSync", () => {
  it("writes file content correctly", () => {
    const fp = path.join(tmpDir, "test.json");
    writeFileAtomicSync(fp, '{"a":1}');
    expect(fs.readFileSync(fp, "utf-8")).toBe('{"a":1}');
  });

  it("creates .bak of previous version", () => {
    const fp = path.join(tmpDir, "test.json");
    writeFileAtomicSync(fp, '{"v":1}');
    writeFileAtomicSync(fp, '{"v":2}');
    expect(fs.readFileSync(fp, "utf-8")).toBe('{"v":2}');
    expect(fs.readFileSync(fp + ".bak", "utf-8")).toBe('{"v":1}');
  });

  it("leaves no temp files on success", () => {
    const fp = path.join(tmpDir, "test.json");
    writeFileAtomicSync(fp, "data");
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("overwrites atomically (file always has valid content)", () => {
    const fp = path.join(tmpDir, "test.json");
    writeFileAtomicSync(fp, '{"step":1}');
    // Overwrite 100 times — file should always be parseable
    for (let i = 2; i <= 100; i++) {
      writeFileAtomicSync(fp, JSON.stringify({ step: i }));
    }
    const result = JSON.parse(fs.readFileSync(fp, "utf-8"));
    expect(result.step).toBe(100);
  });
});

describe("writeFileAtomic (async)", () => {
  it("writes file content correctly", async () => {
    const fp = path.join(tmpDir, "async.json");
    await new Promise<void>((resolve, reject) => {
      writeFileAtomic(fp, '{"async":true}', (err) => (err ? reject(err) : resolve()));
    });
    expect(fs.readFileSync(fp, "utf-8")).toBe('{"async":true}');
  });

  it("creates .bak on overwrite", async () => {
    const fp = path.join(tmpDir, "async.json");
    writeFileAtomicSync(fp, '{"v":1}');
    await new Promise<void>((resolve, reject) => {
      writeFileAtomic(fp, '{"v":2}', (err) => (err ? reject(err) : resolve()));
    });
    expect(fs.readFileSync(fp + ".bak", "utf-8")).toBe('{"v":1}');
  });
});

describe("readJsonWithRecovery", () => {
  it("reads valid JSON", () => {
    const fp = path.join(tmpDir, "data.json");
    fs.writeFileSync(fp, '{"ok":true}');
    expect(readJsonWithRecovery(fp)).toEqual({ ok: true });
  });

  it("returns null for missing file", () => {
    expect(readJsonWithRecovery(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("recovers from corrupt primary using .bak", () => {
    const fp = path.join(tmpDir, "data.json");
    // Write a valid backup
    fs.writeFileSync(fp + ".bak", '{"from":"backup"}');
    // Write corrupt primary
    fs.writeFileSync(fp, "{corrupt!!!");
    const result = readJsonWithRecovery(fp);
    expect(result).toEqual({ from: "backup" });
    // Should also restore primary from backup
    expect(JSON.parse(fs.readFileSync(fp, "utf-8"))).toEqual({ from: "backup" });
  });

  it("returns null when both primary and backup are corrupt", () => {
    const fp = path.join(tmpDir, "data.json");
    fs.writeFileSync(fp, "bad{");
    fs.writeFileSync(fp + ".bak", "also bad{");
    expect(readJsonWithRecovery(fp)).toBeNull();
  });

  it("returns null when primary is corrupt and no backup exists", () => {
    const fp = path.join(tmpDir, "data.json");
    fs.writeFileSync(fp, "not json");
    expect(readJsonWithRecovery(fp)).toBeNull();
  });
});
