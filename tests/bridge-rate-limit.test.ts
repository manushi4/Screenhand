// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BridgeClient } from "../src/native/bridge-client.js";

/**
 * Creates a BridgeClient with _callInner mocked out so we can test
 * the rate-limiting logic in call() without spawning a real native process.
 *
 * Each _callInner invocation returns a promise that the test controls
 * via the returned `slots` array — call slot.resolve() to complete it.
 */
function createMockClient(): {
  client: BridgeClient;
  slots: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>;
} {
  const client = new BridgeClient("/fake/path");
  // Mark as started so call() doesn't try to spawn
  (client as any).started = true;

  const slots: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

  // Replace _callInner with a mock that hands control to the test
  vi.spyOn(client as any, "_callInner").mockImplementation(() => {
    return new Promise((resolve, reject) => {
      slots.push({ resolve, reject });
    });
  });

  return { client, slots };
}

describe("BridgeClient rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows up to 20 concurrent requests", async () => {
    const { client, slots } = createMockClient();

    // Launch 20 concurrent calls — all should enter _callInner immediately
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      promises.push(client.call("test.method", { i }));
    }

    // All 20 should have created slots (meaning they reached _callInner)
    expect(slots.length).toBe(20);
    expect((client as any).activeRequests).toBe(20);

    // Resolve them all
    for (const slot of slots) {
      slot.resolve({ ok: true });
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r).toEqual({ ok: true });
    }

    expect((client as any).activeRequests).toBe(0);
  });

  it("21st request waits and succeeds when a slot opens", async () => {
    const { client, slots } = createMockClient();

    // Fill all 20 slots
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      promises.push(client.call("test.method", { i }));
    }
    expect(slots.length).toBe(20);

    // The 21st call should NOT immediately create a slot — it waits in the poll loop
    let call21Resolved = false;
    const promise21 = client.call<{ idx: number }>("test.method", { i: 20 }).then((v) => {
      call21Resolved = true;
      return v;
    });

    // Advance a few poll ticks — still blocked, no new slot yet
    await vi.advanceTimersByTimeAsync(100);
    expect(slots.length).toBe(20);
    expect(call21Resolved).toBe(false);

    // Free one slot by resolving the first request
    slots[0]!.resolve({ idx: 0 });
    await promises[0]; // let it settle

    // Advance timers so the 21st call's poll loop picks up the free slot
    await vi.advanceTimersByTimeAsync(100);

    // Now the 21st call should have entered _callInner
    expect(slots.length).toBe(21);

    // Resolve the 21st
    slots[20]!.resolve({ idx: 20 });
    const result = await promise21;
    expect(result).toEqual({ idx: 20 });
    expect(call21Resolved).toBe(true);

    // Clean up remaining
    for (let i = 1; i < 20; i++) {
      slots[i]!.resolve({ idx: i });
    }
    await Promise.all(promises);
    expect((client as any).activeRequests).toBe(0);
  });

  it("throws overloaded error after 5 seconds of no available slots", async () => {
    const { client, slots } = createMockClient();

    // Fill all 20 slots (never resolve them — keep them blocked)
    const batch: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      batch.push(client.call("test.method", { i }));
    }
    expect(slots.length).toBe(20);

    // The 21st call will wait up to 5s then throw.
    // Attach a catch handler immediately to prevent unhandled rejection warnings
    // during timer advancement.
    let overloadError: Error | null = null;
    const promise21 = client.call("test.method", { i: 20 }).catch((err: Error) => {
      overloadError = err;
    });

    // Advance past the 5-second wait threshold
    await vi.advanceTimersByTimeAsync(5_100);
    await promise21;

    expect(overloadError).not.toBeNull();
    expect(overloadError!.message).toBe(
      "Bridge overloaded: too many concurrent requests (waited 5s)",
    );

    // The failed 21st request should NOT have leaked into activeRequests.
    // Active should still be 20 from the original batch.
    expect((client as any).activeRequests).toBe(20);

    // Clean up: resolve all 20 in-flight requests so no promises leak
    for (const slot of slots) {
      slot.resolve({ ok: true });
    }
    await Promise.all(batch);
  });

  it("activeRequests counter does not leak when _callInner rejects", async () => {
    const { client, slots } = createMockClient();

    expect((client as any).activeRequests).toBe(0);

    // Launch a call that will fail
    const failPromise = client.call("test.failing");
    expect(slots.length).toBe(1);
    expect((client as any).activeRequests).toBe(1);

    // Reject it
    slots[0]!.reject(new Error("bridge exploded"));

    await expect(failPromise).rejects.toThrow("bridge exploded");

    // Counter must be back to zero — no leak
    expect((client as any).activeRequests).toBe(0);
  });

  it("activeRequests counter does not leak when multiple calls fail", async () => {
    const { client, slots } = createMockClient();

    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) {
      promises.push(client.call("test.failing", { i }));
    }
    expect((client as any).activeRequests).toBe(5);

    // Reject all
    for (const slot of slots) {
      slot.reject(new Error("kaboom"));
    }

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }

    expect((client as any).activeRequests).toBe(0);
  });

  it("multiple queued requests all eventually proceed as slots free up", async () => {
    const { client, slots } = createMockClient();

    // Fill 20 slots
    const batch1: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      batch1.push(client.call("test.method", { i }));
    }

    // Queue 5 more (all will wait)
    const batch2: Array<Promise<unknown>> = [];
    for (let i = 20; i < 25; i++) {
      batch2.push(client.call("test.method", { i }));
    }

    // Only 20 should have slots so far
    expect(slots.length).toBe(20);

    // Free all 20 original slots
    for (let i = 0; i < 20; i++) {
      slots[i]!.resolve({ idx: i });
    }
    await Promise.all(batch1);

    // Advance timers to let the 5 queued calls detect free slots
    await vi.advanceTimersByTimeAsync(200);

    // All 5 queued calls should now have slots
    expect(slots.length).toBe(25);

    // Resolve them
    for (let i = 20; i < 25; i++) {
      slots[i]!.resolve({ idx: i });
    }

    const results = await Promise.all(batch2);
    expect(results).toHaveLength(5);
    expect((client as any).activeRequests).toBe(0);
  });
});
