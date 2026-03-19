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

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
  event?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-method timeout overrides (ms).
 * Methods not listed here use the default 10s timeout.
 */
const METHOD_TIMEOUTS: Record<string, number> = {
  "app.launch": 30_000,
  "cg.captureScreen": 15_000,
  "cg.captureWindow": 15_000,
  "cg.captureWindowBuffer": 15_000,
  "cg.typeText": 30_000,  // L2-66 fix: long text keystroke simulation needs more time
  "vision.ocr": 20_000,
  "vision.ocrRegion": 20_000,
  "vision.findText": 20_000,
  "ax.getMenuBar": 30_000,
};

/**
 * Resolves the correct native bridge binary path for the current platform.
 */
function defaultBinaryPath(): string {
  // import.meta.dirname is Node 20+; for Node 18 derive from import.meta.url
  const base = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

  if (process.platform === "win32") {
    return path.resolve(
      base,
      "../../native/windows-bridge/bin/Release/net8.0-windows/windows-bridge.exe",
    );
  }

  // macOS (default)
  return path.resolve(
    base,
    "../../native/macos-bridge/.build/release/macos-bridge",
  );
}

/**
 * Platform-aware native bridge client.
 * Spawns the correct bridge binary (macOS Swift or Windows C#) based on the OS,
 * communicating via the same JSON-RPC-over-stdio protocol.
 *
 * Drop-in replacement for the original MacOSBridgeClient.
 */
export class BridgeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readonly binaryPath: string;
  private restarting = false;
  /** Resolves when the current restart completes (callers can await it) */
  private restartPromise: Promise<void> | null = null;
  private started = false;
  private consecutiveTimeouts = 0;
  private consecutiveRestarts = 0;
  private lastRestartAt = 0;
  /** Serializes stdin writes to prevent interleaving of large payloads */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Max concurrent bridge requests to prevent DoS */
  private readonly maxConcurrent = 20;
  private activeRequests = 0;

  /** Force-restart bridge after this many consecutive RPC timeouts */
  private static readonly MAX_CONSECUTIVE_TIMEOUTS = 3;
  /** Give up restarting after this many consecutive restart failures */
  private static readonly MAX_CONSECUTIVE_RESTARTS = 8;
  /** Reset restart counter if bridge stays alive for this long */
  private static readonly RESTART_HEALTH_WINDOW_MS = 15_000;
  /** Base delay between restart attempts (doubles each retry) */
  private static readonly RESTART_BASE_DELAY_MS = 500;
  /** After hitting max restarts, pause for this long before allowing retries */
  private static readonly RESTART_COOLDOWN_MS = 60_000;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath ?? defaultBinaryPath();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.spawn();
    this.started = true;

    // Verify bridge is responsive before returning
    try {
      const pingOk = await Promise.race([
        this._sendRaw<{ pong: boolean }>("ping", undefined, 5_000).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      if (!pingOk) {
        const stderrContext = this.recentStderr.length > 0
          ? `\nBridge stderr:\n  ${this.recentStderr.slice(-5).join("\n  ")}`
          : "";
        console.error(
          `[BridgeClient] Bridge did not respond to initial ping.${stderrContext}\n` +
          `Check: System Settings > Privacy & Security > Accessibility permissions for your terminal app.`,
        );
      }
    } catch {
      // Non-fatal — bridge may still respond to subsequent calls
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.killProcess();
    this.rejectAllPending("Bridge stopped");
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    // Wait for a slot instead of immediately rejecting — handles bursts from
    // intelligence wrapper + perception generating multiple bridge calls per tool
    if (this.activeRequests >= this.maxConcurrent) {
      const waitStart = Date.now();
      while (this.activeRequests >= this.maxConcurrent) {
        if (Date.now() - waitStart > 5_000) {
          throw new Error("Bridge overloaded: too many concurrent requests (waited 5s)");
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }

    this.activeRequests++;
    try {
      return await this._callInner<T>(method, params, timeoutMs);
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Low-level send: writes a JSON-RPC request and waits for response.
   * Does NOT check restart state or process liveness — used inside restart()
   * to avoid deadlock (this.call → _callInner awaits restartPromise = deadlock).
   */
  private async _sendRaw<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const effectiveTimeout = timeoutMs ?? METHOD_TIMEOUTS[method] ?? 10_000;

    if (!this.process || !this.process.stdin?.writable) {
      throw new Error("Bridge process not available for raw send");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method };
    if (params) request.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge call "${method}" timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const line = JSON.stringify(request);
      this.writeQueue = this.writeQueue.then(() => {
        return new Promise<void>((writeResolve) => {
          try {
            this.process!.stdin!.write(line + "\n", () => writeResolve());
          } catch {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`Bridge stdin write failed for "${method}"`));
            writeResolve();
          }
        });
      });
    });
  }

  private async _callInner<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const effectiveTimeout = timeoutMs ?? METHOD_TIMEOUTS[method] ?? 10_000;

    // Wait for any in-progress restart before proceeding
    if (this.restarting && this.restartPromise) {
      await this.restartPromise;
    }

    if (!this.process || this.process.exitCode !== null) {
      await this.restart();
    }

    // Guard: restart may have failed, no usable process
    if (!this.process || !this.process.stdin?.writable) {
      throw new Error(`Bridge unavailable after ${this.consecutiveRestarts} restart attempts`);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method };
    if (params) {
      request.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts++;
        reject(new Error(`Bridge call "${method}" timed out after ${effectiveTimeout}ms`));

        // Force restart if bridge appears stalled
        if (this.consecutiveTimeouts >= BridgeClient.MAX_CONSECUTIVE_TIMEOUTS) {
          this.consecutiveTimeouts = 0;
          this.restart().catch(() => {});
        }
      }, effectiveTimeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const line = JSON.stringify(request);
      // Serialize stdin writes to prevent interleaving of large payloads
      this.writeQueue = this.writeQueue.then(() => {
        return new Promise<void>((writeResolve) => {
          try {
            this.process!.stdin!.write(line + "\n", () => writeResolve());
          } catch {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`Bridge stdin write failed for "${method}"`));
            writeResolve();
          }
        });
      });
    });
  }

  async ping(): Promise<{ pong: boolean; pid: number; accessible: boolean }> {
    return this.call("ping");
  }

  async checkPermissions(): Promise<{ trusted: boolean }> {
    return this.call("check_permissions");
  }

  /** Recent stderr lines from the bridge process (kept for diagnostics) */
  private recentStderr: string[] = [];
  private static readonly MAX_STDERR_LINES = 20;

  /** Get recent stderr output for diagnostics */
  getRecentStderr(): string[] {
    return [...this.recentStderr];
  }

  private async spawn(): Promise<void> {
    const child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Track which process this is so stale event handlers don't trigger restarts
    const spawnedProcess = child;

    child.on("error", (err) => {
      this.emit("error", err);
      // Only auto-restart if this is still the active process
      if (this.started && this.process === spawnedProcess) {
        this.restart().catch(() => {});
      }
    });

    child.on("exit", (code) => {
      this.emit("exit", code);
      // Only auto-restart if this is still the active process and not mid-restart
      if (this.started && !this.restarting && this.process === spawnedProcess) {
        this.restart().catch(() => {});
      }
    });

    // Parse stdout line by line
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      this.handleLine(line);
    });

    // Capture stderr for diagnostics and emit
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.emit("stderr", text);
      for (const line of text.split("\n").filter(Boolean)) {
        this.recentStderr.push(line);
        if (this.recentStderr.length > BridgeClient.MAX_STDERR_LINES) {
          this.recentStderr.shift();
        }
      }
    });

    this.process = child;
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Ignore malformed lines
    }

    // Event (streaming notification from observer)
    if (response.event) {
      this.emit("ax-event", response.event);
      return;
    }

    // Response to a pending request
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    // Any response (success or error) means bridge is alive — reset crash counters
    this.consecutiveTimeouts = 0;
    if (this.consecutiveRestarts > 0) {
      this.consecutiveRestarts = 0;
    }

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /** Reject all pending requests with the given reason. */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** Kill the current process and null the reference. */
  private killProcess(): void {
    if (this.process) {
      try {
        this.process.kill("SIGKILL");
      } catch { /* already dead */ }
      this.process = null;
    }
  }

  private async restart(): Promise<void> {
    // If restart already in progress, wait for it instead of returning early.
    // Without this, concurrent callers see this.process=null and throw "Bridge unavailable".
    if (this.restarting) {
      if (this.restartPromise) await this.restartPromise;
      return;
    }
    this.restarting = true;

    const doRestart = async () => {
      this.rejectAllPending("Bridge process crashed, restarting");

      try {
        // Reset restart counter if bridge was healthy for a while
        if (Date.now() - this.lastRestartAt > BridgeClient.RESTART_HEALTH_WINDOW_MS) {
          this.consecutiveRestarts = 0;
        }

        this.consecutiveRestarts++;
        this.lastRestartAt = Date.now();

        // Too many consecutive restarts — enter cooldown instead of permanent death
        if (this.consecutiveRestarts > BridgeClient.MAX_CONSECUTIVE_RESTARTS) {
          this.emit("error", new Error(
            `Bridge restart limit reached (${BridgeClient.MAX_CONSECUTIVE_RESTARTS} consecutive failures). ` +
            `Cooling down for ${BridgeClient.RESTART_COOLDOWN_MS / 1000}s before retrying.`,
          ));
          // Wait for cooldown period, then reset and allow retry
          await new Promise<void>((r) => setTimeout(r, BridgeClient.RESTART_COOLDOWN_MS));
          this.consecutiveRestarts = 1; // Reset but count this as attempt #1
        }

        // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
        const delay = BridgeClient.RESTART_BASE_DELAY_MS * Math.pow(2, this.consecutiveRestarts - 1);
        this.killProcess();

        // Wait for backoff delay — let old process fully die
        await new Promise<void>((r) => setTimeout(r, Math.min(delay, 8_000)));

        await this.spawn();

        // Verify the new process is responsive
        // NOTE: call _sendRaw directly instead of this.call() to avoid deadlock —
        // this.call() → _callInner() awaits this.restartPromise, which IS this function.
        const pingTimeout = 5_000;
        const pingOk = await Promise.race([
          this._sendRaw<{ pong: boolean }>("ping", undefined, pingTimeout).then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), pingTimeout)),
        ]);

        if (!pingOk) {
          const stderrContext = this.recentStderr.length > 0
            ? `\nBridge stderr:\n  ${this.recentStderr.slice(-5).join("\n  ")}`
            : "";
          throw new Error(
            `Native bridge did not respond to ping within 5s.${stderrContext}\n` +
            `Possible causes:\n` +
            `  1. Accessibility permissions not granted — open System Settings > Privacy & Security > Accessibility and add your terminal app\n` +
            `  2. Bridge binary may be corrupted — run: npm run build:native\n` +
            `  3. Another bridge process may be stuck — check: pgrep macos-bridge`,
          );
        }

        // Healthy restart — reset counters (bridge is alive and responsive)
        this.consecutiveTimeouts = 0;
        this.consecutiveRestarts = 0;
        this.emit("restart");
      } catch (err) {
        // Spawn failed — kill zombie if any
        this.killProcess();
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.restarting = false;
        this.restartPromise = null;
      }
    };

    this.restartPromise = doRestart();
    await this.restartPromise;
  }
}

/**
 * @deprecated Use BridgeClient instead. This alias exists for backward compatibility.
 */
export const MacOSBridgeClient = BridgeClient;
