import { describe, it, expect } from "vitest";
import {
  planExecution,
  executeWithFallback,
  DEFAULT_RETRY_POLICY,
  METHOD_CAPABILITIES,
  EXECUTION_METHODS,
} from "../src/runtime/execution-contract.js";
import type { ExecutionMethod, ActionResult } from "../src/runtime/execution-contract.js";

describe("planExecution", () => {
  it("returns ax, cdp, coordinates for click with all infra", () => {
    const plan = planExecution("click", { hasBridge: true, hasCDP: true });
    expect(plan).toEqual(["ax", "cdp", "coordinates"]);
  });

  it("excludes cdp when hasCDP is false", () => {
    const plan = planExecution("click", { hasBridge: true, hasCDP: false });
    expect(plan).toEqual(["ax", "coordinates"]);
  });

  it("excludes bridge-dependent methods when hasBridge is false", () => {
    const plan = planExecution("click", { hasBridge: false, hasCDP: true });
    expect(plan).toEqual(["cdp"]);
  });

  it("returns empty when no infra available for click", () => {
    const plan = planExecution("click", { hasBridge: false, hasCDP: false });
    expect(plan).toEqual([]);
  });

  it("includes ocr for read action", () => {
    const plan = planExecution("read", { hasBridge: true, hasCDP: true });
    expect(plan).toContain("ocr");
    expect(plan).toContain("ax");
    expect(plan).toContain("cdp");
  });

  it("ocr cannot click", () => {
    const plan = planExecution("click", { hasBridge: true, hasCDP: true });
    expect(plan).not.toContain("ocr");
  });

  it("locate returns ax, cdp, ocr", () => {
    const plan = planExecution("locate", { hasBridge: true, hasCDP: true });
    expect(plan).toEqual(["ax", "cdp", "ocr"]);
  });

  it("select returns ax, cdp", () => {
    const plan = planExecution("select", { hasBridge: true, hasCDP: true });
    expect(plan).toEqual(["ax", "cdp"]);
  });

  it("scroll returns ax, cdp, coordinates", () => {
    const plan = planExecution("scroll", { hasBridge: true, hasCDP: true });
    expect(plan).toEqual(["ax", "cdp", "coordinates"]);
  });

  it("ocr cannot select or scroll", () => {
    expect(METHOD_CAPABILITIES.ocr.canSelect).toBe(false);
    expect(METHOD_CAPABILITIES.ocr.canScroll).toBe(false);
  });
});

describe("executeWithFallback", () => {
  function makeResult(method: ExecutionMethod, ok: boolean): ActionResult {
    return { ok, method, durationMs: 10, fallbackFrom: null, retries: 0, error: ok ? null : "fail", target: "test" };
  }

  it("returns first success immediately", async () => {
    const calls: string[] = [];
    const result = await executeWithFallback(
      "click",
      ["ax", "cdp"],
      { ...DEFAULT_RETRY_POLICY, delayBetweenRetriesMs: 0 },
      async (method) => {
        calls.push(method);
        return makeResult(method, true);
      },
    );
    expect(result.ok).toBe(true);
    expect(result.method).toBe("ax");
    expect(calls).toEqual(["ax"]);
  });

  it("falls through on failure", async () => {
    const calls: string[] = [];
    const result = await executeWithFallback(
      "click",
      ["ax", "cdp"],
      { maxRetriesPerMethod: 0, maxTotalRetries: 5, delayBetweenRetriesMs: 0, escalateAfter: 3 },
      async (method) => {
        calls.push(method);
        if (method === "ax") return makeResult(method, false);
        return makeResult(method, true);
      },
    );
    expect(result.ok).toBe(true);
    expect(result.method).toBe("cdp");
    expect(result.fallbackFrom).toBe("ax");
    expect(calls).toEqual(["ax", "cdp"]);
  });

  it("retries within a method", async () => {
    let axAttempts = 0;
    const result = await executeWithFallback(
      "click",
      ["ax"],
      { maxRetriesPerMethod: 2, maxTotalRetries: 5, delayBetweenRetriesMs: 0, escalateAfter: 3 },
      async (method, attempt) => {
        axAttempts++;
        if (attempt < 2) return makeResult(method, false);
        return makeResult(method, true);
      },
    );
    expect(result.ok).toBe(true);
    expect(axAttempts).toBe(3); // attempt 0, 1, 2
  });

  it("respects maxTotalRetries across methods", async () => {
    const calls: string[] = [];
    const result = await executeWithFallback(
      "click",
      ["ax", "cdp", "coordinates"],
      { maxRetriesPerMethod: 2, maxTotalRetries: 2, delayBetweenRetriesMs: 0, escalateAfter: 3 },
      async (method) => {
        calls.push(method);
        return makeResult(method, false);
      },
    );
    expect(result.ok).toBe(false);
    // First attempt (0 retries) + 2 retries = 3 calls, but maxTotalRetries=2 limits it
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("returns last result when all methods fail", async () => {
    const result = await executeWithFallback(
      "click",
      ["ax", "cdp"],
      { maxRetriesPerMethod: 0, maxTotalRetries: 5, delayBetweenRetriesMs: 0, escalateAfter: 3 },
      async (method) => makeResult(method, false),
    );
    expect(result.ok).toBe(false);
    expect(result.method).toBe("cdp");
  });
});

describe("METHOD_CAPABILITIES", () => {
  it("has entries for all execution methods", () => {
    for (const method of EXECUTION_METHODS) {
      expect(METHOD_CAPABILITIES[method]).toBeDefined();
      expect(METHOD_CAPABILITIES[method].method).toBe(method);
    }
  });

  it("ocr cannot click, type, select, or scroll", () => {
    expect(METHOD_CAPABILITIES.ocr.canClick).toBe(false);
    expect(METHOD_CAPABILITIES.ocr.canType).toBe(false);
    expect(METHOD_CAPABILITIES.ocr.canSelect).toBe(false);
    expect(METHOD_CAPABILITIES.ocr.canScroll).toBe(false);
    expect(METHOD_CAPABILITIES.ocr.canRead).toBe(true);
    expect(METHOD_CAPABILITIES.ocr.canLocate).toBe(true);
  });
});
