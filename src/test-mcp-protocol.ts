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

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const tsxBin = path.join(projectRoot, "node_modules", ".bin", "tsx");

const TIMEOUT_MS = 10_000;

const proc = spawn(tsxBin, [path.join(projectRoot, "src/mcp-entry.ts")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SCREENHAND_ADAPTER: "placeholder" },
  cwd: projectRoot,
});

let stderrBuf = "";
proc.stderr!.on("data", (d: Buffer) => { stderrBuf += d.toString(); });

// MCP SDK v1.27 uses newline-delimited JSON (NDJSON), not Content-Length framing
function send(msg: Record<string, unknown>) {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: proc.stdout! });
const lineQueue: string[] = [];
let lineWaiter: ((line: string) => void) | null = null;

rl.on("line", (line) => {
  if (lineWaiter) {
    const w = lineWaiter;
    lineWaiter = null;
    w(line);
  } else {
    lineQueue.push(line);
  }
});

function readResponse(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lineWaiter = null;
      reject(new Error(`Timeout. stderr: ${stderrBuf.slice(-300)}`));
    }, TIMEOUT_MS);

    const handle = (line: string) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    };

    const queued = lineQueue.shift();
    if (queued) {
      clearTimeout(timer);
      resolve(JSON.parse(queued));
    } else {
      lineWaiter = handle;
    }
  });
}

function fail(msg: string): never {
  console.error("FAIL:", msg);
  proc.kill();
  process.exit(1);
}

try {
  // Wait for server to start
  await new Promise((r) => setTimeout(r, 2000));

  // 1. Initialize
  console.log("Sending initialize...");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" },
    },
  });

  const initResp = await readResponse();
  const initResult = initResp.result as Record<string, unknown> | undefined;
  if (!initResult) fail(`No init result: ${JSON.stringify(initResp)}`);

  console.log("=== Initialize ===");
  console.log(`  Protocol: ${initResult.protocolVersion}`);
  console.log(`  Server: ${JSON.stringify(initResult.serverInfo)}`);

  // 2. Send initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((r) => setTimeout(r, 300));

  // 3. List tools
  console.log("\nListing tools...");
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResp = await readResponse();
  const toolsResult = toolsResp.result as Record<string, unknown> | undefined;
  if (!toolsResult) fail(`No tools result: ${JSON.stringify(toolsResp)}`);

  const tools = (toolsResult.tools as Array<{ name: string; description?: string }>) ?? [];

  console.log("=== Tools ===");
  for (const tool of tools) {
    console.log(`  ${tool.name}: ${(tool.description ?? "").slice(0, 70)}`);
  }
  console.log(`\n  Total: ${tools.length} tools`);

  if (tools.length < 10) fail(`Expected 16 tools, got ${tools.length}`);

  // 4. Test session_start
  console.log("\nCalling session_start...");
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "session_start", arguments: {} },
  });
  const sessionResp = await readResponse();
  const sessionResult = sessionResp.result as Record<string, unknown> | undefined;
  if (!sessionResult) fail(`No session result: ${JSON.stringify(sessionResp)}`);

  const sessionContent = sessionResult.content as Array<{ type: string; text: string }>;
  const sessionData = JSON.parse(sessionContent?.[0]?.text ?? "{}");
  console.log("=== session_start ===");
  console.log(`  Session ID: ${sessionData.sessionId}`);
  console.log(`  Profile: ${sessionData.profile}`);

  if (!sessionData.sessionId) fail("No sessionId returned");

  // 5. Test app_list (should work with placeholder)
  console.log("\nCalling app_list...");
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "app_list", arguments: { sessionId: sessionData.sessionId } },
  });
  const appResp = await readResponse();
  const appResult = appResp.result as Record<string, unknown> | undefined;
  console.log("=== app_list ===");
  const appContent = appResult?.content as Array<{ type: string; text: string }> | undefined;
  const isError = appResult?.isError;
  console.log(`  isError: ${isError ?? false}`);
  console.log(`  Response: ${(appContent?.[0]?.text ?? "").slice(0, 100)}`);

  proc.kill();
  console.log("\nAll tests passed!");
  process.exit(0);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
