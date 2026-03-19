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

/**
 * ToolRegistry — captures MCP tool handlers so the PlanExecutor can call
 * tools internally without going through the MCP transport layer.
 *
 * Handlers are registered during tool setup in mcp-desktop.ts.
 * The registry stores the *original* (unwrapped) handler to avoid
 * double-logging through the intelligence wrapper.
 */

import type { ToolExecutor } from "./executor.js";

type Handler = (params: Record<string, unknown>) => Promise<any>;

export class ToolRegistry {
  private readonly handlers = new Map<string, Handler>();

  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  getToolNames(): string[] {
    return [...this.handlers.keys()];
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }

    try {
      const result = await handler(params);
      // Extract text from MCP result format { content: [{ type: "text", text: "..." }] }
      let text = "";
      if (result?.content && Array.isArray(result.content)) {
        text = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
      // Detect failures: explicit isError flag OR soft failure patterns in text
      if (result?.isError) {
        return { ok: false, error: text };
      }
      const lower = text.toLowerCase();
      const isSoftFailure =
        (lower.includes("not found") &&
          !lower.includes("clicked") &&
          !lower.includes("using default") &&
          !lower.includes("created") &&
          !lower.includes("using fallback")) ||
        lower.includes("window not found") ||
        (lower.startsWith("error:") &&
          !/^error:\s*(none|no |nothing|0 )/.test(lower));
      if (isSoftFailure) {
        return { ok: false, error: text };
      }

      return { ok: true, result: text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  toExecutor(): ToolExecutor {
    return (tool, params) => this.execute(tool, params);
  }
}
