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

export class MacOSBridgeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readonly binaryPath: string;
  private restarting = false;
  private started = false;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath ?? path.resolve(
      import.meta.dirname ?? process.cwd(),
      "../../native/macos-bridge/.build/release/macos-bridge",
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.spawn();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    // Reject all pending
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge stopped"));
      this.pending.delete(id);
    }
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (!this.process || this.process.exitCode !== null) {
      await this.restart();
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method };
    if (params) {
      request.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge call "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const line = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(line);
    });
  }

  async ping(): Promise<{ pong: boolean; pid: number; accessible: boolean }> {
    return this.call("ping");
  }

  async checkPermissions(): Promise<{ trusted: boolean }> {
    return this.call("check_permissions");
  }

  private async spawn(): Promise<void> {
    const child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("error", (err) => {
      this.emit("error", err);
      if (this.started) {
        this.restart().catch(() => {});
      }
    });

    child.on("exit", (code) => {
      this.emit("exit", code);
      if (this.started && !this.restarting) {
        this.restart().catch(() => {});
      }
    });

    // Parse stdout line by line
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      this.handleLine(line);
    });

    // Log stderr
    child.stderr?.on("data", (data: Buffer) => {
      this.emit("stderr", data.toString());
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

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge process crashed, restarting"));
      this.pending.delete(id);
    }

    try {
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      await this.spawn();
      this.emit("restart");
    } finally {
      this.restarting = false;
    }
  }
}
